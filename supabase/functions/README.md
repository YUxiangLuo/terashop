# 支付与部署

本页维护渠道配置、部署安全、Worker 和人工恢复。请求参数见 [API 使用参考](../../docs/api.md#支付与退款)，交易不变量见 [ADR](../../docs/architecture-decisions.md)，浏览器 SDK 与 Sandbox 清单见 [前台接入](../../docs/storefront-paypal.md)。

## 私有媒体通路

`managed-media` 使用运行时 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`，无需支付渠道配置。`verify_jwt=false` 仅关闭网关旧式校验；handler 经 Auth 验证用户 JWT，service-only `managed_media_command` 再校验非匿名管理员 actor。MCP 不持有 service key。生产部署须包含此函数及 SQL/Storage 基线；禁止客户端直调该 RPC 或写入 `media-staging`、`catalog-media/managed/` 命名空间。

仅接受无 Origin 的 POST JSON（最大 1,400,000 bytes）：`action=upload` 带 `request_id,content_type,data_base64`；`get/recover/publish/discard` 仅带 `media_id`。未知字段拒绝，不接收 URL、文件路径、actor 或客户端摘要。上传仅允许 1 byte–1 MiB JPEG/PNG/WebP；MIME/摘要核验不等于图片解码或内容安全扫描。输出仅含 `id,request_id,state,content_type,byte_size,sha256,published`，无私有读取 URL。MCP 在 `published=true` 时从配置 origin 构造公开 URL。

先分配记录、写入私有对象并核验，再标记 staged；发布先提交永久 retained，再写公开对象、核验并标记 published。所有写入不可覆盖且不自动重试。未知结果先保留原身份并读取；分配响应丢失可明确使用同 request_id 和相同内容重放上传。发布与商品/分类关联不是一个事务，关联仍使用原版本化命令。discard 仅冻结 staged，不调用 Storage DELETE。旧公开媒体永不导入此通路，物理删除、signed preview 和大文件传输仍未实现。

## 环境与认证

以 [`.env.example`](../../.env.example) 的服务端支付分组为模板，通过 `supabase secrets set` 配置所用渠道的变量，不提交实际密钥，也不要上传包含前台/OAuth 配置的整个模板。
Edge Runtime 需提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。
生产设置 `PAYMENT_ALLOWED_ORIGINS` 为商城与后台的精确 Origin 列表；任何 service role、渠道或 Webhook Secret 都不能下发浏览器。

| 入口 | 认证 |
| --- | --- |
| `paypal-client-token` | handler 验证用户 JWT；卡开关控制，域名由服务器配置 |
| PayPal 创建 / 捕获 / 退款 | handler 验证用户 JWT，数据库校验归属/管理员 |
| `paypal-webhook` | 不验证 JWT；通过官方 postback API 验证 transmission headers |
| `paypal-reconcile-refunds` | handler 校验 service-role token |
| `paypal-reconcile-captures` | handler 校验 service-role token；只查询已发起 Capture，不扣款 |

部署使用仓库的 `supabase/config.toml`。网关 JWT 校验关闭不代表匿名授权：用户、Worker 和 Webhook 各自在 handler 内完成认证。
本地 Auth 配置便于测试，生产需另行审查邮箱确认、密码策略、MFA、业务限流和允许的跳转地址。
本地已启用 Mailpit、邮箱确认和 manual linking，游客通过 Auth 原生邮箱绑定验证后设置密码，不增加注册 Edge Function。生产开放该入口前须配置并验证 SMTP 和回调地址；不能用关闭邮箱确认或管理员代确认替代。Mailpit 只捕获本地邮件且包含登录凭据，不向公网暴露；测试覆盖与待补事项见[测试指南](../../docs/testing.md)。
Google OAuth 启用前必须吊销并轮换历史已暴露凭据。

匿名用户使用同样的 JWT 认证，不接受 Cart token 代替；身份及 actor 映射见 [ADR-009](../../docs/architecture-decisions.md#adr-009支付信任边界与-outbox)。本地已启用 `enable_anonymous_sign_ins`；Auth 配置变更须重启本项目本地 Supabase，db reset 不重新加载配置。生产启用匿名登录时必须同时配置 CAPTCHA（客户端传 captchaToken）、匿名注册 IP 限流及覆盖直连 RPC 的业务限流；每 Customer 配额不能阻止批量新建身份。
匿名页面/凭据响应禁止共享缓存；持久化并刷新会话，丢失后没有邮件查单或自动恢复接口。上线前制定匿名 Auth 清理期限与执行任务，不能直接按创建时间删除仍需付款、退款重试或售后访问的会话；Auth 删除仅解除 Customer 关联，不可级联清商业记录。目前仓库没有自动匿名 Auth 清理 Worker。
Cart 的创建/读取/编辑/预览可由游客调用；上线前在覆盖直接 PostgREST RPC 的网关施加 IP/行为限流、请求大小与超时限制，不仅保护 BFF。凭据必须从 URL、日志和埋点排除；cookie/BFF 接入须配置 HTTPS、HttpOnly/SameSite 和 CSRF 防护。仓库未实现这些部署层控制。

## PayPal Orders v2 / Payments v2

必填：`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID`；创建 Order 还需 `PAYPAL_RETURN_URL` 和 `PAYPAL_CANCEL_URL`（生产 HTTPS）。
生产显式设置 `PAYPAL_LIVEMODE=true`；`PAYPAL_BRAND_NAME` 可选。`PAYPAL_API_BASE` 生产留空，由模式选择官方地址。结账统一使用 USD，商户账户须具备对应收款能力。
回调 URL 必须对应实际部署的页面；当前示例 storefront 尚无这些路由，模板中的 URL 仅为占位。地址字段见 [地址合同](../../docs/api.md#地址合同)，并须满足渠道的额外地区要求。

站内卡支付默认关闭。商户获批 Expanded Checkout 并通过 Sandbox 验收后，设置 `PAYPAL_CARDS_ENABLED=true`、`PAYPAL_STOREFRONT_DOMAIN` 为实际 Storefront hostname（不带协议、端口或路径），部署 `paypal-client-token` 与匹配的 create/capture handler。浏览器仅获得域绑定的 SDK v6 client token；服务端 OAuth token 不下发。网关须对这些接口按 IP/用户限流；仓库没有分布式限流实现。关闭卡开关停止签发 token、新建卡 Order 和新卡 Capture，但不阻断已发生资金的入账与对账。3DS 策略见 [ADR](../../docs/architecture-decisions.md#服务端卡认证策略)。

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

部署时必须使用配套数据库和 handler：Capture/Refund 的发出保护及资源关联见 [ADR-009/011](../../docs/architecture-decisions.md#adr-009支付信任边界与-outbox)，退款金额与回库合同见 [API](../../docs/api.md#支付与退款)。运维不得绕过保护重发扣款、释放不明退款额度或把退款当作实收退货。
`PAYMENT.CAPTURE.REFUNDED` 携带 Refund 资源，按退款 ID 和 `links.up` 的 Capture ID 保存资金事实；未绑定本地请求时进入待关联/对账，不猜商品取消量。渠道 HTTP 禁止重定向；401 最多刷新 token 重试一次，其他失败由原幂等命令恢复。
Postback 验签保留原始事件 JSON 表示；解析对象仅用于业务归一化。创建 Order、Capture、Refund 的渠道键分别为 `ord_`、`cap_`、`ref_` 加相应去连字符 UUID。当前未部署基线统一采用此合同；已有在途渠道请求不得在升级时换键重发。
Webhook 入箱后处理失败返回 500；已识别的瞬时数据库故障保留为 received / transient_database_error 并确认收件，按 `next_attempt_at` 退避后由 Inbox Worker 重试。即便渠道停止重试，也必须能恢复本地入账。
使用真实 Sandbox 交易演练：Webhook Simulator 不能通过 postback 验签。

参考：[Orders v2](https://developer.paypal.com/docs/api/orders/v2/)、[Payments v2](https://developer.paypal.com/docs/api/payments/v2/)、[官方 Payments OpenAPI](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payment_v2.json)、[事件列表](https://developer.paypal.com/api/rest/webhooks/event-names/)、[postback 验签](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post/)。

## 必需 Worker 与告警

仓库提供以下入口；**调度及通用 Outbox 消费器需部署方实现**。RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`。
下表均给出 service 调用方式：POST，使用 `Authorization: Bearer <service-role-key>`；PostgREST 另需 `apikey`。Outbox 人工重投另支持管理员 JWT，见恢复流程。

| 任务 | 请求体 | 调度 |
| --- | --- | --- |
| RPC `expire_checkout_quotes` | `{"max_quotes":100}` | 每分钟，释放 Quote 预占并取消关联的未付款订单，覆盖所有下单入口 |
| RPC `purge_expired_carts` | `{"max_carts":100}` | 定时循环清理过期 Cart/行；返回删除数量，上限 500 |
| RPC `retry_payment_provider_events` | `{"max_events":50}` | 持续定时运行 |
| Edge `paypal-reconcile-refunds` | `{"max_events":20}` | 每分钟；同一请求最短轮询间隔 5 分钟 |
| Edge `paypal-reconcile-captures` | `{"max_events":20}` | 每分钟；同一意图最短轮询间隔 5 分钟，只 GET Order |
| RPC `claim_outbox_events` | `{"worker_id":"worker-1","max_events":50,"lease_seconds":300}` | 循环领取，副作用消费者必须幂等 |
| RPC `complete_outbox_event` | `{"event_id":"<uuid>","worker_id":"worker-1","lease_token":"<claim 返回的 uuid>","succeeded":true}` | 消费后确认；失败传 false 与 `error_message` |
| RPC `redrive_outbox_event` | `{"event_id":"<uuid>","expected_attempt":25,"worker_id":"operator-1","reason":"依赖已恢复，工单号…"}` | 人工确认原因并排除故障后重投；不自动无限重试 |

交易过期只需调度 `expire_checkout_quotes`，每次最多处理 500 个对象，使用 SKIP LOCKED；旧 `expire_unpaid_orders` 已移除。未付款窗口到期前普通取消仍受不明 Capture 保护，到期 Worker 释放预占不代表渠道资金已失败，迟到成功继续进入对账。

### Capture 查询恢复

Capture Worker 通过 service-only `list_pending_paypal_captures({"max_requests":20})` 领取已绑定 Order、存在持久化发送标记、状态为 requires_action/processing/cancelled 且没有关联 capture 资金事实的意图。过期不排除，已确认 failed/succeeded 排除；未发送的 APPROVED Order 不属于后台代扣范围。领取使用 SKIP LOCKED 和持久化 last_provider_poll_at/provider_poll_attempts，HTTP 失败或 Worker 崩溃也须等至少五分钟重领；这不是外部副作用的 exactly-once 租约。

Worker 只 GET `/v2/checkout/orders/<绑定 ID>`，验证关联后将 Capture 交现有 Inbox；不 POST Capture、不根据 Order 的 APPROVED/VOIDED 或一次 404 判定资金失败、不延长库存预占、不自动退款。未发现 Capture 返回 `awaiting_capture`，单项 HTTP/资源错误返回 `retry_required` 并继续其他对象；`processed` 计数代表处理的候选数，不是成功支付数。调度方必须检查 `results`，不能只检查 HTTP 200。

正常 Pending 仍定期查询；关联 capture 资金事实出现后交 Inbox 重试/人工对账，避免绕过 Inbox 的 25 次自动重试限制。非 USD 等无法关联意图的资金仍需人工处理。查询没有自动次数上限，也不以次数耗尽证明资金失败：必须监控未解决意图年龄、provider_poll_attempts、过期未决、持续 awaiting_capture/retry_required 及外部 action_required 资金。建议未解决超过一小时告警；排除配置/网络故障后继续 GET，不换 ID、不清标记、不重新扣款。长期无 Capture、404 或 reversal 需人工核实，当前不提供自动终结这些未知结果的命令。

Capture 标记已提交但实际 POST 尚未发出的崩溃也会进入该队列，GET 无 Capture 时保持未知。`paypal.capture_requested` Outbox 可用于告警/唤醒查询，不是允许消费者代扣的指令。调度应持续运行，不只依赖该事件；调度、告警平台和消费者仍需部署方配置。

### Outbox 与 Inbox 恢复

Outbox claim 返回 `attempt`、`lease_token` 和 `lease_expires_at`；过期、旧 token、错误 owner 的 complete 返回 false。处理时长超过租约需调整下次领取配置；相同 worker_id 不能替代租约 token，消费者仍须按 event_id 幂等。

Outbox 每个自动窗口最多领取 25 次。最后一次处理失败进入 exhausted；最后一次租约到期后，后续 claim 会有界清理该状态。部署方用受信数据库只读监控 `commerce.outbox_events` 的 exhausted、超期 processing 及积压年龄；该表不对 PostgREST 开放。恢复时读取当前累计 attempts 作为 expected_attempt，调用 redrive；保留事件 ID、payload、累计次数，追加 `commerce.outbox_redrives` 审计并开启新 25 次窗口。相同 event/expected_attempt/worker/reason 的重放返回 true，不改变后续 processing/published 状态；不同内容或不匹配状态拒绝。禁止直接清零 attempts、修改 payload 或换 event_id 重发。

Inbox 自动重试达到 25 次后停止，事件不会因此丢失。排除故障后，从受信数据库取原 `commerce.payment_provider_events` 的 provider、provider_event_id、source、event_type、object_reference、livemode、occurred_at、payload_hash、data，通过 service-only `ingest_payment_provider_event` 原样重投；已有事件保留累计次数并重跑本地处理。也可让渠道通过已验签的 Webhook 重送同一原始事件。不能以重新抓取的不同 JSON 伪造旧 hash、改事件身份或再发 Capture/Refund POST。先在本地/渠道 Sandbox 演练重投成功、重复重投不重复入账，再为生产操作者开放流程。

管理员可通过 `list_admin_outbox_events`、`list_admin_payment_provider_events` 读取分页运维摘要，无须 service key。摘要不含 payload/data、原始错误、hash 或 lease_token；完整筛选与游标合同见 [管理 API](../../docs/api.md#管理员运维查询与恢复)。

管理员排除故障后可用自己的 JWT 调用 `redrive_outbox_event({event_id,expected_attempt,reason})`，不得传 worker_id；数据库以 `admin:<Auth UUID>` 固定审计身份。重投可能触发下游消费者，应由操作者确认，不作为 Agent 自动失败重试循环。相同操作者和原因可重放，不同操作者不能复用已有耗尽点的重投身份。领取、完成、Inbox 重跑和渠道资金接口仍为 service-only；管理员摘要不构成伪造或重新提交渠道事件的授权。

### 清理与告警

Cart 过期拒绝访问，物理删除依赖 `purge_expired_carts`；监控积压，清理不取消关联 Quote/订单或改库存。Quote Worker 清理终态预占工作行，延迟不延长预占；同时监控数据库 autovacuum/死元组。Cart 行属性保留到物理清理，Quote/订单历史属性不在此清理范围。

关注 `payment.reconciliation_required`、`paypal.refund_reconciliation_requested`，告警失败/重试耗尽的 Inbox、Outbox、unmatched / action-required 资金和退款延迟。
不明 Capture / Refund 必须重试或对账；不得先手工收款或重新申请退款再猜测线上资金结果。未绑定且发出超过一小时的退款会停止 POST 重试，额度继续保留；需人工核实渠道结果，再用可信 Refund ID 绑定并 GET 恢复，不能换新键盲退。上线仍须核实真实渠道的幂等保留期。
PayPal disputes、chargebacks 及 payout/balance reconciliation 仍需 Dashboard 人工监控；未建专用账本前不要把争议事件接入自动退款/库存流程。

## 开发与发布验证

项目尚未部署，数据库改动通过修改基线并重建本地环境验证，见 [数据库开发](../../docs/database.md)。不维护旧 schema 或旧 handler 的升级兼容。
首次发布按以下清单验收，之后固定迁移并设计前向升级：

1. 配置真实商品、配送范围和税务规则；当前仅支持国家级比例税，无匹配规则时零税额不代表免税。
2. 初始化完整数据库，再部署匹配的函数和静态客户端；核对 HTTPS、精确 CORS Origin、实际回调路径和密钥隔离。
3. 完成本页身份安全、SMTP、限流及数据保留配置，轮换历史 OAuth 凭据。
4. 部署 Worker、幂等 Outbox 消费器和告警，演练重试耗尽、未知资金及人工恢复。
5. 完成 [钱包与卡支付 Sandbox 清单](../../docs/storefront-paypal.md#sandbox--上线验收仍待完成)；本地 mock 边界见 [测试指南](../../docs/testing.md)。
