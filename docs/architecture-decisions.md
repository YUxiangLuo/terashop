# 商用化架构决策（ADR 汇总）

这些决策用于约束当前增量迁移。若产品边界变化，先更新 ADR，再修改数据库。

## ADR-001：部署模型

**状态：采用（当前阶段）**

一个 Supabase 项目承载一个店铺，不在核心表增加 `store_id`。这能保持交易查询、RLS、
唯一约束和库存锁简单可靠。若产品转为共享数据库的多租户 SaaS，必须在接入首个租户前
单独设计 tenant key、复合唯一键、跨租户 RLS 与运维隔离，不能只给部分表补 `store_id`。

## ADR-002：货币与舍入

**状态：采用（CNY MVP）**

- 当前订单币种为 CNY，账本金额使用 `numeric(12,2)`。
- 每个可落账调整先按两位小数舍入，再汇总；PostgreSQL `round(numeric, 2)` 是当前权威实现。
- V1 整单折扣按各行剩余净额，以整数分最大余数法分摊；先取整除商，再按余数降序、变体 UUID 升序分配剩余分。
  分子使用精确 `numeric` 整数乘法和 `div/mod`，避免 bigint 乘积溢出或除法舍入；分摊合计必须等于目标优惠额。
- 不用浮点数存储或比较金额。
- 引入多币种前，增加 currency exponent/rounding policy，不复用固定两位小数假设。

## ADR-003：已支付订单不可变

**状态：采用，核心保护已落地**

已支付订单的商品、价格、税、运费和地址快照不能原地重算。数据库 trigger 会阻止包括
service role 在内的原地改写；订单行只允许受控退款流程单向推进兼容退款字段。后续变化必须
通过 Order Edit、Adjustment、补扣或退款账本表达，保留原始商业事实和完整审计链。

兼容订单存在活动 PaymentIntent 时，同样锁定商业快照和商品行，禁止修改地址或改价；
已绑定但未确认 Stripe 渠道取消的本地 failed/cancelled 意图也继续保护快照。
地址编辑与新意图创建共用 quote → order 锁，不能先锁 order 再等待 intent；渠道取消确认后才可编辑。
不重写历史错配的意图金额；Stripe 取消 Worker 将金额/币种错配的旧意图纳入回收。
这些订单需先渠道撤销/对账，再重新报价或创建意图。直接商品行写入只以 NOWAIT 获取订单锁，
竞争时返回 409，不能在已持商品行锁的 trigger 中反向等待订单锁。

## ADR-004：库存语义

**状态：采用，新流程已落地，V1 兼容保留**

新 Checkout Quote 流程使用 `on_hand - active reserved = available`：报价时短时预占但不改
`on_hand`，转单后继续持有，支付确认在同一事务中把预占转为正式扣减，取消/超时仅释放预占。
V1/V2 `create_order` 暂时保留“下单即扣库存”，但 inventory trigger 会阻止它消耗活跃预占。
取消/退款继续以原始 `inventory_movements` 为权威回补依据，不能依赖变体当前配置。

按行退款优先取消尚未履约的数量，其余数量属于已履约商品的退款；分别在
`refund_request_lines.cancelled_quantity`（请求时冻结）和 `refund_lines.cancelled_quantity`
（成功事实）记录取消数量。可新履约数量 = 原订购数量 − 活跃履约数量 − 已成功取消数量
− 活跃退款请求预留的取消数量。`get_order_fulfillment_balance` 仅向订单客户、管理员和 service role
返回这些数量，并将不可履约订单的 available 置零。金额型退款不推测商品取消数量，但全额退款订单禁止新增履约。
存在按行退款事实或活跃请求的履约不能再通过取消履约来释放数量，应走退货/新订单流程。
历史退款无法无歧义区分取消和退货，迁移采用未履约优先的保守分配，不修改历史金额、库存或退款数量；
缺少历史关系化退款行的兼容数量也保守计入限制，不能用于重新发货。

## ADR-005：促销 V2

**状态：采用，V1 保留**

V2 管线固定为：条件求值 → 候选生成 → 组合选择 → 行级分摊 → 税 → usage ledger。
发布后的 `promotion_version` 不可变，订单记录实际命中的版本。状态、目标、组合和分摊关系化；
受约束的条件 DSL 与 action 参数使用 JSONB。上线前与 `price_checkout` V1 双算并比较结果。

V1 仍按 priority 贪心选择，不宣称寻找全局最优组合。免邮在其求值位置按已生效商品优惠后的金额
判断是否仍有运费可免；满额包邮已生效时，不占用独占资格。不产生收益的独占免邮被跳过；
最早的可叠加免邮可延后，若后续商品优惠使金额跌破包邮线，则仅在无独占优惠时应用，仍只记一次真实免邮收益。

## ADR-006：API 分层

**状态：采用，迁移中**

物理表和内部函数不作为长期 Storefront 合同。内部交易实现进入 `private` / `commerce`
schema；`public` 目前只保留兼容包装。`commerce` 不对 PostgREST 暴露且不授予客户端物理表权限，
订单交易账本通过显式 JSON DTO 读取。
目标仍是暴露 `api`（Storefront）与 `admin_api`（后台）DTO/RPC，显式选择字段并版本化。

## ADR-007：税务范围

**状态：采用（有限 MVP）**

当前只支持按 ISO 国家码配置单一有效比例税率，可选择运费计税；这不是全球税务合规引擎。
在进入需要州/省、邮编、VAT、免税资格或含税定价的市场前，接入专业税务服务或建设独立
Tax Quote/Tax Transaction 模块。不得把当前 `tax_rates` 宣称为全球合规能力。

## ADR-008：交易账本与兼容双写

**状态：采用，V2 基础已落地**

`orders` / `payments` / `fulfillments.items` / `order_items.refunded_*` 暂时保留为兼容模型；新交易在
同一数据库事务内双写到 `commerce.order_adjustments`、`payment_intents`、`payment_transactions`、
`fulfillment_lines`、`refunds` 和 `refund_lines`；渠道退款在成功账本之前先进入可变状态受限的
`refund_requests`。核心账本行 append-only，外键使用
`ON DELETE RESTRICT`，历史支付和履约在前向 migration 中回填。兼容字段只能在受控 RPC 中推进，不允许
把双写拆成两个网络请求。订单创建、履约和退款保留 V1 兼容入口，并新增带请求指纹及事务内
幂等记录的 V2 入口；可重试的新集成必须优先使用 V2。

## ADR-009：支付信任边界与事务 Outbox

**状态：采用，Stripe 与 PayPal 适配已落地**

支付创建/捕获和 Outbox worker RPC 只授予 `service_role`。Storefront 不持有 service role；Stripe
客户/管理员命令由 Edge 网关先验 JWT，函数再通过 Auth `/user` 校验。Stripe Webhook 对 raw body 做
HMAC-SHA256 验签，PayPal Webhook 使用 OAuth2 调官方 `verify-webhook-signature` postback 验证
transmission headers；两者都只在验签后用 provider event id 推进数据库。库存预占消费、订单状态、交易、
审计事件和 Outbox 在同一事务提交。同一订单最多一个活跃 PaymentIntent，避免多个可确认支付对象造成
重复扣款；Stripe 失败换卡复用意图，PayPal Capture
declined 后终结当前意图并允许创建新 Order。其他渠道仍需独立验签与字段归一化适配器。

PayPal Edge 发出 Capture POST 前，必须调用 service-only `prepare_paypal_capture`，按
intent → quote → order 顺序校验归属、应付金额、订单及预占状态，并持久化捕获请求时间。
登记后普通取消不能与渠道捕获竞争；网络错误不清除此标记，同一个意图 UUID 继续作为渠道幂等键，
重试先查询渠道资源。Quote 到期仍允许释放库存和取消订单，不无限延长 hold；晚到资金继续进入对账。
无 Quote 的兼容订单遇到结果不明的捕获，需重试或渠道核对后恢复，不自动猜测失败。

`mark_order_paid` 不得取消仍可扣款的 Stripe/PayPal 意图再手工收款；只有线上意图已终结才允许执行。
本地 cancelled/failed 不等于 Stripe 渠道已终结，撤销 Worker 同样扫描这些历史意图及已不应付款的订单。

## ADR-010：Checkout Quote 的价格与预占边界

**状态：采用，已落地**

Quote 预占库存但不提前占用促销 usage。转单时按固定锁顺序重新锁库存与有限促销并再次计价；
只有完整 pricing hash 一致才创建订单，否则要求客户端生成新 Quote。Quote 默认 15 分钟、最长
30 分钟，每客户最多 5 个活跃 Quote，每次最多 50 行/100 件；账号与 IP 级滥用防护仍应由 Edge
限流承担。支付确认消费预占，定时 worker 释放超时 Quote 并取消未支付订单。Quote 进入 completed、
cancelled 或 expired 后立即清除临时地址和备注，长期交易快照只保留在订单中。

## ADR-011：渠道事件、外部资金事实与异步退款

**状态：采用，Stripe 与 PayPal 已落地**

验签后的事件先进入幂等 Provider Event Inbox；数据库只保存 raw payload 的 SHA-256 和 allowlist
归一化字段，不持久化 card/customer/payer/payee email、OAuth access token 或 client secret。渠道已成功的 capture/refund
必须先写不可删除的 `provider_money_movements`，再匹配内部交易。若金额不一致、订单已取消或库存
预占已失效，不得丢弃渠道资金事实，也不得伪造库存扣减；标记 `action_required` 并写事务 Outbox
等待补偿退款或人工履约。即使渠道事件币种超出当前 CNY 结账能力，只要它代表真实成功资金也先作为
unmatched 外部事实保存；Stripe 同时保存 provider minor units、Stripe charge exponent 与精确 major amount，
避免零小数币种误算。这不等于允许创建非 CNY 订单。

Stripe snapshot Webhook 不允许 Connect/organization context。事件可能重复和乱序；处理器按事件
`occurred_at` 拒绝旧的非资金事件回退新状态，而成功资金始终优先持久化。可信 API 路径绑定的 provider
reference 优先于可变 metadata；仅有 metadata 的早到事件不得绑定本地意图/退款，只先记 unmatched 并等待绑定后重试。
Inbox 行一旦持久化，即使业务处理因锁竞争暂时失败也向 Stripe 返回 2xx，由 service-only retry worker 恢复。
短库存 hold 默认禁用 redirect 支付方式；Quote/订单过期后，租约 worker 还必须用稳定幂等键取消 Stripe
PaymentIntent，防止浏览器保存的 `client_secret` 在本地取消后继续付款。若取消与成功竞态，则仍按真实成功资金
入 Inbox/reconciliation。开放长异步支付前必须另行定义 reservation 延期与资金晚到策略。

Stripe API 的 Refund 对象没有 `livemode` 字段；API 响应的模式来自已校验的密钥配置，
Webhook 的模式来自已验签的事件 envelope。绑定退款引用不得将 processing/requires_action 回退为
submitted，终态由 Provider Inbox 推进。

真实渠道退款采用两阶段：`refund_requests` 先以关系化行预留可退数量和金额，渠道确认前不修改订单、
库存或成功退款账本；只有签名 Webhook/API 响应确认 `succeeded` 后，才在单事务写 payment/refund、
推进订单并按原始负库存流水回补。`failed`/`cancelled` 请求释放预留。Stripe Refund 的 metadata 可变，
因此本地 Refund UUID 不能作为唯一关联依据，还必须匹配原捕获的 PaymentIntent/Charge；成功但关联冲突的
外部退款先记资金事实并进入 reconciliation。同步 `refund_order` 只保留给手工流程和测试，且不能穿透
活跃异步退款请求。

PayPal Order ID 代表买家批准对象，Capture ID 才代表实际资金，因此内部 PaymentIntent 保留 Order ID，
成功交易和外部资金事实使用 Capture ID。只有 `COMPLETED` Capture 才消费库存；`PENDING` 等后续事件。
`PAYMENT.CAPTURE.REVERSED` 记录不可删除的外部退款方向资金异常、触发人工对账并阻止该 Capture 继续退款；
即使 reversal 先于 completed 乱序到达，也不消费库存或把订单标记已支付，但不会静默伪造本地退款。
PayPal pending Refund 由 service-only worker 查询具体 Refund 资源；
`PAYMENT.CAPTURE.REFUNDED` 只作为聚合轮询信号，不能据此猜测某个部分退款已经完成。轮询候选通过
`FOR UPDATE SKIP LOCKED` 公平 claim，并设置最短重查间隔，避免并发重复查询和老请求饿死新请求。

Stripe disputes/chargebacks、Stripe payout/balance reconciliation 与 PayPal disputes 暂不自动化，统一由渠道
Dashboard 人工监控并进入 reconciliation。没有专用争议/结算账本前，不把这些事件接入会误写退款或库存的自动状态机。

## ADR-012：客户写入权限与默认地址

**状态：采用**

普通客户 INSERT 评价必须为 pending；只有管理员审核后才公开，管理员的受权写入不受客户 policy 限制。
不批量撤销历史已批准评价，因无法可靠区分真实审核与旧漏洞写入，历史数据需另行审计。

既有地址切换默认值必须调用 `set_default_address`，先取得客户 advisory lock，再锁目标地址并清理旧默认。
保留创建地址时 `is_default=true` 的兼容 INSERT，但此路径也必须在更新任何旧地址前取锁。
客户端只可直接修改内容字段；身份/归属不可变，默认值切换不允许直接 PATCH，包括 service-role 表写入。
`make_default=false` 可清除指定地址的默认值；数据库唯一索引继续保证每客户最多一个默认地址，
清除/删除默认地址允许留下零个，不自动挑选其他地址。

owner 权限的 `product_listing` 视图必须显式过滤停用分类；Metaobject definition 停用是否隐藏子对象仍待产品确认，不在本批改动。
