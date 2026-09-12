# 架构决策

本文维护当前业务不变量；调用示例见 [API](api.md)，schema 组织见 [数据库开发](database.md)，渠道配置与 Worker 见 [支付与部署](../supabase/functions/README.md)。
项目尚未部署，不维护历史 schema/API 兼容承诺。开发期直接修改基线并重建本地数据库；改变业务规则时同步更新本文与回归测试。

## ADR-001：部署模型

一个 Supabase 项目承载一个店铺，核心表不增加 `store_id`，以简化交易查询、唯一约束、RLS 和库存锁。
共享数据库多租户不在当前范围；引入前须完整设计 tenant key、复合唯一键、跨租户 RLS 和运维隔离，不能只给部分表补列。

## ADR-002：货币与舍入

- 商品、运费、固定金额促销及交易统一使用 USD；数据库约束内部订单与资金账本的币种，Edge 不能单独承担该校验。金额使用 `numeric(12,2)`，不以浮点数存储或比较。
- 每个调整先用 PostgreSQL `round(numeric, 2)` 舍入再汇总。
- 整单优惠按行剩余净额，以整数分最大余数法分摊；余数降序、变体 UUID 升序打破平局，合计严格等于目标优惠。
- 分子使用精确 `numeric` 整数乘法与 `div/mod`，避免 bigint 溢出和除法舍入；行优惠不得超过行毛额。
- 两位小数和整数美分是明确的 USD 合同，不是通用币种算法。当前不提供多币种、价格表切换或自动汇兑；真实非 USD 外部资金仍单独记录并对账，不能冒充 USD 结算。

## ADR-003：订单快照不可变

已支付订单的商品、价格、税、运费和地址快照不可原地重算，trigger 同样约束 service role；退款字段仅由受控流程单向推进。
后续商业变更必须由 Order Edit、Adjustment、补扣或退款事实表达，而不是覆盖原始记录。

活动 PaymentIntent 同样锁定未支付订单的商业快照；已绑定、但未确认 Stripe 渠道取消的本地 failed/cancelled 意图也继续保护快照。
金额/币种错配的意图由取消 Worker 回收并对账，不改写意图金额来掩盖错配。
地址编辑与意图创建共用 quote → order 锁；结算使用 intent → quote → order，不能先锁 order 再等待 intent。
直接商品行写入只以 NOWAIT 获取订单锁，竞争时返回 409，避免在已持商品行锁时反向等待订单锁。

## ADR-004：库存与履约数量

Quote 流程采用 `on_hand - active reserved = available`：报价预占、转单继续持有，支付成功时在同一事务中转为实际扣减；取消/超时仅释放预占。
`create_order` / `create_order_v2` 当前仍提供下单即扣库存的路径，但 inventory trigger 不允许其消耗 Quote 预占。
`inventory_movements` 只记录真实 on_hand 变化；取消/退款以原始负流水为回补依据，不依赖变体当前的库存配置。

按行退款优先取消未履约数量，分别在 `refund_request_lines.cancelled_quantity` 预留、`refund_lines.cancelled_quantity` 固化。
可新履约数量 = 订购数量 − 活跃履约数量 − 已成功取消数量 − 活跃退款请求预留的取消数量。
`get_order_fulfillment_balance` 向订单客户、管理员和 service role 返回安全数量 DTO；不可履约订单的 available 为零。
金额型退款不推测商品取消量，但全额退款订单禁止新增履约；存在按行退款事实或活跃请求的履约不能再通过取消履约释放数量，应走退货/新订单流程。

## ADR-005：促销计算

当前引擎按 priority 贪心选择，不寻找全局最优组合；条件与 action 参数保存在受校验的 JSONB 中，目标范围支持商品、变体及分类闭包。
免邮只记录实际收益：已满额包邮时不占独占资格，零收益独占免邮被跳过；最早的可叠加免邮可在后续优惠使金额跌破包邮线时延后生效，但不能穿透独占商品优惠。

版本化促销管线是后续设计，不是已实现能力：条件求值 → 候选生成 → 组合选择 → 行级分摊 → 税 → usage ledger。
届时发布版本不可变，订单记录实际命中版本，状态/目标/组合/分摊关系化，条件 DSL 和 action 参数保留 JSONB；替换当前引擎前须双算验证。

## ADR-006：API 与权限

`public` 暴露部分业务表与 RPC，`private` 存放内部函数，`commerce` 保存交易事实且不对 PostgREST 暴露。
表启用 RLS，新对象默认不授予客户端权限；显式 DTO 选择字段，内部表不是长期 Storefront 合同。`api` / `admin_api` 分层仍是演进目标。
管理员与客户同属 `authenticated` 角色；订单状态、支付、履约和库存写入必须走受控命令，不能依靠客户端区分管理员。

## ADR-007：税务范围

当前按两位国家码选择单一有效比例税率，`include_shipping` 控制运费计税；国家码统一为大写。不内置任何国家的税率，seed 不安装税务规则。
地址缺失的商品预估不计算目的地税；正式报价和下单必须提供国家。没有匹配规则时返回零税额，只是当前计算结果，不表示当地免税或已完成税务合规，部署前必须配置适用规则。
州/省、邮编、VAT、免税资格、含税定价及全球税务合规不在范围内，需要专业服务或独立 Tax Quote / Tax Transaction 模块。

## ADR-008：交易账本与投影同步

当前写入模型包含 `orders`、`payments`、`fulfillments.items`、`order_items.refunded_*`；同一事务同步关系化的
`order_adjustments`、`payment_intents`、`payment_transactions`、`fulfillment_lines`、`refunds` 和 `refund_lines`。
渠道退款先进入状态受限的 `refund_requests`，成功后才写成功账本。
核心账本 append-only，外键采用 `ON DELETE RESTRICT`；不得把模型/账本同步拆成两个网络请求。
订单、履约和手工退款的 `*_v2` 命令通过请求指纹与事务内幂等记录支持重试；基础入口仍被命令链使用，不能只删除包装而不调整调用关系。

## ADR-009：支付信任边界与 Outbox

支付创建/捕获和 Worker RPC 仅授予 service role，浏览器不得持有该凭据。
客户/管理员 Edge 入口通过 Auth `/user` 验证身份，Stripe 另有网关 JWT 验证；数据库最终检查归属/管理员。
Stripe 对 raw body 做 HMAC-SHA256 验签；PayPal 通过 OAuth2 调官方 postback API 验证 transmission headers；验签后才能入箱。
库存消费、订单状态、交易、审计和 Outbox 在同一事务提交；同一订单最多一个活跃 PaymentIntent。
Stripe 换卡复用意图，PayPal Capture declined 后终结当前意图并允许新建 Order。

PayPal Capture POST 前必须调用 `prepare_paypal_capture`，按 intent → quote → order 顺序复核归属、金额、订单及预占，并持久化捕获标记。
普通取消不能穿透该标记，网络错误不清除它；重试先查询渠道，再复用原意图 UUID 作为幂等键。
Quote 到期仍可释放库存并取消订单，不无限延长 hold；无 Quote 的不明捕获需显式重试/对账，不猜测失败。
`mark_order_paid` 不得先取消仍能扣款的线上意图再手工收款；本地终态不等于渠道终态，撤销 Worker 也扫描不可支付订单上的意图。

## ADR-010：Quote 的价格与预占边界

Quote 不提前占用促销 usage；转单时按固定锁顺序锁库存与有限促销，再次计价，只有完整 pricing hash 一致才创建订单，否则重新报价。
默认 15 分钟、最长 30 分钟，每客户最多 5 个活跃 Quote，每次最多 50 行/100 件；账号/IP 级滥用防护仍需 Edge 限流。
支付成功消费预占，Worker 处理超时订单；Quote 进入 completed/cancelled/expired 时清除临时地址和备注，长期快照仅保留在订单。

## ADR-011：渠道事件、外部资金与异步退款

Inbox 只保存原始事件的 SHA-256 与 allowlist 归一化字段，不保存 card/customer/payer/payee email、OAuth token 或 `client_secret`。
真实成功 capture/refund 先写不可删除的 `provider_money_movements`，再匹配内部交易；金额冲突、订单取消或预占失效时标记 `action_required` 并写 Outbox，不能丢弃资金、伪造库存或静默复活订单。
超出 USD 结账能力的成功资金仍作为 unmatched 外部事实保存；Stripe 另存 minor units、charge exponent 和精确 major amount，避免零小数币种误算。

### Stripe

- 只接受平台账户 snapshot Webhook，不支持 Connect / organization context。
- 按 `occurred_at` 阻止旧非资金事件回退新状态，成功资金始终优先持久化。
- 可信 API 绑定的 provider reference 优先于可变 metadata；仅有 metadata 的早到事件先 unmatched，绑定后重试，不能自动绑定本地对象。
- Inbox 持久化后即使业务处理失败仍向 Stripe 返回 2xx，由重试 Worker 恢复。
- Quote/订单过期后还须以稳定幂等键取消渠道 PaymentIntent；取消与成功竞态仍按真实资金入箱。短 hold 默认禁用 redirect；开放长异步支付前须另定预占与晚到资金策略。
- Refund API 没有 `livemode`，模式来自已校验密钥；Webhook 模式来自已验签 envelope。绑定退款不回退 processing/requires_action，终态由 Inbox 推进。
- 退款除本地 UUID 外还必须核对父 PaymentIntent / Charge；成功但关联冲突的退款先记资金事实再对账。

### PayPal

Order ID 是批准对象，Capture ID 才是资金引用；只有 COMPLETED 消费库存，PENDING 等后续事件。
REVERSED 记录外部退款方向异常、阻止继续退款并触发对账；即使先于 completed 到达，也不消费库存、标记已支付或伪造本地退款。
pending Refund 由 Worker 查询具体资源，`PAYMENT.CAPTURE.REFUNDED` 仅作聚合唤醒信号；候选用 `SKIP LOCKED` 公平领取并设置最短重查间隔。

### 退款与未自动化范围

退款请求先预留金额/数量，渠道成功后才在单事务写成功账本、更新订单并按原扣减仓回库；failed/cancelled 释放预留。
同步 `refund_order` 仅用于手工/测试流程，不能穿透活跃渠道退款请求。
Stripe disputes/chargebacks、payout/balance reconciliation 与 PayPal disputes 仍需 Dashboard 人工监控；没有专用账本前不接入自动退款/库存状态机。

## ADR-012：客户写入与默认地址

收货地址使用 `recipient_name`、`line1`、`line2`、`city`、`region`、`postal_code`、`country`、`phone`；仅姓名、第一地址行和国家在订单中必填，其余字段按地区/渠道需要填写。地址簿与直接地址快照使用同一解析入口，不默认为 CN 或 US。
普通客户只能创建 pending 评价，管理员审核后公开；作者修改内容自动回落待审，管理员受权写入不受客户 policy 限制。
默认地址命令先取客户 advisory lock，再锁目标地址并清理旧默认；创建地址时传 `is_default=true` 也遵守该锁顺序。
客户端仅可 PATCH 地址内容，身份/归属不可变，既有默认值切换必须走 `set_default_address`，service-role 表写入也不能绕过。
唯一索引保证每客户最多一个默认地址；`make_default=false` 或删除允许留下零个，不自动另选。
owner 权限的 `product_listing` 必须显式过滤停用分类；Metaobject definition 停用是否隐藏子对象仍待产品确认。
