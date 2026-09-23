# 测试指南

## 运行

无数据库的快速门禁：

```bash
bun run typecheck
bun run storefront:check
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

## Admin / MCP 本地融合验收

先运行本地 Supabase 和 `bun run admin:dev`，确认 Admin 的实际端口；另一个终端运行：

```bash
MCP_BROWSER=1 MCP_ADMIN_URL=http://127.0.0.1:5174 \
  bun run test:current tests/mcp-oidc-interaction.test.ts -t 'node: durable'
```

需要 Docker、OpenSSL 和 `agent-browser`。沿用已有 Node LTS OAuth 宿主、Bun HTTPS MCP、真实本地 Auth/SMTP 和独立临时 issuer 数据库；临时证书由浏览器信任，不关闭 TLS 校验，无需公网域名。`MCP_ADMIN_URL` 只接受精确回环 origin，并要求 `MCP_BROWSER=1`；仅此模式开启测试 MCP 的调用审计和浏览器授权的 `store:write`，不更改部署默认值。

在原 OAuth 故障回归之后，同一真实授权继续创建停用分类，再独立登录 Admin 核对名称、负排序值与停用状态。Admin 修改后，MCP 能读取新事实，携带原始 `updated_at` 的旧请求被拒绝。连接页必须显示真正由 MCP 产生的成功／拒绝审计，不包含参数；页面明确撤销后，用同一 bearer 直接发送读写均须返回 401，商品目录事实不被修改。没有注入 Admin session、手工造授权／审计或自动换 token。夹具结束清理本轮分类、账户、审计、授权、临时数据库和进程；失败仍会尝试清理。

该验收还覆盖 Realtime：MCP 修改后干净分类编辑页自动重读；本地草稿与冲突锁定不被后续通知覆盖；离线期间修改在恢复后核对；本人的新调用自动出现在最新记录页。截图写入 `/tmp/admin-realtime-*.png`，检查移动端草稿提示、恢复后的分类事实和调用记录。

Realtime 前置迁移为 `20260923000005_admin_realtime.sql`。`bun run test:current tests/admin-realtime.test.ts` 使用真实本地 WebSocket 验证私有频道、事务回滚无通知、公开频道隔离、普通用户/匿名拒绝、浏览器发布拒绝、跨用户隔离及降级后 RPC 门禁；`bun test tests/unit/admin-realtime.test.ts` 验证通知合并、前台恢复与卸载清理。`bun scripts/admin-connections-smoke.ts` 另验证旧记录页收到通知后不跳页；`bun scripts/admin-categories-smoke.ts` 保留本地草稿并验证并发冲突。以上脚本清理本轮临时数据，不对共享环境执行迁移。

该验收覆盖一条代表性跨客户端业务链路，不等于全部 113 个工具的端到端覆盖，也不替代真实域名、SMTP、生产 Edge CORS、目标 Agent 产品客户端与上线运维验收。未设置 `MCP_ADMIN_URL` 时保持原有浏览器只读验收。

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
