# tera-headless — Headless 电商后端（Supabase）

面向商用的 headless 电商后端，参考 WooCommerce 的功能覆盖面与 Shopify 的扩展体系设计。
当前已完成订单生命周期、关键完整性加固、关系化交易账本、事务 Outbox，以及
`on_hand - reserved = available` 的 Checkout Quote 库存预占流程。Stripe PaymentIntent 与
PayPal Orders v2/Payments v2 已接入统一 Provider Inbox、外部资金对账和异步退款状态机；
稳定 `api` / `admin_api` schema 与更多支付渠道仍在演进中。

## 快速开始

```bash
bun install
bunx supabase start        # API :54321 / Studio :54323 / DB :54322
bunx supabase db reset     # 重放迁移 + 载入演示数据
bun run test               # 重置数据库并串行运行完整 API 测试
```

关键边界与演进目标见 [`docs/architecture-decisions.md`](docs/architecture-decisions.md)。

## 架构总览

```
supabase/migrations/
├── 20260829170000_foundation.sql   # 用户、通用函数、Metafield/Metaobject 体系
├── 20260829170001_catalog.sql      # 分类、商品、选项、变体、图片、多仓库存
├── 20260829170002_checkout.sql     # 地址、运费、税、订单、履约、支付、审计
├── 20260829170003_hardening.sql    # 库存流水审计、发货校验、地址管理、评价、审核 RPC
├── 20260829170004_promotions.sql   # 促销引擎（自动/输码促销、叠加互斥、预览计价）
├── 20260829170005_fixes.sql        # 审查修复：折扣钳制/并发锁/权限收拢/退款/改地址重算
├── 20260830050000_critical_integrity.sql # 交易不变量/API 边界/并发/RLS 加固
├── 20260830060000_transaction_ledgers.sql # 关系化账本/幂等命令/Payment Intent/Outbox
├── 20260830070000_checkout_reservations.sql # Quote/库存预占/支付确认转换/过期释放
├── 20260830080000_provider_payments.sql # Provider Inbox/外部资金事实/异步退款请求
├── 20260830090000_paypal_payments.sql # PayPal Order/Capture/reversal/退款轮询边界
├── 20260830100000_stripe_best_practices.sql # Stripe 精确资金/乱序状态/退款父引用加固
├── 20260830110000_payment_command_safety.sql # PayPal 捕获/取消互斥、手工收款与渠道终态
├── 20260830120000_refund_fulfillment_quantities.sql # 退款取消数量/履约预留与历史回填
├── 20260830130000_order_edit_and_review_permissions.sql # 支付快照/评价 INSERT/目录可见性
├── 20260830140000_exact_discount_allocation.sql # 整数分最大余数分摊/免邮实际收益
└── 20260830150000_default_address_commands.sql # 默认地址 RPC/列权限/锁顺序

supabase/functions/
├── stripe-create-payment-intent/ / stripe-webhook/ / stripe-create-refund/
├── stripe-reconcile-payment-intents/ # service-only 过期 PaymentIntent 取消/终态对账
├── paypal-create-order/ / paypal-capture-order/ / paypal-webhook/
├── paypal-create-refund/           # admin 鉴权 + PayPal Payments v2 退款
└── paypal-reconcile-refunds/       # service-only pending refund 轮询

tests/                              # bun test，共 238 例
├── helpers.ts                      # API/RPC/认证/库存 辅助函数
├── catalog.test.ts                 # 商品目录与视图
├── orders.test.ts                  # 下单金额/折扣/运费/税/取消/RLS
├── admin.test.ts                   # 履约/支付标记/库存管理/权限边界
├── extensions.test.ts              # Metafield/Metaobject/评价审核流
├── promotions.test.ts              # 促销引擎（预览/四类促销/叠加互斥/落账）
├── fixes.test.ts                   # 审查修复回归（钳制/并发/退款/权限/匿名化）
├── critical-integrity.test.ts      # 资金/履约/库存/RLS/并发攻击性回归
├── transaction-ledgers.test.ts     # Adjustment/支付意图/交易/退款行/履约行/Outbox
├── inventory-reservations.test.ts  # Quote/并发预占/转单/支付消费/取消与过期释放
├── provider-payments.test.ts       # Provider Inbox/资金异常/异步退款/并发预留
├── stripe-edge.test.ts             # Stripe 签名、金额转换、PII 归一化与 HTTP 幂等
├── paypal-payments.test.ts         # PayPal capture/reversal/异步退款与库存闭环
├── paypal-edge.test.ts             # OAuth、postback 验签、DTO/PII 与 PayPal 幂等
├── payment-workflows.test.ts       # 真实 handler + mock 渠道、捕获/取消、退款重试与手工支付
├── payment-concurrency.test.ts     # 数据库事务屏障，验证捕获/取消两种锁交错
├── refund-fulfillment.test.ts       # 退款取消量/履约并发/回库与安全 DTO
├── order-edit-payments.test.ts      # 活动意图锁快照/改价与意图创建的受控并发
├── pricing-allocation.test.ts       # 分币/大金额/属性样本/免邮阈值与账本一致性
├── default-addresses.test.ts        # 默认地址权限/既有行并发/事务屏障
└── storefront-permissions.test.ts   # 评价 INSERT/再审核/停用分类
```

### 商品域（Shopify 变体模型）
- `categories`（嵌套）/ `products` / `product_options` / `product_option_values`
- `product_variants`（SKU 级价格/划线价/成本价；无选项商品 = 单个默认变体）
- `variant_option_values` / `product_images`
- `locations` + `inventory_levels`：多仓 `on_hand`；新结账流程按活跃 Quote 计算 `reserved/available`
- `product_listing` 视图：列表页专用（价格区间、in_stock 布尔、主图），不泄露库存数和成本价

### 交易域（WooCommerce 式金额结构 + Shopify 式双状态）
- `orders`：`subtotal - discount_total + shipping_total + tax_total = total`
  - `financial_status`（pending/paid/refunded…）与 `fulfillment_status`（unfulfilled/partial/fulfilled）正交
  - 地址/运费/折扣码全部存快照
- `order_items`：商品名/SKU/选项/单价全快照，与商品表解耦
- `addresses` 地址簿 / `shipping_methods`（满额包邮、国家限制）/ `tax_rates`（按国家）
- `discounts`（百分比/定额/免运费，门槛、次数上限、每客限一次）+ `discount_redemptions`
- `fulfillments`：保留兼容 JSON 快照；`commerce.fulfillment_lines` 是关系化履约数量事实
- `payments`：兼容投影；`commerce.payment_intents` + `payment_transactions` 是幂等支付交易账本
- `commerce.payment_provider_events` + `provider_money_movements`：验签后事件收件箱与外部资金事实/对账状态
- `commerce.order_adjustments`：有符号金额调整，数据库持续验证 `subtotal + adjustments = total`
- `commerce.refunds` + `refund_lines`：成功退款事实；`refund_requests` 在渠道确认前预留可退金额/数量
- `commerce.checkout_quotes` + `checkout_quote_lines`：限时库存预占，支付确认后原子转正式扣减
- `order_events`：append-only 业务审计；`commerce.outbox_events` 原子承接外部副作用

### 促销引擎（自动 + 输码，预览即算）
- `promotions`：一张表覆盖全部促销类型，`params` JSONB 承载类型参数
  - `order_percentage` 整单折扣 / `order_fixed` 满减 / `item_percentage` 范围打折或满N件X折
  - `buy_x_get_y` 买一送一（支持“买A送B”跨范围，最便宜件优先免）/ `free_shipping`
  - `code = null` 自动生效；有码 = 输码生效（每客限次、总次数、时间窗）；码统一存大写
  - `priority` 决定求值顺序；`stackable=false` 为独占，生效后阻止后续促销（含免邮促销）
  - 行级折扣钳制：任意促销叠加后单行折扣不超过行金额，杜绝负行额/负税
- 整单折扣使用整数分最大余数法，按剩余净额分摊，余数相同时以变体 UUID 排序；总分摊严格等于目标优惠
- 零收益免邮不占独占资格；可叠加免邮在后续优惠跌破包邮线时可延后生效，但不能与独占商品优惠组合
  - 下单时对涉及的促销行加锁（`for update`），usage_limit / 每客限次并发安全
- `promotion_targets`：作用范围（商品/分类/变体；分类含子分类闭包；空 = 全场）
- `price_checkout` RPC：**预览与下单共用的计价引擎**，返回行级折扣与促销明细
- `order_promotions` 落账快照 + `order_items.discount_total/line_total` 行级分摊（部分退款精度）
- 示例数据：服饰分类8折 / 马克杯满3件7折 / 数据线买一送一（均自动生效）

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

# 订单预览（匿名可用；自动促销+输码促销实时计算，结果与下单严格一致）
POST /rest/v1/rpc/price_checkout
{"items":[{"variant_id":"...","quantity":3}], "discount_code":"WELCOME10"}

# 推荐结账流程：报价即预占 available，不提前扣 on_hand；Quote 默认 15 分钟
POST /rest/v1/rpc/create_checkout_quote
{"idempotency_key":"checkout-attempt-id","items":[...],"address":{...},"ttl_seconds":900}
POST /rest/v1/rpc/create_order_from_quote {"quote_id":"..."}  # 建 pending 订单，继续持有预占
POST /rest/v1/rpc/get_checkout_quote       {"quote_id":"..."}
POST /rest/v1/rpc/get_order_checkout_quote {"order_id":"..."}
POST /rest/v1/rpc/cancel_checkout_quote    {"quote_id":"...","reason":"..."}

# 兼容下单（登录；仍为下单即扣 on_hand，但不能穿透活跃 reservation）
POST /rest/v1/rpc/create_order
{"items":[{"variant_id":"...","quantity":1}],
 "address_id":"...",                  # 或直接传 "address":{...}
 "shipping_method_id":"...",
 "discount_code":"WELCOME10"}
# 不使用 Quote 的兼容集成至少使用幂等 V2；同一语义请求只建一单、只扣一次库存
POST /rest/v1/rpc/create_order_v2
{"idempotency_key":"checkout-attempt-id","items":[...],"address":{...}}

# 地址内容仍可 PATCH；新建地址仍可 POST is_default=true
# 既有地址设置/清除默认必须走 RPC，不再直接 PATCH is_default
POST /rest/v1/rpc/set_default_address {"address_id":"..."}
POST /rest/v1/rpc/set_default_address {"address_id":"...","make_default":false}

# 取消（仅未支付未发货，按原扣减仓回补库存+释放促销+记流水）
POST /rest/v1/rpc/cancel_order {"order_id":"...","reason":"..."}

# 仅 pending + 未发货且无活动支付意图的兼容订单可改地址（自动重算税、重校验运法）
# 本地 Stripe cancelled/failed 还需渠道取消确认；Quote 和已支付订单不可原地重算
POST /rest/v1/rpc/update_order_address {"order_id":"...","address":{...}}

# 管理端（admin）；线上意图仍可扣款时禁止 mark_order_paid，必须先完成渠道撤销/对账
POST /rest/v1/rpc/mark_order_paid      {"order_id":"...","provider":"manual"}
POST /rest/v1/rpc/create_fulfillment   {"order_id":"...","items":[...],"carrier":"顺丰","tracking_number":"..."}
# 后台重试优先使用 V2（幂等键为店铺级）
POST /rest/v1/rpc/create_fulfillment_v2 {"order_id":"...","items":[...],"idempotency_key":"fulfillment-command-id"}
POST /rest/v1/rpc/adjust_inventory     {"variant_id":"...","delta":10,"reason":"restock","note":"补货"}
POST /rest/v1/rpc/moderate_review      {"review_id":"...","status":"approved"}
POST /rest/v1/rpc/set_user_role        {"user_id":"...","role":"admin"}   # 最后一名 admin 不可降级

# Stripe / PayPal 商用退款（admin）：先预留可退额度；仅渠道成功后才落账、改订单和回补库存
POST /functions/v1/stripe-create-refund
POST /functions/v1/paypal-create-refund
Authorization: Bearer <admin-jwt>
{"order_id":"...","idempotency_key":"refund-command-id",
 "items":[{"order_item_id":"...","quantity":1}],"restock":true,"reason":"破损"}

# 手工/测试兼容退款：同步成功，不代表真实渠道已确认
POST /rest/v1/rpc/refund_order {"order_id":"...","items":[{"order_item_id":"...","quantity":1}],
                                "restock":true,"reason":"破损"}
POST /rest/v1/rpc/refund_order_v2 {"order_id":"...","idempotency_key":"manual-refund-id","items":[...]}
# 客户/管理员读取安全交易账本 DTO（只返回订单归属人的账本）
POST /rest/v1/rpc/get_order_ledger     {"order_id":"..."}
# 同样限制归属；返回每行 ordered/fulfilled/cancelled/reserved/available_quantity
POST /rest/v1/rpc/get_order_fulfillment_balance {"order_id":"..."}

# Storefront 创建 Stripe PaymentIntent：网关 + 函数双重校验 JWT，client_secret 不进入数据库
POST /functions/v1/stripe-create-payment-intent
Authorization: Bearer <customer-jwt>
{"order_id":"...","idempotency_key":"payment-attempt-id"}

# Stripe 控制台 Webhook 指向此入口；verify_jwt=false，但函数必须先验 Stripe-Signature
POST /functions/v1/stripe-webhook

# PayPal：创建 Order → 买家批准 → 捕获；两个客户入口均在函数内验证 JWT/订单归属
POST /functions/v1/paypal-create-order  {"order_id":"...","idempotency_key":"payment-attempt-id"}
POST /functions/v1/paypal-capture-order {"payment_intent_id":"..."}
# PayPal App Webhook 指向此入口；函数通过官方 verify-webhook-signature API 验签
POST /functions/v1/paypal-webhook

# 下列 RPC 仅授予 service_role，只供 Edge Function/Worker 调用，禁止发给浏览器
POST /rest/v1/rpc/prepare_paypal_capture {"payment_intent_id":"...","customer_id":"..."}
POST /rest/v1/rpc/ingest_payment_provider_event {...verified-normalized-event...}
POST /rest/v1/rpc/retry_payment_provider_events {"max_events":50}
POST /rest/v1/rpc/claim_outbox_events           {"worker_id":"worker-1","max_events":50,"lease_seconds":300}
POST /rest/v1/rpc/complete_outbox_event         {"event_id":"...","worker_id":"worker-1","succeeded":true}
POST /rest/v1/rpc/expire_checkout_quotes        {"max_quotes":100}
POST /functions/v1/stripe-reconcile-payment-intents {"max_intents":5} # Authorization: service role
POST /functions/v1/paypal-reconcile-refunds      {"max_events":20}  # Authorization: service role

# GDPR 匿名化（admin）：清 profile PII + 删地址簿与 customer 域 metafield；
# 财务记录依法保留，审计 actor 自动置空
POST /rest/v1/rpc/anonymize_user       {"p_user_id":"..."}
```

补充说明：
- `inventory_movements` 只记录 `on_hand` 事实变化；Quote 预占不伪造流水，支付确认时才写 `order` 扣减
- 新 Quote 流程使用 `available = on_hand - active reserved`；V1/V2 兼容下单仍立即扣库存但受 reservation guard 保护
- 按行退款优先取消未履约数量，已发货部分不重复计入取消；pending 退款预留取消量，成功后固化，失败/取消释放
- 可新增履约数量扣除已成功取消和活跃退款预留；全额退款订单不可新增履约，即使退款未指定商品行
- 有按行退款事实/活跃请求的履约不可再取消以释放数量；通过安全 DTO 查询剩余数量，不用原订购量自行推算
- `product_reviews`：每客每商品一条，普通客户 INSERT 只能为 pending；需 admin 审核后公开，作者改内容自动回落待审
- `product_listing.categories` 仅包含启用分类，不通过 owner 权限视图绕过分类可见性
- 分类自连接不支持 PostgREST 内嵌查询，前端拉平铺列表自行组树即可
- 金额口径：`order_items.total` = 行毛额（单价×数量），`line_total` = 行净额（扣行折扣）；
  `orders.discount_total` 只含商品折扣，免运费优惠记于 `order_promotions.amount` 并把
  `shipping_total` 置 0；`payments.amount` 恒正，方向由 `kind`（charge/refund）表达
- `tax_rates.include_shipping` 控制运费是否计入税基（默认否，按需开启）
- admin JWT 与普通用户同属 `authenticated` 数据库角色，状态类写操作一律走
  security definer RPC：orders 表 admin 仅能直改 `admin_note` 列，payments / fulfillments /
  inventory_levels 的写入权限已从客户端角色整体收回；`inventory_movements` 与
  `order_events` 仅受控 RPC 可追加，客户端角色只读且不可改写
- `commerce` schema 不在 PostgREST exposed schemas 中，启用无客户端 policy 的 RLS；Storefront
  只通过显式 JSON DTO 读取。Quote 终态会清除临时地址/备注；已支付订单快照、交易金额、
  Provider Event/外部资金、预占/履约/退款事实和 Outbox payload 不能被客户端原地改写
- Stripe/PayPal 原始事件只用于验签和 SHA-256 审计哈希；数据库仅保存 allowlist 归一化资金字段，
  不保存 card、payer/payee email、customer 对象、OAuth access token 或 `client_secret`

## 安全模型
- 全表 RLS；新表/函数默认不授予客户端权限，Storefront/Admin API 必须显式 allowlist
- 订单只能走 `create_order` / `create_order_v2` RPC 创建（无直插策略，且仅 `authenticated` 可执行）
- Storefront 子资源继承父商品发布状态，草稿商品的变体、图片、选项和 metafield 不可匿名读取
- 客户订单 RPC 返回安全 JSON，不包含 `admin_note`；国家码统一为 ISO 3166-1 alpha-2 大写
- 列级权限：`cost`（成本价）、`admin_note`、`payments.raw`、`profiles.role` 不对客户端暴露
  （admin 面板需要这些字段时走受控后台接口或对应 RPC）
- 精确库存数与库存流水仅 admin 可见，前端用 `product_listing.in_stock`
- 折扣码不公开，验证只在服务端事务内进行
- Google OAuth 默认关闭，Secret 只从环境变量读取；历史中已暴露的凭据必须在 Google Cloud 吊销并轮换
- 设置管理员：`select set_user_role('<user-uuid>', 'admin')`（需已有 admin）或首次用 SQL 直改

## 生产 Stripe 接入
1. 配置 restricted `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、严格布尔 `STRIPE_LIVEMODE`、
   固定 API 版本与 `PAYMENT_ALLOWED_ORIGINS`；完整参数见 [`supabase/functions/README.md`](supabase/functions/README.md)。
2. Storefront 调用 `stripe-create-payment-intent`。Supabase 网关先验 JWT，函数再通过 Auth `/user` 验证，
   数据库最终校验订单归属。Stripe POST 使用本地 intent UUID 作为幂等键；同单只允许一个活跃意图，
   `client_secret` 只在关联、金额、币种、模式和状态均匹配后返回，且绝不入库。
3. 当前 30 分钟以内的库存 hold 默认配置 `STRIPE_ALLOW_REDIRECTS=never`；启用 redirect/长异步支付方式前，
   必须先设计兼容的 reservation 延期、取消和资金晚到对账策略。
4. Stripe Webhook 使用 snapshot events、平台账户 endpoint、未经修改的 raw body、endpoint secret 和 5 分钟验签窗；
   Connect/organization context 会被拒绝。事件先进入不可变 Provider Inbox；Inbox 已持久化后即使业务处理暂时失败也返回 2xx，
   由 `retry_payment_provider_events` 接管，不能依赖 Stripe 事件投递顺序。
5. 成功资金先落外部资金事实，再原子消费 reservation 和推进订单。若资金晚于预占、金额不匹配或内部状态冲突，
   系统生成 `payment.reconciliation_required`，不会丢弃资金事实、伪造库存或错误标记已支付。
6. Stripe 退款先预留可退金额/数量；只有渠道 `succeeded` 才写成功账本和回补库存。除本地 Refund UUID 外，
   还必须核对其父 PaymentIntent/Charge，避免可变 metadata 将真实退款关联到错误订单。
7. 定时 Worker 先调用 `expire_checkout_quotes`，再调用 `stripe-reconcile-payment-intents` 取消浏览器仍可能持有
   `client_secret` 的过期渠道意图；同时运行 `retry_payment_provider_events`、消费 Outbox，并告警失败 Inbox、
   unmatched/action-required money、取消失败和退款延迟。Stripe disputes/chargebacks 与 payout/balance 对账本阶段仍需
   Dashboard 人工监控和 reconciliation；未建专用账本前不要把 dispute 事件订阅到当前入口。
   `mark_order_paid` / `refund_order` 仅用于手工流程和测试；service role、Stripe Secret 与 Webhook Secret 绝不能下发浏览器。

## 生产 PayPal 接入
1. 配置 `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`、跳转 URL 和
   `PAYPAL_LIVEMODE`；完整事件列表见 [`supabase/functions/README.md`](supabase/functions/README.md)。
2. Storefront 调用 `paypal-create-order` 获取可信 approval URL；买家批准后调用
   `paypal-capture-order`。Order ID 绑定内部意图，实际资金账本使用不同的 Capture ID。
   Capture POST 前在数据库持久化捕获请求并锁定取消；结果不明时保留保护，重试先 GET 且复用幂等键。
   Quote 到期仍释放库存；晚到资金进入对账，不通过延长库存 hold 掩盖异常。
3. `paypal-webhook` 使用 OAuth2 和 PayPal 官方 postback API 验证 transmission headers；验签后才写 Inbox。
4. `COMPLETED` Capture 才消费库存；`PENDING` 等待后续事件；`REVERSED` 只记外部资金异常并阻止继续退款，
   不会伪造本地退款或静默改写订单。
5. PayPal 退款走 `paypal-create-refund`。定时调用 service-only `paypal-reconcile-refunds` 轮询 pending refund；
   `PAYMENT.CAPTURE.REFUNDED` 仅作为聚合唤醒信号，最终状态以具体 Refund 资源为准。
6. Webhook Simulator 不能通过 postback 验签，部署前必须使用真实 sandbox 交易演练；商户账户需支持接收 CNY。

## 本批前向迁移注意事项

- 迁移 `20260830130000`–`20260830150000` 只向前升级，**不要重置已有数据库**。安排写入维护窗口，先升级数据库，再启用客户端的新默认地址 RPC 调用。
- 地址直接 PATCH 仅保留内容字段；不可写入 `id`、`customer_id`、时间戳或 `is_default`。后台/service 表写入也应通过 `set_default_address` 切换默认值。
- 新计价规则可能使旧 Quote 转单返回 `pricing changed`，此时需重新报价，不会静默重定价。既有订单/退款金额不会被迁移重写。
- 历史订单与 Stripe 意图金额不一致时，取消 Worker 会回收旧渠道对象；必须先完成渠道撤销/对账，再生成新的支付尝试。
- 历史 approved 评价无法可靠区分真实审核与旧漏洞写入，需单独审计，不会批量降级。
- 直接商品行写入遇到订单锁竞争会返回 409，避免锁反转；交易写入应通过先锁订单的命令完成。

## 开发检查

```bash
bun run test             # reset + 238 个串行 API/handler/并发回归
bun run db:lint          # public API + commerce 账本 schema lint
bun run types:check      # 检查生成类型是否漂移
bun run typecheck        # TypeScript 静态检查
```

生成前端类型：`bun run types:generate`
