# demo — Headless 电商后端（Supabase）

商用级 headless 电商后端，参考 WooCommerce 的功能覆盖面与 Shopify 的扩展体系设计。
当前实现到完整订单生命周期（下单→支付标记→履约→完成/取消），Stripe/PayPal 支付已留好扩展位。

## 快速开始

```bash
bun install
bunx supabase start        # API :54321 / Studio :54323 / DB :54322
bunx supabase db reset     # 重放迁移 + 载入演示数据
```

## 架构总览

```
supabase/migrations/
├── 20260829170000_foundation.sql   # 用户、通用函数、Metafield/Metaobject 体系
├── 20260829170001_catalog.sql      # 分类、商品、选项、变体、图片、多仓库存
└── 20260829170002_checkout.sql     # 地址、运费、税、折扣、订单、履约、支付、审计
```

### 商品域（Shopify 变体模型）
- `categories`（嵌套）/ `products` / `product_options` / `product_option_values`
- `product_variants`（SKU 级价格/划线价/成本价；无选项商品 = 单个默认变体）
- `variant_option_values` / `product_images`
- `locations` + `inventory_levels`：**多仓库存**，下单扣默认仓
- `product_listing` 视图：列表页专用（价格区间、in_stock 布尔、主图），不泄露库存数和成本价

### 交易域（WooCommerce 式金额结构 + Shopify 式双状态）
- `orders`：`subtotal - discount_total + shipping_total + tax_total = total`
  - `financial_status`（pending/paid/refunded…）与 `fulfillment_status`（unfulfilled/partial/fulfilled）正交
  - 地址/运费/折扣码全部存快照
- `order_items`：商品名/SKU/选项/单价全快照，与商品表解耦
- `addresses` 地址簿 / `shipping_methods`（满额包邮、国家限制）/ `tax_rates`（按国家）
- `discounts`（百分比/定额/免运费，门槛、次数上限、每客限一次）+ `discount_redemptions`
- `fulfillments`：一单多次发货，自动推进履约状态，付讫+发完自动 completed
- `payments`：Stripe/PayPal 扩展点（provider/kind/provider_ref/raw），webhook 用 service role 直写
- `order_events`：全链路审计日志

### 扩展体系（Shopify Metafields / Metaobjects）
- `metafield_definitions` + `metafields`：给 product/variant/category/customer/order/shop
  挂类型化自定义字段（text/number/boolean/date/url/json/list/metaobject_reference…），
  数据库级类型校验 trigger
- `metaobject_definitions` + `metaobjects`：自定义内容类型（示例：尺码表 size_guide），
  可被 metafield 引用

## API 速查

```bash
# 店铺商品列表（匿名）
GET /rest/v1/product_listing?select=slug,price_from,in_stock

# 商品详情（含变体、选项、图片、metafields）
GET /rest/v1/products?slug=eq.xxx&select=*,product_variants(*),product_images(*)

# 下单（登录；价格服务端计算，超卖/折扣/运费/税全自动）
POST /rest/v1/rpc/create_order
{"items":[{"variant_id":"...","quantity":1}],
 "address_id":"...",                  # 或直接传 "address":{...}
 "shipping_method_id":"...",
 "discount_code":"WELCOME10"}

# 取消（仅未支付未发货，回补库存+释放折扣）
POST /rest/v1/rpc/cancel_order {"order_id":"...","reason":"..."}

# 管理端（admin）
POST /rest/v1/rpc/mark_order_paid      {"order_id":"...","provider":"manual"}
POST /rest/v1/rpc/create_fulfillment   {"order_id":"...","items":[...],"carrier":"顺丰","tracking_number":"..."}
```

## 安全模型
- 全表 RLS；订单只能走 `create_order` RPC 创建（无直插策略）
- 列级权限：`cost`（成本价）、`admin_note`、`payments.raw` 不对客户端暴露
- 精确库存数仅 admin 可见，前端用 `product_listing.in_stock`
- 折扣码不公开，验证只在服务端事务内进行
- 设置管理员：`update profiles set role='admin' where email='...';`

## 接入 Stripe/PayPal（预留）
1. Edge Function 创建支付意图 → 写 `payments`（kind=charge, status=pending, provider_ref=xxx）
2. Webhook Function 验签 → 更新 `payments.status='succeeded'` + `orders.financial_status='paid'` + 写 `order_events`
3. 退款：`payments` 插 kind=refund 记录 + `financial_status='refunded'/'partially_refunded'`

前端类型：`bunx supabase gen types typescript --local > types/database.ts`
