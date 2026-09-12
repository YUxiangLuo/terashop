# 支付与部署

客户调用方式见 [API 速查](../../docs/api.md)，交易/锁/退款不变量见 [ADR](../../docs/architecture-decisions.md)。本页只维护渠道配置与运行步骤。

## 环境与认证

以 [`.env.example`](../../.env.example) 为模板，通过 `supabase secrets set` 配置所用渠道的环境变量，不提交实际密钥。
Edge Runtime 需提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。
生产设置 `PAYMENT_ALLOWED_ORIGINS` 为商城与后台的精确 Origin 列表；任何 service role、渠道或 Webhook Secret 都不能下发浏览器。

| 入口 | 认证 |
| --- | --- |
| Stripe 创建意图 / 退款 | 网关 `verify_jwt=true`，handler 再通过 Auth `/user` 校验；数据库校验归属/管理员 |
| PayPal 创建 / 捕获 / 退款 | handler 验证用户 JWT，数据库校验归属/管理员 |
| `stripe-webhook` | 不验证 JWT；对未经修改的 raw body 验证 `Stripe-Signature` |
| `paypal-webhook` | 不验证 JWT；通过官方 postback API 验证 transmission headers |
| 两个对账 Edge Functions | handler 校验 service-role token |

部署使用仓库的 `supabase/config.toml`，不要用统一的 `--no-verify-jwt` 覆盖各入口设置。
本地 Auth 配置便于测试，生产需另行审查邮箱确认、密码策略、MFA、业务限流和允许的跳转地址。
Google OAuth 启用前必须吊销并轮换历史已暴露凭据。

## Stripe

必填：`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`；生产显式设置 `STRIPE_LIVEMODE=true`，密钥模式必须匹配。
优先使用仅授予所需 PaymentIntent / Refund 读写权限的 restricted key，不使用 publishable key 作为服务端密钥。

| 参数 | 默认值 / 限制 |
| --- | --- |
| `STRIPE_API_VERSION` | `2026-02-25.clover`；Webhook 配置相同的 snapshot API 版本 |
| `STRIPE_WEBHOOK_SECRETS` | 可选，轮换期间的旧 Secret，以逗号分隔；主 Secret 仍必填 |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | 300；范围 30–900 |
| `STRIPE_HTTP_TIMEOUT_MS` | 10000；范围 1000–20000 |
| `STRIPE_ALLOW_REDIRECTS` | `never`；启用 `always` 前必须设计长异步支付的预占和取消策略 |
| `STRIPE_API_BASE` | 生产留空；仅测试模式允许本地 mock |

Webhook 指向 `/functions/v1/stripe-webhook`，使用平台账户 snapshot events，不使用 thin events 或 Connect / organization context。订阅：

```text
payment_intent.processing
payment_intent.requires_action
payment_intent.payment_failed
payment_intent.succeeded
payment_intent.canceled
refund.created
refund.updated
refund.failed
```

Inbox 持久化后业务处理暂时失败仍返回 2xx，必须由重试 Worker 恢复。
安全的网络/409/429 重试复用原幂等键；收到 POST 5xx 后留给调用方通过本地幂等命令重试。
Refund API 对象没有 `livemode`，模式来自已校验的密钥；成功退款还必须匹配父 PaymentIntent / Charge，不能仅信任 metadata。

参考：[PaymentIntents](https://docs.stripe.com/api/payment_intents)、[验签](https://docs.stripe.com/webhooks/signature)、[事件顺序](https://docs.stripe.com/webhooks)、[幂等](https://docs.stripe.com/api/idempotent_requests)、[取消](https://docs.stripe.com/api/payment_intents/cancel)、[币种](https://docs.stripe.com/currencies)、[退款事件](https://docs.stripe.com/api/events/types)。

## PayPal Orders v2 / Payments v2

必填：`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`；创建 Order 还需 `PAYPAL_RETURN_URL` 和 `PAYPAL_CANCEL_URL`（生产 HTTPS）。
生产显式设置 `PAYPAL_LIVEMODE=true`；`PAYPAL_BRAND_NAME` 可选。`PAYPAL_API_BASE` 生产留空，由模式选择官方地址。商户账户必须支持接收 CNY。

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
使用真实 Sandbox 交易演练：Webhook Simulator 不能通过 postback 验签。

参考：[Orders v2](https://developer.paypal.com/docs/api/orders/v2/)、[Payments v2](https://developer.paypal.com/docs/api/payments/v2/)、[事件列表](https://developer.paypal.com/api/rest/webhooks/event-names/)、[postback 验签](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post/)。

## 必需 Worker 与告警

仓库提供以下入口；**调度及通用 Outbox 消费器需部署方实现**。RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`。
全部为 POST，使用 `Authorization: Bearer <service-role-key>`；PostgREST 另需 `apikey`。

| 任务 | 请求体 | 调度 |
| --- | --- | --- |
| RPC `expire_checkout_quotes` | `{"max_quotes":100}` | 每分钟，先执行 |
| Edge `stripe-reconcile-payment-intents` | `{"max_intents":5}` | 过期任务之后；取消过期、本地终态、不可支付或金额错配的渠道意图 |
| RPC `retry_payment_provider_events` | `{"max_events":50}` | 持续定时运行 |
| Edge `paypal-reconcile-refunds` | `{"max_events":20}` | 每分钟；同一请求最短轮询间隔 5 分钟 |
| RPC `claim_outbox_events` | `{"worker_id":"worker-1","max_events":50,"lease_seconds":300}` | 循环领取，副作用消费者必须幂等 |
| RPC `complete_outbox_event` | `{"event_id":"<uuid>","worker_id":"worker-1","succeeded":true}` | 消费后确认；失败传 false 与 `error_message` |

关注 `payment.reconciliation_required`、`stripe.payment_intent_cancel_failed`、`paypal.refund_reconciliation_requested`，告警失败/重试耗尽的 Inbox、Outbox、unmatched / action-required 资金和退款延迟。
本地 failed/cancelled 不等于渠道无法扣款；不得先手工收款再猜测线上资金结果。
Stripe disputes/chargebacks、payout/balance reconciliation 和 PayPal disputes 仍需 Dashboard 人工监控；未建专用账本前不要把争议事件接入自动退款/库存流程。

## 开发与发布验证

项目尚未部署，数据库改动通过修改基线并重建本地环境验证，见 [数据库开发](../../docs/database.md)。不维护旧 schema 或旧 handler 的升级兼容。
首次发布时先初始化完整数据库，再部署匹配的函数与客户端；确认 Worker 已调度，完成真实渠道 Sandbox、JWT/验签和故障恢复演练。
此后才固定已发布迁移并设计生产升级顺序。测试命令见 [项目 README](../../README.md)。
