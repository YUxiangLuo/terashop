# 外部 Review 的实验复核与修复

基点：[`ca5a4ca`](https://github.com/vesein/tera-headless/commit/ca5a4ca8c5a941e39c8238a7ca996d77ae9843d1)。
来源：[用户提供的 Review](https://chatgpt.com/share/6aa6b719-4528-83ee-9564-a670f03cbfd6)。
环境：本项目本地 Supabase / PostgreSQL 17.6；先在可丢弃数据库复现，再修改未部署初始化基线、重建并回归。不修改生产数据库，不调用真实 PayPal。

## 按风险顺序修复

| 顺序 | 问题与未修复实验 | 修复后的合同与回归 |
| --- | --- | --- |
| R1 | selected 买赠的 buy/get 重叠时，同一件商品既满足购买又被赠送；存在 $110 毛额、$100 错误优惠、$10 应付的实际订单，并非只影响预览 | 买赠购买/赠送单位互斥，保留交集购买预算；覆盖相同集合、商品/变体间接交集、部分重叠、1+1 / 2+1 / 1+2 数量边界、属性拆行。见 [promotions](../../tests/promotions.test.ts) |
| R2 | Outbox 第 25 次领取后进程崩溃，租约过期却既不能 complete 也不能再次 claim | exhausted 状态、有界清理、service-only 人工重投、累计次数与不可变审计；原 token 失效，重投重放不能重置新租约或 published。见 [transaction-ledgers](../../tests/transaction-ledgers.test.ts) |
| R4 | 先开始的事务后取得退款锁，按 created_at 选“最新退款”会把两个幂等键都绑定到另一笔退款；没有观察到重复退款金额 | 内部函数直接返回本次退款 UUID，包装绑定该资源；受控锁屏障验证 $3/$4 各自关联、重放后合计仍为 $7。见 [payment-concurrency](../../tests/payment-concurrency.test.ts) |
| R5 | 定义改为 number 与 text 值写入并发，可留下类型冲突；无定义时并发新增定义同样有漏洞，RC/RR 均复现 | 按逻辑字段键串行化，并用持久 guard 的真实版本写冲突拒绝旧 RR 快照；争用要求重试事务。见 [database-design-concurrency](../../tests/database-design-concurrency.test.ts) |
| R6 | 新 Storefront DTO 隐藏停用变体图片，但旧图片表和 product_listing 仍可公开读取 | 旧表/视图与新 DTO 一致过滤；管理员底表仍可管理图片，Storefront 不升权。见 [catalog-api](../../tests/catalog-api.test.ts) |
| R3 | 客户零元订单停在 pending，只能由管理员完成 | 转单校验后原子消费预占、标记 paid；不创建支付意图或伪造资金流水。覆盖直接下单/显式 Quote × 零价/全额优惠、重放、过期拒绝。见 [inventory-reservations](../../tests/inventory-reservations.test.ts) |
| R7 | 旧列表物化全店预占；共享库存函数扫描目标 SKU 的历史 Quote 行 | 增加事务性预占工作集，终态删除；旧列表按目标变体查询，新 DTO/结账共享工作集。覆盖回滚、转单、付款、批量写入超卖、篡改/权限与实际 SQL 计划。见 [inventory-working-set](../../tests/inventory-working-set.test.ts) |

### R2 需要区分 Outbox 与 Inbox

Inbox 自动 Worker 在 25 次后停止，但可信原事件再次入箱仍可处理到第 26 次，并且保持资金幂等。因此没有新增另一套 Inbox 重投接口；保留既有入口，补充精确 envelope 恢复流程。

[provider-retry](../../tests/provider-retry.test.ts) 在捕获/退款路径分别注入真实 PostgreSQL 瞬时错误，运行至 25 次；移除故障后验证 Worker 停止、原 envelope 两次重投成功、交易与库存各只落一次。故障注入不禁用生产完整性触发器。

## R7 的性能证据与限制

修复前的 `EXPLAIN (ANALYZE, BUFFERS)` 实验：

| 查询 | 额外数据 0 / 1,000 / 10,000 行 | 执行时间（ms） |
| --- | --- | --- |
| 固定 5 商品的旧列表 | 无关商品的预占 | 0.184 / 1.715 / 24.993 |
| 固定目标 SKU 的库存汇总 | 目标 SKU 已取消的历史报价行 | 0.052 / 5.821 / 16.227 |

修复后的正式回归从数据库读取库存函数的实际 SQL，而非维护一份测试副本；保留目标 SKU 3 件预占，逐步增加 0 / 1,000 / 10,000 条已取消历史报价，所有触发器均开启。
一次本地样本为 **0.017 / 0.154 / 1.579 ms**，共享命中块 **1 / 25 / 234**。执行计划只访问 `inventory_reservations`，不访问历史报价头/行；旧列表的索引条件包含目标 variant/location。

这些数据不是同一数据集上的生产基准，也不代表固定加速倍数或生产 p95。正式测试在同一未提交事务中生成并删除工作行，不能执行 VACUUM，因此仍观察到死元组开销随批次增长；不声称查询成本与维护状况无关。部署必须运行 Quote 过期 Worker，并监控 autovacuum、死元组及工作集积压。回归断言查询对象、索引可用性和正确数量，不以机器相关耗时阈值判定通过。

## 运行与边界

```sh
bun run test --integration
bun run test:unit
bun run db:lint
bun run types:check
bun run typecheck
bun run docs:check
```

最终从基线重建后的结果：**475 项集成测试通过、0 失败（41 个文件）**；另有 **18 项单元测试通过、0 失败**。SQL lint 检查 281 个函数/触发器上下文，0 issues，保留原有 3 个精确审阅诊断；生成类型漂移、TypeScript、文档链接及 `git diff --check` 均通过。

补充的受控并发实验先复现了“受信直接 INSERT 等待 Quote 取消后重建预占”的漏洞，再由父 Quote 锁修复并通过回归。全量完成后的只读校验确认：工作集与未终结 Quote 行的差异为 0，Metafield 定义/值类型冲突为 0，待执行订单校验队列为 0。

业务合同见 [ADR](../architecture-decisions.md)，客户端零元结账见 [API](../api.md)，人工重投与告警见 [支付与部署](../../supabase/functions/README.md)。
本轮修改的是未部署基线，不是已有线上数据的升级脚本；通用 Outbox 消费器、调度、告警接入以及真实渠道 Sandbox 恢复演练仍由部署方完成。
