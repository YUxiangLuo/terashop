# Tera Admin

Svelte 5 / SvelteKit CSR 管理端，与 Storefront 共用 Bun workspace。无服务端路由，adapter-static 输出 SPA；普通业务由当前管理员会话调用 Supabase 受控 RPC。**导航和登录门禁不代替数据库权限检查。**

## 本地运行

先按根目录 [快速开始](../README.md#快速开始) 初始化可丢弃的本地 Supabase，并应用当前完整迁移。`bun run setup` 会清空本地数据库和账号，不用于共享环境升级。

```bash
bun run admin:dev       # 默认 http://127.0.0.1:5174
bun run admin:check     # 无需数据库
bun run admin:build
bun run admin:preview   # 默认 http://127.0.0.1:4175
```

开发/预览只监听回环，实际端口以终端输出为准。`PUBLIC_SUPABASE_URL` 与 `PUBLIC_SUPABASE_ANON_KEY` 均未设置时，脚本读取本项目本地服务；远程构建必须同时设置二者。可用 `bun --env-file=.env scripts/frontend.ts admin build` 读取环境文件。公开变量写入浏览器产物，禁止填写 service-role、S3 或 PayPal secret。

## 第一个管理员

不提供默认密码、自动提权或公开管理员注册。仅对可丢弃的本地环境：

1. 在 Studio `http://127.0.0.1:54323` 创建邮箱/密码用户并确认邮箱。
2. 复制 Auth UUID，在 Studio SQL 编辑器执行：

```sql
update public.profiles set role = 'admin' where id = '<AUTH_USER_UUID>'::uuid;
```

3. 在 Admin 登录。后续角色变更使用受控 `set_user_role`，不接受 `user_metadata` 声明的角色。

生产账号须由受信运维验证身份后授权，并配置 MFA、密码恢复及 Auth 安全策略，不能照搬本地人工确认。重建本地数据库后须重新初始化账号。

## 导航与能力

七组导航使用现有详情路由；650px 及以下为支持焦点约束和 Escape 关闭的 Menu 抽屉。退款/退货/履约从订单进入，调拨从库存进入。Personal 区域独立提供本人 Agent 连接。

| 分组 | 当前能力 | 主要边界 |
| --- | --- | --- |
| Orders | 订单筛选、历史快照、备注、事件、支付记录、发货/物流、线下退款、退货；报价查询与取消 | 无支付捕获、真实渠道退款或独立订单取消 UI；取消报价可连带取消未付款订单 |
| Products | 商品、规格/变体、分类树、图片、条码/成本/原价/标签/SEO、素材查询恢复 | 聚合原子保存；已有变体停用而非删除；发布后需重建 Storefront 静态页面 |
| Inventory | 商品/SKU 搜索、余额/流水、调整、即时调拨、仓库管理 | 停用仓库可读历史，禁止新调整/调拨；不移动预占，无在途或收货追踪 |
| Customers | 商业客户创建、联系方式、地址增删改/默认设置、关联订单 | 不创建 Auth 账号；匿名化记录只读，无直接匿名化编辑入口 |
| Promotions | 五类促销、规则/用量/目标读取，商品/分类/变体搜索选择或 UUID 输入 | 目标整组替换最多 100 条，超过拒绝，不截断；使用量不是已付款销售 |
| Operations | 对账异常、支付 Inbox、Outbox 只读诊断，Agent 审批 | 不提供资金重放、Worker 操作或 Outbox 重投按钮；空列表不证明健康 |
| Settings | 配送范围/费用、税率 | 国家级比例税，无承运商、面单或复杂税务合规功能 |

商品、分类和配置更新保留原 revision / 微秒时间戳；商品聚合保留未编辑的扩展字段和变体排序。新配置通常默认停用，启用须明确确认。分类停用不级联停用子分类或商品；仓库启停/默认切换不搬库存；促销、配送和税率变更不改历史订单。

金额最多两位小数，不自动舍入。税率界面用百分数（7.25% → API 0.0725），促销百分比参数仍用百分数；配送国家留空表示不限国家，免邮门槛空值与 0 不同。完整规则见 [API](../docs/api.md)，本页仅描述 UI 和恢复方式。

## 编辑结果与草稿保护

编辑器核对读取/写回执的记录身份、版本及必要字段；空值、错 ID、旧版本或不完整回执不会清空草稿，也不证明数据库回滚。冲突或未知结果锁定再次保存，须显式重读核对，不能自动换版本重试。

- 未提交草稿主要在页面内存中；离开有提示，退出或丢失会话清除编辑界面，不是服务端持久草稿。
- 商品/分类/仓库等创建 UUID 保留在 URL，响应丢失先按原 ID 核对。客户创建保留 URL 请求键及**内存中的原联系方式**，不把 PII 写入恢复存储；刷新或关闭标签页会丢失原参数，不能猜测参数或换键再建。
- 库存草稿切换仓库/变体前须确认；商品页库存草稿未完成时禁止商品保存/重载，避免重建组件丢失输入。
- 列表和历史读取失败保留旧数据并标记过时；游标原样传递，不把 bigint/微秒令牌转成 Number/Date。分页不是冻结快照。

### 库存与发货的失败恢复

库存调整、调拨、履约及退货等命令发送前在当前标签页 `sessionStorage` 保存完整原参数和幂等键，按管理员、操作类型和资源隔离；存储失败不发送。未知结果锁定新操作，刷新后仅显式恢复原请求，不能换键或依据余额变化推断成功。

首次明确数据库拒绝可允许修正；未知请求的重试被拒绝不证明第一次失败。仅身份、归属和业务字段匹配的回执才清除待决记录；读取失败或 Realtime 通知不能解除锁定。已经提交的原键重放与新操作资格不同，仓库停用等后续变化不应阻止核对历史。

恢复记录不含 Auth token 或客户地址，但可能含备注/物流信息。退出不清除待决记录，供同一管理员恢复；关闭标签页、清浏览器数据或换设备后不保证恢复，也不跨标签页去重。无法确认时先核对后台事实并由受信运维调查，不直接删记录盲重试。

### 退款、退货与取消

- **线下退款只记账，不向 PayPal 转账。** UI 只对符合条件的手工收款订单开放新登记。先 `preview_manual_refund` 显示含税金额与库存影响，明确确认钱已线下退回，再携原 preview token、原因和幂等键提交；事实变化后须重新试算和确认。
- 金额退款与商品数量/可选运费退款不混用。金额模式不取消商品或回库；商品模式可取消未发货量，库存释放须明确选择。未知提交保留原请求，不用剩余余额或变化后的资格否定历史成功。
- 退货按发货行授权，分批登记实收，再选择回库/报废。授权不收货，实收不增加可售库存，两者都不退款。回库固定进入实收仓且需合法原扣减事实；停用仓不可新回库，但可报废。
- 关闭退货停止继续收货，取消仅限尚无实收；不改变已完成处置或资金，终态不可重开。未知关闭先重读，保留原目标；当前终态不证明由本次请求完成。
- 取消报价须填写客户可见原因，converted 报价可能连带取消未付款订单。不能退款、续期或穿透后端捕获保护；有效过期不等于存储取消成功。发货取消同样不退款、不回库。

## Agent 操作的人工接管

Admin 与 MCP 共用受控业务合同，MCP 返回的资源链接只打开详情，不执行操作。用户在 `/approvals` 独立登录，核对并决定本人 Agent 的退款、角色变更、客户/用户匿名化请求；支持最新记录及原 ID 查询。

批准绑定原请求且有时限，不是给 Agent 通用写权限。`consuming` 要先核对业务事实，`consumed` 不证明渠道结算。完整流程以 [MCP 逐笔人工审批](../mcp/README.md#远程逐笔人工审批) 为准。

## 本人的 MCP 连接

`/connections` 展示本人脱敏授权和调用观察。非匿名用户被降级后仍可访问该安全页、撤销本人连接，不能进入管理业务页或查看他人连接。Admin 退出不等于撤销 MCP。

- 可撤销单个、当前页或跨页预览中的明确 ID 集合。跨页预览最多 100 条，超限整体拒绝；含本地已撤销但尚未申请上游清理的记录。超时重试保持原集合，不纳入后来新建的连接。
- 撤销先停止新准入、删除密文并登记清理任务；OAuth 宿主异步撤销上游 token 家族。不能取消已派发业务，也不删除 Supabase Auth session。`active` 仅表示未本地撤销，`cleanup` 表示该入口的清理进度，均非健康证明。
- 确认集合只留在页面内存，刷新后重读事实。授权与调用列表每页 20 条，非跨页快照。
- 调用记录须运维开启 `authorization.auditTools` 才采集；只显示本人安全摘要和固定资源链接，无参数、结果或凭据，也不能重放/删除。`pending/returned/rejected/unknown` 是宿主观察，不等于结算或送达；空列表不证明无调用。

接入由预注册客户端发起 OAuth/PKCE。可选公开构建变量只展示受信运维配置：

```bash
PUBLIC_MCP_CONNECTION='{"resource":"https://mcp.example.com/mcp","issuer":"https://auth.example.com","scopes":["store:read","store:write"]}' bun run admin:build
```

仅允许这三个字段；HTTPS 地址无凭据/query/fragment，resource 须有非根路径。构建拒绝未知字段、未知/重复 scope；不填协议 scopes `openid/offline_access`，不填任何 secret。未配置则不推断地址，更新后须重建。页面不读取远程元数据、不发起 OAuth、不签发 PAT；展示不证明服务可用或实际授权。部署时与真实 issuer/resource/scopes/写开关核对，见 [MCP 运维](../mcp/OPERATIONS.md)。

## 实时失效通知

私有 Supabase Broadcast 只发送“可能变化”，不发送业务行、资源 ID、参数或凭据；浏览器不能发布。业务数据始终从授权 RPC 重读，频道权限缓存不保证降级后立即断开。个人频道只供本人非匿名身份订阅，降级后仍可使用安全页。

通知合并 200ms，隐藏页不自动读取；首次订阅、重连、聚焦/回到前台重新核对或提示。没有持续轮询、可靠送达或精确库存到期推送，不能用于确认写成功。读取失败保留旧数据；草稿、确认集合和未知请求不会被通知覆盖。

### 当前覆盖与上线边界

| 页面 | 处理方式 |
| --- | --- |
| 商品列表、分类树 | 按已应用筛选自动重读已加载页数，保留筛选草稿/展开状态；一页失败不混装部分新结果 |
| 分类编辑 | 干净时自动重读；草稿、保存中、冲突和未知结果保留 |
| 本人调用记录 | 最新页自动重读，历史页只提示 |
| 本人连接 | 无确认集合时自动重读第一页；后续页、预览和未知撤销保留 |
| 库存、调拨 | 只提示，显式刷新余额/流水；不重建表单或解锁未知操作 |
| 其他业务页 | 按当前路由订阅业务域，只提示，用户显式核对 |

提示可能来自同域其他记录，Dismiss 只收起提示，不表示已读取。自然到期未必发生数据库写入，因此预占到期不保证推送；最终库存限制由数据库检查。SPA 切换清理订阅，同名频道等待旧退订完成再创建，不重挂载业务页面。

发布前应用当前完整店铺迁移；通知相关为 `20260923000005`～`00010`。核对 Realtime 私有 Broadcast / `realtime.send`、WSS 网络路径和 Auth JWT 配置，不需将业务表加入 publication 或给浏览器 service key。这里的 WSS 代理要求不代表远程 MCP 支持反向代理。

目标环境须验证跨用户隔离、降级 RPC 拒绝、断线恢复、草稿/未知写保护，并观察通知量、连接数和 RPC 读取量。限流可导致通知丢失，本地回归不等于生产容量验收。测试入口见 [测试指南](../docs/testing.md#admin--mcp-本地融合验收)。

## 图片权限与失败处理

新上传使用 `managed-media`：**私有暂存 → 明确永久公开 → 加入表单 → 保存商品关联**。先保存商品，一次上传一张 JPEG/PNG/WebP，1 byte–1 MiB；发布不会自动关联商品。

浏览器使用管理员自己的会话。服务端单独配置精确来源列表 `MEDIA_ALLOWED_ORIGINS`（逗号分隔，生产 HTTPS），默认拒绝浏览器，**不继承支付 CORS**。不向浏览器分发 service key，CORS 不代替身份校验。本地示例：

```sh
printf 'MEDIA_ALLOWED_ORIGINS=http://127.0.0.1:5174\n' > /tmp/tera-media.env
bunx --no-install supabase functions serve managed-media --network-id tera-headless-loopback --env-file /tmp/tera-media.env
```

上传前在当前标签页保存原 request UUID、MIME、字节数和 SHA-256，不存文件内容或 token。丢失回执先按 request ID 查询，只有同一文件可显式恢复原请求，不能换 UUID 重传。关闭标签页会丢失本地记录，应保留 request ID；`/media` 和商品上传区可据此发现其他标签页或 Agent 的素材。

私有素材无预览/signed URL。发布前永久保留，公开后任何持有 URL 的人均可读取，**不能删除或转回私有**；草稿商品也不保密。发布和保存关联不是同一事务，确认关联后才清除上传恢复记录。

`/media` 支持查询、准备丢弃、删除和恢复删除结果，仅已确认上传结束的私有 staged 素材可进入删除流程。pending 上传、retained/公开对象及旧公开文件不可删；读取不自动发布、关联或删除。不做垃圾回收，移除商品图片只解除关联。MIME/摘要不等于内容安全扫描，旧 bucket 的 5 MiB 上限不等于新服务上传限额。完整生命周期见 [Edge 合同](../supabase/functions/README.md#私有媒体通路)。

## 静态部署与验收

发布 `admin/build/` 到独立 HTTPS 域名根路径；静态托管须将页面路由回退到 `200.html`（状态 200），已有 JS/CSS 正常提供。例如：

```nginx
location / {
    try_files $uri /200.html;
}
```

构建不预取管理员资料或会话，不能发布 localhost 配置。noindex 不是访问控制；实际授权依赖 Auth、数据库和 Storage。先经批准应用店铺迁移，再升级 MCP/Edge/Admin，具体顺序见 [数据库开发](../docs/database.md) 和 [MCP 运维](../mcp/OPERATIONS.md)。

浏览器烟测需要本地 Supabase、运行中的 Admin 与 `agent-browser`，只可对可丢弃环境执行。常用入口如下；部分脚本包含受控响应故障注入，不能据截图宣称真实渠道验收。库存/交易脚本会保留不可变审计数据，恢复纯演示目录需重新 setup。

| 范围 | 脚本（仓库根目录 `bun scripts/<文件>`） |
| --- | --- |
| 导航、连接、逐笔审批 | `admin-navigation-smoke.ts`、`admin-connections-smoke.ts`、`admin-fusion-smoke.ts` |
| 商品实时列表、分类、客户、素材 | `admin-products-live-smoke.ts`、`admin-categories-smoke.ts`、`admin-customers-smoke.ts`、`admin-media-smoke.ts` |
| 库存、调拨、仓库 | `admin-inventory-review-smoke.ts`、`admin-transfer-smoke.ts`、`admin-locations-smoke.ts` |
| 促销、目标、配送、税率 | `admin-promotions-smoke.ts`、`admin-promotion-targets-smoke.ts`、`admin-shipping-smoke.ts`、`admin-taxes-smoke.ts` |
| 订单活动、退款、退货、报价、运维 | `admin-order-activity-smoke.ts`、`admin-refunds-smoke.ts`、`admin-returns-smoke.ts`、`admin-quotes-smoke.ts`、`admin-reconciliation-smoke.ts` |
| 异常回执与页面通知 | `admin-write-receipts-smoke.ts`、`admin-page-changes-smoke.ts` |

多数脚本支持 `ADMIN_URL` 指定实际本地端口，截图位置以脚本为准；须实际查看桌面、移动及失败状态截图。真实 OAuth → MCP → Admin 联动、数据库回归和夹具清理约定统一见 [测试指南](../docs/testing.md)。
