# tera-headless

基于 Supabase 的 Headless 电商：**单店、单币种（USD）、一人运营**，外加一个通过远程 MCP 操作的 AI Agent。项目尚未部署。

## 范围原则

- 按一人运营设计，不引入面向团队或大商家的机制（多仓库、退货 RMA、多管理员角色、Outbox 租约与人工重投、只为 REPEATABLE READ 调用方准备的防御等）。新需求先问"一个人开店是否真的需要"。
- 特色功能，必须保留：Metafields / Metaobjects、促销引擎、远程 MCP（HTTPS + OAuth）。
- 必须保留的正确性机制：金额用 `numeric`、订单快照不可变、账本只追加、写命令带幂等键、`expected_version` 乐观锁（PT409）、READ COMMITTED 下防超卖的行锁和 `NOWAIT`、PayPal 验签与捕获/退款幂等键。顾客之间、你和 Agent 之间仍然存在并发。

## 结构

- `supabase/migrations/`：**业务规则几乎全部在 PostgreSQL 里**。`public` 对外暴露，`private` 是内部函数，`commerce` 存交易事实、不对 PostgREST 暴露。写操作一律走受控 RPC。
- `supabase/functions/`：Deno Edge Functions，负责 PayPal 和媒体管理。
- `admin/`：SvelteKit CSR 管理端。`storefront/`：SvelteKit 静态前台，还没有结账和支付界面。
- `mcp/`：Admin MCP 服务。`oidc-provider` 拒绝在 Bun 上运行，所以授权服务用 Node 22；其余部分（含脚本和测试）用 Bun。
- `shared/admin-contracts.ts`：Admin 与 MCP 共用的输入合同。
- `types/database.ts`：生成文件，**不要手改**，用 `bun run types:generate` 更新。

## 命令

只用 bun / bunx。

```bash
bun run start                 # 启动本地 Supabase（只监听 127.0.0.1）
bun run typecheck && bun run admin:check && bun run storefront:check
bun run test:unit && bun run docs:check
bun run setup                 # 重放迁移 + 种子数据，会清空本地库
bun run test --integration    # 重建库并跑全部集成测试，约 6 分钟，会清空本地库
bun run test:current tests/xxx.test.ts   # 不重建，只跑单个文件
bun run db:lint && bun run types:check
bun run admin:create <email>  # 把已注册的本地用户设为管理员
```

- 本地库可以随意清空；不要碰宿主 5432 端口上的 PostgreSQL。
- 测试必须 `--parallel=1`，因为默认仓、管理员集合、Worker 队列等是共享状态。
- `managed media runs through the real local Edge gateway` 需要另开终端运行 `bunx --no-install supabase functions serve --network-id tera-headless-loopback`；没启动时这一项失败属于环境问题。

## 改动约定

- **迁移**：项目没有部署，直接改基线文件 `20260912000000`～`05`，不写兼容层或"已删除"注释。后续增量迁移会 `create or replace` 覆盖基线函数，所以定位行为时要搜索整个迁移目录。改完 SQL 后依次执行 `setup` 和 `types:generate`。首次生产部署后改为只追加迁移。
- **Admin 与 MCP 对齐**：后台每增删一个能力，都要同步修改 MCP 工具，涉及 `mcp/src/server.ts`、`schemas.ts`、`permissions.ts`、`admin-links.ts`、`audit-resource-ref.ts`、`action-approvals.ts`。同时更新 `mcp/README.md` 里的工具数量（只读 / 写入），以及 `tests/unit/mcp.test.ts` 里的计数。
- **高风险操作**：`refund_paypal`、`commit_manual_refund`、`anonymize_customer` 通过远程 MCP 调用时，需要在后台人工审批。
- **文档用中文**，各类内容只在一处维护：
  - 业务不变量：`docs/architecture-decisions.md`（保留 ADR 编号）
  - 参数与返回值：`docs/api.md`
  - 测试与验收：`docs/testing.md`
  - 支付部署与 Worker：`supabase/functions/README.md`
  - `docs/reviews/` 是历史记录，不要修改。
- 改动金额、库存、退款、履约或权限时，要同步更新对应的回归测试和 ADR。
