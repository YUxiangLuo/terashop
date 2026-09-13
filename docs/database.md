# 数据库开发

项目尚未部署。六个 `supabase/migrations/` 文件是可修改的初始化基线，不维护历史升级兼容；每个函数只维护一份最终定义，直接编辑所属文件，不叠加修补迁移、替换函数体或历史回填。首次生产部署后才采用只追加的前向迁移策略。

## 文件职责

完整基线必须一起部署，不能挑选其中一部分：

| 文件后缀 | 内容 |
| --- | --- |
| `00_schema.sql` | schema、表、约束、索引、RLS 开关与默认权限；Auth 基础对象由 Supabase 提供 |
| `01_catalog.sql` | 目录/发布、扩展、客户、地址、评价、角色、库存调整 |
| `02_checkout.sql` | Cart、计价/税分摊、价格快照、订单、Quote 与预占 |
| `03_transactions.sql` | 账本、履约、退款、Return/Receipt/处置、快照保护、Outbox |
| `04_payments.sql` | 支付意图、渠道 Inbox、外部资金与对账 |
| `05_security.sql` | 视图、业务/Auth 触发器、RLS policy、显式 API 权限 |

表先于函数创建，权限最后开放。跨域函数引用仅在创建阶段通过事务局部的 `check_function_bodies=false` 延后校验，不能靠删掉 RLS、约束或状态机保护解决依赖顺序。

## 修改与验证

**以下命令会清空本项目本地数据库，只用于可丢弃的开发环境，不操作宿主 PostgreSQL、其他项目或业务数据。**

```bash
bun run start
bun run test             # 重建完整 schema、seed 并测试
bun run db:lint
bun run types:generate   # 仅在 schema/API 有意变化时更新，不手改 types/database.ts
bun run types:check
bun run typecheck
bun run docs:check
```

仅重建用 `setup`；不重建的筛选、重跑和夹具规则见 [测试指南](testing.md)。金额、库存、退款、履约、权限变化必须同步回归及 [ADR](architecture-decisions.md)；命令输入输出维护在 [API](api.md)，部署/Worker 维护在 [支付运维](../supabase/functions/README.md)，本页不重复业务合同。

## SQL 静态检查

[`db-lint.ts`](../scripts/db-lint.ts) 使用本项目本地 Supabase，检查 `public` / `private` / `commerce` 的 PL/pgSQL；触发器按实际挂载表逐一检查（包括 `auth.users`）。SQL-language 函数和动态 SQL 仍依赖初始化与运行回归。

- `plpgsql_check` 与从实际函数提取的临时表结构均在事务内准备，成功/失败都回滚，不调用业务函数。
- 未审阅诊断或准备失败均返回非零；现有 3 个例外精确匹配源码、语句、诊断及触发器挂载表，不跳过整个函数。
- 修改相关 SQL 后重跑 lint 和 [故障注入回归](../tests/database-lint.test.ts)，源码变化须重新审阅，不能扩大例外或用注释关闭检查。

## 历史证据（不是当前规范）

- [基点 b7bac3f 的八项审阅](reviews/b7bac3f.md)：退款发送竞态、库存顺序、生命周期、金额、Outbox、权限、幂等。
- [基点 76cba7b 的设计复审](reviews/76cba7b.md)：促销 scope、RR 旧快照、owner FK、订单号、校验次数和查询边界。
- [基点 ca5a4ca 的外部 Review 复核](reviews/ca5a4ca.md)：买赠集合重叠、重试耗尽与恢复、退款资源关联、Metafield 并发、图片可见性、零元订单和预占工作集。

报告的实验、测试数和本机计时保持归档状态，旧命令不得直接用于当前部署。当前库存生命周期见 ADR-024，唯一支付账本见 ADR-025；操作以当前 API 和部署文档为准。
