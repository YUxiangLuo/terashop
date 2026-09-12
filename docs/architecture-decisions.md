# 架构决策

本文维护当前业务不变量；调用示例见 [API](api.md)，schema 组织见 [数据库开发](database.md)，渠道配置与 Worker 见 [支付与部署](../supabase/functions/README.md)。
项目尚未部署，不维护历史 schema/API 兼容承诺。开发期直接修改基线并重建本地数据库；改变业务规则时同步更新本文与回归测试。

## ADR-001：部署模型

一个 Supabase 项目承载一个店铺，核心表不增加 `store_id`，以简化交易查询、唯一约束、RLS 和库存锁。
共享数据库多租户不在当前范围；引入前须完整设计 tenant key、复合唯一键、跨租户 RLS 和运维隔离，不能只给部分表补列。

## ADR-002：货币与舍入

- 商品、运费、固定金额促销及交易统一使用 USD；数据库约束内部订单与资金账本的币种，Edge 不能单独承担该校验。金额使用 `numeric(12,2)`，不以浮点数存储或比较。
- 所有业务 numeric 列显式排除 NaN / ±Infinity；促销 JSON 的金额、百分比和门槛同样要求有限值，不能把精度或非负 CHECK 当作有限值校验。
- 每个调整先用 PostgreSQL `round(numeric, 2)` 舍入再汇总。
- 整单优惠按剩余净额，以整数分最大余数法先分摊到变体，再分摊到该变体的商业行；余数降序，以变体 UUID / `line_key` 升序打破各层平局，合计严格等于目标优惠。
- 分子使用精确 `numeric` 整数乘法与 `div/mod`，避免 bigint 溢出和除法舍入；行优惠不得超过行毛额。
- 两位小数和整数美分是明确的 USD 合同，不是通用币种算法。当前不提供多币种、价格表切换或自动汇兑；真实非 USD 外部资金仍单独记录并对账，不能冒充 USD 结算。

## ADR-003：订单快照不可变

已支付订单的商品、价格、税、运费和地址快照不可原地重算，trigger 同样约束 service role；退款字段仅由受控流程单向推进。
后续商业变更必须由 Order Edit、Adjustment、补扣或退款事实表达，而不是覆盖原始记录。
所有订单（包括非 Quote 订单）必须有商品行；行毛额等于单价 × 数量，订单 subtotal / discount_total 等于行汇总。延迟约束在提交时校验，允许同一事务先头后行构建，但不允许分两个 HTTP 请求留下不完整订单；账本 `is_balanced` 也检查头行一致性。

活动 PaymentIntent 同样锁定未支付订单的商业快照。
金额/币种错配的资金进入对账，不改写意图金额来掩盖错配。
地址编辑与意图创建共用 quote → order 锁；结算使用 intent → quote → order，不能先锁 order 再等待 intent。
直接商品行写入只以 NOWAIT 获取订单锁，竞争时返回 409，避免在已持商品行锁时反向等待订单锁。

## ADR-004：库存与履约数量

Quote 流程采用 `on_hand - active reserved = available`：报价预占、转单继续持有，支付成功时在同一事务中转为实际扣减；取消/超时仅释放预占。
`create_order` / `create_order_v2` 保留下单即扣库存的路径，但不能消耗 Quote 预占；付款窗口固定 15 分钟，到期由 `expire_unpaid_orders` 按原仓释放库存。订单及意图的付款期限不可延长，Quote 转单沿用报价期限。
`inventory_movements` 只记录真实 on_hand 变化；取消/退款以原始负流水为回补依据，不依赖变体当前的库存配置。所有订单必须先付款再履约，避免未付款却已出库的订单无法安全过期。

库存统一按 `(variant_id, location_id)` 取锁；退款/取消在分摊前锁全部原库存，过期 Worker 锁整个批次，不能仅对每个订单单独排序。结账的变体锁使用 `NO KEY UPDATE`，避免与库存流水 FK 的 `KEY SHARE` 形成反向等待。Quote 与即时订单过期 Worker 分别调用，不能在同一事务中先锁库存再取得 Quote 锁。

按行退款优先取消未履约数量，分别在 `refund_request_lines.cancelled_quantity` 预留、`refund_lines.cancelled_quantity` 固化。
可新履约数量 = 订购数量 − 活跃履约数量 − 已成功取消数量 − 活跃退款请求预留的取消数量。
`get_order_fulfillment_balance` 向订单客户、管理员和 service role 返回安全数量 DTO；不可履约订单的 available 为零。
金额型退款不推测商品取消量，但全额退款订单禁止新增履约；存在按行退款事实或活跃请求的履约不能再通过取消履约释放数量，应走退货/新订单流程。

## ADR-005：促销计算

当前引擎按 priority 贪心选择，不寻找全局最优组合；条件与 action 参数保存在受校验的 JSONB 中，目标范围支持商品、变体及分类闭包。
商品百分比和买赠先按变体聚合数量/剩余额度确定收益，再分摊到商业行；整单优惠同样先分摊到变体。客户可控属性和商业拆行不得放大舍入优惠，也不能改变后续促销的 SKU 级可用额度。
免邮只记录实际收益：已满额包邮时不占独占资格，零收益独占免邮被跳过；最早的可叠加免邮可在后续优惠使金额跌破包邮线时延后生效，但不能穿透独占商品优惠。

当前已保存实际应用顺序、规则/目标快照与关系化分摊；它们不是可编辑促销的发布版本。
版本化发布、候选组合选择和条件 DSL 仍是后续设计，不是已实现能力；替换当前贪心引擎前须双算验证。

## ADR-006：API 与权限

`public` 暴露部分业务表与 RPC，`private` 存放内部函数及目录树同步哨兵，`commerce` 保存交易事实且不对 PostgREST 暴露。
表启用 RLS，新对象默认不授予客户端权限；已有对象也按表/列列举 SELECT / INSERT / UPDATE / DELETE 授权，anon/authenticated 不得拥有 TRUNCATE / TRIGGER / REFERENCES / MAINTAIN 或序列权限。显式 DTO 选择字段，内部表不是长期 Storefront 合同。`api` / `admin_api` 分层仍是演进目标。
管理员与客户同属 `authenticated` 角色；订单状态、支付、履约和库存写入必须走受控命令，不能依靠客户端区分管理员。

## ADR-007：税务范围

当前按两位国家码选择单一有效比例税率，国家规则优先于 wildcard `*`，`include_shipping` 控制运费计税；国家码统一为大写。不内置任何国家的税率，seed 不安装税务规则。
地址缺失的商品预估不计算目的地税；正式报价和下单必须提供国家。没有匹配规则时返回零税额，只是当前计算结果，不表示当地免税或已完成税务合规，部署前必须配置适用规则。
计算状态、规则、基数和实际分摊保存在交易快照中；零税率与未匹配规则分别表达，不从金额零推断免税资格。
州/省、邮编、VAT、免税资格、含税定价及全球税务合规不在范围内，需要专业服务或独立 Tax Quote / Tax Transaction 模块。

## ADR-008：交易账本与投影同步

当前写入模型包含 `orders`、`payments`、`fulfillments.items`、`order_items.refunded_*`；同一事务同步关系化的
`order_adjustments`、`payment_intents`、`payment_transactions`、`fulfillment_lines`、`refunds`、`refund_lines` 和退款金额组件。
渠道退款先进入状态受限的 `refund_requests`，成功后才写成功账本。
核心账本 append-only，外键采用 `ON DELETE RESTRICT`；不得把模型/账本同步拆成两个网络请求。
订单、履约和手工退款的 `*_v2` 命令通过请求指纹与事务内幂等记录支持重试；基础入口仍被命令链使用，不能只删除包装而不调整调用关系。

## ADR-009：支付信任边界与 Outbox

支付创建/捕获和 Worker RPC 仅授予 service role，浏览器不得持有该凭据。
客户/管理员 Edge 入口通过 Auth `/user` 验证身份；数据库最终检查归属/管理员。
PayPal 通过 OAuth2 调官方 postback API 验证 transmission headers；验签后才能入箱。
库存消费、订单状态、交易、审计和 Outbox 在同一事务提交；同一订单最多一个活跃 PaymentIntent。
PayPal Capture declined 后终结当前意图并允许新建 Order。客户端 PaymentIntent 幂等键按 `(order_id, provider, idempotency_key)` 隔离；渠道仍使用本地意图 UUID，不直接复用客户提供的键。

Outbox 存储每次领取确定的 `lease_expires_at` 与随机 `lease_token`。重领不能用新调用者的 lease_seconds 缩短旧期限；complete 必须同时匹配 event、worker、token 且未过期。消费者仍须幂等，租约 fencing 不提供外部副作用的 exactly-once。

PayPal Capture POST 前必须调用 `prepare_paypal_capture`，按 intent → quote → order 顺序复核归属、金额、订单及预占，并持久化捕获标记。
普通取消不能穿透该标记，网络错误不清除它；重试先查询渠道，再复用原意图 UUID 作为幂等键。
Quote 或即时订单到期仍可释放库存并取消订单，不无限延长 hold；这不意味着未知 Capture 已失败，迟到成功资金只入对账，不复活订单或再次扣库存。
`mark_order_paid` 不得先取消仍能扣款的线上意图再手工收款；不明 Capture 保留保护，已终结失败的 Capture 才允许新支付尝试。

## ADR-010：Quote 的价格与预占边界

Quote 不提前占用促销 usage；转单时按固定锁顺序锁库存与有限促销，再次计价，只有完整 pricing hash 一致才创建订单，否则重新报价。
Quote 默认 15 分钟、最长 30 分钟。三个客户建单/报价入口共享每次最多 50 行/100 件、每客户最多 5 个活跃 checkout（未转单 Quote + 未过期未付款订单）的限制；客户级 advisory lock 串行化配额检查，转单/幂等重试不重复占名额。账号/IP 级滥用防护仍需 Edge 限流。
支付成功消费预占，Worker 处理超时订单；Quote 进入 completed/cancelled/expired 时清除临时地址和备注，长期地址/备注快照仅保留在订单。商业行属性仍随不可变的报价/订单明细保留，不属于该临时 PII 清理范围。

## ADR-011：渠道事件、外部资金与异步退款

Inbox 只保存原始事件的 SHA-256 与 allowlist 归一化字段，不保存 customer/payer/payee email 或 OAuth token。
真实成功 capture/refund 先写不可删除的 `provider_money_movements`，再匹配内部交易；金额冲突、订单取消或预占失效时标记 `action_required` 并写 Outbox，不能丢弃资金、伪造库存或静默复活订单。
超出 USD 结账能力的成功资金仍按 PayPal 返回的十进制金额保存并对账，不能推进 USD 订单。
`40P01` / `40001` / `55P03` 等瞬时数据库错误不等同商业冲突：保留资金事实，将 Inbox 留在 received / transient_database_error，按 `next_attempt_at` 指数退避重试本地入账（2–256 秒，Worker 自动重试最多处理 25 次），不重复发出渠道收退款；重试耗尽必须告警。

### PayPal

PayPal 是唯一线上渠道，数据库约束意图、Inbox、渠道资金和异步退款的 provider；保留管理员手工收付款账本。
只用 API 绑定的 Order / Refund ID 或已入账 Capture 匹配本地对象，不能靠可变 metadata 自动绑定；早到事件先 unmatched，绑定后由 Worker 重试。
Refund API 的 `custom_id` 可缺省，已绑定 ID 和存在的父 Capture 引用必须匹配；金额/币种错配和 Webhook 父引用冲突先保存成功资金，再对账，不能提前回库。

Order ID 是批准对象，Capture ID 才是资金引用；只有 COMPLETED 消费库存，PENDING 等后续事件。
REVERSED 记录外部退款方向异常、阻止继续退款并触发对账；即使先于 completed 到达，也不消费库存、标记已支付或伪造本地退款。
pending Refund 由 Worker 查询具体资源，`PAYMENT.CAPTURE.REFUNDED` 仅作聚合唤醒信号；候选用 `SKIP LOCKED` 公平领取并设置最短重查间隔。

### 退款与未自动化范围

退款请求先预留金额/数量，渠道成功后才在单事务写成功账本、更新订单并按原扣减仓回库；failed/cancelled 释放预留。
Refund POST 前必须调用 service-only `prepare_paypal_refund`，重新检查管理员及请求状态并持久化不可清除的发出标记。已发出但未绑定不等于未退款：不明网络结果保留额度，同键重试使用原请求 UUID；取消必须先取得可信渠道终态确认。未绑定的终态请求禁止 POST，已绑定重试仅 GET 已知 Refund。未绑定且发出超过一小时的请求停止 POST 重试并保留预留，必须通过可信渠道查询/绑定后恢复；这是本店保守重试窗口，不假定 PayPal 幂等键无限期有效。
同步 `refund_order` 仅用于手工/测试流程，不能穿透活跃渠道退款请求。
PayPal disputes、chargebacks 及 payout/balance reconciliation 仍需 Dashboard 人工监控；没有专用账本前不接入自动退款/库存状态机。

## ADR-012：客户写入与默认地址

收货地址使用 `recipient_name`、`line1`、`line2`、`city`、`region`、`postal_code`、`country`、`phone`；仅姓名、第一地址行和国家在订单中必填，其余字段按地区/渠道需要填写。地址簿与直接地址快照使用同一解析入口，不默认为 CN 或 US。
普通客户只能创建 pending 评价，管理员审核后公开；作者修改内容自动回落待审，管理员受权写入不受客户 policy 限制。
默认地址命令先取客户 advisory lock，再锁目标地址并清理旧默认；创建地址时传 `is_default=true` 也遵守该锁顺序。
客户端仅可 PATCH 地址内容，身份/归属不可变，既有默认值切换必须走 `set_default_address`，service-role 表写入也不能绕过。
唯一索引保证每客户最多一个默认地址；`make_default=false` 或删除允许留下零个，不自动另选。
owner 权限的 `product_listing` 必须显式过滤停用分类；Metaobject definition 停用是否隐藏子对象仍待产品确认。

## ADR-013：目录完整性与发布

任何状态均禁止跨商品选项、同一变体同一选项多值、图片关联其他商品的变体。商品及子资源身份/归属不可迁移；分类树禁止任意长度的环。
草稿可分步构建；发布商品至少有一个变体，启用变体必须选全该商品的规格且组合唯一；无选项商品最多一个启用默认变体。停用变体不要求完整/唯一，重新启用时校验；所有变体停用可保留商品，但不可购买。
延迟约束在提交时检查最终状态，允许原子互换规格；多个 HTTP 请求不能留下不完整的已发布目录，需先转草稿。
子资源 INSERT 的父资源必须在当前事务可见；不能先跳过不可见父商品的锁，再依靠外键等待另一个连接提交。结构写入以所属商品行的 `NO KEY UPDATE NOWAIT` 锁及非键更新时间写入串行化，避免子行 → 发布者反向等待；价格更新不参加结构串行化。真实行版本变化保证 REPEATABLE READ 旧快照报 `40001`，而不是漏检并发组合。
分类结构编辑通过事务 advisory try-lock 和 `private.category_tree_guard` 单行写冲突串行化；该表启用 RLS，不向客户端或 service role 授权。并发 `55P03` / `40001` 重试整笔事务，不能关闭触发器。当前按受影响商品检查，尚未做大批量目录导入性能验证。

## ADR-014：商业行与库存身份分离

`attributes` 是受大小限制的文本对象，与目录规格 `options` 分开；它不是价格、税率或业务授权。`line_key = SHA-256(variant UUID + ':' + canonical JSON attributes)`，仅相同变体/属性合并数量；所有价格/报价/建单入口共用规范化，未知输入字段与伪造 key 拒绝。
Quote 行有独立 UUID，转单沿用为订单行 UUID；数据库生成 `line_key` 并以 `(quote_id/order_id, line_key)` 保证唯一。无变体的受信订单行以自身 UUID 为 key 的身份源，客户结账仍必须指定变体。支付保护涵盖属性及 key 的来源字段；不得在 BEFORE trigger 中比较尚未重算的生成列。
库存需求、预占和扣减始终按 `(variant_id, location_id)` 汇总；履约/退款仍按订单行 UUID 独立处理。报价消费逐行核对 ID、属性与完整商业快照，不能仅验证相同 SKU 的数量总和。
稳定 key 不等于稳定金额：数量、价格、促销等变化仍参加请求/报价 hash。商业行属性会长期保留，不替代数据保留策略；持久 Cart、收费配置、购买计划、套装及退货物流尚未实现。

## ADR-015：定价事实与退款组成

订单头是明细的守恒汇总，不新增第二套应收金额。商品折扣分摊、税行、配送毛额/减免/净额采用关系表，促销应用保存规则参数、目标与顺序快照；初始 `order_adjustments` 是同一组头部金额的摘要，不再重复累计这些明细。当前只有一条配送收费和一个国家级比例税率。
Quote 保存受校验且参与 pricing hash 的报价 JSON；转单用商业行 UUID 落关系明细。税务上下文记录 `not_calculated` / `no_rule` / `calculated`，受信无税订单可为 `unrecorded`。命中规则后先按 SKU/配送、再按商业行用最大余数分配整数分，SKU 级结果不受客户拆属性影响。
提交时校验目标/促销/头部优惠守恒、配送恒等式、税基/规则/税额守恒和跨单归属。支付意图与定价明细写入都产生父订单行版本冲突，NOWAIT 防止明细→订单反向等待；REPEATABLE READ 旧快照不能绕过付款快照保护。被历史明细引用的运法/税率/促销只停用，不删除；已支付明细不随配置变化。

按数量退款的商品净额保留在现有退款行中，对应税自动生成组件；配送净额需显式选择，并退对应配送税。税/运费组件引用原订单事实，不参考当前目录或税配置。纯金额/剩余金额退款标记 `unallocated`，不猜商品数量或税/配送归属。
手工和异步请求共用退款计划：各组件按比例舍入、钳制余额，最后一份吸收余数；预留计入数量、净额、税和配送容量。请求 INSERT 持父订单锁并真实写行版本，数据库检查 Capture 已退款和活跃预留总额，包括受信写入与旧快照。失败/取消释放整套预留，渠道成功将原请求分摊固化，逆序完成不重新计价。
退款行净额 + 税/配送/未分配组件 = 退款头 = 资金退款；完整组成在提交时校验，组件 append-only。零总额不是资金退款，不通过虚构零金额支付实现收货/回库。Refund 仍不等于 Return/Receipt，税明细也不是法定税务发票或合规认证。
