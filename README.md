# tera-headless — Headless 电商后端（Supabase）

面向商用的 headless 电商后端，参考 WooCommerce 的功能覆盖面与 Shopify 的扩展体系设计。
当前已完成订单生命周期、关键完整性加固，以及 Adjustment / Payment Transaction / Refund Line /
Fulfillment Line 关系化账本和事务 Outbox。数据库已提供 service-only Payment Intent 幂等捕获入口；
支付渠道验签 Edge Function、库存预占和稳定 API schema 仍在演进中，浏览器端不得直接调用支付服务 RPC。

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
└── 20260830060000_transaction_ledgers.sql # 关系化账本/幂等命令/Payment Intent/Outbox

tests/                              # bun test，共 137 例
├── helpers.ts                      # API/RPC/认证/库存 辅助函数
├── catalog.test.ts                 # 商品目录与视图
├── orders.test.ts                  # 下单金额/折扣/运费/税/取消/RLS
├── admin.test.ts                   # 履约/支付标记/库存管理/权限边界
├── extensions.test.ts              # Metafield/Metaobject/评价审核流
├── promotions.test.ts              # 促销引擎（预览/四类促销/叠加互斥/落账）
├── fixes.test.ts                   # 审查修复回归（钳制/并发/退款/权限/匿名化）
├── critical-integrity.test.ts      # 资金/履约/库存/RLS/并发攻击性回归
└── transaction-ledgers.test.ts     # Adjustment/支付意图/交易/退款行/履约行/Outbox
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
- `fulfillments`：保留兼容 JSON 快照；`commerce.fulfillment_lines` 是关系化履约数量事实
- `payments`：兼容投影；`commerce.payment_intents` + `payment_transactions` 是幂等支付交易账本
- `commerce.order_adjustments`：有符号金额调整，数据库持续验证 `subtotal + adjustments = total`
- `commerce.refunds` + `refund_lines`：退款头、行级金额/数量及实际回补数量
- `order_events`：append-only 业务审计；`commerce.outbox_events` 原子承接外部副作用

### 促销引擎（自动 + 输码，预览即算）
- `promotions`：一张表覆盖全部促销类型，`params` JSONB 承载类型参数
  - `order_percentage` 整单折扣 / `order_fixed` 满减 / `item_percentage` 范围打折或满N件X折
  - `buy_x_get_y` 买一送一（支持“买A送B”跨范围，最便宜件优先免）/ `free_shipping`
  - `code = null` 自动生效；有码 = 输码生效（每客限次、总次数、时间窗）；码统一存大写
  - `priority` 决定求值顺序；`stackable=false` 为独占，生效后阻止后续促销（含免邮促销）
  - 行级折扣钳制：任意促销叠加后单行折扣不超过行金额，杜绝负行额/负税
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

# 下单（登录；价格服务端计算，超卖/折扣/运费/税全自动）
POST /rest/v1/rpc/create_order
{"items":[{"variant_id":"...","quantity":1}],
 "address_id":"...",                  # 或直接传 "address":{...}
 "shipping_method_id":"...",
 "discount_code":"WELCOME10"}
# 新集成使用幂等 V2；同一用户 + idempotency_key + 同一语义请求只建一单、只扣一次库存
POST /rest/v1/rpc/create_order_v2
{"idempotency_key":"checkout-attempt-id","items":[...],"address":{...}}

# 取消（仅未支付未发货，按原扣减仓回补库存+释放促销+记流水）
POST /rest/v1/rpc/cancel_order {"order_id":"...","reason":"..."}

# 仅 pending + 未发货订单可修改地址（自动重算税、重校验运法国家限制）
# 已支付订单必须等待 Order Edit / Adjustment 流程，不允许原地改价
POST /rest/v1/rpc/update_order_address {"order_id":"...","address":{...}}

# 管理端（admin）
POST /rest/v1/rpc/mark_order_paid      {"order_id":"...","provider":"manual"}
POST /rest/v1/rpc/create_fulfillment   {"order_id":"...","items":[...],"carrier":"顺丰","tracking_number":"..."}
# 后台重试优先使用 V2（幂等键为店铺级）
POST /rest/v1/rpc/create_fulfillment_v2 {"order_id":"...","items":[...],"idempotency_key":"fulfillment-command-id"}
POST /rest/v1/rpc/adjust_inventory     {"variant_id":"...","delta":10,"reason":"restock","note":"补货"}
POST /rest/v1/rpc/moderate_review      {"review_id":"...","status":"approved"}
POST /rest/v1/rpc/set_user_role        {"user_id":"...","role":"admin"}   # 最后一名 admin 不可降级

# 退款（admin）：按行退 / 自定义金额 / 全额退剩余，三选一
POST /rest/v1/rpc/refund_order {"order_id":"...","items":[{"order_item_id":"...","quantity":1}],
                                "restock":true,"reason":"破损"}
POST /rest/v1/rpc/refund_order {"order_id":"..."}                            # 全额退剩余
# 可重试后台任务使用幂等 V2，避免重复退款/重复回补
POST /rest/v1/rpc/refund_order_v2 {"order_id":"...","idempotency_key":"refund-command-id","items":[...]}
# 客户/管理员读取安全交易账本 DTO（只返回订单归属人的账本）
POST /rest/v1/rpc/get_order_ledger     {"order_id":"..."}

# 下列 RPC 仅授予 service_role，必须由验签后的 Edge Function/Worker 调用，禁止发给浏览器
POST /rest/v1/rpc/create_payment_intent  {"order_id":"...","provider":"stripe","idempotency_key":"..."}
POST /rest/v1/rpc/capture_payment_intent {"payment_intent_id":"...","provider_reference":"...","idempotency_key":"webhook-event-id"}
POST /rest/v1/rpc/claim_outbox_events    {"worker_id":"worker-1","max_events":50,"lease_seconds":300}
POST /rest/v1/rpc/complete_outbox_event  {"event_id":"...","worker_id":"worker-1","succeeded":true}

# GDPR 匿名化（admin）：清 profile PII + 删地址簿与 customer 域 metafield；
# 财务记录依法保留，审计 actor 自动置空
POST /rest/v1/rpc/anonymize_user       {"p_user_id":"..."}
```

补充说明：
- `inventory_movements` 记录每笔库存变动（下单/取消/补货/调整/退货），含变动后结存与仓位
- `product_reviews`：每客每商品一条，需 admin 审核后公开；作者改内容自动回落待审
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
  只通过显式 JSON DTO 读取。已支付订单快照、交易金额、履约行、退款行和 Outbox payload
  即使使用 service role 也不能原地改写或删除

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

## 生产支付接入（数据库基础已落地，渠道适配待实现）
1. Edge Function 用 service role 调用 `create_payment_intent`，幂等键重复提交返回同一意图。
2. 只有验签成功的支付渠道 Webhook 才调用 `capture_payment_intent`；数据库原子写兼容 payment、
   capture transaction、订单财务状态、审计事件和 Outbox，重复 webhook 不会重复收款。
3. Worker 通过 `claim_outbox_events` 的 `FOR UPDATE SKIP LOCKED` 租约消费外部副作用，并用
   `complete_outbox_event` 确认或退避重试。
4. 渠道退款意图/异步确认状态机仍待实现；当前 `mark_order_paid` / `refund_order` 仅用于手工流程和测试。
5. service role 是最高信任凭据，绝不能下发到 Storefront、移动端或其他不可信客户端。

## 开发检查

```bash
bun run test             # reset + 137 个串行 API/并发回归
bun run db:lint          # public API schema lint
bun run types:check      # 检查生成类型是否漂移
bun run typecheck        # TypeScript 静态检查
```

生成前端类型：`bun run types:generate`
