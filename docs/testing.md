# 测试指南

## 运行

无数据库的快速门禁：

```bash
bun run typecheck
bun run storefront:check
bun run admin:check
bun run test:unit
bun run docs:check
```
`docs:check` 仅检查本地 Markdown 文件引用，不验证锚点或远程链接。

**集成测试会写入数据；`test` / `setup` 还会清空本项目本地库，只能使用可丢弃的 Supabase。**

```bash
bun run start
bun run test                                       # 重建后运行全部测试
bun run test:current tests/admin.test.ts            # 不重建，单文件
bun run test:current tests/admin.test.ts -t '重复标记支付被拒绝'
bun run test:current tests/admin.test.ts --rerun-each=2 --randomize --seed=6149
```

运行器从本项目 Supabase CLI JSON 读取连接/凭据，失败或非回环地址则拒绝启动，不 eval 输出，也不使用 shell 遗留的连接覆盖本项目目标。`bun run test:current` 不重建；`bun run test --integration` 重建并运行全部非 unit 测试，该全量模式不与文件筛选混用。

[CI](../.github/workflows/ci.yml) 先运行快速门禁；数据库任务依次启动、初始化、执行 `storefront:build`，再重建并运行集成测试、SQL lint 和类型漂移检查。静态构建放在测试写入额外目录数据之前。

保持 `--parallel=1`。默认仓、税率、管理员集合、全局 Worker 队列仍有共享状态；handler 测试还拦截全局 fetch/Deno。局部夹具隔离不等于整个套件可以并行。

`tests/admin-retry.test.ts` 覆盖客户创建、库存调整和手工收款的同键跨管理员并发、参数冲突、权限与键长度校验，以及失败回滚、默认仓变化、客户匿名化和退款后的重放。并发用例实际等待数据库锁竞争，并断言资金、库存和事件只写一次；不是仅检查 HTTP 成功。

`tests/fulfillment-update.test.ts` 覆盖履约状态／物流更新：同键及不同键并发、旧版本和旧 REPEATABLE READ 快照、service 写入版本保护、字段／权限校验、审计与 Outbox、退货取消保护、失败后同键重试及取消不回库。

`tests/admin-operations.test.ts` 覆盖运维摘要分页、同时间戳游标、敏感字段排除、Inbox 自动重试次数边界，以及 Outbox 管理员身份绑定、并发重投审计和 Worker 状态保护；同时验证 Worker 命令不对管理员开放。

## MCP 分层验证

| 层次 | 命令 | 环境与边界 |
| --- | --- | --- |
| Node 协议兼容 | `bun scripts/mcp-oidc-compat.ts` | 固定 Node LTS Docker；合成身份，不验证真实登录 |
| 持久化/TLS/生命周期 | `bun scripts/mcp-oidc-compat.ts --with-storage` | 一次性 Docker PostgreSQL，不连接店铺库；包含故障注入，不是公网验收 |
| 真实授权与 MCP | `bun run test:current tests/mcp-oidc-interaction.test.ts` | 本地 Supabase/Auth/SMTP、Docker、OpenSSL；真实 HTTPS 子场景及代表性写入/刷新/撤销恢复 |
| 浏览器登录与同意 | `MCP_BROWSER=1 bun run test:current tests/mcp-oidc-interaction.test.ts -t 'node:'` | 另需 agent-browser、Chromium、certutil；邮件跨标签页、明确批准/拒绝、重启/断网失效及回执丢失 |
| 五分钟自然过期 | 上述浏览器命令增加 `MCP_BROWSER_EXPIRY=1` | 不修改 TTL/时钟，约六分钟；覆盖期限两侧及重新授权 |
| 离线维护 | `bun run test:current tests/mcp-oidc-maintenance.test.ts` | 可丢弃本地数据库；保留撤销标记和待恢复记录 |
| 备份恢复演练 | `bun scripts/mcp-recovery-drill.ts` | 独立 Docker 内真实 pg_dump/pg_restore，仅 issuer 数据，不代表完整 Supabase 恢复 |

浏览器显式信任一次性证书，不关闭 TLS 校验、不注入身份或 Cookie；从真实本地 SMTP 获取验证链接。测试客户端并非目标 Agent 产品，不把代表性读写扩张为全部工具或渠道资金验收。具体故障场景见 [浏览器夹具](../tests/support/oidc-browser.ts) 与 [联合测试](../tests/mcp-oidc-interaction.test.ts)。

可用绝对路径环境变量 `MCP_BROWSER_SCREENSHOT`、`MCP_BROWSER_FAILURE_SCREENSHOT`、`MCP_BROWSER_OFFLINE_SCREENSHOT`、`MCP_BROWSER_LOST_RESPONSE_SCREENSHOT`、`MCP_BROWSER_DISCARDED_RECEIPT_SCREENSHOT` 保存相应状态；自然过期模式另用 `MCP_BROWSER_EXPIRY_SCREENSHOT`。查看截图前后都不得泄漏 token、邮件验证链接或个人资料。

媒体 Edge 网关测试需在独立终端运行 `bunx --no-install supabase functions serve --network-id tera-headless-loopback`，新增函数后重载，再执行 `bun run test:current tests/managed-media.test.ts`。直接调用 handler 的浏览器烟测不能替代网关验收。

## Admin / MCP 本地融合验收

先运行本地 Supabase 和 `bun run admin:dev`，确认 Admin 的实际端口；另一个终端运行：

```bash
MCP_BROWSER=1 MCP_ADMIN_URL=http://127.0.0.1:5174 \
  bun run test:current tests/mcp-oidc-interaction.test.ts -t 'node: durable'
```

需要上述浏览器环境。沿用 Node LTS OAuth 宿主、Bun HTTPS MCP、真实本地 Auth/SMTP 和独立临时 issuer 数据库，无需公网域名。`MCP_ADMIN_URL` 只接受精确回环 origin，并要求 `MCP_BROWSER=1`；仅此模式开启测试 MCP 的调用审计和浏览器授权的 `store:write`，不更改部署默认值。

在原 OAuth 故障回归之后，同一真实授权继续创建停用分类，再独立登录 Admin 核对名称、负排序值与停用状态。Admin 修改后，MCP 能读取新事实，携带原始 `updated_at` 的旧请求被拒绝。连接页必须显示真正由 MCP 产生的成功／拒绝审计，不包含参数；页面明确撤销后，用同一 bearer 直接发送读写均须返回 401，商品目录事实不被修改。没有注入 Admin session、手工造授权／审计或自动换 token。夹具结束清理本轮分类、账户、审计、授权、临时数据库和进程；失败仍会尝试清理。

该验收还覆盖 Realtime：MCP 修改后干净分类编辑页自动重读；本地草稿与冲突锁定不被后续通知覆盖；离线期间修改在恢复后核对；本人的新调用自动出现在最新记录页。截图写入 `/tmp/admin-realtime-*.png`，检查移动端草稿提示、恢复后的分类事实和调用记录。

Realtime 前置迁移为 `20260923000005_admin_realtime.sql`。`bun run test:current tests/admin-realtime.test.ts` 使用真实本地 WebSocket 验证私有频道、事务回滚无通知、公开频道隔离、普通用户/匿名拒绝、浏览器发布拒绝、跨用户隔离及降级后 RPC 门禁；`bun test tests/unit/admin-realtime.test.ts` 验证通知合并、前台恢复与卸载清理。`bun scripts/admin-connections-smoke.ts` 另验证旧记录页收到通知后不跳页；`bun scripts/admin-categories-smoke.ts` 保留本地草稿并验证并发冲突。以上脚本清理本轮临时数据，不对共享环境执行迁移。

分类浏览器回归还覆盖实时分类树：展开分支收到新增通知后自动显示、22 个子分类跨页保留、第二页失败不安装第一页的新数据、显式重试后两页一起更新、移出与删除后自动移除，以及启用筛选随事实变化但不清空未提交的搜索输入。使用本地临时数据，故障注入仅拦截一次浏览器分页读取；桌面错误态和手机恢复态截图为 `/tmp/admin-category-live-error.png`、`/tmp/admin-category-live-mobile.png`。

商品列表实时回归需再应用 `20260923000006_admin_product_realtime.sql`。本地 Admin 启动后运行 `bun scripts/admin-products-live-smoke.ts`（支持 `ADMIN_URL`），验证 21 条商品的跨页刷新、第二页失败保留全部旧数据及重试、筛选草稿不变、变体价格更新、状态移出和删除。截图为 `/tmp/admin-products-live*.png`；夹具仅创建和清理本轮本地商品与账号。`tests/admin-realtime.test.ts` 同时验证商品频道权限、事务回滚与商品/变体/图片/分类关联四张表的增删改通知，不向客户端发送业务内容。

库存通知需 `20260923000007_admin_inventory_realtime.sql`。`bun scripts/admin-transfer-smoke.ts` 验证已提交但回执丢失的调整，在另一笔调整把余额变回原值后仍保留原请求；显式刷新不解锁、不改参数，原键重试不重复生效。还验证调拨草稿遇到通知后不被覆盖，Refresh balances 保留输入及未知调拨；保留原有停用仓库后的幂等重试回归。截图为 `/tmp/admin-stock-live-pending.png`、`/tmp/admin-transfer-*.png`。库存测试沿用不可变流水夹具约定：归档测试商品、停用测试仓库，保留历史审计，不删除业务流水。`tests/admin-realtime.test.ts` 使用真实报价预占／取消和调整验证通知与余额、回滚无通知、非管理员与降级后的订阅／读取拒绝；自然时间到期不保证产生通知。

其余页面与个人连接需继续应用 `20260923000008`～`00010`。运行 `bun run test:current tests/admin-domain-realtime.test.ts tests/mcp-connection-realtime.test.ts` 验证五个管理员域的真实订阅隔离、事务提交与最小载荷，以及本人连接创建／更新／删除、清理完成、跨用户拒绝和降级后的自助访问；凭据 envelope 更新不触发连接通知。来源表覆盖包含促销兑换记录、订单页渠道资金记录与商品规格选项，避免仅监听主表。

`bun scripts/admin-page-changes-smoke.ts` 验证远端商品修改不会替换本地草稿，并通过 SPA 导航遍历订单、报价、客户、仓库、配送、税率、促销、Outbox、支付事件和对账列表，验证页面提示不会导航或重建业务页面。列表通知探针使用零行 UPDATE，不改动已有业务行；代表性真实业务写通知另由数据库集成测试验证。`bun scripts/admin-connections-smoke.ts` 还覆盖连接第一页自动更新、后续页保留、撤销确认集合不随新授权扩张、未知撤销原参数重试。`bun scripts/admin-returns-smoke.ts` 验证仓库配置变化通知收货页，同时保留所选仓库、实收数量和备注。截图为 `/tmp/admin-page-live-*.png` 和原有连接截图；桌面及手机均需检查。`tests/unit/admin-page-changes.test.ts` 锁定路由到业务域的覆盖，避免与已有页面订阅重复；`tests/unit/admin-realtime.test.ts` 验证同名频道退订未完成时的新挂载等待、等待中的页面卸载以及旧回调失效。

完整本地验收建议串行运行 `bun run typecheck`、`bun run admin:check`、`bun run test:unit`、`bun run test:current`、`bun run db:lint`、`bun run admin:build`、上述浏览器回归及实际 OAuth/MCP/Admin 联动；不要为追求速度并发启动多套浏览器、OAuth 宿主或重建数据库。测试历史数据不是生产资料，仍按各脚本的不可变账本清理约定处理。生产部署清单和自动刷新／提示矩阵见 [Admin 实时通知说明](../admin/README.md#当前覆盖与上线边界)。

这些验收不等于全部 113 个工具的端到端覆盖，也不替代真实域名、SMTP、生产 Edge CORS、目标 Agent 产品客户端、WebSocket 代理、生产负载与上线运维验收。未设置 `MCP_ADMIN_URL` 时保持原有浏览器只读验收。

## 编辑回执与金额精度回归

本地应用 `20260923000011_catalog_money_precision.sql` 后，`bun run test:current tests/catalog-money-precision.test.ts` 验证创建／更新中的价格、原价及成本拒绝 `1.005`，且整笔编辑与 revision 回滚；覆盖边界金额、可空金额、无效金额拒绝及既有精确数字字符串兼容性。`tests/unit/catalog-money-precision.test.ts` 对齐 Admin、MCP 的输入精度；`tests/unit/admin-write-receipts.test.ts` 覆盖异常身份、版本、嵌套字段、nullable 字段和微秒比较。

运行本地 Admin 后，`bun scripts/admin-write-receipts-smoke.ts` 在真实写入已提交后篡改响应，验证创建／更新的草稿保留、再次派发阻止和显式重读恢复。`bun scripts/admin-inventory-review-smoke.ts` 验证库存草稿离开确认、未知操作刷新恢复和历史刷新／分页失败保留旧数据。脚本仅操作本轮本地夹具；库存历史保持不可变，结束归档商品、停用仓库并撤销测试账号管理员角色。

全量高写入回归可能触发本地 Realtime 的消息速率限制。若订阅成功但通知等待超时，应检查 Realtime 服务日志中的 `MessagePerSecondRateLimitReached`／`UnableToBroadcastChanges: too_many_requests`，并独立复跑对应 WebSocket 用例以区分限流与权限／触发器缺陷。单独通过不能把失败的全量结果记作通过；不要跳过断言或提高配额来掩盖丢失通知。Broadcast 不是可靠事件流，Admin 显式刷新仍必须从 RPC 读取事实。

## Storefront 验证与演示数据

`bun run storefront:build` 需要可访问的 Supabase，只读取公开目录；构建和 `storefront:check` 不等于浏览器验收。页面改动应在 `storefront:preview` 中检查桌面与手机布局、图片加载、排序、售罄禁用、购物袋数量和报价金额／到期恢复。当前没有自动化浏览器测试套件，注册回调与支付 UI 尚未实现；真实 PayPal 验收见 [接入合同](storefront-paypal.md#sandbox--上线验收仍待完成)。

默认 seed 仅含女装。历史回归通过 `support/legacy-catalog.ts` 安装旧商品和促销；新交易测试使用自有夹具。测试后的数据库不是纯演示目录，需要时按 [Storefront 说明](../storefront/README.md#当前能力与演示数据) 重置并重建，不要在共享环境执行 reset。

## 本地邮件验证

`local_smtp.enabled=true` 启用 Mailpit，界面为本机 `http://127.0.0.1:54324`；实际 API 地址通过 CLI 的 MAILPIT_URL 注入并验证为回环地址，不继承外部邮箱地址。配置变更须先 `bun run stop && bun run start`，db reset 不重新加载 Auth 配置。Mailpit 捕获邮件，不向真实收件人投递；界面/API 可读取验证凭据，不要暴露到公网、保存为 CI artifact 或记录完整确认链接。

本地和 CI 必须用 `bun run start`：它通过项目专用 Docker bridge 将发布端口限制到 `127.0.0.1` 并检查绑定。旧容器若监听所有网卡，先 stop 再 start；直接 `bunx supabase start` 会绕过保护。仅将客户端 URL 写成 localhost 不提供访问控制。实现见 [`scripts/start.ts`](../scripts/start.ts)。

普通注册现在开启邮箱确认；`helpers.signup` 必须收到真实 SMTP 邮件、提取确认 token 并调用 Auth 验证接口后才能返回登录夹具，不用 service role 代确认或 generateLink 替代投递。`support/mail.ts` 按随机唯一收件人筛选，校验链接确属本项目 Auth 和预期类型，最多等待 10 秒。Mailpit 不保证随 db reset 清空，测试不得读取全局最新邮件或清空其他测试邮件；重复注册相同邮箱时取该收件人的最新匹配邮件。

| 场景 | 当前覆盖 / 后续价值 |
| --- | --- |
| 注册确认 | 所有普通注册夹具走真实捕获邮件；专项验证未确认不能密码登录 |
| 游客升级注册 | 已覆盖确认前不能设置密码、无效/重放 token 拒绝、验证后密码登录、原 Customer/Cart/已支付订单保留及邮箱冲突拒绝 |
| 密码找回 | 已覆盖真实 recovery 邮件、一次性验证、重设后旧密码失败、新密码成功 |
| 注册账户改登录邮箱 | 已覆盖真实新邮箱确认、占用冲突、确认前旧邮箱可登录/新邮箱不可登录、确认后反转；Customer/订单联系邮箱不变。当前只验证新邮箱，不覆盖双邮箱确认或取消 |
| 重发与过期 | signup/recovery/email_change 均覆盖 429 不投递且保留旧令牌、成功重发废弃未过期旧令牌、3600 秒期限两侧、成功验证后重放拒绝 |
| Storefront 回调 | 后续在 `storefront/` 补浏览器点击链接、PKCE/code 交换、刷新/跨标签页、错误页面及跳转白名单；当前仅验证 Auth HTTP，不覆盖浏览器会话落地 |
| 交易通知 | 邮件捕获可用于未来订单/发货/退款 Outbox 消费器的收件人、快照内容、幂等投递与失败重试测试；目前没有这些邮件消费者，Mailpit 不会自动发送业务邮件 |

本地捕获不能验证公网 SMTP 凭据/TLS、SPF/DKIM/DMARC、反垃圾/真实收件率、退信/投诉或生产限流。当前 double_confirm_changes/secure_password_change 仍为开发配置，不表示已完成生产账户安全策略；上线另行验证真实邮件服务，不可为解决无 SMTP 而关闭邮箱确认。

限流拒绝必须使用真实发送时间立即重发；允许重发和过期用例只调整独立用户的邮件发送时间，不改 token、确认状态或全局时钟。验证成功重发时排除旧邮件 ID，不能把旧邮件当新投递；不声称覆盖精确毫秒边界或生产全局发信配额。

## 夹具与断言

- 正向 RPC 优先用 `helpers.command()` 的生成类型；非法参数测试保留 `rpc()` 明确的非类型安全入口。
- `support/http.ts` 统一认证、超时和 `Prefer`，`checked()` 检查成功状态，`onlyRow()` 要求恰好一行。负向查询显式断言状态/空数组，不用 catch 把网络或解析错误变成“查无数据”。
- `support/catalog.ts` 经发布/库存命令创建随机命名商品；`payment-fixtures.ts` 只组合支付域操作，`support/promotions.ts` 管理促销。预期金额、数量和状态留在用例里，不封装成“执行所有流程并断言成功”的大助手。
- 每项用例明确建立 pending/paid/部分履约/已退数量，不能消费上一测试的产物。seed 只服务演示目录/价格 smoke test；新交易回归优先使用自有商品和库存。
- 资源创建后立即登记 `Cleanup`，在 finally / afterEach / afterAll 执行；逆序尝试全部任务，清理失败必须可见。有历史引用的促销、商品、仓库和税率停用/归档而非强删。共享状态恢复到进入测试时的完整快照，不只恢复一个管理员。

## 并发与覆盖保留

`database-concurrency.ts` 集中真实连接、持锁/释放、旧快照和锁等待检测；所有分支都等待结束，包括设置/提交失败。用 `pg_blocking_pids` 或明确 ready/release 证明交错，轮询 sleep 仅用于观察条件，不能靠固定延时猜测另一命令已执行。`scripts/lib/transactions.ts` 提供独立的 `withRollback`，测试不再从 lint 可执行入口借用事务工具。

退款轮询用 `payment-fixtures.withRefundPolling` 锁住其他夹具，让真实 SKIP LOCKED 只领取本例请求；不能靠提高页容量、反复消费其他用例队列或 mock 候选 RPC 强行命中。

按业务域添加回归，历史缺陷编号放在注释中。整理时保留下列不同维度，不能只因为错误消息相同就合并：

- READ COMMITTED 对照 / REPEATABLE READ 旧快照；RPC / 受信直接写入。
- SQL 角色权限 / 业务不变量；延迟 COMMIT / 强制校验 / 保存点回滚。
- 渠道适配单测 / 真实 Auth、PostgREST、handler 入账；外部资金 / 内部账本 / 实收库存。

回滚实验、故障注入及暂停触发器不得关闭业务保护；强制中断后应重建本地库清理。测试通过不替代真实渠道 Sandbox、网关、备份恢复、生产数据基数或吞吐验证。数据库规则和历史证据分别见 [ADR](architecture-decisions.md) 与 [数据库开发](database.md)。
