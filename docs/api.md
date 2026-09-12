# API 速查

RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`，均使用 POST。
PostgREST 请求携带 `apikey`；客户/管理员命令另携带 `Authorization: Bearer <user-jwt>`。
参数名与默认值见 [生成类型](../types/database.ts)，业务约束见 [ADR](architecture-decisions.md)。
所有商品、运费、固定金额优惠、订单、收款和退款均以 **USD** 计价；`product_listing.currency` 显式返回 `USD`，不提供币种切换或自动换汇。

## 商品查询（匿名）

```http
GET /rest/v1/product_listing?select=id,slug,name,price_from,in_stock
GET /rest/v1/products?slug=eq.xxx&select=id,name,description,product_variants(id,sku,price),product_images(url,alt)
```

使用显式字段选择，不对变体使用 `select=*`：`cost` 有列权限保护。精确库存仅管理员可读，商城使用 `in_stock`。
商品子资源继承发布状态；分类拉取平铺列表后在客户端组树，列表视图仅包含启用分类。

管理员创建商品应先用 `status:"draft"`，依次建立变体、选项/值、规格关联、图片，最后 PATCH 为 `active`。
草稿也禁止跨商品选项/图片和同一选项多值；发布商品必须有变体，启用变体必须选全规格且组合唯一（无选项时最多一个启用默认变体）。停用变体可暂存未完成配置。
约束在事务提交时检查；增加规格或替换整个组合可先转草稿分步编辑，或在同一可信事务中完成全部修改。
子资源 ID 和所属商品/选项/变体不可迁移，关联需删除重建。分类禁止任意长度的环。
并发目录修改遇到 SQLSTATE `55P03` / `40001` 时重试整笔事务，不绕过约束。

## 推荐结账流程

1. `price_checkout` 预览价格（匿名可用），不占库存，也不保证之后价格不变。
2. 登录后 `create_checkout_quote` 生成报价并预占库存。
3. `create_order_from_quote` 再次校验价格，建立待支付订单，继续持有预占。
4. 调用渠道支付入口；渠道确认成功后，数据库原子扣库存并推进订单。

```http
POST /rest/v1/rpc/create_checkout_quote

{"idempotency_key":"checkout-attempt-id","items":[{"variant_id":"<uuid>","quantity":1}],"address":{"recipient_name":"Alex Morgan","country":"US","region":"NY","city":"New York","line1":"123 Example Street","line2":"Apt 4B","postal_code":"10001"},"ttl_seconds":900}
```

```http
POST /rest/v1/rpc/create_order_from_quote

{"quote_id":"<uuid>"}
```

`price_checkout` 接受 `items`、`address`、`shipping_method_id`、`discount_code`。
不传地址时仅预估商品价格，不计目的地税；选择配送方式必须显式传国家。传入地址时 `country` 不可省略。
Quote 还支持 `address_id`、`note`；价格变化时需新建 Quote，不会静默重定价。
同一业务重试复用幂等键，不同参数必须使用新键。
建单与报价均限制 50 条规范化商业行/100 件，每客户最多 5 个活跃 checkout（未转单 Quote + 未过期未付款订单）；转单及幂等重试不重复占名额。订单 DTO 的 `payment_expires_at` 是固定付款期限，不可延长。

| RPC | 参数 / 用途 |
| --- | --- |
| `get_checkout_quote` | `quote_id` |
| `get_order_checkout_quote` | `order_id` |
| `cancel_checkout_quote` | `quote_id`、可选 `reason` |
| `cancel_order` | `order_id`、可选 `reason`；仅未支付未发货且无捕获保护的订单 |
| `get_order_ledger` | `order_id`；安全交易账本 DTO，退款含金额组成 |
| `get_order_pricing` | `order_id`；客户本人/admin/service 可读的价格、优惠、税与配送快照 |
| `get_order_fulfillment_balance` | `order_id`；每行订购/履约/取消/退款预留/可履约数量 |
| `update_order_address` | `order_id`、`address` 或 `address_id`；仅符合编辑条件的非 Quote 订单 |

查询限制订单/Quote 归属，部分接口另允许管理员。Quote、已支付订单及活动支付意图保护下的商业快照不可原地改价或改地址。

## 商业行身份

所有计价、报价和即时建单入口共用以下 `items` 合同：

```json
[
  {"variant_id":"<同一个 SKU 的 uuid>","quantity":1,"attributes":{"engraving":"Alice"}},
  {"variant_id":"<同一个 SKU 的 uuid>","quantity":1,"attributes":{"engraving":"Bob"}}
]
```

- `attributes` 可省略，默认为 `{}`；必须是文本值对象，最多 20 个键、键长 1–64 字符且非空白、值长至多 500 字符，JSON 文本总长至多 8192 UTF-8 字节。
- 相同变体和完全相同属性才合并数量；属性键顺序、UUID 大小写及输入重排不改变结果。文本大小写、空格仍有意义，不自动改写定制内容。
- `line_key` 由服务器按变体/属性计算，与数量无关；响应会返回它，重传时必须匹配。其他未声明字段拒绝，不能提交自定价格、目录 `options` 或尚未实现的购买计划。
- 预览返回 `line_key` / `attributes`；Quote 另返回独立行 `id`，转单沿用为 `order_items.id`。即时订单直接分配行 ID。履约和退款继续传 `order_item_id`，不能用 SKU 代替行 ID。
- 库存按变体/仓库汇总；优惠先按变体确定，再按商业行分摊，不能通过添加属性放大促销收益。

订单明细可查询 `/rest/v1/order_items?order_id=eq.<uuid>&select=id,line_key,variant_id,attributes,quantity,line_total`。
属性是不可变交易快照中的客户文本，不是服务端授权指令；前端显示时必须转义，不应包含密钥或不必要的个人信息。终态 Quote 的地址/备注清理不包含行属性。
当前只是保存商业配置，不包含收费定制、订阅、套装或持久购物车。

## 价格明细与税务依据

预览、Quote 和 `get_order_pricing` 使用相同的金额口径：

- `lines[].discount_allocations[]`：`promotion_id`、`label`、`amount`，合计等于该商业行 `discount_total`。
- `promotions[].snapshot`：实际使用的规则类型、参数、优先级、目标和 `application_index`；不是指向可变规则的实时视图。
- `shipping_line`：当前最多一条，含毛运费 `gross_amount`、减免 `discount_total`、配送政策减免 `threshold_discount`、净运费 `total`，以及政策、优惠分摊和税明细。免邮仍保存原收费与减免；满额包邮不虚构促销。
- 商品行和配送行的 `tax_lines[]`：规则 ID、名称、适用国家/`*`、比例 `rate`、折后计税基数 `taxable_amount`、税额 `amount`。订单明细另有稳定 `id`，退款组件引用它。
- `tax_context`：`not_calculated`（无目的地预览）、`no_rule`（无匹配规则）、`calculated`（包括显式零税率），保存目的地、实际规则与算法 `country_rate_variant_line_v1`。`unrecorded` 仅供无税额的受信订单构建，不是免税证明。

税先按 SKU/配送、再按商业行进行整数分最大余数分配，合计等于折后应税基数乘单一税率的舍入结果。拆属性不能改变 SKU 税额。当前不支持多税种、含税价格、州/邮编税、免税证书或税务发票。
商品净额 + 净运费 + 税 = 订单总额；促销免邮收益不重复计入商品折扣。被订单明细引用的税率、运法、促销应停用，不可删除；修改配置不会改写已支付快照。仅符合条件的即时未付订单改地址会重建目的地税，不重新计算商品优惠/运费。

## 支付与退款

| Edge Function | 调用方 | 请求 |
| --- | --- | --- |
| `paypal-create-order` | 客户 | `order_id`、`idempotency_key`；跳转返回的 `approve_url` |
| `paypal-capture-order` | 客户 | 买家批准后传 `payment_intent_id` |
| `paypal-create-refund` | 管理员 | `order_id`、`idempotency_key`、可选 `items`、`shipping_amount` 或互斥的 `amount`，以及 `restock`、`reason` |

退款示例：

```json
{"order_id":"<uuid>","idempotency_key":"refund-command-id","items":[{"order_item_id":"<uuid>","quantity":1}],"restock":true,"reason":"破损"}
```

手工 `refund_order` / `refund_order_v2` 与 PayPal 使用同一组成合同：

- `items` 按独立 `order_item_id` / 数量退**商品净额及对应税**。净额仍在 `refund_lines.amount`，税另列组件，不能把两者重复相加。
- `shipping_amount` 是明确选退的**折后运费、不含税**，可单独传或与 `items` 同传；系统另退对应配送税。省略不退运费，免邮没有正运费可退。
- `amount` 与 `items` / `shipping_amount` 互斥，保存为 `unallocated`，不猜税、运费或商品数量；三者全省略表示退当前可退余额，同样是未分配金额。
- 金额必须是有限正 USD、至多两位小数。各净额/税分别按比例舍入并钳制剩余额度，最后一份吸收余数；总额必须大于零且不超过实收可退余额。`restock=true` 必须有商品行。
- `get_order_ledger.refunds[].components` 与退款请求 DTO 的 `components` 返回 `tax` / `shipping` / `unallocated`、来源 ID、金额；商品行金额 + 组件金额 = 退款总额。异步成功使用请求时的原分摊，不按最新税率或剩余请求重算。

例如只退 4 USD 净运费，传 `{"order_id":"<uuid>","idempotency_key":"shipping-refund-1","shipping_amount":"4.00"}`；若原配送税为 13%，渠道实际收到的本次退款额为 4.52 USD（未发生余数调整时）。

退款请求被接受不等于渠道退款成功；确认前仅预留可退额度/数量，不回库。已发出的退款即使尚无渠道 ID，也不能无确认取消或释放额度。
PayPal 创建 Order 的客户端幂等键按订单隔离；不同订单可以复用同一个键。支付/退款响应 `pending_reconciliation=true` 也可能表示可重试的本地数据库故障，不能当作已完成交易。
渠道密钥、Webhook 和 Worker 接入见 [支付与部署](../supabase/functions/README.md)。

## 地址合同

地址簿及下单/改地址请求共用字段：

- 必填：`recipient_name`、`line1`、`country`（两位国家码，规范化为大写）。不根据 USD、语言或服务器位置推断国家。
- 可选：`line2`、`city`、`region`（州/省/其他行政区）、`postal_code`、`phone`。不强制所有国家采用同一行政区、邮编或电话号码格式。
- 地址簿另有 `label`、`is_default`。配送商和支付渠道可提出额外的地区字段要求。

开发期已直接替换旧地址字段与 CN/CNY 假设，没有兼容别名；按 [数据库开发](database.md) 重建本地库，并使用最新生成类型。

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

- `create_order` / `create_order_v2`：下单即扣库存，但不能穿透 Quote 预占；V2 增加请求指纹与幂等键。同样受建单限额约束，15 分钟未付款由专用 Worker 取消并按原仓回库。
- `create_fulfillment`：无幂等键的基础履约命令，所有订单均须先付款；安全重试使用 `create_fulfillment_v2`。
- `mark_order_paid`：`order_id`、`provider:"manual"`；仅手工收款，线上意图仍可扣款时禁止使用。
- `refund_order` / `refund_order_v2`：同步手工/测试退款，不代表真实渠道已退款；不能穿透活跃异步退款请求。

金额口径：`order_items.total` 为毛额，`line_total` 为扣行折扣后的净额；`orders.discount_total` 只含商品折扣。
免邮收益记录于促销应用与配送分摊中，`shipping_total` 为减免后的运费；`payments.amount` 恒正，方向由 `kind` 表达。退款不等于退货收货，当前 `restock` 仍是管理员在成功退款时选择回库，尚无 Return/Receipt 模块。
