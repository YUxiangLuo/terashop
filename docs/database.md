# 数据库开发

项目处于未部署的开发阶段。`supabase/migrations/` 是可修改的初始化基线，不维护旧迁移链或数据升级兼容；改完后重建可丢弃的本地数据库。
首次生产部署前再固定基线，之后才采用只追加的前向迁移策略。

## 文件职责

文件共同组成一个完整基线，不能挑选其中一部分部署：

| 文件后缀 | 内容 |
| --- | --- |
| `00_schema.sql` | schema、表、约束、索引、RLS 开关与默认权限；Supabase 提供 Auth 基础对象 |
| `01_catalog.sql` | 目录完整性/发布、商品扩展、客户、地址、评价、角色、库存调整 |
| `02_checkout.sql` | 计价、促销、订单、Quote 与库存预占 |
| `03_transactions.sql` | 账本、履约、退款、快照保护和 Outbox |
| `04_payments.sql` | 支付意图、渠道 Inbox、外部资金与对账 |
| `05_security.sql` | 视图、业务/Auth 触发器、RLS policy、显式 API 权限 |

每个函数只维护一份最终定义。更改已有函数直接编辑对应文件，不再叠加 `fixes`、字符串替换函数体或历史数据回填。
表先于业务函数创建；跨域函数引用仅在创建阶段通过事务局部的 `check_function_bodies=false` 延后校验，权限最后显式开放。不要删掉 RLS、约束或状态机保护来解决初始化顺序问题。

## 修改与验证

```bash
bun run start
bun run test             # 重建本地 schema、seed，再执行完整 API/handler/并发测试
bun run db:lint
bun run types:generate   # schema/API 有意变化时更新；否则只运行 types:check
bun run types:check
bun run typecheck
```

只需要重建时使用 `bun run setup`；`test:current` 不重建，但仍会写入测试数据。勿把测试命令指向业务数据库或其他项目。
金额、库存、退款、履约或权限规则变化必须同步更新回归测试和 [ADR](architecture-decisions.md)。

## SQL 静态检查

`bun run db:lint` 使用本项目的本地 Supabase 连接，检查 `public` / `private` / `commerce` 的 PL/pgSQL 函数；触发器按每个实际挂载表分别检查，包括 `auth.users` 上的业务触发器。SQL-language 函数与动态 SQL 不在此检查覆盖内，仍需初始化校验与回归测试。

检查器见 [`scripts/db-lint.ts`](../scripts/db-lint.ts)：

- 在同一事务中安装 `plpgsql_check`，从实际 `price_checkout` 定义提取两个建表语句，准备临时表；不调用业务函数，也不维护重复的临时表结构。
- 成功或失败均回滚，扩展与检查用对象不会留下；无法识别临时表 DDL 时直接失败。
- **所有未审阅的告警或错误均使命令返回非零状态**，现有 CI 已调用此命令。不接受函数注释关闭检查。
- 仅有两类精确例外：两个 UUID/整数规范化函数中固定 JSON 聚合语句的 `STABLE` 告警；两个多表触发器中由固定 `TG_TABLE_NAME` 分支排除的字段访问。例外同时匹配诊断与实际源码位置/语句，触发器还匹配挂载表，不跳过整个函数。

库存规范化结果与幂等哈希在输入重排、UUID 大小写、拆行和不同会话设置下应保持一致；商业行仅合并相同属性，增加独立 ID 后 Quote 行已具有 `id` 字段，对应的旧缺列例外不再产生（当前共 5 个精确诊断）。回归也注入错误，验证缺列、变化的 JSON 表达式和错误的触发器分支不会被例外吞掉。更改这些语句后先审查新诊断，不扩大例外范围来消除报错。

## 深度审阅回归

退款发出/取消、库存锁与批量过期、瞬时入账故障、有限金额、头行守恒、Outbox fencing 和最小权限已纳入正式回归，见 [审阅与修复闭环](database-review.md)。
时间推进和故障注入使用可回滚事务；库存交错仅安装测试暂停触发器，finally 删除，不禁用业务约束。测试异常中断后重建本地库清理，禁止在生产或宿主 PostgreSQL 上运行。

## 目录与商业行回归

- [`catalog-integrity.test.ts`](../tests/catalog-integrity.test.ts)：草稿/发布、归属不可迁移、规格完整性/唯一性、分类环、发布竞态及 REPEATABLE READ 旧快照。
- [`checkout-lines.test.ts`](../tests/checkout-lines.test.ts)：属性边界、key/幂等、同 SKU 多行库存合计、手工/PayPal 支付、逐行履约/退款及防促销拆行套利。

`private.category_tree_guard` 是内部同步哨兵，不是新增业务 API；目录编辑要求整笔事务重试。生成的 `line_key` 不可直写，Quote 行 UUID 转单后继续使用。当前阶段未新增 Cart、独立客户、税费明细或 Return 模块。

## 基线合并背景

基线保留当前实际使用的数据模型、RPC 签名和权限，只移除重复定义、已被覆盖的补丁、schema 搬迁和历史回填步骤。
即时扣库下单、`*_v2` 幂等包装及支付/履约投影仍有内部调用和测试覆盖；它们不是历史迁移，可单独调整业务调用链后再整合，不能与删升级脚本混为一谈。
