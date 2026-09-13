# API 速查

RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`，均使用 POST。
PostgREST 请求携带 `apikey`；客户/管理员命令另携带 `Authorization: Bearer <user-jwt>`。
参数名与默认值见 [生成类型](../types/database.ts)，业务约束见 [ADR](architecture-decisions.md)。
所有商品、运费、固定金额优惠、订单、收款和退款均以 **USD** 计价；`product_listing.currency` 显式返回 `USD`，不提供币种切换或自动换汇。

## Storefront / Admin 商品读取合同

新客户端优先使用以下显式 DTO，而不是把底表结构作为商城合同。RPC 均位于 `public`；命名不授予权限，数据库独立验证身份、发布状态和输出字段。

| RPC | 参数 | 返回 / 权限 |
| --- | --- | --- |
| `list_storefront_products` | `page_size` 默认 20，1–100；可选 `after_id`、`category_id` | `{items,next_cursor}`；匿名可用，只含 active 商品；分类精确匹配且须启用，不包含子分类闭包 |
| `get_storefront_product` | `product_id` | 商品详情或 null；匿名可用，草稿/归档/不存在均返回 null |
| `get_admin_product` | `product_id` | 管理详情或 null；仅 admin/service，包含草稿、停用子资源、成本及内部扩展值 |

列表以 UUID 升序分页，将 `next_cursor` 传给下一次 `after_id`；无后续页时为 null。并发新增商品可能落在已翻过的范围，游标不保证跨请求快照。卡片包含 `id/slug/name/currency/price_from/in_stock/primary_image`，不返回精确库存。仅对当前页商品计算库存，不复用全店预占聚合视图。

详情包含基本商品/SEO 字段、`variants`、`options`、`images`、`categories` 和 `metafields`。变体通过 `option_value_ids` 对应选项值；商品/变体扩展值使用 `{namespace,key,type,value}`。Storefront 隐藏停用变体及其专属图片、停用分类、内部扩展字段和成本；**管理员调用 Storefront 也不会扩大输出范围**。库存仍只看默认仓可用量及有效 Quote 预占，不承诺后续结账成功。

Admin 详情增加商品状态/时间戳及变体 `cost/is_active/track_inventory`；精确库存继续使用管理员 `get_inventory_availability`，不是将 Storefront 切换为“管理员模式”。公共扩展引用不会自动递归展开，需按 Metaobject ID 读取其受保护资源。

现有底表/视图读取保留原授权，用于逐步迁移已有调用与测试；本阶段没有完成全部订单/客户管理查询分层，也未增加搜索、运营排序或写入命令。底表的扩展字段读取同样执行下文的新可见性规则。

### 现有底表查询

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

## Customer 与登录身份

`customers.id` 是独立商业 UUID，**不等于 Auth user ID**。`auth_user_id` 是唯一、可空的登录关联；联系邮箱非唯一，不用邮箱或客户端 metadata 自动认领/合并客户。注册创建新 Customer，后台 `create_customer` 可创建无账号客户；目前没有客户合并、账号重关联或为无账号客户代下单的 RPC。

- `current_customer_id()` 返回当前活跃客户 UUID；无关联或已匿名化返回 null，授权失败关闭。
- `orders` / Quote / 地址 / 评价 / 优惠用量 / 客户 metafield 使用 Customer ID；角色、`set_user_role.user_id` 和审计 `actor_id` 仍使用 Auth ID。
- `/rest/v1/customers` 仅本人/admin/service 可读；可 PATCH `email`、`full_name`、`phone`，不可写身份、Auth 关联、匿名化状态。`profiles` 仅保存账户邮箱/角色等，不再保存姓名/电话，也不提供自助 PATCH。
- Auth 邮箱变化不覆盖客户联系邮箱。删除 Auth 只解除关联，不删除 Customer 或订单；新同邮箱账号不会接管旧记录。
- `anonymize_customer` 清客户联系信息、地址、客户 metafield 与全部 Cart，禁止恢复这些客户自有内容；`anonymize_user` 另清 profile 和审计 actor。两者都不等于删除 Auth、撤销登录凭据或擦除订单地址/属性、评价正文等历史数据。

## 持久 Cart（可选）

Cart 保存购买意向，不保存价格、锁价或占库存。可以为空，每个活跃 Cart 最多 50 条规范化商业行/100 件；同变体/属性合并，已有行 ID 在改数量时保留。停售/价格、库存、优惠资格在预览/转 Quote 时重新核验，不把 Cart 当可支付对象。

| RPC | 参数 / 行为 |
| --- | --- |
| `create_cart` | 登录客户必须传 `idempotency_key`；游客不传键，返回一次 `guest_token`。可选 `ttl_seconds`，默认 604800，范围 60–2592000 |
| `get_cart` | `cart_id`；游客另传 `guest_token`，客户 Cart 只认登录归属 |
| `list_carts` | 登录客户的未过期 active Cart，不含游客或其他客户对象 |
| `update_cart` | `cart_id`、`expected_version`、完整 `items`；可选 `address`、`shipping_method_id`、`discount_code`、`note`、`guest_token` |
| `preview_cart` | `cart_id`、可选 `guest_token`；返回 `{cart_id,version,pricing}`，空 Cart 的 pricing 为 null |
| `claim_cart` | 登录后传 `cart_id`、`expected_version`、原 `guest_token`；显式认领，不合并其他 Cart；旧游客凭据立即失效 |
| `abandon_cart` | `cart_id`、`expected_version`、可选 `guest_token`；清行/地址/备注并终结编辑，不释放 Quote 库存 |
| `checkout_cart` | 仅登录客户，传 `cart_id`、`expected_version`；原子创建 Quote、预占库存并将 Cart 设为 converted，返回 Quote DTO |

`update_cart` 是**完整替换**，不是 PATCH：未传的地址/配送/优惠码/备注会清空，`items:[]` 清行。地址可只填国家以预估，正式结账仍须姓名/line1/国家；地址 JSON 至多 16 KiB，备注至多 2000 字符，优惠码至多 100 字符。行输入使用下文商业行合同，不可把包含行 `id`/价格的响应直接回传。

```http
POST /rest/v1/rpc/update_cart

{"cart_id":"<uuid>","guest_token":"<仅游客需要的凭据>","expected_version":1,"items":[{"variant_id":"<uuid>","quantity":1,"attributes":{"engraving":"Alice"}}],"address":{"recipient_name":"Alex","line1":"123 Example Street","country":"US"}}
```

- 每次编辑/认领/终结版本 +1；版本冲突为 HTTP 409，不静默覆盖。最近一次完全相同的规范化命令重试返回当前结果；更早的重试需 `get_cart` 恢复，不无限保留全部 mutation 历史。创建幂等也只在 Cart 保留期内有效。
- 每客户最多 5 个未过期 active Cart，创建与认领共用配额；这与 5 个活跃 checkout 是两套不同资源上限。转 Quote 仍需满足原 checkout 配额/库存/价格规则，任何失败都不改变 Cart。
- Cart 的期限固定，读取、编辑、认领均不续期。converted / abandoned 不可重新编辑；再次购买创建新 Cart。转 Quote 会清 Cart 地址/备注，但保留商业行；Quote 行重新分配 UUID、沿用 `line_key`，再将 Quote UUID 沿用到订单行。
- 游客凭据是 256 位随机 bearer capability，只授权一个 Cart，不授权 Customer、订单、Quote 或支付。数据库只保存 SHA-256；只有创建响应带明文，丢失后不能取回。放弃后的空 Cart 仍可凭原凭据读取直到到期，认领/到期后旧凭据不可用。
- 始终用 HTTPS/POST；不要把 token 放 URL、日志、埋点或公开存储。BFF 推荐 Secure/HttpOnly/SameSite cookie 并防 CSRF；直接浏览器接入须管理 XSS/凭据存储风险。共享游客凭据就等于共享编辑和认领权。
- 到期立即拒绝访问，`purge_expired_carts` 负责物理删除。访客没有稳定账号可用于总量配额；上线必须在覆盖直接 RPC 的网关部署创建/读取/预览/写入限流，当前数据库限制不等于匿名防滥用或隐私合规验证。

## 推荐结账流程

1. `price_checkout` 预览价格（匿名可用），不占库存，也不保证之后价格不变。
2. 登录后 `create_checkout_quote` 生成报价并预占库存；使用 Cart 时先认领，再调用 `checkout_cart`。
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
这些属性只是商业文本配置，不包含收费定制、订阅或套装；Cart 与交易快照的生命周期不同。

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
{"order_id":"<uuid>","idempotency_key":"refund-command-id","items":[{"order_item_id":"<uuid>","quantity":1}],"restock":true,"reason":"取消未发货商品"}
```

手工 `refund_order` / `refund_order_v2` 与 PayPal 使用同一组成合同：

- `items` 按独立 `order_item_id` / 数量退**商品净额及对应税**。净额仍在 `refund_lines.amount`，税另列组件，不能把两者重复相加。
- `shipping_amount` 是明确选退的**折后运费、不含税**，可单独传或与 `items` 同传；系统另退对应配送税。省略不退运费，免邮没有正运费可退。
- `amount` 与 `items` / `shipping_amount` 互斥，保存为 `unallocated`，不猜税、运费或商品数量；三者全省略表示退当前可退余额，同样是未分配金额。
- 金额必须是有限正 USD、至多两位小数。各净额/税分别按比例舍入并钳制剩余额度，最后一份吸收余数；总额必须大于零且不超过实收可退余额。`restock=true` 必须有商品行，且**只释放本次取消的未发货数量**。已发货部分不会因退款成功自动回库，必须使用下方 Return / Receipt / Disposition。
- `get_order_ledger.refunds[].lines` 的 `cancelled_quantity` 是未发货取消量，`restocked_quantity` 是其中实际释放的库存量；后者不大于前者。退款恢复库存记 `cancel` 流水，不冒充实物退回。
- `get_order_ledger.refunds[].components` 与退款请求 DTO 的 `components` 返回 `tax` / `shipping` / `unallocated`、来源 ID、金额；商品行金额 + 组件金额 = 退款总额。异步成功使用请求时的原分摊，不按最新税率或剩余请求重算。

例如只退 4 USD 净运费，传 `{"order_id":"<uuid>","idempotency_key":"shipping-refund-1","shipping_amount":"4.00"}`；若原配送税为 13%，渠道实际收到的本次退款额为 4.52 USD（未发生余数调整时）。

退款请求被接受不等于渠道退款成功；确认前仅预留可退额度/数量，不回库。已发出的退款即使尚无渠道 ID，也不能无确认取消或释放额度。
PayPal 创建 Order 的客户端幂等键按订单隔离；不同订单可以复用同一个键。支付/退款响应 `pending_reconciliation=true` 也可能表示可重试的本地数据库故障，不能当作已完成交易。
渠道密钥、Webhook 和 Worker 接入见 [支付与部署](../supabase/functions/README.md)。

## Return / Receipt / Disposition

三种事实与资金退款分开：Return 是管理员的退货授权，Receipt 是实际收货，Disposition 是验收后处置。当前每个 Return 对应**一次已 shipped/delivered 的 fulfillment**，通过 `order_item_id` 定位该次发货中的商业行；跨发货退回需多个 Return。客户自助申请/审批、退货面单、换货补发、序列号/批次与退货政策自动判定尚未实现。

| RPC | 权限 | 参数 / 行为 |
| --- | --- | --- |
| `create_return` | admin | `fulfillment_id`、`items:[{order_item_id,quantity}]`、`idempotency_key`、可选 `reason`；创建 open 授权，不改库存/资金 |
| `receive_return` | admin | `return_id`、明确的活跃 `location_id`、`items:[{return_line_id,quantity}]`、`idempotency_key`、可选 `note`；可分批实收，不增加可售库存 |
| `dispose_return_receipt` | admin | `receipt_line_id`、`quantity`、`disposition:"restock"` 或 `"discard"`、`idempotency_key`、可选 `note`；每次处理一条实收行的部分或全部数量 |
| `close_return` | admin | `return_id`、可选 `cancel`（默认 false）；关闭剩余待收量，true 仅允许取消尚无实收的授权 |
| `get_order_returns` | 本人 / admin / service | `order_id`；发货行的可退余额、授权/实收、嵌套收货与处置 DTO |

创建/收货每次接受 1–100 条输入行，只允许相应 ID/正整数 quantity，相同 ID 合并，重排/UUID 大小写不影响指纹；未知字段拒绝。reason 至多 500 字符，note 至多 2000 字符，均为客户可见文本，不应存后台秘密。幂等键 1–200 字符，分别按 fulfillment、Return、receipt line 隔离；相同参数返回同一记录（DTO 可包含后续进展），不同参数拒绝。

```http
POST /rest/v1/rpc/receive_return

{"return_id":"<退货 UUID>","location_id":"<实际收货地点 UUID>","idempotency_key":"receipt-1","items":[{"return_line_id":"<授权行 UUID>","quantity":2}]}
```

收到的商品可以先待验收；`undisposed_quantity` 是实收量减去已处置量。随后分别调用 `dispose_return_receipt`，例如一件 `restock`、一件 `discard`。这不是所有仓库不可售库存的总账；received_at 是本系统记录收货的时间，不接收任意回填时刻。

- 尚无按 Return 自动生成退款的 RPC。既有按商品数量退款仍**优先取消未发货部分**；不能因为创建了 Return 就假定退款会改为“仅退已发货”。若要保留未发货履约量，可另行选择纯金额退款，但它是 unallocated，不推断商品/税的归属。
- 发货可退量 = 有效发货数量 − 所有 Return 实收量 − open Return 尚未实收的授权量。退款数量不占用/释放这个独立余额；已退款、纯金额退款或零价商品仍可依法按店铺政策处理退货。
- 每条授权的累计实收不能超量；每条实收的累计处置不能超量。`restock` 必须有该订单的原始库存扣减事实，增加**实收地点**的可售库存并关联唯一库存流水；不参考变体现在的 track_inventory，也不自动调拨到默认仓（商城结账仍只使用默认仓）。`discard` 不改库存，没有扣减事实的商品不能凭收货新造可售库存。
- 原始扣减覆盖的恢复总量是额外上限。退款只释放未发货取消量，实收处置只处理已发货退回量；先退款/先收货、事件重放或并发不能重复回库。退货、收货、处置从不自动调用退款，也不重算原价/税。
- close 释放未实收授权，保留实收占用；即使尚未验收，也可关闭收货后继续处置已有实收。cancel 只允许无实收时使用。终态不可重开/再收货；新退货仍受剩余可退量限制。
- 存在 open 授权或任何实收的 fulfillment 不可撤销；退回商品不会把原发货改为 cancelled，也不重新赋予发货额度。
- 数量/归属/指纹与流水引用由 FK、触发器和提交时校验共同保护；事实不可删除/改写，仅审计 actor 可单向匿名化。SQLSTATE `55P03` / `40001` / `40P01` 重试整笔事务，不关闭保护。新事件 `return.open/closed/cancelled/received/disposed` 经订单审计进入现有 Outbox，消费者仍须幂等。

## 地址合同

地址簿及下单/改地址请求共用字段：

- 必填：`recipient_name`、`line1`、`country`（两位国家码，规范化为大写）。不根据 USD、语言或服务器位置推断国家。
- 可选：`line2`、`city`、`region`（州/省/其他行政区）、`postal_code`、`phone`。不强制所有国家采用同一行政区、邮编或电话号码格式。
- 地址簿另有 `label`、`is_default`。配送商和支付渠道可提出额外的地区字段要求。

开发期已直接替换旧地址字段与 CN/CNY 假设，没有兼容别名；按 [数据库开发](database.md) 重建本地库，并使用最新生成类型。

## 客户与管理员命令

| RPC | 权限 | 主要参数 / 限制 |
| --- | --- | --- |
| `current_customer_id` | 所有角色 | 当前活跃 Customer UUID 或 null |
| `create_customer` | admin / service | 可选 `email`、`full_name`、`phone`；不附带登录权限 |
| `anonymize_customer` | admin / service | `customer_id`；不删除交易历史 |
| `set_default_address` | 地址归属人 / admin / service | `address_id`、`make_default`（默认 true） |
| `create_fulfillment_v2` | admin | `order_id`、`items`、`idempotency_key`、可选物流信息 |
| `adjust_inventory` | admin | `variant_id`、`delta`、`reason`、可选 `note` |
| `moderate_review` | admin | `review_id`、`status` |
| `set_user_role` | admin | `user_id`、`role`；最后一名 admin 不可降级 |
| `anonymize_user` | admin | `p_user_id` 为 Auth ID；匿名化关联客户，另清 profile PII 与审计 actor；不是完整账号删除 |

地址内容可直接 PATCH，身份/归属/时间戳不可改；既有地址的默认值必须走 RPC。新建地址仍可传 `is_default=true`。
普通客户创建评价只能为 pending，作者修改内容后重新待审。首次管理员由可信 SQL 引导，后续走角色 RPC。
管理员与客户同属数据库 `authenticated` 角色；订单状态、支付、履约、库存等交易写入必须走受控命令，不能绕过流程直写表。

## 促销范围与扩展字段管理

商品百分比及买赠的 `promotions.apply_scope` 为 `all`（默认）或 `selected`；买赠的 `get_scope` 为 `same_as_apply`（默认）或 `selected`。定向活动应以 selected 或 inactive 创建，再配置目标，避免先公开全店优惠。INSERT `promotion_targets` 自动将对应范围收窄为 selected，删除最后一条仍匹配零商品；扩大范围须先删除对应目标，再显式 PATCH scope。规则、范围与目标一起进入交易快照。整单百分比/固定金额与免邮仍按原有整单语义执行，不借此改变算法或增加条件 DSL。

`metafields` 继续写 owner_type / owner_id / type / value，未知类型拒绝；任意 JSON 使用 `type:"json"`。响应中的 `owner_*_id` 是不可直写的生成 FK 路由；商品、变体、分类删除会级联清理其 metafields。Customer/Order 不可删除及匿名化的既有合同不变。

`metafield_definitions.access` 默认 `admin`：

- `admin`：仅管理员/service 可读定义及其值。未建立定义的值也只在管理端可见。
- `public`：仅适用于 product/variant/category/shop；产品、变体、分类仍须满足原发布/启用条件。
- `customer`：仅适用于 customer/order；有活跃 Customer 的账号可读定义，值仍仅归属客户及管理员/service 可读，不向其他客户公开。

`metaobject_definitions.access` 为 `admin`（默认）或 `public`。公开条目还要求自身 active、定义 is_active；修改/删除定义的可见性会在后续查询中立即生效。公开/客户可见的类型化 Metaobject 引用仅在全部目标条目及定义均可公开读取时返回；任一目标私有、停用、草稿或不存在，整个引用字段隐藏，管理员仍可读取修复。任意 JSON/文本不是权限语言，不自动发现或删除其中的敏感内容。

这些规则同时约束底表 RLS 与新 Storefront DTO，不能用旧接口绕过；字段可见性仅管理员/service 可配置。seed 的洗护/材质/尺码表/重量显式公开，礼品留言显式为 customer；其他新增定义不得依赖旧的默认公开行为。

`order_number` 在数据库保证唯一，创建后不可 PATCH（包括 service role）。库存预占和每条新增履约事实都会写共享资源版本；直接 SQL / Worker 遇到 `40001` 应重试整笔事务，不假设仅取行锁就能刷新 REPEATABLE READ 快照。

## 即时下单与手工命令

以下是当前调用链的一部分，不代表历史兼容承诺；新商城优先采用上面的 Quote 流程。

- `create_order` / `create_order_v2`：下单即扣库存，但不能穿透 Quote 预占；V2 增加请求指纹与幂等键。同样受建单限额约束，15 分钟未付款由专用 Worker 取消并按原仓回库。
- `create_fulfillment`：无幂等键的基础履约命令，所有订单均须先付款；安全重试使用 `create_fulfillment_v2`。
- `mark_order_paid`：`order_id`、`provider:"manual"`；仅手工收款，线上意图仍可扣款时禁止使用。
- `refund_order` / `refund_order_v2`：同步手工/测试退款，不代表真实渠道已退款；不能穿透活跃异步退款请求。

金额口径：`order_items.total` 为毛额，`line_total` 为扣行折扣后的净额；`orders.discount_total` 只含商品折扣。
免邮收益记录于促销应用与配送分摊中，`shipping_total` 为减免后的运费；`payments.amount` 恒正，方向由 `kind` 表达。退款不等于退货收货：退款 `restock` 仅释放未发货取消量，已发货商品由实际收货后的 disposition 驱动回库。
