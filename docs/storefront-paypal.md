# SSG Storefront 的 PayPal 结账合同

SSG 只生成公开目录和页面外壳；购物车、地址、报价、订单和支付状态必须在浏览器运行时获取。静态价格不是结账承诺，不能将个人数据写入构建产物或 CDN 共享缓存。本仓库不包含 Storefront；以下是接入合同，不是已验证的浏览器实现。

## 身份与部署边界

- 浏览器可使用 Supabase 公共 key、当前用户会话和 PayPal JS SDK 的 client ID。service-role key、PayPal client secret 仅在 Edge/Worker。
- 先恢复现有 Supabase 会话，没有会话才匿名登录；生产须配置 CAPTCHA 和覆盖直连 RPC 的网关限流。不要在刷新/每次付款时创建新匿名身份。
- token Cart 先由当前会话认领，再转 Quote。Cart capability、PayPal token、PayerID、邮箱和订单号都不是订单访问凭据。
- HTTP 调用使用当前用户 JWT；Edge 通过 Auth `/user` 验证，再由数据库验证 Customer 归属。浏览器不传可信 `actor_id`。
- Auth 会话需持久化并刷新。纯静态站点的浏览器存储受 XSS 影响，需 CSP、依赖治理和安全日志策略；如选择 HttpOnly cookie/BFF，另行实现 CSRF 防护，不能在纯浏览器 Supabase 客户端里假装已有 HttpOnly 隔离。

## 从报价到付款

1. 在地址、配送和优惠选择完成后创建 Quote，展示数据库金额和 `expires_at`。不要在打开商品页时预占库存。
2. 用户确认后调用 `create_order_from_quote`。报价过期或价格 hash 变化时重新报价并要求确认，不能静默接受新价格。无须单独确认报价的流程可用幂等 `create_order`。
3. 保存本地订单 ID；若订单已是 `paid`（包括零元订单），直接展示订单，不创建 PayPal 支付。
4. 为本次支付尝试生成并持久化 `idempotency_key`，调用 `paypal-create-order`，请求只有 `order_id` 和该键。金额、币种、地址、跳转 URL 由后端决定。
5. 保存 `{order_id,payment_intent_id,provider_reference,idempotency_key,expires_at}`。`provider_reference` 是 PayPal Order ID，不是本地订单或 Capture ID。按订单/PayPal Order 分别存储，不用一个全局“当前支付”覆盖多标签页。
6. 跳转到响应的 `approve_url`；`null` 不表示成功，先查询本地订单，必要时恢复原意图。若采用官方 Buttons，`createOrder` 返回 PayPal Order ID，`onApprove` 调用下面的 Capture Edge，不能把本地 UUID 交给 SDK。
7. 买家批准后，以原会话调用 `paypal-capture-order`，仅传 `payment_intent_id`。不要从浏览器调用 service-only RPC，不自行 POST PayPal REST Capture。
8. 查询 `get_customer_order(order_id)` 的本地订单状态；需要恢复意图时使用 `get_payment_operations(order_id)`。订单 `financial_status=paid` 才能展示本地付款完成；后续退款仍根据最新订单/账本展示。

Quote、订单创建、支付尝试是不同幂等范围。每次网络重试复用对应操作的原键/原参数；不要每次点击生成新支付键。一个订单最多一个活跃 PaymentIntent。创建响应丢失先以原键重试；已终态可能返回 `payment_intent_terminal`，此时重读订单和意图，不自动发起新付款。

地址在本地订单中固定，PayPal 使用 `SET_PROVIDED_ADDRESS`。需要改址时取消可取消的未付款订单并重新结账；捕获结果不明时不能绕过保护取消。当前不支持在 PayPal 内改址再原地重算订单。

## 返回页与取消页

`PAYPAL_RETURN_URL` / `PAYPAL_CANCEL_URL` 是服务器配置的固定 HTTPS 地址。SSG 部署须实际提供这些路径，返回页是动态恢复入口，不是静态“支付成功”页。

- 返回后先恢复 Auth，再用回传 PayPal token 与本地保存的 `provider_reference` 核对；未知关联不自动 Capture。不要信任查询参数中的金额或成功标记。
- 本地支付上下文丢失但会话仍在时，从客户订单列表和 `get_payment_operations` 恢复并匹配；没有匹配时展示可恢复错误，不生成新订单。
- 处理完 URL 后移除支付查询参数，避免日志/埋点泄露。不要将 Auth token 或 Cart capability 放进返回 URL。
- 用户退出 PayPal、关闭弹窗或到达取消页，不代表本地订单已取消，也不能证明渠道未扣款。先查订单；明确取消本地订单须另调 `cancel_order` 并处理捕获保护拒绝。
- 匿名 Auth 会话也丢失时，当前无法凭邮箱找回订单；提示用户保留原浏览器会话或联系支持，不按邮箱合并历史。

## 渠道状态不等于本地入账状态

创建响应 `provider_status` 是 PayPal **Order** 状态，Capture 响应同名字段是 PayPal **Capture** 状态，不能混用。创建响应 `status` 在未观察到 Capture 时是本地意图状态，观察到 Capture 时是 Inbox outcome；Capture 响应用 `processing_status` 表示 outcome。

两个响应的 `pending_reconciliation=true` 都表示 Inbox 尚在 `received` 或资金需要 `action_required` 对账。`false` 也不代表已付款，例如 `APPROVED`、Capture `PENDING` 或已失败事件都可能是 false。`amount/currency` 是本地期望金额，不是异常外部资金的证明。

| 观察结果 | Storefront 动作 |
| --- | --- |
| 本地订单已付款 | 展示订单完成，不再 Capture/创建意图 |
| 有批准链接、意图可操作且未过期 | 进入 PayPal 批准；同次尝试保留原 ID/键 |
| PayPal Order `APPROVED` | 仅代表批准；按用户付款流程调用 Capture |
| Capture `PENDING`、`processing`、`transient_database_error` | 展示处理中，退避查询本地订单；不提示再次付款 |
| `action_required` | 展示待确认/联系支持；禁止以新付款替代对账 |
| `instrument_declined` | 提示选择其他资金来源；这是独立恢复分支，不当作网络超时，也不自动创建新意图 |
| 网络超时、5xx、`paypal_unavailable`、`database_unavailable` | 结果未知，先查订单，必要时用原意图恢复；不能清标记或换键扣款 |
| 401 | 刷新/恢复原 Auth 后重试，不创建新匿名客户 |
| 意图已确认 `failed` 且订单仍可付 | 才能开启新的支付尝试和新键 |
| 订单/Quote 过期或取消 | 不继续扣款；已有未知 Capture 交后台对账，不能把取消当作资金失败证明 |

浏览器订单查询可用有上限的退避（例如 2、4、8 秒，之后间隔 10 秒），页面不可见时暂停，等待超限展示“仍在确认，可稍后查看订单”；不要每次查询都调用 Capture，也不要永远锁住页面等待。后续由 Worker/Webhook 收尾。

当前 Capture POST 的 `INSTRUMENT_DECLINED` 只返回归一化错误码，不会单凭该 HTTP 响应伪造失败 Capture 事件或清除发送标记。官方 SDK 的 restart、原 Order 再批准/再 Capture 与本地意图终态的组合尚需真实 Sandbox 验证；未完成前不要提供会自动生成新意图的“换卡重试”。后台 GET 没发现 Capture 也不是可信失败终态。

## 后台恢复与上线验收

`paypal-reconcile-captures` 只 GET 已绑定且曾发起 Capture 的 Order；没有浏览器重试和 Webhook 也能发现渠道资金。查询发现的结果复用 Inbox，订单过期的迟到资金只进入对账。它不为仅批准的 Order 扣款、不延长库存预占，也不自动退款。调度与监控见[支付与部署](../supabase/functions/README.md)。

本地测试使用真实 Auth/PostgreSQL 与生产 handlers，仅 mock PayPal HTTP；覆盖响应丢失、数据库暂时失败、重复资金、领取隔离/冷却、错误资源、Pending、金额错配及迟到资金。

获得 Sandbox 后仍必须验证：真实批准跳转、Webhook postback、JS SDK 创建参数兼容性、资金来源失败恢复、Pending 到终态、移动端/App Switch、刷新/多标签页/会话丢失和商户资金记录。Mock 不证明这些外部行为，也不代表已部署调度或生产支付可用。

参考：[PayPal 标准接入](https://developer.paypal.com/studio/checkout/standard/integrate)、[资金来源失败](https://developer.paypal.com/platforms/checkout/standard/customize/handle-funding-failures)、[API 合同](api.md)。
