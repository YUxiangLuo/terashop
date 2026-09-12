# 支付与部署

客户调用方式见 [API 速查](../../docs/api.md)，交易/锁/退款不变量见 [ADR](../../docs/architecture-decisions.md)。本页只维护渠道配置与运行步骤。

## 环境与认证

以 [`.env.example`](../../.env.example) 为模板，通过 `supabase secrets set` 配置所用渠道的环境变量，不提交实际密钥。
Edge Runtime 需提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。
生产设置 `PAYMENT_ALLOWED_ORIGINS` 为商城与后台的精确 Origin 列表；任何 service role、渠道或 Webhook Secret 都不能下发浏览器。

| 入口 | 认证 |
| --- | --- |
| PayPal 创建 / 捕获 / 退款 | handler 验证用户 JWT，数据库校验归属/管理员 |
| `paypal-webhook` | 不验证 JWT；通过官方 postback API 验证 transmission headers |
| `paypal-reconcile-refunds` | handler 校验 service-role token |

部署使用仓库的 `supabase/config.toml`。网关 JWT 校验关闭不代表匿名授权：用户、Worker 和 Webhook 各自在 handler 内完成认证。
本地 Auth 配置便于测试，生产需另行审查邮箱确认、密码策略、MFA、业务限流和允许的跳转地址。
Google OAuth 启用前必须吊销并轮换历史已暴露凭据。

## PayPal Orders v2 / Payments v2

必填：`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`；创建 Order 还需 `PAYPAL_RETURN_URL` 和 `PAYPAL_CANCEL_URL`（生产 HTTPS）。
生产显式设置 `PAYPAL_LIVEMODE=true`；`PAYPAL_BRAND_NAME` 可选。`PAYPAL_API_BASE` 生产留空，由模式选择官方地址。结账统一使用 USD，商户账户须具备对应收款能力。
地址映射为通用 `recipient_name` / `line1` / `line2` / `city` / `region` / `postal_code` / `country`，不推断国家或强制所有地区填写城市、州及邮编；渠道的额外地区要求仍需满足。

Webhook 指向 `/functions/v1/paypal-webhook`，订阅：

```text
PAYMENT.CAPTURE.COMPLETED
PAYMENT.CAPTURE.PENDING
PAYMENT.CAPTURE.DECLINED
PAYMENT.CAPTURE.REFUNDED
PAYMENT.CAPTURE.REVERSED
PAYMENT.REFUND.PENDING
PAYMENT.REFUND.FAILED
```

Order ID 与实际资金 Capture ID 不同。Capture POST 前必须持久化 `prepare_paypal_capture`；重试先 GET，再复用本地意图 UUID 作为 `PayPal-Request-Id`，网络错误不清除捕获保护。
`PAYMENT.CAPTURE.REFUNDED` 仅唤醒轮询，具体退款终态以 Refund 资源为准。
Refund POST 前必须持久化 `prepare_paypal_refund`；发出后即使未绑定 ID，也不得无渠道确认取消或释放退款额度。原键重试保留同一请求 UUID，已绑定时只 GET 已知 Refund；未绑定终态在 POST 前拒绝。
退款校验已绑定 Refund ID、可选 `custom_id` 与父 Capture 引用；API 重试不回退 processing 或终态。HTTP 请求禁止重定向；401 最多刷新 token 后重试一次，其他失败交由原幂等命令重试。
Webhook 入箱后处理失败返回 500；已识别的瞬时数据库故障保留为 received / transient_database_error 并确认收件，按 `next_attempt_at` 退避后由 Inbox Worker 重试。即便渠道停止重试，也必须能恢复本地入账。
使用真实 Sandbox 交易演练：Webhook Simulator 不能通过 postback 验签。

参考：[Orders v2](https://developer.paypal.com/docs/api/orders/v2/)、[Payments v2](https://developer.paypal.com/docs/api/payments/v2/)、[官方 Payments OpenAPI](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payment_v2.json)、[事件列表](https://developer.paypal.com/api/rest/webhooks/event-names/)、[postback 验签](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post/)。

## 必需 Worker 与告警

仓库提供以下入口；**调度及通用 Outbox 消费器需部署方实现**。RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`。
全部为 POST，使用 `Authorization: Bearer <service-role-key>`；PostgREST 另需 `apikey`。

| 任务 | 请求体 | 调度 |
| --- | --- | --- |
| RPC `expire_checkout_quotes` | `{"max_quotes":100}` | 每分钟，释放 Quote 预占 |
| RPC `expire_unpaid_orders` | `{"max_orders":100}` | 每分钟，取消即时扣库路径的过期未付款订单并回库 |
| RPC `retry_payment_provider_events` | `{"max_events":50}` | 持续定时运行 |
| Edge `paypal-reconcile-refunds` | `{"max_events":20}` | 每分钟；同一请求最短轮询间隔 5 分钟 |
| RPC `claim_outbox_events` | `{"worker_id":"worker-1","max_events":50,"lease_seconds":300}` | 循环领取，副作用消费者必须幂等 |
| RPC `complete_outbox_event` | `{"event_id":"<uuid>","worker_id":"worker-1","lease_token":"<claim 返回的 uuid>","succeeded":true}` | 消费后确认；失败传 false 与 `error_message` |

两个过期 RPC 都必须调度，各自独立事务调用，不能包装在同一个 SQL 事务内；每次最多处理 500 个对象，并使用 SKIP LOCKED。未付款窗口到期前普通取消仍受不明 Capture 保护，到期 Worker 释放库存不代表渠道资金已失败，迟到成功继续进入对账。
Outbox claim 返回 `attempt`、`lease_token` 和 `lease_expires_at`；过期、旧 token、错误 owner 的 complete 返回 false。处理时长超过租约需调整下次领取配置；相同 worker_id 不能替代租约 token，消费者仍须按 event_id 幂等。

关注 `payment.reconciliation_required`、`paypal.refund_reconciliation_requested`，告警失败/重试耗尽的 Inbox、Outbox、unmatched / action-required 资金和退款延迟。
不明 Capture / Refund 必须重试或对账；不得先手工收款或重新申请退款再猜测线上资金结果。未绑定且发出超过一小时的退款会停止 POST 重试，额度继续保留；需人工核实渠道结果，再用可信 Refund ID 绑定并 GET 恢复，不能换新键盲退。上线仍须核实真实渠道的幂等保留期。
PayPal disputes、chargebacks 及 payout/balance reconciliation 仍需 Dashboard 人工监控；未建专用账本前不要把争议事件接入自动退款/库存流程。

## 开发与发布验证

项目尚未部署，数据库改动通过修改基线并重建本地环境验证，见 [数据库开发](../../docs/database.md)。不维护旧 schema 或旧 handler 的升级兼容。
首次发布时先初始化完整数据库，再部署匹配的函数与客户端；确认 Worker 已调度，完成真实渠道 Sandbox、JWT/验签和故障恢复演练。
此后才固定已发布迁移并设计生产升级顺序。测试命令见 [项目 README](../../README.md)。
