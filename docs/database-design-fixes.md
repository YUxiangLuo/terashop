# 数据库设计复审：实验与修复

基点：`76cba7b`。本轮修改未部署的初始化基线，必须重建可丢弃的本地数据库；不是生产数据升级脚本。

## 实验方法

先添加断言“错误不可发生”的正式回归，在**未修改的数据库基线**运行：24 项中 22 fail / 2 pass。
失败覆盖下表所有问题；READ COMMITTED 库存对照和保存点回滚对照通过。之后修改基线并重放迁移，不通过关闭触发器、修改隔离级别或削弱断言消除错误。

- 使用本项目 Supabase / PostgreSQL 17.6，端口 54322；不操作宿主 5432，不调用真实 PayPal。
- 并发测试以事务屏障建立旧 REPEATABLE READ 快照，等待另一个真实命令提交后再恢复旧事务，不依赖 sleep 猜测交错。
- 促销、类型、订单号及计时实验使用可回滚事务；并发中的订单/报价使用独立测试客户和商品。完整回归重置的也只有本项目本地数据库。
- 性能计数使用 `track_functions=all` / `pg_stat_xact_user_functions` 的前后差值；计数是回归合同，耗时只作本机观察，不代表生产 p95 或吞吐。

## 证据与修复合同

| 问题 | 未修复实验 | 修复 |
| --- | --- | --- |
| 最后一个促销目标消失 | 删除 category / product / variant / 关联行后，无关 $10 商品优惠由 $0 变 $5；买赠 get 目标消失也会回退为赠送 apply 商品 | 持久化 `apply_scope` / `get_scope`，selected 空集合匹配零商品；插入目标自动收窄，删除不扩大；扩大范围必须显式修改 scope |
| RR 库存预占 | on_hand=1，两个不同客户报价均提交，reserved=2；旧事务也可通过即时下单/库存调整穿透新预占 | 预占行 INSERT 更新同一 inventory level 的 `reservation_revision`，形成真实写冲突；旧快照以 40001 失败，不伪造物理库存流水 |
| RR 连续部分履约 | 订购 4，已发 1，两个事务各发 2，总履约变 5；RPC 和受信直接 INSERT 都可发生 | 每次插入 fulfillment line 都写父订单版本，不能以投影状态未变为由省掉同步写入；保留 NOWAIT 及现有数量检查 |
| 重复整单校验 | 1 / 10 / 50 行订单分别执行 12 / 57 / 257 次完整校验 | 隐藏的事务性订单校验队列按 order_id 去重，延迟触发时消费标记并校验；对应次数均为 1 |
| Metafields 类型/owner | `not_a_type` 可存储；删除商品/变体/分类留下孤儿；并发与旧快照同样能绕过 EXISTS | 类型 CHECK + 未知类型显式拒绝；五个由 owner_type/owner_id 生成的路由列建立真实 FK，父对象删除级联清理，不接受伪造路由列 |
| 订单号 | `OVERRIDING SYSTEM VALUE` 可导入重复订单号 | `UNIQUE(order_number)`；订单创建后 ID / 对外订单号不可改写 |
| 跨单明细查询 | 实际 `order_pricing_json` SQL 的部分优惠/税查询仅按非索引首列过滤 | 子查询显式增加 order_id，复用现有复合索引；商品税仍允许选择更精确的 order_item_id 索引，不强制单一 cost-based plan |

第 2、3 项是 SQL REPEATABLE READ 的缺陷，不声称普通默认 READ COMMITTED HTTP 请求已出现超卖。

## 关键设计边界

### 促销范围

- 商品百分比与买赠的 apply 范围：`all` 或 `selected`；买赠 get 范围：`same_as_apply` 或 `selected`。
- 创建定向促销时直接传 selected，或先以 inactive 创建，再配置目标、启用；不要先公开 all 再分请求补目标。
- 插入/编辑目标在父促销上 NOWAIT 取锁并写版本；已存在目标时不允许直接重设 all / same_as_apply，须先删除对应目标再明确重设。删除父促销本身仍可级联删除关联。
- 规则、scope 与目标数组从同一条 SQL 的 MVCC 快照读取，并共同进入报价 hash 和订单促销快照，避免旧 scope 与新目标混搭。
- 整单百分比/固定金额及免邮保留原有整单语义，不借此扩展条件 DSL 或改变优惠算法。

### 库存与履约

`reservation_revision` 仅为并发同步版本，不是 reserved 数量，也不是新的库存账本。预占仍从有效 Quote 行汇总，on_hand 及 inventory_movements 的语义不变。库存锁顺序仍按 variant/location；客户配额锁不能代替不同客户共享的库存版本冲突。

履约版本写入放在共享行触发器，不仅放 RPC 包装中；即使 `refresh_order_fulfillment` 跳过未变化的状态投影，也不会跳过对新事实的并发保护。

### 订单校验队列

`private.order_validation_queue` 启用 RLS，不授予 anon / authenticated / service_role 表权限。业务 AFTER trigger 只安排校验，同一订单在排队期间仅占一行。唯一的 deferred constraint trigger 消费队列并运行原有完整金额/税/配送不变量。

先移除排队标记再校验，因此 `SET CONSTRAINTS ALL IMMEDIATE` 之后的新修改会重新入队；保存点的回滚同时回滚标记与数据，不使用事务 ID GUC 或“本会话已检查”的跳过标记。强制校验后再次非法修改、保存点回滚后再修改、两张订单独立校验和真正 COMMIT 时拒绝不完整订单均有回归。

这次没有删除快照保护、父行版本写入或提交时兜底。Quote / Return 的延迟校验不在此队列中，不能把本轮计数结果外推为所有交易函数均已批量优化。

### Metafields

保留现有 owner_type / owner_id 输入合同。`owner_*_id` 是自动生成、不可直写的 FK 路由，不是第二套可编辑归属；相应部分索引服务于真实 FK 的级联删除查询。原 EXISTS 检查保留可读错误，真正的并发完整性由 PostgreSQL RI 保证。

Customer / Order 自身仍不可删除，匿名化继续使用原客户锁及清理流程。shop 继续使用单店约定；Metaobject JSON 引用、definition 的发布/版本规则没有被本轮改造成新内容系统。

## 正式回归与运行

- [`database-design-integrity.test.ts`](../tests/database-design-integrity.test.ts)：目标删除、买赠、显式 scope、类型、owner FK、不可伪造路由和订单号。
- [`database-design-concurrency.test.ts`](../tests/database-design-concurrency.test.ts)：预占/下单/调整、部分履约、owner 删除的旧快照，以及 READ COMMITTED 对照。
- [`order-validation.test.ts`](../tests/order-validation.test.ts)：真实函数调用计数、保存点/强制校验/COMMIT、队列权限与实际 SQL 执行计划。
- 既有退货指纹测试增加 order-first 锁屏障，避免前一个失败事务尚在清理时，被 NOWAIT 瞬态错误抢先中断预期的指纹断言；保留原错误断言和独立的受控并发测试。

```bash
bun run test
bun run db:lint
bun run types:generate
bun run types:check
bun run typecheck
```

最终从基线重建后的全量结果：**413 pass / 0 fail，35 个测试文件**。本轮新增 28 项回归；连同既有退货回归的定向运行为 58 pass / 0 fail。SQL lint 检查 265 个函数/触发器上下文，0 issues，仍为原有 3 个精确审阅例外；类型自动生成后漂移检查、TypeScript 检查及 `git diff --check` 均通过。提交完成后校验队列剩余 0 行。

50 行、单一促销与测试税规则的本地观察：未修复完整建单及延迟校验样本为 1909 ms；最终完整回归为 160 ms，其他修复后样本为 234 / 374 / 531 ms，对应完整校验次数稳定由 257 降至 1。环境热缓存/调度会改变耗时，测试不使用耗时阈值作为生产性能承诺。

双下单路径、payments/payment_transactions 双模型和 fulfillment JSON/关系表的进一步收敛，仍是独立架构重构建议，不与本轮缺陷修复混合。真实渠道 Sandbox、生产基数查询、备份恢复和隐私保留策略仍需上线前验证。
