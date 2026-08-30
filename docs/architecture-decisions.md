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
- 不用浮点数存储或比较金额。
- 引入多币种前，增加 currency exponent/rounding policy，不复用固定两位小数假设。

## ADR-003：已支付订单不可变

**状态：采用，核心保护已落地**

已支付订单的商品、价格、税、运费和地址快照不能原地重算。数据库 trigger 会阻止包括
service role 在内的原地改写；订单行只允许受控退款流程单向推进兼容退款字段。后续变化必须
通过 Order Edit、Adjustment、补扣或退款账本表达，保留原始商业事实和完整审计链。

## ADR-004：库存语义

**状态：目标已采用，迁移中**

目标模型为 `on_hand - reserved = available`：checkout 创建短时 reservation，支付确认后转为
正式扣减，超时/失败释放预占。当前 V1 仍在创建待支付订单时直接扣 `on_hand`；在 reservation
上线前，取消/退款必须以原始 `inventory_movements` 为权威回补依据，不能依赖变体当前配置。

## ADR-005：促销 V2

**状态：采用，V1 保留**

V2 管线固定为：条件求值 → 候选生成 → 组合选择 → 行级分摊 → 税 → usage ledger。
发布后的 `promotion_version` 不可变，订单记录实际命中的版本。状态、目标、组合和分摊关系化；
受约束的条件 DSL 与 action 参数使用 JSONB。上线前与 `price_checkout` V1 双算并比较结果。

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
`fulfillment_lines`、`refunds` 和 `refund_lines`。核心账本行 append-only，外键使用
`ON DELETE RESTRICT`，历史支付和履约在前向 migration 中回填。兼容字段只能在受控 RPC 中推进，不允许
把双写拆成两个网络请求。订单创建、履约和退款保留 V1 兼容入口，并新增带请求指纹及事务内
幂等记录的 V2 入口；可重试的新集成必须优先使用 V2。

## ADR-009：支付信任边界与事务 Outbox

**状态：采用，数据库基础已落地**

支付创建/捕获和 Outbox worker RPC 只授予 `service_role`。Storefront 不持有 service role；渠道
Webhook 必须先在 Edge Function 验签，再用 provider event id 作为幂等键推进数据库。订单状态、
交易、审计事件和 Outbox 在同一事务提交，邮件、渠道回调、物流等外部副作用由 worker 使用
`FOR UPDATE SKIP LOCKED` 租约消费。数据库入口已落地，具体 Stripe/PayPal 验签适配器仍待实现。
