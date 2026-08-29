# demo — Headless 电商后端（Supabase）

基于 Supabase 本地开发栈的极简 headless 电商后端：商品 + 订单（到订单创建为止），
支付（Stripe/PayPal）仅预留扩展位，暂未实现。

## 快速开始

```bash
bun install
bunx supabase start        # 启动本地后端（API :54321 / Studio :54323 / DB :54322）
bunx supabase db reset     # 重置数据库并重放迁移 + seed 数据
```

## 数据模型（4 张表）

| 表 | 说明 |
|---|---|
| `profiles` | auth.users 扩展，注册自动创建；`role` = customer / admin |
| `products` | 商品（价格、库存内联；`is_active=false` 即下架，不物理删除） |
| `orders` | 订单；地址存 JSONB 快照；支付扩展位：`payment_provider` / `payment_ref` / `paid_at` |
| `order_items` | 订单明细（商品名、单价快照） |

订单状态：`pending → paid → shipped → completed`，另有 `cancelled` / `refunded`。

## API 用法

商品列表（匿名可读）：

```
GET /rest/v1/products?select=slug,name,price,stock&is_active=eq.true
```

下单（需登录；价格以服务端为准，事务内锁库存扣减，超卖自动回滚）：

```
POST /rest/v1/rpc/create_order
{
  "items": [{"product_id": "<uuid>", "quantity": 2}],
  "address": {"receiver": "张三", "phone": "138...", "detail": "上海市xx路1号"}
}
```

取消订单（仅 pending 可取消，自动回补库存）：

```
POST /rest/v1/rpc/cancel_order {"order_id": "<uuid>"}
```

## 权限（RLS）

- 商品：所有人可看在售商品；仅 admin 可写
- 订单：买家只能读自己的；**不能直接 insert，必须走 `create_order` RPC**；admin 可改状态
- 设置管理员：在 Studio 或 SQL 里执行 `update profiles set role = 'admin' where id = '<user-uuid>';`

## 后续接入支付（Stripe/PayPal）

1. 建 Edge Function 创建支付意图（Stripe PaymentIntent / PayPal Order）
2. Webhook Function 验签后更新订单：
   `status='paid'` + `payment_provider` + `payment_ref` + `paid_at`
3. `refunded` 状态流转同理

前端类型生成：`bunx supabase gen types typescript --local > types/database.ts`
