# 数据库开发

项目处于未部署的开发阶段。`supabase/migrations/` 是可修改的初始化基线，不维护旧迁移链或数据升级兼容；改完后重建可丢弃的本地数据库。
首次生产部署前再固定基线，之后才采用只追加的前向迁移策略。

## 文件职责

文件共同组成一个完整基线，不能挑选其中一部分部署：

| 文件后缀 | 内容 |
| --- | --- |
| `00_schema.sql` | schema、表、约束、索引、RLS 开关与默认权限；Supabase 提供 Auth 基础对象 |
| `01_catalog.sql` | 目录完整性/发布、商品扩展、客户、地址、评价、角色、库存调整 |
| `02_checkout.sql` | Cart/认领/版本、计价/税分摊、价格快照、订单、Quote 与库存预占 |
| `03_transactions.sql` | 账本、履约、退款、Return/Receipt/处置、快照保护和 Outbox |
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
- 仅有两类精确例外：两个 UUID/整数规范化函数中固定 JSON 聚合语句的 `STABLE` 告警；Quote 多表触发器中由固定 `TG_TABLE_NAME` 分支排除的字段访问。例外同时匹配诊断与实际源码位置/语句，触发器还匹配挂载表，不跳过整个函数。

库存规范化结果与幂等哈希在输入重排、UUID 大小写、拆行和不同会话设置下应保持一致；商业行仅合并相同属性，Quote 行增加 ID、退款组成校验改为 JSON 取标识后，旧缺列例外已移除（当前共 3 个精确诊断）。回归也注入错误，验证缺列、变化的 JSON 表达式和错误的触发器分支不会被例外吞掉。更改这些语句后先审查新诊断，不扩大例外范围来消除报错。

## 深度审阅回归

退款发出/取消、库存锁与批量过期、瞬时入账故障、有限金额、头行守恒、Outbox fencing 和最小权限已纳入正式回归，见 [审阅与修复闭环](database-review.md)。
时间推进和故障注入使用可回滚事务；库存交错仅安装测试暂停触发器，finally 删除，不禁用业务约束。测试异常中断后重建本地库清理，禁止在生产或宿主 PostgreSQL 上运行。

## 目录与商业行回归

- [`catalog-integrity.test.ts`](../tests/catalog-integrity.test.ts)：草稿/发布、归属不可迁移、规格完整性/唯一性、分类环、发布竞态及 REPEATABLE READ 旧快照。
- [`checkout-lines.test.ts`](../tests/checkout-lines.test.ts)：属性边界、key/幂等、同 SKU 多行库存合计、手工/PayPal 支付、逐行履约/退款及防促销拆行套利。

`private.category_tree_guard` 是内部同步哨兵，不是新增业务 API；目录编辑要求整笔事务重试。生成的 `line_key` 不可直写，Quote 行 UUID 转单后继续使用。Customer、Cart 与 Return/Receipt 见下文。

## 价格明细与退款组成

`commerce.order_shipping_lines` / `order_tax_lines` / `order_discount_allocations` 解释订单头同一组金额；`order_promotions` 保存实际规则与应用顺序。Quote 行用受校验、参与 hash 的 JSON 保存报价明细，转单再落关系表，不提前创建交易账本。
退款商品净额继续使用 `refund_lines` / `refund_request_lines`；新增 `refund_components` / `refund_request_components` 保存税、配送和未分配金额。外键约束同一订单归属，提交时校验组成总额；事实不可改写，异步成功原样复制请求分摊。

[`pricing-breakdown.test.ts`](../tests/pricing-breakdown.test.ts) 覆盖国家/wildcard/零税、拆属性与美分守恒、两条建单路径、历史快照、支付锁、缺失/跨单明细、混合/未分配退款、取消/逆序完成、handler 与受控并发。定价明细与意图创建均写订单行版本；退款请求 INSERT 同样写父订单并检查 Capture 剩余额度，拒绝旧 REPEATABLE READ 快照绕过保护。税规则清理使用停用，不能删除历史引用。
这些测试不代表全球税务合规或生产吞吐验证；关系明细/逐行延迟校验的生产基数查询与批量写入仍须实测。

## 独立客户与 Cart

`public.customers` 与 Auth profile 分离；商业 FK 指向 Customer，审计 actor/角色继续指向账户。账号删除仅 SET NULL 关联，Customer 不可删除/迁移/复活。地址、客户 metafield 与 Cart 写入和匿名化使用同一客户行锁；已持子行的直接 UPDATE 使用 NOWAIT 避免反向等待，内容/配额修改写父行版本保护 REPEATABLE READ。

`commerce.carts` / `cart_lines` 启用 RLS 且不向 API 角色授予裸表权限，凭据哈希不会进入 DTO。显式命令校验归属、版本、状态和大小；延迟约束校验 50 行/100 件及 converted Cart 与 Quote 的商业行一致性。Cart 过期/放弃不等于订单或 Quote 到期，清理不改资金与库存。Cart 中引用的运法/变体删除仍受 FK 约束，停用不影响保留意向，转报价时重新验证。

[`customers-carts.test.ts`](../tests/customers-carts.test.ts) 覆盖独立身份/同邮箱不合并、账号解除关联、NULL 授权、匿名化和内容写入交错、凭据隔离/认领竞态、版本/旧快照/配额、过期清理及 Cart → Quote → 手工/PayPal 两条付款路径。匿名限流、凭据 cookie/日志治理、生产规模吞吐与数据保留政策仍由部署方落实。

## 退货与实收处置

`commerce.returns` / `return_lines` 保存单次发货的授权，`return_receipts` / `return_receipt_lines` 保存地点与实际数量，`return_dispositions` 保存分次验收结果及回库流水引用。五表均隐藏、启用 RLS，无 API 角色裸写权限。指纹同时校验明细集合，提交时验证发货/授权/实收/处置数量守恒；闭合授权只释放未实收部分。

退款恢复库存已收拢到共享退款行触发器，`restocked_quantity <= cancelled_quantity`；手工和异步完成不再维护两套直接回库代码。取消恢复记 cancel 流水，实收回库记 return 并与 disposition 唯一绑定。`recover_order_stock` 以原负流水和累计恢复额为兜底，实际库存仍非完整物理仓储模型。

[`returns-receipts.test.ts`](../tests/returns-receipts.test.ts) 覆盖分批/关闭/报废、零价与无扣减商品、同 SKU 商业行、原扣减/显式目的仓、先退款/先收货、PayPal 重放、权限/匿名化、指纹防添行、原子回滚及授权/收货/处置与报价/撤销发货的受控并发和旧快照。仓储政策、国际逆向运输、实际商户验证与生产基数性能仍需部署方落实。

## 基线合并背景

基线保留当前实际使用的数据模型、RPC 签名和权限，只移除重复定义、已被覆盖的补丁、schema 搬迁和历史回填步骤。
即时扣库下单、`*_v2` 幂等包装及支付/履约投影仍有内部调用和测试覆盖；它们不是历史迁移，可单独调整业务调用链后再整合，不能与删升级脚本混为一谈。
