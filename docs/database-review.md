# 数据库深度审阅与修复闭环

审阅基点：`b7bac3f`。本轮直接修改未部署的初始化基线，既有本地数据库需要重建；不是已部署环境的数据升级脚本。

## 已修复的八项问题

| 编号 | 原始实测证据 | 修复后的合同 |
| --- | --- | --- |
| R1 退款发出/取消竞态 | 已进入模拟渠道 POST，取消及替代退款均 200；原 COMPLETED 响应绑定失败，API 路径未记录资金 | POST 前 `prepare_paypal_refund` 持久化不可清除标记；未绑定但已发出也不能无确认取消。终态不再 POST；不明响应保留预留及幂等键，超过一小时停止 POST，可信绑定后仅 GET 恢复 |
| R2 库存锁死锁 | Quote 按 variant A→B，退款按 item UUID 对应 B→A；手工出现 40P01，PayPal 退款停在 processed/action_required | 退款/取消预锁全部原库存；批量过期按整个批次统一 `(variant_id, location_id)` 锁。变体使用兼容 FK 引用的 NO KEY UPDATE。瞬时错误 received + 退避，不再误判为商业冲突 |
| R3 即时下单绕过生命周期 | Quote 拒绝 101 件，即时入口接受；未来时间运行 Quote Worker 后仍占库 | 三个入口共享 50 行/100 件、每客户 5 个活跃 checkout。即时订单 15 分钟付款窗口，专用 `expire_unpaid_orders` 幂等回库；所有订单先付款再履约 |
| R4 非有限金额 | NaN 商品价能生成 paid 订单及 NaN capture | 所有业务 numeric 列排除 NaN / ±Infinity，促销金额/百分比/门槛同样受限 |
| R5 头行金额不守恒 | 受信写入把商品行改为 100，头部仍 10，付款成功且 is_balanced=true | 行毛额 CHECK + 所有订单头行延迟约束；完整改价必须在同一事务内，账本平衡也校验行汇总 |
| R6 Outbox 无 fencing | 同名 Worker 的旧 attempt 可确认新 attempt；新领取者决定旧租约时长 | 持久化 lease_expires_at / lease_token，确认同时验证 owner/token/期限；过期或旧任务返回 false |
| R7 对象授权过宽 | anon SQL 角色能 TRUNCATE 全部地址（实验回滚） | 客户角色只保留逐表/列的业务读写权限，无 TRUNCATE/TRIGGER/REFERENCES/MAINTAIN 或序列能力 |
| R8 幂等键跨客户冲突 | 两个客户不同订单复用同一键，第二笔 400 | 本地 PaymentIntent 键改为 `(order_id, provider, idempotency_key)`；PayPal 仍使用意图 UUID |

R1 使用真实生产 handler / 本地 Auth / PostgREST，只模拟渠道 HTTP；没有声称发生了两次真实外部退款。R5 属于受信写入不变量，不是普通客户可直接改价。R7 需要 SQL 执行能力，原审阅没有发现匿名 HTTP TRUNCATE 入口。

## 正式回归

原 opt-in 审计脚本已由断言“缺陷不可发生”的正式回归替代，不再维护一份将旧错误结果视为成功的实验脚本。

- [`database-review-fixes.test.ts`](../tests/database-review-fixes.test.ts)：真实退款 handler 的发出/取消窗口、取消先提交、网络歧义及陈旧重试；并发共享配额、付款期限、迟到 Capture；NaN、头行守恒、Outbox token、SQL 角色权限和跨客户幂等。
- [`inventory-concurrency.test.ts`](../tests/inventory-concurrency.test.ts)：手工退款、PayPal 退款、取消、批量过期四种实际命令与 Quote 的受控交错。测试专用 AFTER trigger 仅暂停实际库存更新，通过 advisory barrier / pg_blocking_pids 确认锁等待，不禁用业务不变量。
- [`provider-retry.test.ts`](../tests/provider-retry.test.ts)：分别向 capture / refund 本地入账注入 40P01、40001、55P03，确认保留外部资金、退避、自动恢复及幂等库存。故障触发器与资金实验整体回滚。
- 原有回归保留；履约顺序改为先付款，独立测试不再累积同一客户的未付款额度，Outbox 测试改为传领取 token。

## 数据库约束与命令分工

| 不变量 | 数据库兜底 / 受控命令 |
| --- | --- |
| 有限 USD 金额 | 各业务 numeric 有限值 CHECK、内部 USD CHECK、促销参数 trigger |
| 行金额乘积、头行汇总 | order_items CHECK、orders / order_items 延迟 constraint trigger |
| 已支付/活动意图快照不变 | 订单及商品行 snapshot triggers；直接商品行写入 NOWAIT 订单锁 |
| 付款窗口不可延长 | orders.payment_expires_at / created_at trigger；意图期限绑定订单并不可改 |
| 客户配额 | 客户级 advisory lock，Quote + 未付款订单统一计数 |
| 库存顺序与回库 | lock_order_inventory；取消/退款以原负流水为准，批量处理预锁整个集合 |
| 外部退款发出不可撤销猜测 | prepare_paypal_refund + 不可清除 marker + cancel 渠道确认门槛 |
| 外部成功资金与本地入账分离 | Provider Inbox / money movements；瞬时错误退避，商业冲突 action_required |
| Outbox 确认归属 | 持久化租约与 token；complete 原子比较并检查未过期 |
| 客户权限 | 对象/列 allowlist + RLS + RPC 归属/管理员检查，不以 RLS 替代 ACL |

## 发布注意事项

- **新增必需 Worker：`expire_unpaid_orders`**。与 `expire_checkout_quotes` 各自独立 RPC / 事务执行；不能把两者包进同一 SQL 事务而破坏 quote → order → inventory 锁顺序。
- **Outbox complete 新增必填 `lease_token`**；使用 claim 返回值。消费者仍需幂等，不保证外部副作用 exactly-once。
- 未付款发货不再允许；商品行/订单头分两个 HTTP 请求写入也不再允许。前端和受信导入应使用最新合同与生成类型。
- Inbox 瞬时错误按 next_attempt_at 重试；失败、25 次重试耗尽、未知资金及陈旧未绑定退款需要告警/人工对账。
- 初始化基线、API、ADR 与部署文档已同步；操作示例见 [支付与部署](../supabase/functions/README.md)。

## 验证结果与边界

最终重建回归：**276 pass / 0 fail / 2319 次断言**（原 254 项，新增 22 项）。SQL lint 检查 161 个函数/触发器场景，0 个未审阅问题，6 个精确例外；生成类型一致性、TypeScript、文档链接、密钥扫描通过。五个支付入口均在实际 Deno Runtime 加载，GET 返回预期 405。

验证只使用本项目可丢弃的本地 Supabase，数据库为 PostgreSQL 17.6、宿主映射端口 54322；没有访问或重置宿主 5432，也没有调用真实 PayPal。

本地回归不替代真实 Sandbox、商户 USD 能力、Webhook 配置和渠道幂等保留期验证。原审阅的外键索引清单只是保守候选，不是必须补齐的索引缺陷；没有以小样本宣称生产吞吐达标。生产规模执行计划、备份恢复演练及隐私/税务保留策略仍属于上线工作。
