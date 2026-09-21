# 架构决策

本文维护当前业务不变量；调用示例见 [API](api.md)，schema 组织见 [数据库开发](database.md)，渠道配置与 Worker 见 [支付与部署](../supabase/functions/README.md)。
本文是当前规则，不是按时间追加的变更日志；保留 ADR 编号以稳定引用。迁移策略见 [数据库开发](database.md)，历史实验见其归档入口。改变业务规则时同步更新所属 ADR 与回归测试。

按主题阅读：部署与权限（001、006）、金额与定价（002、005、007、015）、订单与库存（003、004、010、014、024）、支付与账本（008、009、011、025）、客户与 Cart（012、016、017、023）、目录与管理（013、019–022）、退货（018）。

## ADR-001：部署模型

一个 Supabase 项目承载一个店铺，核心表不增加 `store_id`，以简化交易查询、唯一约束、RLS 和库存锁。
共享数据库多租户不在当前范围；引入前须完整设计 tenant key、复合唯一键、跨租户 RLS 和运维隔离，不能只给部分表补列。

## ADR-002：货币与舍入

- 商品、运费、固定金额促销及交易统一使用 USD；数据库约束内部订单与资金账本的币种，Edge 不能单独承担该校验。金额使用 `numeric(12,2)`，不以浮点数存储或比较。
- 所有业务 numeric 列显式排除 NaN / ±Infinity；促销 JSON 的金额、百分比和门槛同样要求有限值，不能把精度或非负 CHECK 当作有限值校验。
- 每个调整先用 PostgreSQL `round(numeric, 2)` 舍入再汇总。
- 整单优惠按剩余净额，以整数分最大余数法先分摊到变体，再分摊到该变体的商业行；余数降序，以变体 UUID / `line_key` 升序打破各层平局，合计严格等于目标优惠。
- 分子使用精确 `numeric` 整数乘法与 `div/mod`，避免 bigint 溢出和除法舍入；行优惠不得超过行毛额。
- 两位小数和整数美分是明确的 USD 合同，不是通用币种算法。当前不提供多币种、价格表切换或自动汇兑；真实非 USD 外部资金仍单独记录并对账，不能冒充 USD 结算。

## ADR-003：订单快照不可变

所有客户订单均由 Quote 转单，商品、价格、税、运费和地址快照自建单起不可原地重算，trigger 同样约束 service role；退款字段仅由受控流程单向推进。未付款改址须取消后重新结账。
后续商业变更必须由独立事实表达，而不是覆盖原始记录。退款与相关 Adjustment 账本已实现；通用 Order Edit、任意调价和补扣接口尚未实现，不能据此假定已有可调用命令。
所有订单（包括非 Quote 订单）必须有商品行；行毛额等于单价 × 数量，订单 subtotal / discount_total 等于行汇总。延迟约束在提交时校验，允许同一事务先头后行构建，但不允许分两个 HTTP 请求留下不完整订单；账本 `is_balanced` 也检查头行一致性。
`order_number` 有 UNIQUE 约束，创建后与订单 ID 一样不可变，identity 不代替唯一性。整单校验通过隐藏的 `private.order_validation_queue` 按待检订单去重；触发时消费标记，强制校验后新改动重新排队，保存点回滚同时回滚标记，不以会话缓存跳过检查。

活动 PaymentIntent 同样锁定未支付订单的商业快照。
金额/币种错配的资金进入对账，不改写意图金额来掩盖错配。
地址编辑与意图创建共用 quote → order 锁；结算使用 intent → quote → order，不能先锁 order 再等待 intent。
直接商品行写入只以 NOWAIT 获取订单锁，竞争时返回 409，避免在已持商品行锁时反向等待订单锁。

## ADR-004：库存与履约数量

库存生命周期见 [ADR-024](#adr-024单一下单管线与简化库存语义)。订单及意图的付款期限不可延长，转单沿用报价期限；本节维护工作集、并发与履约数量规则。
`inventory_movements` 只记录真实 on_hand 变化；取消/退款以原始负流水为回补依据，不依赖变体当前的库存配置。所有订单必须先付款再履约，避免未付款却已出库的订单无法安全过期。

有效预占从内部 `commerce.inventory_reservations` 工作集读取，不再扫描历史 Quote 行。报价行 AFTER INSERT 在取得 Quote/库存锁、校验额度后写入工作集；转单保留，completed/cancelled/expired 的 AFTER trigger 删除，保存点/事务回滚同时恢复。工作行必须匹配不可变报价行，禁止修改、提前删除或 TRUNCATE，不向 API 角色授权。查询仍检查 expires_at，Worker 延迟不延长预占；Worker 负责清理过期工作行，数据库 autovacuum 负责回收死元组，二者均须监控。历史快照和物理流水保持原义，工作集不是第二套可编辑库存账本。

每次预占行 INSERT 都更新相应库存行的 `reservation_revision`，但不改 on_hand、不记物理流水。单纯行锁不能防止 REPEATABLE READ 旧快照漏看其他客户的预占；真实版本写冲突要求调用方重试整笔事务。每条新增履约事实也写父订单版本，即使连续部分履约没有改变状态投影，RPC 与受信 INSERT 都不能绕过。

库存统一按 `(variant_id, location_id)` 取锁；退款在分摊前锁全部原库存。未付款取消/过期不产生库存流水。结账的变体锁使用 `NO KEY UPDATE`，避免与库存流水 FK 的 `KEY SHARE` 形成反向等待；不能先锁库存再取得 Quote 锁。

按行退款优先取消未履约数量，分别在 `refund_request_lines.cancelled_quantity` 预留、`refund_lines.cancelled_quantity` 固化。
可新履约数量 = 订购数量 − 活跃履约数量 − 已成功取消数量 − 活跃退款请求预留的取消数量。
`get_order_fulfillment_balance` 向订单客户、管理员和 service role 返回安全数量 DTO；不可履约订单的 available 为零。
金额型退款不推测商品取消量，但全额退款订单禁止新增履约；存在按行退款事实或活跃请求的履约不能再通过取消履约释放数量，应走退货/新订单流程。

管理员通过 `update_fulfillment` 更新状态和物流，不能改商业行或归属。命令按订单 → 履约顺序取锁，以 `expected_version` 防止丢失更新；履约每次 UPDATE（包括 service 写入）由 trigger 推进版本，禁止调用者直接指定版本。命令的无变化请求不执行 UPDATE。独立店铺级幂等记录与更新同事务提交，重放返回当前 DTO 而不重新应用旧请求。物流变化通过 trigger 写前后值审计与 Outbox；状态变化沿用原状态机、取消保护及订单投影刷新。取消履约本身不代表退货入库或退款。

## ADR-005：促销计算

当前引擎按 priority 贪心选择，不寻找全局最优组合；条件与 action 参数保存在受校验的 JSONB 中，目标范围支持商品、变体及分类闭包。
商品百分比和买赠先按变体聚合数量/剩余额度确定收益，再分摊到商业行；整单优惠同样先分摊到变体。客户可控属性和商业拆行不得放大舍入优惠，也不能改变后续促销的 SKU 级可用额度。
免邮只记录实际收益：已满额包邮时不占独占资格，零收益独占免邮被跳过；最早的可叠加免邮可在后续优惠使金额跌破包邮线时延后生效，但不能穿透独占商品优惠。

商品百分比/买赠使用持久化 `apply_scope=all/selected`，买赠的赠送集合使用 `get_scope=same_as_apply/selected`。插入目标自动收窄；删除最后一个目标仍是 selected 空集合，不扩大为全店或回退同款买赠。扩大范围须先删除对应目标，再显式重设 scope；创建定向活动应从 selected 或 inactive 开始，不能先公开全店活动再分请求补目标。目标变更写父促销版本并使用 NOWAIT；规则、scope、目标从同一 SQL 快照读取并进入 hash。整单优惠/免邮保留原有整单语义，本次不扩展目标 DSL。

同一买赠内，购买资格与赠品必须占用不同实物单位；selected 的 apply/get 集合即使经商品或分类间接重叠，也不能让赠品同时满足 buy。先求最大可行赠品数量，再按单价/UUID 选择最便宜赠品，同时保留交集中的购买数量预算。相同集合与 same_as_apply 一致，买一赠一的 1/2/3 件分别赠 0/1/1 件。其他促销的叠加仍按原 priority 和剩余金额规则处理。

匿名价格预览、Cart 编辑、Quote 和便捷下单共用 `canonical_checkout_lines` 的输入预算：原始数组最多 100 项，`items::text` 的 UTF-8 字节数最多 1 MiB；逐行校验前检查这两项。先拒绝过长的数量数字，避免 integer 溢出；再安全累计限制为 100 件，合并后最多 50 条商业行。允许 100 条相同输入合并成 1 行，不能把原始行数限制误设成 50。买赠购买轮数起点至多 100（含零轮兜底最多 101 次条件检查），不再依赖调用方各自限量。空 Cart 仍允许，空预览/Quote 仍拒绝；通用库存/订单项数量规范化不承载此业务上限。

1 MiB 限制针对已解析 JSONB 的文本表示，不是 HTTP 请求体上限，不能避免上游接收/解析巨大 JSON 的成本；网关请求大小、超时和限流仍是部署要求。

当前已保存实际应用顺序、规则/目标快照与关系化分摊；它们不是可编辑促销的发布版本。
版本化发布、候选组合选择和条件 DSL 仍是后续设计，不是已实现能力；替换当前贪心引擎前须双算验证。

## ADR-006：API 与权限

`public` 暴露部分业务表与 RPC，`private` 存放内部函数、目录树同步哨兵及事务性订单校验队列，`commerce` 保存交易事实且不对 PostgREST 暴露。
表启用 RLS，新对象默认不授予客户端权限；已有对象也按表/列列举 SELECT / INSERT / UPDATE / DELETE 授权，anon/authenticated 不得拥有 TRUNCATE / TRIGGER / REFERENCES / MAINTAIN 或序列权限。显式 DTO 选择字段，内部表不是长期 Storefront 合同。`api` / `admin_api` 分层仍是演进目标。
管理员与客户同属 `authenticated` 角色；订单状态、支付、履约和库存写入必须走受控命令，不能依靠客户端区分管理员。

角色管理命令更新独立 guard 后再验证管理员身份与最后管理员数量；原 advisory lock 不能独自保证旧 RR 快照安全。此保证针对 `set_user_role`，受信初始化的直接 profiles 写入不属于该命令合同。

## ADR-007：税务范围

当前按两位国家码选择单一有效比例税率，国家规则优先于 wildcard `*`，`include_shipping` 控制运费计税；国家码统一为大写。不内置任何国家的税率，seed 不安装税务规则。
地址缺失的商品预估不计算目的地税；正式报价和下单必须提供国家。没有匹配规则时返回零税额，只是当前计算结果，不表示当地免税或已完成税务合规，部署前必须配置适用规则。
计算状态、规则、基数和实际分摊保存在交易快照中；零税率与未匹配规则分别表达，不从金额零推断免税资格。
州/省、邮编、VAT、免税资格、含税定价及全球税务合规不在范围内，需要专业服务或独立 Tax Quote / Tax Transaction 模块。

## ADR-008：交易账本与投影同步

支付统一直接写 `commerce.payment_transactions`，不再保留 `public.payments` 中转表。`orders`、`fulfillments.items`、`order_items.refunded_*` 与关系化的
`order_adjustments`、`payment_intents`、`payment_transactions`、`fulfillment_lines`、`refunds`、`refund_lines` 和退款金额组件在同一事务内保持一致。
渠道退款先进入状态受限的 `refund_requests`，成功后才写成功账本。
核心账本 append-only，外键采用 `ON DELETE RESTRICT`；不得把模型/账本同步拆成两个网络请求。
订单创建、履约创建和手工退款分别只公开 `create_order`、`create_fulfillment`、`refund_order`，通过必填幂等键、请求指纹与事务内幂等记录支持重试。不保留版本后缀、兼容别名或非幂等公开重载；履约创建和退款的内部写入由 private 函数承载。

`create_customer`、`adjust_inventory`、`mark_order_paid` 同样要求幂等键，各有独立店铺级范围。同键调用通过事务 advisory lock 串行化，业务写入与不可变幂等记录共同提交或回滚；参数冲突拒绝。重放先检查当前权限，再读取绑定资源当前状态，不缓存含 PII 的响应。库存绑定首次解析的仓库，客户匿名化和订单后续退款不会被重放覆盖。HTTP 调用使用默认 READ COMMITTED；更高隔离级别的事务调用者仍须处理事务冲突并重试整个事务。

手工退款内部命令直接返回本次写入的退款 UUID，公开包装将该 UUID 绑定到幂等记录；不能按 created_at 或事务开始时间猜测“最新退款”。同单并发的不同请求分别绑定自己的资源，重放不再次退款。

## ADR-009：支付信任边界与 Outbox

支付创建/捕获和 Worker RPC 仅授予 service role，浏览器不得持有该凭据。
客户/管理员 Edge 入口通过 Auth `/user` 验证身份；数据库最终检查归属/管理员。创建/读取意图与 Capture 准备 RPC 接收 `actor_id`（已验证的 Auth UUID），由数据库映射活跃 Customer，不能把客户 UUID 或请求体中的身份当作认证。
PayPal 通过 OAuth2 调官方 postback API 验证 transmission headers；原始 JSON 作为 `webhook_event` 原样嵌入，不解析后重新序列化；验签后才能入箱。
库存消费、订单状态、交易、审计和 Outbox 在同一事务提交；同一订单最多一个活跃 PaymentIntent。
PayPal Capture declined 后终结当前意图并允许新建 Order。客户端 PaymentIntent 幂等键按 `(order_id, provider, idempotency_key)` 隔离；渠道创建 Order / Capture 分别使用 `ord_` / `cap_` 加去连字符的意图 UUID，退款使用 `ref_` 加去连字符的请求 UUID。同操作重试不换键，不同操作不共用键，不直接复用客户提供的键。

Outbox 存储每次领取确定的 `lease_expires_at` 与随机 `lease_token`。重领不能用新调用者的 lease_seconds 缩短旧期限；complete 必须同时匹配 event、worker、token 且未过期。消费者仍须幂等，租约 fencing 不提供外部副作用的 exactly-once。

Outbox 自动重试有界，耗尽后仅允许受信人工重投。重投必须保留事件身份、累计次数和不可变审计；同一耗尽点的幂等重放不能重置后续处理。次数、请求参数与恢复步骤统一见 [Outbox 恢复](../supabase/functions/README.md#outbox-与-inbox-恢复)。

管理员可读取 Outbox/Inbox 的分页安全摘要并重投耗尽 Outbox；数据库将重投操作者绑定当前 Auth UUID，不接受管理员提供 worker_id。相同耗尽点仍按操作者与原因校验重放，不扩展为无限自动重试。查询不暴露原始事件、错误内容或租约凭据；Inbox 处理可能记账，重投仍留在 service/验签渠道边界，不因增加管理查询而开放。

PayPal Capture POST 前必须调用 `prepare_paypal_capture`，按 intent → quote → order 顺序复核归属、金额、订单及预占，并持久化捕获标记。
普通取消不能穿透该标记，网络错误不清除它；重试先查询渠道，再复用原 Capture 操作键。
Quote 到期仍可释放预占并取消关联订单，不无限延长 hold；这不意味着未知 Capture 已失败，迟到成功资金只入对账，不复活订单或再次扣库存。
`mark_order_paid` 不得先取消仍能扣款的线上意图再手工收款；不明 Capture 保留保护，已终结失败的 Capture 才允许新支付尝试。

Capture 恢复不能依赖浏览器返回或 Webhook 到达：后台只查询已发起的付款并复用 Inbox，不代扣已批准订单、不清发送标记，单次未查到 Capture 不证明失败。候选条件、查询间隔和告警见 [Capture 查询恢复](../supabase/functions/README.md#capture-查询恢复)，浏览器动作见 [接入合同](storefront-paypal.md)。

## ADR-010：Quote 的价格与预占边界

Quote 不提前占用促销 usage；转单时按固定锁顺序锁库存与有限促销，再次计价，只有完整 pricing hash 一致才创建订单，否则重新报价。
Quote 默认 15 分钟、最长 30 分钟。三个客户建单/报价入口共享每次最多 50 行/100 件、每客户最多 5 个活跃 checkout（未转单 Quote + 未过期未付款订单）的限制；客户行 `NO KEY UPDATE` 锁和真实版本写入串行化配额检查，转单/幂等重试不重复占名额。账号/IP 级滥用防护仍需 Edge 限流。
支付成功消费预占，Worker 处理超时订单；Quote 进入 completed/cancelled/expired 时清除临时地址和备注，长期地址/备注快照仅保留在订单。商业行属性仍随不可变的报价/订单明细保留，不属于该临时 PII 清理范围。

## ADR-011：渠道事件、外部资金与异步退款

Inbox 只保存原始事件的 SHA-256 与 allowlist 归一化字段，不保存 customer/payer/payee email 或 OAuth token。
真实成功 capture/refund 先写不可删除的 `provider_money_movements`，再匹配内部交易；金额冲突、订单取消或预占失效时标记 `action_required` 并写 Outbox，不能丢弃资金、伪造库存或静默复活订单。
超出 USD 结账能力的成功资金仍按 PayPal 返回的十进制金额保存并对账，不能推进 USD 订单。
`40P01` / `40001` / `55P03` 等瞬时数据库错误不等同商业冲突：保留资金事实，将 Inbox 留在 received / transient_database_error，按 `next_attempt_at` 指数退避重试本地入账（2–256 秒，Worker 自动重试最多处理 25 次），不重复发出渠道收退款；重试耗尽必须告警。

自动重试耗尽不封死可信事件再次入箱；重投保留原事件身份、hash、归一化 envelope 和累计次数，不重新发出渠道收退款。具体操作见 [Inbox 恢复](../supabase/functions/README.md#outbox-与-inbox-恢复)。

### PayPal

PayPal 是唯一线上渠道，数据库约束意图、Inbox、渠道资金和异步退款的 provider；保留管理员手工收付款账本。
只用 API 绑定的 Order / Refund ID 或已入账 Capture 匹配本地对象，不能靠可变 metadata 自动绑定；早到事件先 unmatched，绑定后由 Worker 重试。
Refund API 的 `custom_id` 可缺省，已绑定 ID 和存在的父 Capture 引用必须匹配；金额/币种错配和 Webhook 父引用冲突先保存成功资金，再对账，不能提前回库。

Order ID 是批准对象，Capture ID 才是资金引用；只有 COMPLETED 消费库存，PENDING 等后续事件。
REVERSED 记录外部退款方向异常、阻止继续退款并触发对账；即使先于 completed 到达，也不消费库存、标记已支付或伪造本地退款。关联订单只要存在 action_required 资金事实就暂停履约，包括新增履约及 pending → shipped；暂停状态变化写父订单版本，使旧 RR 快照不能绕过。履约余额 DTO 返回 payment_hold，暂停期间可履约量为零，不篡改已履约事实。
`PAYMENT.CAPTURE.REFUNDED` 的资源是 Refund：资源 ID 是退款 ID，`links.up` 标识原 Capture；与 API 退款观察共用入账路径。未绑定退款先保存资金事实并告警，仅凭已验证且 matched 的 Capture 资金事实关联订单；手工账本的渠道引用不保证真实或唯一，不用于推导归属。缺少该证据时保留 order_id=null，不凭 `custom_id` 认领请求或猜测数量/税/回库；可信绑定后仍可重试入账。pending Refund 由 Worker 查询具体资源；候选用 `SKIP LOCKED` 公平领取并设置最短重查间隔。

已观察到退款资金事实的请求不再进入自动 GET 轮询；其本地处理由 Inbox 的累计 25 次预算负责，避免轮询重新入箱绕过耗尽上限。受信人工重投仍保留原事件身份与累计次数。

### 服务端卡认证策略

卡支付默认关闭。新 Capture 必须符合归属、金额、有效期及 `APPROVED` 检查，真实 `payment_source` 只有 `card`；钱包意图不能用直接卡来源绕过开关。采用 `SCA_WHEN_REQUIRED`：

| PayPal 服务端 Order 的认证结果 | 策略 |
| --- | --- |
| 已 `APPROVED`、卡来源存在、没有 `authentication_result` | 允许 Capture（未被要求 SCA） |
| `liability_shift=YES/POSSIBLE`，若有 `authentication_status` 则为 `Y/A` | 允许 Capture |
| `NO/UNKNOWN`、空认证对象、未知值或显式失败/未完成 | 拒绝新 Capture，返回 `paypal_card_authentication_required` |

这是保守策略：存在认证结果但无法确认责任转移时可能拒绝渠道本可受理的付款，须用实际商户 Sandbox 的免挑战、豁免和未参与 3DS 卡校准，不能全局跳过校验。认证拒绝发生在 Capture 发送标记之前，不伪造失败资金事件；已发现的 Capture 仍优先幂等入账，即使卡开关关闭或认证异常也不能丢弃资金事实。

支付方式是数据库不可变字段，相同幂等键不能变更；新键也不能绕过一个订单一个活跃意图。SDK 取消、失败或超时不授权清标记或重新扣款。浏览器接入与验收见 [卡支付流程](storefront-paypal.md#站内一次性信用卡--借记卡支付sdk-v6)。

### 退款与未自动化范围

退款请求先预留金额/数量，渠道成功后才在单事务写成功账本、更新订单；`restock` 仅按原扣减仓释放预留的未发货取消量，已发货退款不回库。failed/cancelled 释放退款预留。
Refund POST 前必须调用 service-only `prepare_paypal_refund`，重新检查管理员及请求状态并持久化不可清除的发出标记。已发出但未绑定不等于未退款：不明网络结果保留额度，同键重试使用原 Refund 操作键；取消必须先取得可信渠道终态确认。未绑定的终态请求禁止 POST，已绑定重试仅 GET 已知 Refund。未绑定且发出超过一小时的请求停止 POST 重试并保留预留，必须通过可信渠道查询/绑定后恢复；这是本店保守重试窗口，不假定 PayPal 幂等键无限期有效。
同步 `refund_order` 仅用于手工/测试流程，不能穿透活跃渠道退款请求。
PayPal disputes、chargebacks 及 payout/balance reconciliation 仍需 Dashboard 人工监控；没有专用账本前不接入自动退款/库存状态机。

## ADR-012：客户写入与默认地址

地址簿与直接地址快照使用同一解析入口，不推断国家；字段及必填规则见 [地址合同](api.md#地址合同)。
订单表的收货/账单地址国家 CHECK 必须明确为 TRUE，不能让 JSON `country: null` 经 SQL 三值逻辑通过；受信 INSERT/UPDATE 同样受限。账单地址整体仍可为 SQL NULL，提供时则必须含两位大写国家码。
普通客户只能创建 pending 评价，管理员审核后公开；作者修改内容自动回落待审，管理员受权写入不受客户 policy 限制。
默认地址命令先锁活跃 Customer 行，再锁目标地址并清理旧默认；所有新建地址都先取客户锁，`is_default=true` 沿用该顺序。地址/客户 metafield 内容修改与匿名化串行化；已持子行的 UPDATE 用 NOWAIT，竞争时整笔事务重试，不能在擦除后补入旧客户 PII。
客户端仅可 PATCH 地址内容，身份/归属不可变，既有默认值切换必须走 `set_default_address`，service-role 表写入也不能绕过。
唯一索引保证每客户最多一个默认地址；`make_default=false` 或删除允许留下零个，不自动另选。
owner 权限的 `product_listing` 必须显式过滤停用分类；Metaobject definition 停用时隐藏公开子对象，管理员仍可读取修复。

## ADR-013：目录完整性与发布

任何状态均禁止跨商品选项、同一变体同一选项多值、图片关联其他商品的变体。商品及子资源身份/归属不可迁移；分类树禁止任意长度的环。
草稿可分步构建；发布商品至少有一个变体，启用变体必须选全该商品的规格且组合唯一；无选项商品最多一个启用默认变体。停用变体不要求完整/唯一，重新启用时校验；所有变体停用可保留商品，但不可购买。
延迟约束在提交时检查最终状态，允许原子互换规格；多个 HTTP 请求不能留下不完整的已发布目录，需先转草稿。
子资源 INSERT 的父资源必须在当前事务可见；不能先跳过不可见父商品的锁，再依靠外键等待另一个连接提交。目录子资源写入以所属商品行的 `NO KEY UPDATE NOWAIT` 锁及非键更新时间/revision 写入串行化，避免子行 → 发布者反向等待；变体价格/SKU 等非结构更新也推进商品版本，但不触发结构重检。真实行版本变化保证 REPEATABLE READ 旧快照报 `40001`，而不是漏检并发组合。
分类结构编辑通过事务 advisory try-lock 和 `private.category_tree_guard` 单行写冲突串行化；该表启用 RLS，不向客户端或 service role 授权。并发 `55P03` / `40001` 重试整笔事务，不能关闭触发器。当前按受影响商品检查，尚未做大批量目录导入性能验证。

## ADR-014：商业行与库存身份分离

`attributes` 是受大小限制的文本对象，与目录规格 `options` 分开；它不是价格、税率或业务授权。`line_key = SHA-256(variant UUID + ':' + canonical JSON attributes)`，仅相同变体/属性合并数量；所有价格/报价/建单入口共用规范化，未知输入字段与伪造 key 拒绝。
Quote 行有独立 UUID，转单沿用为订单行 UUID；数据库生成 `line_key` 并以 `(quote_id/order_id, line_key)` 保证唯一。无变体的受信订单行以自身 UUID 为 key 的身份源，客户结账仍必须指定变体。支付保护涵盖属性及 key 的来源字段；不得在 BEFORE trigger 中比较尚未重算的生成列。
库存需求、预占和扣减始终按 `(variant_id, location_id)` 汇总；履约/退款仍按订单行 UUID 独立处理。报价消费逐行核对 ID、属性与完整商业快照，不能仅验证相同 SKU 的数量总和。
稳定 key 不等于稳定金额：数量、价格、促销等变化仍参加请求/报价 hash。商业行属性会长期保留，不替代数据保留策略；Cart 使用相同商业 key，但不是交易快照；收费配置、购买计划、套装、退货面单与换货补发尚未实现。

## ADR-015：定价事实与退款组成

订单头是明细的守恒汇总，不新增第二套应收金额。商品折扣分摊、税行、配送毛额/减免/净额采用关系表，促销应用保存规则参数、目标与顺序快照；初始 `order_adjustments` 是同一组头部金额的摘要，不再重复累计这些明细。当前只有一条配送收费和一个国家级比例税率。
Quote 保存受校验且参与 pricing hash 的报价 JSON；转单用商业行 UUID 落关系明细。税务上下文记录 `not_calculated` / `no_rule` / `calculated`，受信无税订单可为 `unrecorded`。命中规则后先按 SKU/配送、再按商业行用最大余数分配整数分，SKU 级结果不受客户拆属性影响。
提交时校验目标/促销/头部优惠守恒、配送恒等式、税基/规则/税额守恒和跨单归属。支付意图与定价明细写入都产生父订单行版本冲突，NOWAIT 防止明细→订单反向等待；REPEATABLE READ 旧快照不能绕过付款快照保护。被历史明细引用的运法/税率/促销只停用，不删除；已支付明细不随配置变化。

按数量退款的商品净额保留在现有退款行中，对应税自动生成组件；配送净额需显式选择，并退对应配送税。税/运费组件引用原订单事实，不参考当前目录或税配置。纯金额/剩余金额退款标记 `unallocated`，不猜商品数量或税/配送归属。
手工和异步请求共用退款计划：各组件按比例舍入、钳制余额，最后一份吸收余数；预留计入数量、净额、税和配送容量。请求 INSERT 持父订单锁并真实写行版本，数据库检查 Capture 已退款和活跃预留总额，包括受信写入与旧快照。失败/取消释放整套预留，渠道成功将原请求分摊固化，逆序完成不重新计价。
退款行净额 + 税/配送/未分配组件 = 退款头 = 资金退款；完整组成在提交时校验，组件 append-only。零总额不是资金退款，不通过虚构零金额支付实现收货/回库。Refund 仍不等于 Return/Receipt，税明细也不是法定税务发票或合规认证。

## ADR-016：商业客户不等于登录账户

Customer 使用独立 UUID；可选唯一 Auth 关联只代表会话归属，联系邮箱非唯一且不参与合并/授权。注册及匿名 Auth 创建总是新建客户，后台可创建无账号客户；当前不提供客户合并或 Auth 重关联，游客自行下单使用 ADR-023 的匿名会话。订单/Quote/地址/评价/促销用量/客户扩展引用 Customer；角色与审计 actor 仍引用 Auth profile。

Auth 删除解除关联而不级联删除商业记录。同邮箱新账号不能自动恢复旧历史，所有可空客户比较必须失败关闭。匿名化清客户联系信息、地址/客户扩展及 Cart，禁止恢复这些自有内容；不删除交易快照/资金、评价正文，也不替代 Auth 删除、会话撤销或法定数据保留流程。

客户行锁统一 Cart、配额、地址和匿名化的串行顺序；内容写入产生真实行版本以拒绝旧快照。子行 UPDATE 使用 NOWAIT，默认地址命令先锁客户再锁地址，不并存另一套地址 advisory mutex。

## ADR-017：Cart 意向与 Quote 承诺分离

Cart 可以为空，只保存商业行与收货/配送/优惠选择，不存金额、不预占库存、不延长订单付款期限。完整替换命令有版本检查，最近一次相同规范化请求可重放；冲突返回 409，不隐式合并/覆盖。50 行/100 件和每客户 5 个活跃 Cart 限额独立于既有 checkout 配额。

游客持 256 位随机、固定期限的单 Cart capability；库内仅存哈希，创建仅返回一次明文。它不是匿名 Auth 账号或支付凭据。登录后必须显式认领，不合并其他 Cart；客户归属与 token 二选一，认领清 token 后旧访客不再有权访问。默认七天、最长三十天，不因访问续期；到期立即拒绝，限量 SKIP LOCKED Worker 物理删除。

转 Quote 必须持注册或匿名 Auth 会话并拥有 Cart，原子沿用商业 key 创建当前报价/预占，再将 Cart 标记 converted；失败不改变 Cart。Quote 仍独立管理价格哈希、库存、期限与资金，转单沿用 Quote 行 UUID，而非 Cart 行 UUID。终态 Cart 不可重开，清理 Cart 不取消 Quote、订单或资金事实。

Cart/行表与凭据不直接授权任何 API 角色，RPC 使用显式 DTO。匿名批量创建/预览仍需覆盖直连 RPC 的网关限流；期限与单对象上限不是防滥用方案。凭据传递/日志、XSS/CSRF、敏感文本和历史快照的保留政策必须单独落地，不声称已完成隐私合规或生产性能验证。

## ADR-018：退货授权、实际收货、处置与资金分离

Return 按一次有效发货授权商业行数量；open 授权占用可退量，closed 只保留已实收占用，cancelled 必须没有收货。Receipt 指明实际收货地点，可多批、可待验收；Disposition 对实收行分次 restock/discard，累计不超过实收。终态不能重开，已实收数量不能再次授权退回；退货不撤销原发货、不增加再次发货额度。

这些操作仅管理员写，客户只能读自己订单的安全 DTO。退货创建/收货的不可变请求指纹同时验证持久行集合，禁止事后添行；FK 保证同订单/Return/Receipt/发货归属。事实 append-only，唯有 Return 可关闭/取消、审计 actor 可单向匿名化。所有操作产生订单审计与 Outbox，而不是调用支付渠道。

退款 `restock` 收紧为未发货取消库存的释放，金额/税/配送组成不变。手工和 PayPal 共用退款行触发器，只在成功资金退款后恢复 `cancelled_quantity` 中有原扣减的部分，记录为 cancel 库存流水。已发货退款的 restocked_quantity 为零；实物退回须独立收货和处置，零价商品也无需虚构零金额退款。

回库统一校验原始负库存事实和累计恢复上限；取消按原扣减地点分摊，实收 restock 写入明确的收货地点并绑定唯一库存流水。当前 track_inventory、默认仓或商品价格变化不是历史库存证据。库存仍统一按 variant/location 排序锁定，新增收货地点不在锁完原仓后倒序追加；父订单真实写版本保护直接写表及 REPEATABLE READ 旧快照。已持发货/退货子行的更新使用 NOWAIT 防止反向等待。

Receipt 不立即增加可售量，未处置数量只是该退货的待验收余额。on_hand 在付款时扣减，代表未售出的库存余额，不是完整实物在库/不可售库存模型；本阶段不引入全仓实物库存、批次序列号、换货、面单、退货费用或自动退款政策。金额退款可在收货前后独立执行，不能把 Return 数量当作税务冲销或退款到账证明。当前无 Return 关联退款命令，既有商品退款仍优先取消未发货量；需要保留未发货履约量时，纯金额退款保持 unallocated，不猜商品或税归属。

## ADR-019：Metafield 类型与 owner 引用完整性

Metafield 类型使用封闭 CHECK，未知类型拒绝；任意 JSON 必须显式选择 `json`。输入仍为 owner_type / owner_id，五个生成的 owner_*_id 列只负责路由真实外键，不接受客户端赋值。商品、变体、分类删除由 FK 级联清理对应扩展值；Customer / Order 的不可删除保护与匿名化合同不变。父对象删除与旧快照写入的并发正确性由 PostgreSQL RI 保证，EXISTS 检查只提供可读错误。

定义与值的类型校验共用 `(owner_type,namespace,key)` 事务锁，范围跨同类 owner，而非单个 owner_id。竞争返回 55P03，内部持久 key guard 的真实版本写入让旧 REPEATABLE READ 快照以 40001 失败；调用方重试整笔事务。无定义的值仍允许写入，但并发新增定义也受同一保护；guard 在内容删除后保留，不能因暂时没有定义/值而删除并失去旧快照防护。

新增定义或修改 validations 时，以与值写入相同的 min/max/choices 规则检查全部既有值；不兼容变更整笔拒绝，不静默改写内容。validations 修改同样推进 key guard。

类型化 Metaobject 引用通过私有派生关系表维护真实外键：删除引用值清理关系，被引用目标及其定义禁止删除，先解除引用再删除。列表 JSON 保留顺序和重复项，完整性关系只存不同目标。该关系不扩展读取权限，也不解释任意 json 字段中的 UUID。

shop 继续沿用单店约定。历史 owner 引用实验、性能计数及重建回归见 [归档设计复审](reviews/76cba7b.md)。

## ADR-020：显式目录读合同与扩展可见性

Storefront 与 Admin 商品列表/详情使用不同 public RPC，输出显式 DTO；无需为了命名分层复制数据库或交易逻辑。Storefront 的发布/字段过滤不随调用者角色扩大，管理员预览也不得得到私有数据。Admin 入口先验证管理员/service 身份，详情可返回成本、草稿及内部扩展。现有底表 API 暂保留授权；商品、订单和客户管理已有基础查询合同，但不代表全部 API 已分层或底表已封闭。

列表使用有界 UUID keyset 分页和精确分类过滤，先限定候选商品再计算默认仓可用量；不复用全店预占聚合，也不承诺库存快照、跨页一致性或已完成生产性能验证。详情只返回活跃变体、其可见图片和启用分类，库存口径与结账共享有效预占函数。

旧 product_listing 也按目标变体索引查询预占工作集，不再物化全店预占。旧视图、匿名/客户 product_images 表读取与 Storefront DTO 均隐藏停用变体图片；管理员的底表读取仍允许管理这些图片，Storefront 输出则不随管理员身份扩大。

Admin 列表独立使用 `(updated_at DESC,id DESC)` 复合索引和游标，按状态、精确分类、名称或 SKU 字面子串筛选；后台可见停用分类及变体。摘要只聚合当前页全部变体的价格范围和数量，不取完整详情、库存或精确总数。游标保留微秒时间戳但不提供跨请求快照，并发编辑可能把未读行移到已翻过范围；编辑前重读详情并沿用 revision 检查。基础子串搜索不引入全文索引或相关性引擎，低命中率搜索成本仍随目录规模增长。

Metafield 定义默认 access=admin；public 仅用于商品/变体/分类/shop，customer 仅用于客户/订单且继续验证归属。没有定义的值默认私有，既有底表 RLS 同样限制，字段类型校验不替代访问控制。Metaobject 定义默认私有；公开对象须同时满足定义 public/is_active 及条目 active。类型化引用只有全部目标可公开读取时才对非管理员显示，定义/目标收紧时无需批量改写引用值；任意 JSON 内容不做递归权限解释。seed 显式声明其展示字段和客户礼品留言的访问级别。

## ADR-021：商品原子编辑与乐观并发

`create_product` 要求调用方提供稳定商品 UUID 和 slug/name，在一个事务内先建立不可被外部读到的草稿，再复用 update_product 完成全部资源与发布校验。默认保留草稿，也可直接发布完整商品；失败连同初始行回滚。不是 upsert，无历史响应缓存，重复 ID/slug 不覆盖；响应丢失先按原 UUID 查询核对，不能换 ID 盲目重试。创建不增加库存数量，不另写一套目录规则。

`update_product` 以一次事务修改现有商品、变体、规格/值/关联、图片、分类关联及商品/变体 Metafield 值，保存即生效，不引入独立发布版本或草稿副本。在售编辑不必先下架，MVCC 保证其他请求只读取已提交数据；沿用底表约束，返回前复用目录最终状态校验，不关闭触发器或修改事务约束模式。

先取商品 `NO KEY UPDATE` 锁，再比较调用者的 expected_revision；不一致返回 409。内部子行取锁使用 NOWAIT，避免与旧子行先锁的写表路径互等。商品 revision 由数据库维护，所有商品更新及目录子资源写入均推进，包括非结构价格/SKU 更新；调用者不可赋值。版本是不可推算的令牌，不承诺每个 RPC 只加一；失败完全回滚，无写入的空补丁不推进。

省略字段不变，新目录子资源使用调用方 UUID，删除须显式声明；规格关联按变体完整替换。分类关联按集合完整替换，只增删差异；扩展值按 owner/namespace/key 定位，新增/更新须提供 type/value，删除须明确声明且要求已存在。两者的旧写表路径同样推进商品版本，分类关联所属商品不可迁移；旧 Metafield 归属迁移仍允许，但按 UUID 顺序以 NOWAIT 锁定并更新原/目标商品版本。其他 owner 的扩展值继续沿用原有保护，不引入商品锁。

字段白名单、归属、输入大小及条目数受限；API 详见商品编辑合同。当前不包含库存数量、交易快照、分类内容、扩展定义/可见性或 Metaobject 内容，也不为它们提供相同 revision 保证。共享定义与内容变更可能影响多个商品，独立管理；保存字段值不扩大 Storefront 可见性。旧直写路径会使旧表单失效，但直写本身没有 expected_revision 检查，管理表单应统一使用新 RPC。没有 mutation 重放缓存，冲突或响应丢失必须重读核对，不自动覆盖；大批量导入性能尚未验证。

## ADR-022：订单与客户管理读合同

客户订单查询始终根据当前活跃 Customer 限定归属，不接受任意 customer_id；管理员调用客户接口也只能读取自己的商业订单。Admin 订单/客户接口独立验证管理员/service。不存在或他人订单详情返回 null，不用错误差异泄露存在性；没有活跃客户身份的客户查询直接拒绝。

订单详情复用安全订单头和持久化价格明细，聚合关系化履约行及物流信息，不从当前商品目录重算。admin_note 仅 Admin 详情返回，支付渠道操作信息不进入这些 DTO。退款/账本/退货/履约余额保持专用查询，不无限嵌套到列表。订单列表使用唯一不可变 order_number 倒序游标及状态/客户筛选；复用订单号唯一索引，客户索引扩展为 `(customer_id,order_number DESC)`，保留其前缀用途。序号分配不等于提交顺序，游标不提供跨请求快照。

客户管理列表按 `(created_at DESC,id DESC)` 有界分页，可筛匿名化状态并搜索姓名/联系邮箱/电话。显式摘要不含 Auth ID/角色，has_account 表达非匿名 Auth 关联，不表达登录资格。详情包含地址及客户扩展值，订单通过独立分页查询。匿名化后不从历史订单恢复客户 PII，也不宣称已清除法定交易快照。当前无精确总数、复杂搜索引擎或生产容量承诺；新读合同不改变交易生命周期、客户归属或旧表授权。

## ADR-023：游客复用匿名 Auth 与线上交易权限

业务只接受客户自行线上下单，支持无注册游客，不增加后台代客订单模型。游客通过 Supabase anonymous sign-in 建立服务端可验证的会话和独立 Customer；数据库角色仍是 authenticated，因此复用所有 Customer 归属、配额、锁、订单读写和 PayPal actor 校验。不伪造 JWT、不开放 anon 交易权限、不将 Cart capability 扩大为订单/支付凭据。

匿名会话没有登录邮箱或密码，结账联系邮箱由 Customer 保存。新 Quote 和新订单校验联系邮箱的基本格式，首次建单保存去空格快照；邮箱不是 Quote 锁价事实，不因客户之后改联系信息重写旧订单，也不影响已创建对象的幂等重放。邮箱格式不是所有权验证，既不认领同邮箱客户，也不因未来登录已有账户迁移游客订单。

匿名会话不获得后台权限。后台 has_account 根据 Auth 的非匿名状态计算，不把技术会话当作注册账户；Auth 删除和商业记录保留遵循 ADR-016。

游客升级注册保留原 Auth/Customer UUID，由 Auth 验证邮箱所有权，不迁移商业记录或合并已有账户。联系邮箱和订单快照不变，has_account 不表示密码已设置。操作步骤见 [游客验证邮箱后注册](api.md#游客验证邮箱后注册)。

退出、丢失会话或切换已有账号不会自动恢复匿名订单，不能只凭邮箱或订单号授权。每身份配额不是防滥用方案；会话存储见 [前台接入](storefront-paypal.md#身份与部署边界)，CAPTCHA、限流与清理要求见 [部署安全](../supabase/functions/README.md#环境与认证)。

参考：[Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)。

## ADR-024：单一下单管线与简化库存语义

选择简化库存模型：`on_hand` 是未售出的库存余额，`available = on_hand - active reserved`。报价预占、转单继续持有、付款消费预占并扣减，发货不再扣减；不引入实物在库/已售未发货 `committed` 账本。

`create_order` 是创建并转换 Quote 的幂等便捷入口，两步同事务，失败整体回滚；内部随机 Quote key 与调用方显式报价的 key 无关联。该命令使用独立 `order.create` 幂等范围、规范化请求指纹和当前订单 DTO 重放，成功重试不新增 Quote、不延长期限、不重复预占或占用促销。客户端按业务需要选择便捷下单或显式 Quote 流程，两者都支持安全重试。

完整转单校验后若 total=0，客户命令在同一事务消费预占并将 financial_status 设为 paid、填写 paid_at，Quote 变为 completed。无需管理员或支付渠道，不创建 PaymentIntent 或虚构 capture；促销用量、库存、事件和幂等身份只落一次。零价格与全额优惠同样适用，过期/改价报价仍拒绝。

已结算零对价行通过 `cancel_zero_value_order_item` 记录独立、不可改写的取消数量；与履约及退款预留共用余额和父订单锁，按原扣减事实回库，不伪造零金额退款。零总额订单全部取消后 status=cancelled、financial_status=paid；部分发货与取消覆盖全部数量则完成订单。付费订单中的免费行使用相同数量合同，不退付费行、运费或税。

所有客户下单统一使用 Quote，过期统一由 `expire_checkout_quotes` 处理。取消或超时仅释放未付款预占，未知 Capture 与迟到资金遵循 ADR-009。唯一支付账本见 ADR-025；履约 JSON/关系表仍有调用与回归，尚未收敛。

## ADR-025：唯一支付账本

手工收款、PayPal 捕获、手工退款及渠道退款直接写 `commerce.payment_transactions`；删除 `public.payments`、双写触发器和 `legacy_payment_id` 关联，不保留兼容视图。实收统一使用 `capture`，退款使用 `refund`，金额恒正。零元订单不虚构资金交易。

交易、订单状态、退款明细/金额组件、库存和 Outbox 保持单事务提交；支付交易的金额、币种、父交易、幂等键及已绑定渠道引用不可改写。异步退款直接引用请求中的捕获交易，手工退款沿用原捕获关联规则；异步请求活跃时禁止手工退款或直接插入退款交易穿透预留。

每次账本写入以 NOWAIT 锁定并实际更新父订单版本，再检查捕获/退款总额；直接 INSERT 与 pending → succeeded 都不能使用旧 RR 快照超收或超退。

客户、管理员及 service 通过 `get_order_ledger.transactions` 读取安全 DTO，不暴露账本底表或任意 metadata。删除原 `capture_payment_intent.raw` 参数，不再另存渠道 payload 副本；可信事件的 allowlist 字段与 hash 仍保存在 Inbox，真实外部资金仍由 `provider_money_movements` 独立记录并对账。它们分别代表渠道事件、实际资金和本地入账，不是应合并的重复账本。手工收退款不代表线上渠道发生了资金操作。

## ADR-026：媒体采用保守保留与显式引用边界

选择保守策略：旧媒体、以自由 URL 方式使用的媒体不开放物理删除；不能把未发现引用、移除商品图片关联或商品已删除当作清理授权。新受管理媒体须具备明确的生命周期与引用合同后，才能单独开放删除，不提供绕过保护的 force 参数。

第一阶段仅登记显式 URL 字段：`product_images.url` 与非 null 的 `categories.image_url`。`private.catalog_media_url_refs` 保存源记录外键和完整 URL，由源表触发器在同一事务更新，源删除级联清理；外部 URL、query、fragment 和空字符串均原样保留。不根据相似路径/域名推断 Storage 归属，不访问 URL，也不关联到 Storage 内部表。该表启用 RLS，客户端及 service 均不能直接读写或调用同步触发器。现有 RPC、底表写入、商品 revision 和分类编辑令牌语义保持不变。

这是当前字段引用的派生登记，不是完整媒体资产表、历史引用记录或删除许可。富文本、任意 JSON、复制到站外的 URL 无法据此枚举；登记为零也不能证明没有引用。报价/订单目前没有独立图片快照字段，不为媒体清理改写不可变商业快照。本阶段不新增 MCP 工具或 Storage 删除策略。

### 已实现私有暂存、永久保留与受控丢弃

仅增加 managed ID 或外键不能使公开媒体重新获得删除资格：公开 bucket 中的路径可重建 URL，草稿、未关联和没有返回 URL 都不等于从未公开。因此删除资格仅限真正私有、从未公开的暂存对象。一旦进入公开 URL 合同就永久保留，可以复用、解除关联，但不能因为当前引用数归零而回收。旧接口在未来上传的新文件也属于公开媒体，不按创建时间或规范文件名自动纳管。

新增可选通路使用独立私有暂存 bucket、服务端分配的不可覆盖路径与应用自有持久状态；不接纳调用者指定的旧 bucket/path。先创建记录，再上传字节。暂存响应仅返回媒体/操作身份和状态，不返回读取 URL；初版不提供 signed preview，客户端预览原始本地字节。管理员身份检查沿用当前用户，Storage 特权只在受控服务端使用，不能作为任意路径访问或用户授权失败后的回退。

状态与唯一合法转换：

| 状态 | 含义与下一步 |
| --- | --- |
| `uploading` | 正在上传或结果未确认；禁止发布、禁止准备丢弃。按原身份核验完成后转 `staged` |
| `staged` | 已验证私有对象；仅允许原子转为 `retained` 或 `discard_prepared` |
| `retained` | 永久删除否决；表示已经承诺保留，不宣称用户收到 URL 或商品关联成功。允许按原身份恢复发布 |
| `discard_prepared` | 已冻结用于丢弃；禁止发布、关联和复用身份，不等于已删除字节 |
| `discarded` | Storage 已确认对象不存在；永久保留身份记录，不重新上传或发布 |

发布必须先提交 `staged → retained`，再通过 Storage API 向独立、不可覆盖的公开发布命名空间复制。该命名空间不能由既有客户端 INSERT 策略写入。复制成功并核验后才返回公开 URL，再使用现有商品/分类版本化命令关联；不是跨 Storage/数据库的原子保存。复制超时、响应丢失、关联版本冲突均不撤销保留状态，不自动换 ID 或自动接受新版本。宁可多保留，也不留下“已公开但仍可丢弃”的窗口。

发布与丢弃准备必须条件更新同一条持久记录，而非仅使用 advisory lock 或先查引用：发布先提交则丢弃失败；丢弃先提交则发布在任何公开 Storage 写入前失败。真实行版本写冲突要覆盖 READ COMMITTED 两种胜出顺序及 REPEATABLE READ 旧快照。重复准备返回同一操作状态，不创建新操作、不返回 deleted。

当前通过 `managed-media` Edge 和七个 MCP 工具实现暂存、发布、丢弃执行与恢复。私有 `media-staging` bucket 不授予客户端读取/签名/写入/删除策略。service-only RPC 每次检查 actor 的当前管理员身份，`request_id` 绑定 MIME、长度与 SHA-256，服务端分配媒体 ID。删除只通过 Storage API，不以 SQL 删除 storage.objects。

上传使用一次性持久许可：`upload_status=not_started → pending → settled`。begin_upload 与状态转换锁定并更新同一媒体行；仅取得许可的那次 Edge 调用可以发送一次私有 POST，并在成功响应及字节核验后提交 settled。并发重放不能再发送私有 POST。超时、进程消失或许可响应丢失不能清除 pending；不提供过期重置或 force。recover 可以核验现存字节并标记 staged，但不能证明在途请求已经结束，因此不能将 pending 改为 settled。这样的对象可以按原身份发布并永久保留，不能丢弃；字节缺失的 pending 对象可能持续无法恢复，这是保守策略的明确代价。

仅 settled 对象可准备丢弃。delete 先校验冻结状态，再删除固定私有 key、查询确认缺失，最后标记 discarded；recover_delete 只查询并确认，不发 DELETE。保留原媒体记录作为 tombstone，无新删除身份，也不重用原上传身份。删除响应或确认提交响应丢失后先重读、恢复；确需再次执行时由用户明确批准，同 ID 操作不自动重试。鉴权、bucket、网络及任意 404 错误均不是缺失证明。并发 DELETE 可以重复，但冻结对象不再有合法写入者，因此不造成重新出现的对象。

该证明仅适用于从首次上传就使用一次性许可的对象。不得把上一版对象补标 settled，也不得在旧上传执行器仍运行时开放删除。仓库修改的是可重建 SQL 基线，不包含已有部署的数据升级方案；已有对象继续保留，正式升级须另行设计并授权。验收覆盖真实 Storage、在途上传屏障、发布/冻结的 RC/RR 竞争、删除前后及确认前后的响应丢失，而不是仅验证数据库状态。

## ADR-027：远程 MCP 使用独立授权与逐用户下游身份

**状态：设计合同；已实现工具 scope 清单与受信宿主校验接口，远程认证尚未实现。** 当前仍只有 stdio。`stdio.ts` 从安全环境读取一个管理员会话，`AdminBackend` 固定其请求头；`createAdminServer` 的 allowWrites 只决定本进程是否注册写工具。不能把这三个对象作为多用户 HTTP 单例，也不能将工具 annotations 当成授权控制。本决策不启用 `auth.oauth_server`、不新增公开监听端口、不改变现有 RLS/RPC 权限。

### 令牌分开，业务仍由原用户执行

远程 MCP 是 OAuth resource server，固定一个配置的 HTTPS resource URI，例如 `https://admin.example.com/mcp`。初版一个部署只服务一个 Supabase 项目；客户端不能指定项目 URL、issuer、数据库身份或下游 token。

选择受信授权代理模式：客户端只持 MCP 专用令牌；代理通过已验证的授权记录找到该用户的独立 Supabase 会话，再以原用户 JWT 调用现有 AdminBackend/RPC/Edge。两类令牌分别签发、分别存储，不能互换。不得用入站 MCP token 直接访问 Supabase，不使用 service-role 或共享管理员账号代行业务，也不自行伪造带任意 sub 的 Supabase JWT。

授权记录绑定 `(issuer, subject, client_id, resource, project, grant_id)` 与一个 Supabase Auth user UUID；不是 customer UUID，不能按 email、显示名、同名 sub 或客户端参数自动关联。建立关联须同时证明授权服务身份和 Supabase 登录身份，并展示客户端、店铺、账号及批准权限。登录/同意发生在浏览器可信页面，不使用收集密码、access token 或 refresh token 的 MCP 工具。账号切换创建新关联，不静默改绑现有授权。

授权服务产品/库尚未选定；已核对现有 Supabase Auth 并增加独立库的本地兼容性实验，结果见下文，不能自行拼接 OAuth 协议上线。Supabase 官方文档中默认 OAuth aud 为 authenticated，OIDC scopes 不约束数据库；Custom Access Token Hook 可以定制 aud，但不自动完成本代理需要的独立下游会话、MCP 业务 scope 或完整 RFC 8707 支持。不假设仓库已经存在 token-exchange API。

### 最小权限必须在调用时执行

首版 scope 合同如下；这些是本项目业务权限，不是 openid/email/profile 的替代名称：

| scope | 语义 |
| --- | --- |
| `store:read` | 当前全部管理只读工具，包含客户联系方式、订单、成本等敏感数据；不是公开 Storefront 权限 |
| `store:write` | 管理写操作的基础权限，涵盖商品发布、库存和业务配置修改；不隐含 read 或以下附加权限 |
| `store:payments` | 收退款及直接资金记账，除 write 外还须单独批准；包括手工记账和 PayPal 退款 |
| `store:access` | 角色/账户访问控制变更，除 write 外单独批准 |
| `store:privacy` | 客户或账户匿名化等不可逆隐私操作，除 write 外单独批准 |

默认只申请 read，写权限逐步升级。resource metadata 的最小 scopes_supported 和首次 challenge 不诱导客户端申请所有权限；scope 扩大须重新同意，旧授权记录不得因配置变更自动升级。写 scope 不替代用户对退款、删除、公开发布的具体操作批准。

工具按现有注册源明确声明所需 scopes；所有现有工具必须有分类，新工具漏配默认拒绝，测试须校验注册集合完整覆盖。不要从工具名称、description、readOnlyHint、请求参数或前端隐藏状态推导权限。有效权限是 token scopes、当前 grant scopes、部署策略和当前管理员角色的交集。tools/list 只展示可用工具；直接 tools/call 仍再次校验，不能仅依赖初始化时隐藏写工具。stdio 原有 allowWrites 合同保持不变。

### 撤销与下游凭据不靠 JWT 到期兜底

授权代理保存私有 grant 记录（身份元组、批准 scopes、版本、撤销状态）以及独立加密的下游凭据引用。MCP access token、refresh token 与 Supabase access/refresh token 不进入公开业务表、对话、工具参数、URL 或日志。刷新令牌轮换按授权记录串行并以版本比较写回；进程重启后不复用过期缓存，刷新结果未知不并发重试，无法恢复则要求重新登录。加密密钥与数据库分离，备份、轮换和最小访问权限另行验收。

每个 HTTP 请求验证 token 签名/算法、固定 issuer、resource audience、exp/nbf 和必要身份 claims，并在线检查 grant；每次工具执行前重查 grant/scopes，取得绑定的下游会话，核对 Auth 返回的 user UUID 与绑定 UUID 完全一致，再执行当前管理员检查。不得只验证“某个管理员”，否则会把 A 的授权映射到 B。grant 存储、授权服务或刷新服务不可用时拒绝执行，不回退共享会话或 service-role。

撤销 grant、取消下游关联或管理员降级后，不再接纳新的工具执行。检查与已在途业务不是一个分布式事务：撤销不保证取消已经接纳、提交或发送给 PayPal/Storage 的操作；这些操作结果仍按原 ID 查询，不宣称已回滚。Supabase 登出与 MCP grant 撤销是两个动作；不能将登出等同所有已签发 JWT 立即失效。安全界面应提供明确的断开 MCP 授权操作，不能仅删除本地 cookie。

### HTTP 与会话边界

使用现有官方 TypeScript SDK v2 的 Streamable HTTP，不自制 JSON-RPC transport。先验收无跨请求业务状态的处理模式；若 SDK/客户端需要 transport session，session 仅用于协议，不是身份凭据，必须绑定完整授权身份元组及 grant 版本。每次 POST/GET/DELETE、重连和事件恢复均重新鉴权，不能凭 MCP-Session-Id 或 Last-Event-ID 读取其他用户结果。禁止全局 Backend、跨用户结果缓存和复用含用户 token 的工具闭包。跨主体、客户端、店铺或权限版本的 session 不可复用；scope 变更后重新初始化。

未认证/无效 token 返回 401 与 Bearer resource_metadata challenge；有效 token 权限不足返回 403/insufficient_scope，列出当前操作全部所需权限。工具执行业务冲突仍用现有工具错误合同，不把授权失败伪装成成功 JSON。入口校验、scope 判定与 SDK 分发使用同一工具分类源；写请求一旦可能送达后端，就沿用 outcome_unknown，不因 OAuth 续期自动重放。

配置固定 public origin/resource/issuer，不信任客户端 Host 或未受信 Forwarded 来生成元数据或回调。提供 RFC 9728 受保护资源元数据；授权服务提供受验证的 RFC 8414/OIDC discovery。要求 Authorization Code + PKCE S256、精确 redirect URI、state/issuer 校验、短期 access token 与 refresh token 轮换。首版使用预注册客户端，不开放任意动态注册；兼容性验收应明确其限制。若以后支持 Client ID Metadata Documents，单独落实元数据抓取的 SSRF 与缓存控制。

HTTP bearer 只出现在 Authorization header，不在 query/cookie；浏览器授权站点的 cookie 独立使用 HTTPS、HttpOnly、SameSite 与 CSRF 防护。MCP 入口需要 Origin 检查、受限 CORS、受信代理配置、请求体/并发/超时预算，以及按 grant/主体与未认证来源分别限流。日志仅保留脱敏身份关联、工具名、结果码与时延，不能记录 token、完整请求/响应或客户资料；refresh/callback/token endpoint 同样脱敏。

### 按可验收批次实现

本地兼容性核对（2026-09-21）：当前 Auth 镜像为 `v2.196.0`，OAuth discovery 实际返回 404 / `feature_disabled`，没有开启 OAuth 或完成授权端到端验收。对该 tag 的源码核对显示：authorize 可以保存单个 resource，但 [token handler](https://github.com/supabase/auth/blob/v2.196.0/internal/api/oauthserver/handlers.go#L254-L359) 的标准表单分支没有读取 resource，仅在该参数存在时比较；[access-token 签发](https://github.com/supabase/auth/blob/v2.196.0/internal/tokens/service.go#L702-L753) 使用用户的 Aud，不是授权 resource；[scope 清单](https://github.com/supabase/auth/blob/v2.196.0/internal/models/oauth_scope.go#L5-L21) 固定为 OIDC scopes，不支持本 ADR 的业务 scopes。token endpoint 不提供 RFC 8693 token exchange；grant 删除可撤销 OAuth 会话/刷新资格，但不能据此宣称下游所有已签发 JWT 立即失效。结论仅针对该版本的原生实现：不能仅启用开关或改 aud hook 就满足本设计。下一步应验证独立授权服务及身份代理方案，产品尚未选定。

已落地的 [permissions.ts](../mcp/src/permissions.ts) 为 112 个工具逐个声明 scopes，注册遇到未分类工具立即失败。可选 `ToolAuthorization` 只能由受信宿主构造：初始 scopes 过滤注册，每次调用通过 `currentScopes()` 重新取得有效权限，缺权限或回调失败均在访问后端前拒绝，`outcome_unknown=false`，不泄漏回调异常。宿主将来负责验证令牌、身份绑定并求 token/grant/部署权限交集；该接口本身不完成这些工作。当前 stdio 不传此接口，保留原有管理员检查和写开关。工具发现是初始化快照，降权后旧工具调用会拒绝，但尚不动态更新 tools/list；升权、降权后的列表和 HTTP 会话重建由后续 transport 批次完成。作用域测试的会话隔离不代表逐用户凭据隔离已验收。

独立库实验：固定 [oidc-provider v9.12.2](https://github.com/panva/node-oidc-provider/tree/v9.12.2) 为开发依赖，[可重复测试](../tests/unit/oauth-provider.test.ts) 仅绑定随机回环端口，使用一次性签名密钥、内存 adapter、固定虚构身份和自动同意，退出关闭监听，不连接 Supabase 或真实账户。这是协议候选验证，不是可以部署的认证服务。

| 已执行的 Bun 实验 | 结果与边界 |
| --- | --- |
| Discovery、JWKS、Code + S256 | issuer 正确，公开 JWKS 不含私钥；缺失 PKCE、plain、错误 verifier 和未注册 redirect URI 均拒绝 |
| RFC 8707 与业务 scope | 表单 token 请求签发 ES256 JWT，aud 精确等于 MCP resource，scope 仅为批准的 store:read；错误 resource 拒绝，刷新不能升级到 store:write。业务 scopes 配在 resource server，不混入全局 OIDC scopes |
| 授权身份 | token 含 sub、client_id 与从服务端 Grant 取得的 grant_id；客户端传入伪造 grant_id 不覆盖该 claim。尚未验证多用户、下游 UUID 绑定或浏览器登录 |
| 刷新轮换与重放 | 显式开启 rotateRefreshToken；轮换保留 grant_id，旧 token 重放撤销 grant，后继 refresh token 也被拒绝。顺序重放实验不证明持久 adapter 的并发原子性 |
| RFC 7009 | 显式开启 revocation 与 revokeGrantPolicy；撤销 refresh token 删除 grant 并禁止刷新，但已签发 JWT 仍能通过签名验证，MCP 必须在线检查授权记录 |

额外观察：该配置在错误 resource 的刷新请求中先消耗 refresh token，再返回 invalid_target；重试旧 token 返回 invalid_grant 并撤销 grant。回归保留这一行为，不能假设所有 4xx 都没有改变刷新状态。恢复必须重读/重新授权，不自动重放。顺序与 [刷新实现](https://github.com/panva/node-oidc-provider/blob/v9.12.2/lib/actions/grants/refresh_token.js) 的消耗、轮换及 resource 校验顺序相符。

**暂不批准生产选型。** 此版本启动时明确警告 Bun 为 unsupported runtime，官方目标是 Node.js LTS；本地 Bun 1.4.2 实验通过不等于支持承诺。默认内存 adapter 也不可用于生产。下一批优先评估独立部署、官方支持运行时的授权服务，避免把不受支持的嵌入式运行时作为前提；同时复用上述协议验收标准。最终方案仍须补真实登录/同意、持久化及原子 consume/revoke、两管理员隔离、并发刷新、重启恢复、密钥轮换、Supabase 凭据代理和真实 MCP 客户端验收。当前不开放远程 MCP。

独立服务核对：Hydra `v2.3.0` 的 [go.mod](https://github.com/ory/hydra/blob/v2.3.0/go.mod) 固定 Fosite `v0.49.0`，该依赖的 [audience 解析器](https://github.com/ory/fosite/blob/v0.49.0/audience_strategy.go#L77-L94) 读取非标准 audience 而非 resource，不能以这条路径证明本项目所需的 RFC 8707 合同。本批不推进该版本；这不是对所有 Hydra 版本的结论，也未做 Hydra 运行验收。

Keycloak `26.7.0` 已完成 [独立 Docker 实验](../scripts/mcp-keycloak-compat.ts)：镜像固定 tag 和 digest，Bun 只驱动 HTTP 测试，授权服务使用镜像内的 Java 运行时。脚本创建单独的临时 realm/账号/密钥、随机回环端口及容器，finally 删除容器和临时配置，不接现有 Supabase，不使用生产数据。它不加入默认测试，以免常规单测隐式拉取镜像或启动大型服务；运行 `bun scripts/mcp-keycloak-compat.ts` 复验。

| 固定版本的实测结果 | 对接要求 |
| --- | --- |
| 缺少 S256 challenge、plain、未知业务 scope 被拒绝；code 和 refresh 的 resource 不匹配均返回 invalid_target | 显式要求 S256，注册业务 scopes，不能用静态 audience mapper 代替请求绑定 |
| 正常 token 的 RS256 签名/JWKS、issuer、aud、sub、azp、sid 正确；刷新不授予原先没有的 store:write | 刷新扩大 scope 的请求返回成功但取交集，不是 invalid_scope；必须检查实际 token scopes |
| 刷新轮换保留 sid；旧 refresh token 重放后后继 token 也被拒绝 | 配置 revokeRefreshToken=true、refreshTokenMaxReuse=0；尚未验证多节点并发 |
| RFC 7009 撤销后 refresh 被拒绝、introspection active=false，JWT 签名仍有效 | 资源服务器须在线校验，不把 JWT 的密码学有效性当作授权仍有效 |

两处必须保留的版本约束：① 26.7.0 的 [resource processor](https://github.com/keycloak/keycloak/blob/26.7.0/services/src/main/java/org/keycloak/protocol/oidc/resourceindicators/ResourceIndicatorsPostProcessor.java#L55-L95) 不支持直接按自定义 audience 字符串匹配 URI。实测直接 URI mapper 失败；正确配置先把资源客户端 ID 放入 audience，再由该客户端的 resource_url 映射。② [introspection](https://github.com/keycloak/keycloak/blob/26.7.0/services/src/main/java/org/keycloak/protocol/oidc/AccessTokenIntrospectionProvider.java#L318-L350) 要求调用方 client_id 在 token audience 中。测试使用 client_id 与 resource URI 相同的机密资源客户端，关闭其登录/密码/service-account flows；另一个机密客户端即使凭据有效也只得到 active=false。未启用绕过 audience 检查的兼容选项。

两用户/两客户端扩展实验已通过：每位虚构用户共用自己的 cookie jar 登录两个公共客户端，两个客户端共享该用户的 sid/sub，不同用户的 sid/sub 不同。仅用户 A 的客户端 B 请求 store:write，其他三组都保持只读；轮换后各自身份与 scopes 不变。客户端 B 拿 A 的客户端 A refresh token 尝试刷新或撤销均失败，四组 token 仍 active，合法持有方仍可刷新。随后正确撤销 A/A，原 access token 与轮换后 access token 均 inactive；A/B、B/A、B/B 仍可在线校验和刷新。这验证了此版本/配置下的顺序场景，不代表真实浏览器同意、并发、其他资源或多节点隔离已验收。

**Keycloak 仍仅作为本地对接候选，未批准生产使用。** 容器明确警告 resource-indicators:v1 是 experimental；start-dev、临时库、HTTP 和无需同意的测试客户端都不是部署配置。sid 是共享 SSO 会话身份，不能直接替代本项目逐客户端/资源的 grant_id；azp 须由固定 issuer 的适配层解释，不能接收任意客户端传入的映射。不因本次实验通过就更改 stdio 或开放网络入口。

### grant 与 Supabase UUID 的落实边界

服务端 grant 记录生成独立随机 ID，并不可变地绑定已验证的 `(issuer, sub, client_id, resource, project)`、上游 sid/授权纪元及 Supabase Auth user UUID。Keycloak 的 sub 与 Supabase UUID 没有天然对应关系，不能用同名值、邮箱或“均为管理员”推导。账号绑定仍须在可信交互中证明两端身份；查找不得只按 sid 或 sub，撤销按完整 grant 生效。重新授权/切换账号不能仅把旧记录改为 active 或换 UUID，否则旧 bearer 可能继承新授权。相同上游身份元组的恢复暂不自动支持，必须先完成可区分的新上游会话或签名授权纪元设计；可信账号关联交互尚未实现，令牌到现有 grant 的查找见下文在线校验模块。

已实现的下游检查是 [AdminBackend](../mcp/src/backend.ts) 的受信配置 expectedUserId：构造时校验并固定 UUID，每次操作从 Supabase Auth 重查实际用户，在 is_admin、RPC、Edge、Storage 前比较，不匹配返回 IDENTITY_MISMATCH / outcome_unknown=false，不回传任一 UUID。匹配 UUID 后仍执行当前管理员检查；不会因绑定存在就放宽角色。两名真实本地 Supabase 管理员的交叉会话测试和逐调用 mock 测试均覆盖这一点。此字段只能由未来可信 grant 解析器设置，不是工具输入；目前可选仅为兼容单用户 stdio，远程 host 必须强制提供。它不代表 token 验证、双身份关联或凭据代理已完成。

授权元数据现持久化于 PostgreSQL 的 private.mcp_grants，通过 service-only [mcp_grant_command](api.md#mcp-授权记录受信服务内部接口) 创建、解析和撤销，不另建本地文件存储，不向任何 API 角色开放底表。binding 固定六项 issuer/subject/client_id/resource/project/session_id（当前对应已验证上游会话），作为唯一键；UUID 和 scopes 不可变，撤销记录永久保留，不跟随 auth.users 级联删除。正常创建重放返回原 ID；改绑/改权限、复用 revoked binding 拒绝；resolve 锁行且重查管理员，撤销后不再返回有效授权，旧 RR 快照与并发变更冲突时失败。受信 host 必须把输入与固定部署和真实上游身份核对，不能自行伪造新 session_id 来恢复授权；此 RPC 不执行这些协议验证。

存储仅包含授权元数据，无访问/刷新令牌、密码或邮箱。撤销是数据库终态，不恢复、不删除；scope 改变当前须撤销旧授权并建立可区分的新上游会话，暂不原地升级/降级。新连接读取、每个身份维度的隔离、两管理员改绑拒绝、重复撤销、并发创建/撤销以及 RC/RR 旧快照场景由 [集成测试](../tests/mcp-grants.test.ts) 验证。它仍未接入远程 host 或凭据代理，service-role 仅能出现在受信授权存储边界，店铺业务继续使用绑定用户 JWT；不把提供一个元数据 RPC 当作远程 OAuth 已完成。

在线校验已落实为 [KeycloakGrantAuthorizer](../mcp/src/authorization.ts)。按 [RFC 7662](https://www.rfc-editor.org/rfc/rfc7662) 以固定受信端点的 introspection 响应作为令牌有效性依据，不读取未验证 JWT payload，不跟随 token 中的 issuer/JWKS URL。此适配器限定 Keycloak profile：必须含 active=true、typ=Bearer、精确 issuer、包含当前 resource 的 aud、未过期 exp、非未来 nbf（若提供）、非空 sub/client_id/sid 和 scope。typ 用于拒绝 refresh/ID token，token_type_hint 本身不提供类型保证。身份字符串保持原样，不按邮箱或 azp 猜测 client_id。固定 HTTPS 端点（仅回环可 HTTP）、禁止重定向、10 秒请求超时、无缓存/自动重试；凭据只发往各自固定端点。

通过校验后，以完整六字段 binding 调用 mcp_grant_command(resolve)，仅接受 active/version=1 和合法 UUID/scopes；返回 expectedUserId、grantId 与 ToolAuthorization。初始权限是 token ∩ grant ∩ 部署 scopes；逐调用重新 introspect 和 resolve，固定原 grant/user UUID，并将权限限制在初始集合内，升权须重建上下文。grant 查询结束再次检查过期；故障、非法响应、撤销及身份变化均统一 AUTHORIZATION_DENIED，不暴露原异常。该检查是调用准入，不能撤回已执行业务，也不消除检查后发生撤销的时间窗口。

单测覆盖拒绝、权限交集与上下文固定；固定版本 Keycloak Docker 实验调用实际适配器验证 access token、refresh/伪造 token 拒绝及已有上下文的在线撤销，默认 grant 端为合成 fixture。模块尚未接 stdio 或 HTTP，不持久化入站 token，不将入站 token 传给 Supabase；未来宿主必须用独立下游用户会话与 expectedUserId 构造 AdminBackend。Keycloak 仍是候选，不因新增适配器而批准其生产部署。

可选 `bun scripts/mcp-keycloak-compat.ts --with-supabase` 已把真实 Keycloak、PostgreSQL grant、InMemory MCP transport 和 AdminBackend 串联验收。仅连接 CLI 确认的本地实例，创建并清理两名临时管理员；四组 user/client token 各自批准，批准前均拒绝，两个客户端共享 sid 不导致 grant 混用。成功调用核对真实 profile 与下游用户 Authorization；只读上下文直接调用隐藏写工具拒绝且不访问后端。故意把用户 A 的 grant 配上用户 B 的管理员会话，得到 IDENTITY_MISMATCH，只有 Auth 身份请求、没有 is_admin/业务 RPC。单个本地 grant 撤销后，新 authorizer 和已有 MCP 上下文都拒绝，同用户另一客户端与另一个用户仍可用；降权拒绝该用户剩余上下文，恢复角色后重新检查通过；随后上游撤销也在业务访问前拒绝，另一用户保持可用。清理仅删除该次 fixture，客户不可删除保护仅在本地清理事务中临时绕过，不改变 schema/生产授权记录规则。

这证明的是顺序场景下各层身份和撤销检查可以协作，不证明可信账号关联、远程 HTTP、并发竞态或生产配置。测试手工批准两个账号的对应关系，不以邮箱/sub 推导 Supabase UUID；下一步仍需可信双身份关联和加密凭据保存/轮换，之后才能接远程 transport。

### 下游凭据密文格式与边界

[credentials.ts](../mcp/src/credentials.ts) 先落实宿主侧加密原语，不注册 MCP 工具或添加凭据数据库。明文严格限定 `{accessToken,refreshToken,expiresAt}`，token 为 1–16384 个可见 ASCII 字符，expiresAt 为正安全整数 Unix 秒；允许访问令牌已经过期，因为未来刷新代理仍需读取 refresh token。加密不验证这些值由 Supabase 签发，也不验证它们属于该用户，仍须在线身份核验与可信双身份关联。

格式为 `{version:1,keyId,iv,ciphertext}`，IV 和附带认证 tag 的密文为无填充 canonical base64url。使用 Web Crypto AES-256-GCM、随机 12 字节 IV 和 16 字节 tag，算法不可由输入选择。AAD 是 UTF-8 JSON 固定顺序数组 `["tera-mcp-downstream-credentials",1,keyId,project,grantId,userId,revision]`，避免密文被跨项目/授权/用户/修订号移用，key ID 也参与认证。project 和 UUID 按原样匹配，revision 为正安全整数，必须来自受信存储状态，不从 envelope 采信。未来存储层须事务递增 revision/CAS（仅当前版本匹配时写入）并检查 grant 活跃性；本层不能独自防止密文与外部版本号一同回滚，也不以解密成功替代撤销检查。

宿主提供 key ID → 32 字节随机密钥及 active key ID；无默认密钥、不从入站参数/密文获取密钥、不在数据库保存密钥。导入后不可导出，复制输入以隔离配置变更；新写只使用 active key，保留旧 key 才能读旧密文。换 key ID 即使密钥字节相同也不能绕过认证。重加密、旧 key 退役和调用量/轮换策略由未来宿主与存储协调，本层没有批量迁移或生产密钥管理。临时 byte buffer 尽力清零，但 JS 字符串/运行时副本不保证可擦除，不宣称进程内秘密隔离。

配置、加密、解密失败分别只输出固定机器错误，不输出凭据、key 或底层解析异常。单测通过独立 node:crypto API 和固定 AAD 核对双向互操作，覆盖每项 AAD 替换、tag/header/payload 篡改、非法明文、长度边界和保留/退役 key；联合实验使用临时 key 和内存 envelope，真实下游会话解密后用于 MCP 读取，其他用户上下文解密失败。加密原语本身不承担持久化或撤销检查。

后续存储层现已实现为 private.mcp_credentials 和 service-only [mcp_credential_command](api.md#mcp-下游凭据密文受信服务内部接口)，不增加 MCP 工具。底表对所有 API 角色封闭；read/write 均先锁定并 resolve 完整 grant，再核对固定 grant/user UUID，重查当前管理员，随后锁定凭据行。写入以 expected revision 比较交换，从未初始化 0 单调递增；密文必须预先用下一 revision 加密。旧版本写入（包括原请求重放）拒绝，不自动刷新或重试。SQL 只检查 envelope 结构，密钥在库外、tag/明文归属仍由 host 验证；恶意受信 host 或数据库管理员不在此防护范围内。

grant revoke 持相同的 grant 行锁，在同一事务中删除凭据行并保留授权 tombstone。降权仅禁止读写，撤销仍可清除；不擦除进程已读出的 token，不撤回已执行调用。独立数据库测试覆盖服务权限、输入和身份拒绝、重连读取并解密、CAS 重放、首写竞争、旧 RR 快照以及撤销先于写入的竞争；并发插入与旧快照可能返回 40001。旧 RR 在首次插入前可以看到未初始化状态，但不能覆盖已插入数据。

宿主适配现由 KeycloakGrantAuthorizer 的 readCredentials/writeCredentials 直接复用在线 resolve 实现，不让调用方提供 grant/user/binding，也不暴露任意 service-role RPC。每次读取重新校验 token/grant，以固定项目和数据库 revision 认证解密，返回前再次检查上游过期；未初始化返回 null，任何错误只抛 CREDENTIAL_READ_FAILED。写入先按 expectedRevision+1 加密，再经 AdminBackend.assertAdmin 在线核对下游 access token 的 UUID 和角色，最后 CAS 保存并核对响应版本和密文。成功仅返回 revision；所有失败保守标记 CREDENTIAL_WRITE_UNCONFIRMED，必须先重读，不自动重试或刷新。存储后的本地/上游撤销仍通过在线校验拒绝，操作之间的撤销窗口和进程中已持有凭据的边界不变。

联合实验改为使用真实凭据表：两名临时管理员、四组 grant，错误管理员 access token 写入拒绝且 revision 仍为 0；首次写入、旧版本拒绝及下一版本更新后，新宿主实例从数据库读取解密并执行 MCP，撤销本地 grant 删除密文，上游撤销阻止读取。临时密钥只在内存，测试结束清理凭据行；这是新对象读取，不是生产进程重启/密钥恢复验收。单测另覆盖已提交但响应丢失、错误响应、旧 revision 密文和读取期间过期。host 方法只供受信内部流程，返回的下游凭据不可交给 MCP/HTTP 客户端；业务仍需 ToolAuthorization 和 expectedUserId 校验。access token 检查不验证 refresh token 配对或同意，可信账号关联、刷新协调及生产密钥管理仍待实现，远程服务仍未开放。

刷新协调先落实数据库单次准入，不引入可过期 lease：mcp_credential_command 的 claim_refresh 在同一 grant/credential 锁下核对 revision，生成并持久化 refresh_id，只在领取成功响应中返回回执及密文。待完成时 read/write/再次领取拒绝；complete_refresh 须匹配同一 grant、回执和原 revision，提交下一版密文并清除回执。领取响应丢失、进程退出或上游结果未知不会释放或接管，无法完成则撤销并重新登录；完成响应丢失只允许读取确认，不重新调用上游刷新。撤销仍删除包括待完成状态在内的凭据行。该批仅存储原语，不提供实际刷新调用，也不保证数据库可撤回进程已取得的 token。

此锁只协调同一 grant，须结合下游会话独占归属使用。联合 fixture 现为同一用户的两个 grant 分别登录取得独立会话，不执行下游刷新。数据库测试覆盖领取竞争、RC/RR 旧快照、重连后的待完成状态、回执重放/跨 grant、阻止普通读写及撤销后完成拒绝。可信关联、宿主刷新代理与生产恢复仍未实现。

独占会话归属先落实为 grant 上的唯一 downstream_session_id 和 service-only [mcp_bind_downstream_session](api.md#mcp-下游会话归属受信服务内部接口)。复用完整 grant 解析及管理员检查，并核对 auth.sessions 的 user_id；会话仅能绑定一次，不能改绑，多个 grant 竞争由唯一约束裁决。撤销和 Auth 会话删除都保留归属，不以可回收的凭据行承载所有权。测试使用本地 Auth 登录创建独立会话，验证跨管理员拒绝、同用户跨 grant 竞争、改绑拒绝、撤销/会话删除后的记录保留以及 RC/RR 旧快照拒绝。

归属现已接入宿主凭据写入：AdminBackend 使用下游用户 JWT 调用 get_mcp_downstream_session，无参数，由 PostgREST 验证 JWT 后从 auth.jwt() 取得 session_id 并核对 auth.sessions/管理员。host 不自行解码 JWT；核对返回 user UUID 后绑定 session，验证回执，最后 CAS 写入。同用户的另一会话也拒绝替换。绑定成功但保存失败可能留下空绑定，不自动解除；密文 AAD 中的 grant UUID 通过不可变归属关联 session，数据库不证明密文内容。

凭据 RPC 的写入、刷新领取/完成和已初始化读取均强制检查绑定会话仍存在且属于用户；未初始化读取仍返回 revision=0。会话删除后拒绝返回密文和完成刷新，但仍允许撤销清除。测试覆盖真实 JWT 篡改、service/普通客户拒绝、未绑定写入和会话删除后全部凭据动作拒绝；联合实验改用四个独立会话，并验证同用户会话替换拒绝。它仍不证明 refresh token 配对、完整 Auth 超时策略或用户同意，不能据此启用真实刷新。

后续宿主刷新现已接通：`KeycloakGrantAuthorizer.refreshCredentials(token,cipher,{expectedRevision,anonKey})` 在在线验证完整 grant 后领取数据库单次回执；只有确认领取且解密成功才允许调用固定 `/auth/v1/token?grant_type=refresh_token`。Auth 请求只携带公开 apikey 与原 refresh token，不发送 service-role 或入站 MCP token；十秒请求预算，禁止重定向、缓存和自动重试。刷新前、返回后及完成前重查上游 token/grant，固定原 grant/user UUID。新凭据必须来自同一响应，非匿名、未过期且用户匹配，再用新 access token 调用真实管理员/session RPC，并通过不可变绑定确认仍是原下游会话，不能用同用户另一会话替换。下一 revision 密文由原回执完成 CAS，成功只返回 revision，后续读取仍重查授权。

失败统一 CREDENTIAL_REFRESH_UNCONFIRMED，不解锁 pending 或猜测 Auth 是否执行。领取响应丢失时不发刷新请求；刷新成功但结果丢失时保持持久阻塞；完成响应丢失时先 readCredentials 核实，已提交即可恢复，仍 pending 且原执行者无法完成则撤销并重新授权。不能把业务 401 自动变成重复写入，也不刷新入站 MCP token。重查不能撤回已执行的 Auth 请求或消除检查后的撤销窗口；本方法返回的 revision 不是后续业务执行许可。

单测覆盖原子准入、并发、错误用户/同用户另一会话、过期/畸形响应、领取后撤销、刷新中撤销、两类回执丢失与脱敏。真实本地 Supabase 测试用两个独立宿主对象并发刷新同一 revision，确认只向 Auth 发出一次请求、refresh token 轮换、原 session 保留及新宿主读取；另在 Auth 返回 200 后模拟丢失响应，确认新宿主既不能读旧凭据也不能再次刷新。该集成测试只模拟上游 introspection，其余 grant/密文/锁/Auth 均为真实本地服务；未证明真实上游 OAuth 并发或多节点生产恢复。前述“仅数据库原语”的限制因此已收窄为尚无自动续期调度、可信授权关联及远程 transport，而非没有实际下游刷新实现。

### 受信宿主取得同次登录的凭据对

[createDownstreamLogin](../mcp/src/login.ts) 是内部 PKCE 兑换原语，不是 HTTP 回调处理器或 MCP 工具。宿主生成 32 字节随机 verifier，仅公开 S256 challenge；verifier 保留在单个内存对象中，五分钟过期。exchange 从验证后的回调提取授权码，向固定 Supabase HTTPS origin（本地回环可 HTTP）的 `/auth/v1/token?grant_type=pkce` 发送 `{auth_code,code_verifier}`，禁止重定向和自动重试。取同一受信响应中的 access/refresh token 及 expires_at，再用 access token 在线检查非匿名管理员、精确用户 UUID 和真实 session。成功仅向内部宿主返回 `{userId,sessionId,credentials}`，不得把这些凭据交给浏览器或 MCP 客户端。

创建尝试必须提供受信 browserSession（32–256 个 base64url 字符，宿主应使用至少 32 字节随机熵的受保护会话标识，不是用户 UUID），模块只保存其 SHA-256 摘要；另生成独立的 32 字节随机 state。配置还必须提供固定 callbackUrl（HTTPS，回环可 HTTP，无 userinfo/query/fragment），模块生成含 state 的 redirectTo，供 Auth 登录请求使用，不从 Host/Forwarded 或回调参数推导目标。

兑换入口现为 exchange(callbackUrl,browserSession)，不再接收调用方自行拆分的 code/state。完整回调 URL 限长 20000，拒绝原始控制字符/空白、userinfo、fragment；经 URL 解析后的 origin/path 必须等于固定目标。仅接受各出现一次的 code/state，拒绝未知参数、error 与成功参数混合、编码后的重复键、空 code。随后恒时比较浏览器/state 摘要；所有格式或绑定错误返回 LOGIN_CALLBACK_REJECTED，不消耗原尝试。匹配后才在首次 await 前消耗尝试；并发兑换、提供方拒绝、结果未知或后续身份检查失败不重试，统一 LOGIN_EXCHANGE_UNCONFIRMED。state 与 verifier 独立，不能用 state 代替浏览器会话。

宿主必须从自己验证的受保护会话取得 browserSession，不能采信回调 query/body 中的同名值，也不能把浏览器标识放进 URL。HTTP 层仍须传入未丢失重复参数的完整 URL、验证受信代理和请求方法，并落实 Cookie（Secure/HttpOnly/SameSite）、会话生命周期和 CSRF 防护。真实邮件测试使用模块生成的 redirectTo，并将原始回调交给兑换入口；单测覆盖目标替换、重复/编码键、错误参数混入及拒绝后原尝试仍可成功。这不是浏览器 Cookie 或 HTTP 安全验收。尚无 HTTP 回调处理器、邮件发送入口、上游身份关联、用户同意或 grant 创建。

失败可能已在 Auth 创建会话，不宣称已回滚或自动登出。尝试和凭据不持久化，进程重启只能重新登录；这不解决多进程回调路由。摘要绑定不验证宿主传入会话的真实性或实时撤销，宿主仍必须管理浏览器会话，不能把任意客户端的 code 交给任意尝试。

版本依据：Supabase Auth `v2.196.0` 的 [PKCE handler](https://github.com/supabase/auth/blob/v2.196.0/internal/api/token.go#L214-L288) 验证 verifier，成功兑换后在事务中删除 flow state；不能据此假设并发兑换天然串行，宿主仍禁止重复请求。[OTP](https://github.com/supabase/auth/blob/v2.196.0/internal/api/otp.go#L17-L47) 接受 code_challenge/code_challenge_method；邮件 GET verify 在 PKCE 模式重定向为 code，而 POST verify 直接签发 token，不能混用。新增本地测试经真实 SMTP 邮件及 GET 验证链接取得 code，验证错误 verifier 拒绝、原尝试成功、新 session 身份与本地重复兑换拒绝；未启用真实远程登录。

浏览器会话边界由 [createLoginBrowserSessions](../mcp/src/browser-sessions.ts) 提供，本身不启动监听器。仅接受固定 HTTPS origin，不为本地开发降低 Secure Cookie 要求。issue 生成独立的 32 字节会话标识与 CSRF token，Cookie 为 `__Host-tera-mcp-login; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`，无 Domain。内存表只保存会话摘要、CSRF 摘要及五分钟绝对期限，无滑动续期；最多 1024 个会话，创建时清理过期项，满容量拒绝新会话，不驱逐活跃会话。它仅标识登录浏览器事务，不代表用户已认证或取得任何 store scope。

read(request,false) 仅接受固定 origin 的 GET 和唯一、合法、已签发且未过期的 Cookie；回调仍须另外经过 login.ts 的 state/PKCE 校验。read(request,true) 仅接受 POST，并要求 Origin 精确匹配及同会话 `X-CSRF-Token`；revoke 复用该检查，删除服务端会话并返回过期 Cookie。均不采信 Host/Forwarded 来重建 origin；代理必须在后续入口正确提供 Request URL。返回的浏览器标识只能供内部 login 调用，不写入页面或 URL。未知/重复 Cookie、错误来源/方法/CSRF、过期或撤销均统一 BROWSER_SESSION_REJECTED。

下游 Request/Response 流程已由 [createLoginHttpHandler](../mcp/src/login-http.ts) 串联会话签发、一次性邮件发送、PKCE 回调、状态查询和取消。固定 HTTPS origin，bootstrap 要求同源 Origin/自定义请求头，单实例每分钟最多 20 次；每会话只发送一次邮件，create_user=false，1024 字节流式正文上限及十秒正文/提供方请求预算。所有 HTTP 响应 no-store/no-referrer，不含下游身份或凭据，失败不透露邮件提供方正文，发送成功/失败均返回 email_requested，待认证状态只显示 pending（不保证时序不可区分）。callback 成功后清除地址栏中的参数，跳转到固定状态地址；错误浏览器/state 不消耗合法尝试，兑换过程中取消或过期则不保留结果。

内部 takeIdentity 仅允许原会话携带 CSRF 的 POST，一次性返回已验证管理员身份与同一次兑换的凭据，HTTP handler 不公开该领取路径。宿主必须另外证明并绑定上游授权身份、取得明确同意，才可创建 grant、加密保存凭据；不能把此方法当作 grant 批准。身份暂存在内存，五分钟后禁止访问，访问/签发时清理过期项，无定时擦除保证。进程重启丢失所有会话，多节点不共享；取消不回滚已在 Auth 创建的会话，不宣称自动登出。

验证包含路由单测、真实本地 SMTP/Auth 往返，以及 agent-browser 对临时回环 HTTPS 监听器的 Cookie/CSRF/回调跳转/取消检查；浏览器检查使用模拟 Auth，与真实邮件测试分开，不代表真实 MCP 客户端或完整生产登录验收。没有产品登录页面、上游授权关联或生产监听器；当前处理器只能挂在未来宿主验证的上游授权事务之后，进程级限流不替代边缘/用户限流。

用户已明确最终交付是远程 MCP，stdio 只保留为调试/兼容入口。2026-09-21 再核对 [Keycloak 官方 MCP 指南](https://www.keycloak.org/securing-apps/mcp-authz-server)，其兼容表仍将 RFC 8707 列为 Not supported，不能以本仓库开启实验功能的通过结果宣布生产支持；本轮不将 Keycloak 定为生产方案，也不退回忽略 resource 的静态 audience 替代。生产授权服务选择仍是发布前阻塞项；先推进不依赖具体上游提供方的下游登录，再完成双身份批准、刷新代理和远程 transport。

1. **授权兼容性与工具权限清单。** 清单已完成；嵌入式库和独立 Keycloak 的上述协议实验已完成，实验性 feature、生产存储和隔离边界仍需验收。外部服务账号、生产配置与部署需另行授权。
2. **逐用户 grant 与凭据代理。** 完成可信账号关联、加密凭据保存/轮换、精确用户 UUID 校验、撤销与错误恢复；使用两个不同管理员交叉验证，防止“均为管理员”掩盖身份串用。
3. **受保护 HTTP transport。** 接 metadata/challenge、SDK transport 和逐请求 context；验证错误 issuer/audience、过期 token、缺失 scope、匿名/普通客户、scope 降级及直接调用隐藏工具全部拒绝。
4. **并发与部署验收。** 交叉复用 session/event ID、重连、进程重启、并发 refresh、授权服务不可用、执行前撤销、执行中撤销及不确定写结果均须测试；两个真实客户端完成授权、升级 scope、断开授权和恢复流程后，才声明远程可用。

依据（2026-09-21 核对）：[MCP 2026-07-28 Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)、[Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)、[Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)。这些规范与文档支持边界选择，不代表本仓库或当前部署已经具备上述能力。
