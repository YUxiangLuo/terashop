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
