# API 速查

RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`，均使用 POST。
PostgREST 请求携带 `apikey`；客户/管理员命令另携带 `Authorization: Bearer <user-jwt>`。
参数名与默认值见 [生成类型](../types/database.ts)，业务约束见 [ADR](architecture-decisions.md)。

## 商品查询（匿名）

```http
GET /rest/v1/product_listing?select=id,slug,name,price_from,in_stock
GET /rest/v1/products?slug=eq.xxx&select=id,name,description,product_variants(id,sku,price),product_images(url,alt)
```

使用显式字段选择，不对变体使用 `select=*`：`cost` 有列权限保护。精确库存仅管理员可读，商城使用 `in_stock`。
商品子资源继承发布状态；分类拉取平铺列表后在客户端组树，列表视图仅包含启用分类。

## 推荐结账流程

1. `price_checkout` 预览价格（匿名可用），不占库存，也不保证之后价格不变。
2. 登录后 `create_checkout_quote` 生成报价并预占库存。
3. `create_order_from_quote` 再次校验价格，建立待支付订单，继续持有预占。
4. 调用渠道支付入口；渠道确认成功后，数据库原子扣库存并推进订单。

```http
POST /rest/v1/rpc/create_checkout_quote

{"idempotency_key":"checkout-attempt-id","items":[{"variant_id":"<uuid>","quantity":1}],"address":{"receiver":"张三","phone":"13800000000","country":"CN","province":"上海","city":"上海","detail":"世纪大道 1 号"},"ttl_seconds":900}
```

```http
POST /rest/v1/rpc/create_order_from_quote

{"quote_id":"<uuid>"}
```

`price_checkout` 接受 `items`、`address`、`shipping_method_id`、`discount_code`。
Quote 还支持 `address_id`、`note`；价格变化时需新建 Quote，不会静默重定价。
同一业务重试复用幂等键，不同参数必须使用新键。

| RPC | 参数 / 用途 |
| --- | --- |
| `get_checkout_quote` | `quote_id` |
| `get_order_checkout_quote` | `order_id` |
| `cancel_checkout_quote` | `quote_id`、可选 `reason` |
| `cancel_order` | `order_id`、可选 `reason`；仅未支付未发货且无捕获保护的订单 |
| `get_order_ledger` | `order_id`；安全交易账本 DTO |
| `get_order_fulfillment_balance` | `order_id`；每行订购/履约/取消/退款预留/可履约数量 |
| `update_order_address` | `order_id`、`address` 或 `address_id`；仅符合编辑条件的非 Quote 订单 |

查询限制订单/Quote 归属，部分接口另允许管理员。Quote、已支付订单及活动支付意图保护下的商业快照不可原地改价或改地址。

## 支付与退款

| Edge Function | 调用方 | 请求 |
| --- | --- | --- |
| `stripe-create-payment-intent` | 客户 | `order_id`、`idempotency_key`；取得 `client_secret` 后由 Stripe 客户端确认 |
| `paypal-create-order` | 客户 | `order_id`、`idempotency_key`；跳转返回的 `approve_url` |
| `paypal-capture-order` | 客户 | 买家批准后传 `payment_intent_id` |
| `stripe-create-refund` / `paypal-create-refund` | 管理员 | `order_id`、`idempotency_key`、可选 `items` 或 `amount`、`restock`、`reason` |

退款示例：

```json
{"order_id":"<uuid>","idempotency_key":"refund-command-id","items":[{"order_item_id":"<uuid>","quantity":1}],"restock":true,"reason":"破损"}
```

退款请求被接受不等于渠道退款成功；确认前仅预留可退额度/数量，不回库。
渠道密钥、Webhook 和 Worker 接入见 [支付与部署](../supabase/functions/README.md)。

## 客户与管理员命令

| RPC | 权限 | 主要参数 / 限制 |
| --- | --- | --- |
| `set_default_address` | 地址归属人 / admin / service | `address_id`、`make_default`（默认 true） |
| `create_fulfillment_v2` | admin | `order_id`、`items`、`idempotency_key`、可选物流信息 |
| `adjust_inventory` | admin | `variant_id`、`delta`、`reason`、可选 `note` |
| `moderate_review` | admin | `review_id`、`status` |
| `set_user_role` | admin | `user_id`、`role`；最后一名 admin 不可降级 |
| `anonymize_user` | admin | `p_user_id`；清 profile PII、地址簿、客户 metafield 和审计 actor；不是完整账号删除 |

地址内容可直接 PATCH，身份/归属/时间戳不可改；既有地址的默认值必须走 RPC。新建地址仍可传 `is_default=true`。
普通客户创建评价只能为 pending，作者修改内容后重新待审。首次管理员由可信 SQL 引导，后续走角色 RPC。
管理员与客户同属数据库 `authenticated` 角色；订单状态、支付、履约、库存等交易写入必须走受控命令，不能绕过流程直写表。

## 即时下单与手工命令

以下是当前调用链的一部分，不代表历史兼容承诺；新商城优先采用上面的 Quote 流程。

- `create_order` / `create_order_v2`：下单即扣库存，但不能穿透 Quote 预占；V2 增加请求指纹与幂等键。
- `create_fulfillment`：无幂等键的基础履约命令，安全重试使用 `create_fulfillment_v2`。
- `mark_order_paid`：`order_id`、`provider:"manual"`；仅手工收款，线上意图仍可扣款时禁止使用。
- `refund_order` / `refund_order_v2`：同步手工/测试退款，不代表真实渠道已退款；不能穿透活跃异步退款请求。

金额口径：`order_items.total` 为毛额，`line_total` 为扣行折扣后的净额；`orders.discount_total` 只含商品折扣。
免邮收益记录于 `order_promotions.amount`，同时将 `shipping_total` 置零；`payments.amount` 恒正，方向由 `kind` 表达。
