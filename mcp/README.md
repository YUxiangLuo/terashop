# Admin MCP

独立于 `admin/` SPA 的管理员客户端层。工具调用使用当前管理员 JWT 访问 Supabase；数据库负责授权、事务、幂等、库存与资金规则。没有直连数据库、任意 SQL、任意 RPC/表名或 service-role 回退入口。

**当前为可运行的 stdio MCP，112 个显式工具（53 个只读、59 个写入）。尚未达到完整 Admin 覆盖，也不提供远程 HTTP 服务。** 下方覆盖表是完成范围，不以 SPA 当前功能为上限。

最终交付目标是可部署的远程 Admin MCP；stdio 仅为开发调试与兼容入口，不作为完成标准。当前优先串联登录授权、逐用户凭据刷新、Streamable HTTP 和真实客户端验收；大文件及快照导出独立收尾，不阻塞已有工具的远程链路。浏览器只用于登录和授权，不依赖 Admin SPA 执行业务。

远程授权方案已选定：独立 Node.js LTS 容器运行 `oidc-provider 9.12.2`，MCP 与安装、构建、测试工具仍使用 Bun。Supabase 保持唯一用户目录；授权服务须从真实 Supabase 登录取得 UUID，不建立第二套账号或按邮箱推断身份。采用 opaque access token 与在线 introspection；已完成受支持运行时的协议验证、MCP 校验 profile 和初版 PostgreSQL provider adapter，尚无生产授权服务或远程监听器。

## 运行与凭据

在仓库根目录执行 `bun install --frozen-lockfile`。通过 MCP 客户端的安全环境配置或凭据管理器提供以下环境变量，再运行 `bun run mcp:stdio`：

| 变量 | 用途 |
| --- | --- |
| `TERA_SUPABASE_URL` | Supabase origin，例如本地 `http://127.0.0.1:54321`；远程必须 HTTPS，不接受路径、query 或 URL 内凭据 |
| `TERA_SUPABASE_ANON_KEY` | 项目公开 anon / publishable key；不是 service-role secret |
| `TERA_ADMIN_ACCESS_TOKEN` | 非匿名管理员用户的有效 Supabase access token |
| `TERA_MCP_ALLOW_WRITES` | 只有精确值 `true` 才注册写工具；省略时仅注册只读工具 |

首次管理员初始化沿用 [Admin 文档](../admin/README.md)。通过现有 Supabase Auth 登录取得短期会话；本阶段不提供登录工具，不接受密码/令牌作为 tool 参数，不保存或自动刷新 refresh token。令牌到期后在宿主安全配置中替换，并重启 MCP。不要把令牌放进对话、版本库、URL 或启动参数。

通用 MCP 客户端配置示意（占位符需由宿主安全配置替换，不会自动展开）：

```json
{
  "mcpServers": {
    "tera-admin": {
      "command": "bun",
      "args": ["/absolute/path/to/tera-headless/mcp/src/stdio.ts"],
      "env": {
        "TERA_SUPABASE_URL": "https://PROJECT.supabase.co",
        "TERA_SUPABASE_ANON_KEY": "<public key>",
        "TERA_ADMIN_ACCESS_TOKEN": "<short-lived admin session>",
        "TERA_MCP_ALLOW_WRITES": "false"
      }
    }
  }
}
```

使用官方稳定版 **TypeScript SDK v2，`@modelcontextprotocol/server@2.0.0`**，不使用 v1 单包的深路径导入。协议协商交给 SDK `serveStdio`，支持现代 `2026-07-28` 与 SDK 提供的旧版协商路径（包括 `2025-11-25`）。参考 [官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)；本项目不自制 JSON-RPC transport。

启动与每次工具调用均验证 Auth 用户及数据库 `is_admin()`；数据库命令在事务内再次授权。角色降级后不能依靠旧 MCP 会话继续管理。普通客户、匿名会话、无效 token、service token 均不作为管理员会话接受。用户登出不等于所有已签发 JWT 立即失效；凭据撤销的时效沿用 Supabase Auth 合同。

## 工具与行为合同

数据库工具与对应受控 RPC 同名，媒体上传及核验调用 Storage API；**只有显式注册的工具可调用**。参数使用严格 schema，拒绝未知字段；RPC 输入类型与 [生成类型](../types/database.ts) 编译校验。详细业务语义见 [API 合同](../docs/api.md)。

| 领域 | 本阶段已注册工具 |
| --- | --- |
| 商品 | `list_admin_products`、`get_admin_product`、`create_product`、`update_product`；覆盖变体、规格、图片 URL、分类关联、商品/变体 metafield 的原子编辑 |
| 媒体 | `list_admin_product_media`、`upload_product_media`、`inspect_product_media`；按商品路径发现对象，上传不可覆盖的公开对象，按原标识核验字节数和 SHA-256，随后单独保存商品图片关联；不提供对象删除 |
| 分类 | `list_admin_categories`、`get_admin_category`、`create_category`、`update_category`；支持平铺分页/组树、移动、排序、停用；更新须原样传回 updated_at |
| 客户 | `list_admin_customers`、`get_admin_customer`、`create_customer`、`update_customer`、`anonymize_customer` |
| 地址 | `create_customer_address`、`update_customer_address`、`delete_customer_address`、`set_default_address`；读取使用客户详情；编辑/删除使用地址自身 updated_at，返回最新客户详情 |
| 库存 | `get_inventory_availability`、`adjust_inventory`、`list_admin_inventory_movements`、`transfer_inventory`、`get_inventory_transfer`；即时原子调拨，不跟踪在途/收货，不搬预留；流水 ID/游标为字符串，历史实物库存不代表当前可用量 |
| 仓库 | `list_admin_locations`、`get_admin_location`、`create_location`、`update_location`、`set_default_location`；版本化编辑/启停，默认仓原子切换；不删除、不搬库存 |
| 促销 | `list_admin_promotions`、`get_admin_promotion`、`list_admin_promotion_targets`、`list_admin_discount_redemptions`、`create_promotion`、`update_promotion`；版本化规则/目标原子保存与启停，新建默认停用；优惠码占用不等于永久历史或已付款销售 |
| 配送 | `list_admin_shipping_methods`、`get_admin_shipping_method`、`create_shipping_method`、`update_shipping_method`；版本化费用/免邮门槛/国家范围/启停，新建默认停用；不调用承运商、不购买面单、不改写历史收费 |
| 税率 | `list_admin_tax_rates`、`get_admin_tax_rate`、`create_tax_rate`、`update_tax_rate`；版本化国家/比例/运费计税/启停，新建默认停用；国家规则优先于 * 兜底，不叠加、不改写历史税额 |
| 扩展字段 | `list_admin_metafield_definitions`、`get_admin_metafield_definition`、`list_admin_metafields`、`create_metafield_definition`、`update_metafield_definition`、`create_metafield`、`update_metafield`、`delete_metafield`；定义版本化规则/可见性编辑，新定义默认私有；分类/客户/订单/shop 值版本化增删改，值可见性遵循当前定义；按资源读取含无定义值，不展开引用 |
| 扩展对象 | `list_admin_metaobject_definitions`、`get_admin_metaobject_definition`、`list_admin_metaobjects`、`get_admin_metaobject`、`create_metaobject_definition`、`update_metaobject_definition`、`create_metaobject`、`update_metaobject`、`delete_metaobject`、`delete_metaobject_definition`；定义默认私有、条目命令默认草稿，版本化编辑/发布/撤回/删除；引用中条目和非空定义不可删，不自动解除引用或级联 |
| 订单 | `list_admin_orders`、`get_admin_order`、`update_order_admin_note`、`list_admin_order_events`、`get_order_pricing`、`get_order_checkout_quote`、`get_order_ledger`、`get_order_fulfillment_balance`、`cancel_order`、`cancel_zero_value_order_item`；备注按旧值比较后替换，不追踪历史；事件仅安全元数据，不含任意载荷 |
| 手工资金 | `mark_order_paid`、`refund_order`；仅记账，不调用真实支付渠道 |
| 报价运营 | `list_admin_checkout_quotes`、`get_admin_checkout_quote`、`cancel_checkout_quote`；含未转单报价，客户/有效状态/是否关联订单筛选，UUID 分页；摘要不含地址/备注，详情含敏感历史快照。显式取消可连带取消符合条件的未付款订单，不续期、不退款 |
| 渠道资金 | `list_admin_payment_operations` 查询脱敏渠道操作；`refund_paypal` 通过现有 Edge 发起真实退款，要求显式范围与批准、保留原幂等键、不自动重试；服务端决定 sandbox/live，不能用手工退款代替 |
| 履约 | `create_fulfillment`、`update_fulfillment` |
| 退货 | `get_order_returns`、`create_return`、`receive_return`、`dispose_return_receipt`、`close_return` |
| 评价 | `list_admin_reviews`、`get_admin_review`、`moderate_review`、`delete_review`；全部状态查询、版本化审核与删除；作者编辑后重新待审，不代写客户内容 |
| 权限 | `list_admin_users`、`get_admin_user`、`set_user_role`、`anonymize_user`；区分 Auth 用户与商业客户 ID，不返回 Auth 凭据或登录状态，不提供邀请/创建账号 |
| 店铺 | `get_admin_shop_settings`、`update_shop_settings`；版本化名称/展示时区，USD 只读；当前未接前台展示，不改交易时区或 Auth/项目配置 |
| 统计 | `get_admin_payment_summary` 按账本记录时间汇总成功收退款，含手工记账；`get_admin_order_summary` 按下单时间汇总原始订单额及当前状态，含取消/未付款/零元订单；均非收入/到账证明，最多 31 天、10,000 条，超限拒绝，不截断 |
| 运维 | `list_admin_outbox_events`、`list_admin_payment_provider_events`、`list_admin_reconciliation_issues`、`get_admin_operations_summary`、`redrive_outbox_event`；全店未对账资金及分组件区间积压概览，仅安全诊断，不开放资金重放或宣称整体健康 |
| 导出 | `export_admin_orders`；固定字段 JSON 分页，不含客户联系方式，订单号/金额为字符串；不写文件或外发，不保证跨页冻结快照 |

- 成功时同时返回文本 JSON 和 `structuredContent: {data: <后端结果>}`。全部 112 个工具均显式声明领域输出 schema，注册函数不再提供通用 JSON 默认值。固定结构和嵌套关系行拒绝未知字段；订单地址、选项、政策与促销等存储 JSON 快照仍按既有动态内容合同保留。schema 不重算金额或替代数据库业务校验，也不代表已覆盖全部 Admin 功能。
- 管理员报价详情额外返回 customer_id、stored_status，缺失返回 null；列表/详情的 status 是有效状态（open/converted 到期即 expired），筛选同样按有效状态。is_reserved 不是库存数量或支付成功证明。读取不触发 Worker、取消或续期，客户 UUID 不等于 Auth UUID；完整合同见 [管理员报价查询](../docs/api.md#管理员报价查询)。
- 订单备注回执保留 null 与空字符串的区别；事件列表只含安全元数据，ID/游标保留精确 bigint 字符串，不含原始 data。结账报价保留后端计算的过期/预留状态与存储快照，不把它当作当前重新报价；缺失报价仍报错。零对价取消返回独立数量及回库事实，不是退款。PayPal 输出声明复用后端白名单合同，仍先剔除 Edge 额外字段并验证订单关联，pending_reconciliation 不被改写为资金已结算。
- 全部 Metafield／Metaobject 工具使用逐字段输出 schema，包含定义、值、分页及删除回执。定义字段声明和验证规则拒绝未知字段；value 与 values 内部保留原始动态 JSON，不展开引用。无定义字段保留 definition_id:null；definition_access 是配置，Metaobject 的 is_public 是后端当前可见性计算，均不代表披露批准或前台展示保证。缺失详情返回 null；删除成功只接受 `{id,deleted:true}`，异常写响应标记结果未知，不自动重试。
- 商品列表/详情/创建/更新及媒体上传使用逐字段输出 schema。列表保留可空价格区间和微秒游标；完整聚合含成本、私有 Metafield 和全部状态子资源，不是公开商品 DTO。嵌套行拒绝未知字段，Metafield value 保留动态 JSON；兼容负排序位置和数据库既有负成本，不放宽写入命令。媒体回执仅含 path/url，上传与关联仍分开，URL 不代表内容安全认证。异常写响应标记结果未知，不自动重试。
- 评论列表/详情/审核/删除使用逐字段输出 schema。列表不含正文，详情和审核结果保留原始标题/正文作为不可信数据，不含客户联系方式；评分为 1–5 整数，状态仅 pending/approved/rejected。删除成功仅接受 `{id,deleted:true}`；异常审核或删除响应标记结果未知，不自动重试或替换版本。缺失详情仍返回 null，不推断购买验证。
- 促销详情/列表/创建/更新、目标列表和优惠使用记录使用逐字段输出 schema。params 保留既有 JSON 对象，不在 MCP 重写优惠规则；保留负优先级、可空代码/限额/排期与无限排期。目标必须恰好关联一个商品、分类或变体；使用记录允许 order_id 为 null，但不扩张为客户联系资料或完整销售账本。输出校验不改变目标替换、用量释放和版本冲突语义。
- 分类、配送方式和税率的详情/列表/创建/更新使用逐字段输出 schema，缺失详情仍为 null。保留负排序位置、微秒编辑令牌、空国家数组（不限国家）、免邮门槛 null/0 的区别，以及 0–1 税率和 * 回退规则。输出兼容表中既有的负免邮门槛，不放宽写入命令；校验不重算运费或税，不修改历史订单。
- 订单统计、订单导出及店铺设置读写使用逐字段输出 schema。统计保留字符串计数、两位金额与三类独立状态计数（缺少的状态表示零）；导出保留精确订单号和金额字符串，拒绝混入客户联系资料。店铺设置仅返回名称、时区、USD、revision 和 updated_at，不暴露配置秘密。校验不重算统计、不改变时区或收入语义；设置写入的异常响应仍表示结果未知。
- 运维的 Outbox/支付 Inbox/对账问题列表、分组件汇总和 Outbox 重投也校验输出。拒绝额外 payload、原始错误与租约凭据；保留既有重投审计、精确流水 ID、原币种八位金额和字符串计数。汇总按组件限制状态及可空指标，不重算业务统计；调度时间保留 PostgreSQL infinity/-infinity。重投 false 是合法的未匹配结果，不表示投递成功，也不触发自动重试。
- 应用用户列表/详情、角色变更和用户匿名化使用逐字段输出 schema。读取使用 user_id 和可空 customer_id/customer_anonymized_at；写入返回 profile 行（id/email/role/created_at/updated_at），不将 id 改名或与商业客户 ID 混用。保留匿名化后的空邮箱及微秒时间戳，拒绝额外 Auth 字段和未知角色；资料存在不证明可登录，匿名化不撤销 Auth 凭据。
- 客户列表/详情/创建/更新/匿名化、地址创建/更新/删除及默认地址操作使用逐字段输出 schema。列表/详情只返回 has_account，不含 auth_user_id；创建和匿名化沿用客户行合同，保留可空 auth_user_id（关联 ID，不是凭据）。默认地址操作返回地址行，地址 CRUD 返回客户详情。嵌套地址和 Metafield 外层拒绝额外字段，value 保留合法 JSON；时间戳保留微秒字符串。创建重放读取当前客户，不缓存或恢复匿名化前的个人信息；匿名化不删除 Auth 账户或历史订单。
- 履约创建/更新、库存可用量/调整/流水/调拨，以及仓库读取/分页/创建/更新/默认切换也使用逐字段输出 schema。可用量允许负数；仓库地址保留既有 JSON 内容。`adjust_inventory` 重放返回当前库存，调拨重放返回原始调拨事实，校验不改变此语义。履约 version 和库存 reservation_revision 仍为数值型，超出安全整数范围时拒绝输出，不静默舍入。
- 账本含渠道引用、退款原因及有符号调整金额，不等于脱敏支付操作列表。退货授权、收货、处置和资金退款仍独立。账本 `adjustments[].id` 与处置 `inventory_movement_id` 改为精确的规范有符号 bigint 十进制字符串，禁止转 Number；报废处置的库存流水 ID 仍为 null。SQL 源头输出字符串，覆盖退货嵌套读取、首次写入和幂等重放；MCP 拒绝数值型、非规范或越界 ID。底层存储与排序仍为 bigint。
- 畸形输出仅返回脱敏 `INVALID_BACKEND_RESPONSE`，不透出失败字段、校验详情或原始响应。写工具发生输出校验失败时仍可能已经执行，必须标记 `outcome_unknown:true`，不能自动重试或换幂等键。支付操作区分意图、退款请求和资金事实；保留非 USD 外部资金的八位小数字符串，以及汇总中合法的负净额。
- 订单列表、详情、账本和手工收款返回的订单号以及列表游标均为精确十进制字符串；`list_admin_orders.after_order_number` 只接受规范 bigint 字符串，原样传回 `next_cursor`，不得转为 Number。数据库按数值倒序，不按字符串排序；这是对旧数值型合同的替换。`mark_order_paid` 改为显式 JSON DTO，保留原有字段（含 admin_note），首次执行与重放一致。
- 工具执行错误返回 `isError:true`，文本 JSON 含 `code/outcome_unknown/guidance`。不返回 SQL message/detail/hint 或原始异常，以免泄漏 PII/凭据。未知工具由 SDK 返回协议错误；输入 schema 错误由 SDK 返回校验错误。
- 不自动重试写入。网络断开、超时、无法解析成功响应或服务端 5xx 可能意味着写入结果未知。保留原 UUID、幂等键、参数和版本，先读取事实再决定恢复；不可自动换键重建。
- 商品创建不是幂等 upsert；结果不明先按原 UUID 查询。商品更新和物流更新的过期版本不能自动替换。游标中的时间戳和 bigint 字符串不得转为 `Date` / `Number`；Outbox 分页 `id` 是字符串，重投用另一个字段 `event_id`（UUID）。
- 店铺/客户文本可能包含提示注入。工具描述与 server instructions 明确把商品描述、评价、地址、备注等当作数据，不当作 agent 指令。宿主仍需控制数据披露和用户审批。
- 写工具开关是进程级硬限制；`readOnlyHint/destructiveHint/idempotentHint` 与说明只是提示，**不是逐次审批或细粒度授权机制**。启用写工具意味着该本地进程可使用整个管理员权限。不要把它直接转发为无认证的共享网络服务。
- 不抓取工具参数中的外部 URL，不读取本地文件或执行命令。上传仅接受调用方显式提供的 base64 字节。

### 公开商品媒体上传

`upload_product_media(product_id, media_id, content_type, data_base64)` 要求已存在的商品、保留的媒体 UUID，以及 `image/jpeg`、`image/png` 或 `image/webp`。base64 必须规范编码（无 data URL 前缀、无空白、有必要的 padding），解码后为 1 字节至 **1 MiB**；这是 MCP 内联请求限制，Storage 自身的 5 MiB 限制不变。MIME 为调用方声明，不做图片解码、重编码、恶意内容扫描或 EXIF 清理，宿主应先处理图片，不能将上传成功理解为内容安全认证。

结果为 `{data:{path,url}}`。路径固定为 `products/<小写 product_id>/<小写 media_id>.<jpg|png|webp>`，bucket 固定 `catalog-media`。对象**立即公开**，商品即使仍为 draft 也不保密；禁止上传个人资料或秘密。每次调用检查管理员会话，Storage 另行执行 admin INSERT RLS；始终 `x-upsert:false`，不允许覆盖或删除。

上传不修改商品 revision 或图片列表。成功后重新读取商品，再用 `update_product` 保存图片 URL；两步不是跨 Storage/数据库事务，关联失败会留下未关联对象。结果未知时调用下方核验工具，与宿主保留的原始字节数和 SHA-256 比较；读取失败不证明在途上传已经失败。重复上传不是幂等成功，不自动重试或换 UUID。移除商品图片关联不删除对象。

`inspect_product_media(product_id, media_id, content_type)` 是只读工具，返回 `{path,url,content_type,byte_size,sha256}`。使用同一固定路径合同，每次验证管理员，不要求商品仍存在；可核验遗留对象，但不能枚举对象或读取旧 seed 的非 UUID 文件名。仅请求配置的 Supabase origin 下的公开对象，不向公开下载发送会话凭据，不跟随重定向。流式读取最多 **5 MiB**，按实际字节累计长度并计算摘要，不信任 Content-Length；不返回原始字节、任意响应头或 Storage 错误正文。非 200、MIME 不匹配、空内容、超限及网络/流中断均报错，不返回部分摘要。MIME 校验不是图片解码或内容安全扫描；摘要只证明本次读取内容，不承诺绕过所有 CDN 缓存，也不证明商品关联、完整引用范围或可安全删除。

`list_admin_product_media(product_id, page_size?, after_id?)` 可按商品路径分页发现规范命名的 Storage 对象，包括未关联上传及商品删除后保留的对象。对象身份沿用 Storage id，游标不是文件名中的 media_id；默认 20 条，最多 100 条。返回的 expected_content_type 仅由扩展名推导，不宣称字节已验证，也不暴露 owner/metadata。完整字段与范围见 [管理员商品媒体发现](../docs/api.md#管理员商品媒体发现)。

客户端直接删除 Storage 对象仍被数据库策略禁止。商品/分类的显式图片 URL 已在源写入事务内维护私有引用登记，但它不扫描富文本或任意 JSON，也不将 URL 自动认领为 Storage 对象。采用 [保守保留策略](../docs/architecture-decisions.md#adr-026媒体采用保守保留与显式引用边界)：旧媒体和自由 URL 使用的媒体不开放删除；零登记引用不等于删除许可。现有公开上传接口未来上传的文件也继续保留。

新增私有暂存通路（同样仅支持 1 byte–1 MiB JPEG/PNG/WebP）：
- `stage_media_upload`：传入 `request_id`、`content_type`、规范 `data_base64`；服务端分配媒体 ID，不接受路径或旧对象，不返回暂存 URL。
- `get_managed_media`：按 `media_id` 读状态；`url` 仅在确认公开写入后返回。
- `list_admin_managed_media`：只读分页发现所有生命周期状态，按状态、上传状态、published 和原 request_id 组合筛选；不读 Storage、不返回 URL、不代替删除资格检查。原上传响应丢失时优先按 request_id 查询。完整合同见 [受管理媒体发现](../docs/api.md#受管理媒体发现)。
- `recover_media_upload`：核验原私有字节，将 `uploading` 完成为 `staged`，不重新上传。
- `publish_managed_media`：先永久保留，再公开写入并核验；随后另用商品/分类版本化命令关联 URL。
- `prepare_media_discard`：仅将上传已确认结束（`upload_status=settled`）的 `staged` 冻结为 `discard_prepared`，**不删除字节**。
- `delete_managed_media`：明确批准后删除已冻结的私有对象，确认缺失后标记 `discarded`，保留身份记录。
- `recover_media_deletion`：只查询已冻结对象是否缺失并更新数据库状态，不发 Storage DELETE，因此仍是写工具。

发布与丢弃竞争同一持久记录，`retained` 永不回退；失败、解除关联或商品草稿不会恢复删除资格。每个媒体仅许可一次私有上传：`not_started → pending → settled`。pending 超时不能重置，读取恢复不能证明上传已结束，因此 pending 对象不可丢弃。响应丢失先按原媒体 ID 重读；若不知道 ID，可明确以原 request_id 和相同内容重放，pending/终态只返回当前状态，不重新写字节。删除结果未知时先查询或恢复，确需重发由用户明确批准；不自动重试。不提供 signed preview、旧对象导入或大文件。旧执行器创建的对象不能补标 settled；部署与升级限制见 [managed-media Edge](../supabase/functions/README.md#私有媒体通路)。

## 完整 Admin 的后续覆盖范围

下表保留各领域的完成范围；新的开发顺序见后面的核对结论。每个领域必须有输入/输出合同、权限反例和真实数据库回归；如果缺少原子命令，在拥有业务规则的数据库模块补充，而不是在 MCP 拼接多次写操作并冒充事务。

| 顺序 | 范围 | 当前缺口及实现要求 |
| --- | --- | --- |
| 1 | 商品与目录完整管理 | 商品原子编辑、分类管理、≤1 MiB 媒体上传、显式引用登记、私有媒体受控删除及受管理媒体分页发现已接入；剩余大文件，不新增底表编辑后门 |
| 2 | 客户、地址、库存与仓库 | 客户与地址管理、仓库读写/启停/原子默认仓切换、库存流水分页及单变体即时原子调拨已接入；不追踪在途与收货 |
| 3 | 促销、配送、税 | 三类配置的查询、版本化创建/编辑/启停已接入。促销目标整组替换最多 100 个；配送 countries=[] 为不限国家；税率 0.13 为 13%，停用国家规则可能启用 * 兜底。引用中的配置不强删；不提供复杂税制或承运商服务 |
| 4 | 扩展内容与评价 | Metafield 定义查询/创建/版本化规则与可见性编辑、六类 owner 值查询及分类/客户/订单/shop 值增删改已接入；Metaobject 定义/条目查询、创建、版本化编辑、公开状态与安全删除已接入；评价列表/详情/版本化审核与删除已接入。暂不提供嵌套 Metaobject 引用或 Metafield 定义删除。商品/变体值写入已有商品聚合命令；公开引用与不可恢复匿名化仍由数据库校验 |
| 5 | 订单与渠道运营 | 内部备注、订单事件、脱敏支付操作及 PayPal 退款 Edge 适配已接入；真实 Sandbox/部署验收待完成。旧 `get_payment_operations` 不作为 MCP 工具；手工退款不替代渠道退款 |
| 6 | 身份、店铺设置与运营 | 账户身份查询及既有角色/匿名化流程、单店名称/展示时区版本化设置、受限账本收退款汇总、下单区间运营概览、订单 JSON 分页导出、全店未对账资金及分组件区间运维概览已接入；待补设置消费端、快照文件导出。不让 MCP 写 Supabase 项目密钥/Auth 配置，不提供基础设施健康保证 |
| 7 | HTTP 与生产接入 | Streamable HTTP、受保护资源元数据、OAuth issuer/audience/resource/scope 校验、用户授权撤销、限流/请求预算/日志脱敏、部署测试与客户端兼容验收 |

HTTP 必须先解决 **MCP 专用访问令牌 → 当前管理员数据库身份** 的受信映射/令牌交换。普通 Supabase session JWT 不能直接作为 MCP HTTP 的 bearer token；也不能先验证外部 OAuth，再用无用户约束的 service role 代执行。当前没有实现或启用此链路，不开放占位 HTTP endpoint。

远程接入设计已记录在 [ADR-027](../docs/architecture-decisions.md#adr-027远程-mcp-使用独立授权与逐用户下游身份)：选择独立 MCP 授权记录与逐用户下游会话，固定单项目 resource，在线检查撤销，逐工具执行 scope 校验；只读权限也包含管理端敏感信息。read/write 与资金、访问控制、隐私附加 scopes 分开批准。授权服务选型、凭据加密存储及显式刷新已落实；真实登录/同意的完整关联、生产授权服务和 HTTP transport **尚未实现**，不将局部验证计入生产可用性。

以下能力是**未实现的新业务**，不是可以靠 MCP 包装补齐的功能：后台代客下单、通用 Order Edit、客户合并/账户重关联、换货补发、退货面单、复杂税制、多币种。其中后台代客下单与 [ADR-023](../docs/architecture-decisions.md#adr-023游客复用匿名-auth-与线上交易权限) 的仅客户线上下单决策冲突，不能作为本轮开发默认项。完整覆盖现有 Admin 管理域不意味着这些新业务已经实现；新增时需先确认业务范围，再设计数据库不变量与审核流程。

Worker 的 claim/complete、Inbox ingest/retry、原始渠道资金处理始终属于受信服务，不进入管理员 MCP。管理员 Outbox 重投已经可用，不扩张为 Worker 身份模拟。

### 2026-09-21 覆盖核对与下一阶段

核对来源是六个 SQL 基线中的 public 函数、执行授权、实际函数体、Edge/Storage 边界及 MCP 注册，不以 SPA 页面或函数名作为唯一判断。P0 复核时共 104 个工具（51 只读、53 写入），均有显式输出合同；其中 101 个直接对应 SQL RPC，另 3 个是媒体上传、媒体核验与 PayPal 退款适配。149 个 public 函数中未直接注册的 48 个按下表区分客户/公开接口、服务端入口、内部设施和刻意排除或替代的旧接口，未发现管理员专用业务 RPC 漏接。**这不等于完整 Admin 或生产就绪**：底表能力、尚无受控命令的业务和远程认证仍有缺口；工具数量不是业务完成率。

| 未注册入口或能力 | 核对结果 |
| --- | --- |
| `get_checkout_quote`、`cancel_checkout_quote` | [现有 SQL](../supabase/migrations/20260912000002_checkout.sql) 允许当前客户或管理员操作。核对后已增加独立管理员报价分页/详情，覆盖未转单报价；取消已接入 MCP，但 MCP 仍只允许管理员。取消 converted 报价会调用订单取消，completed 报价拒绝取消，不能描述成仅释放库存 |
| `update_order_address` | 遗留接口，不是可直接接入的通用 Order Edit；[当前合同](../docs/api.md) 与 [回归](../tests/inventory-reservations.test.ts) 要求正常 Quote 转单的地址快照不可原地修改，未付款改址走取消并重新结账 |
| `get_payment_operations` | 旧聚合包含渠道引用与特权诊断，不能直接暴露给 agent。现有脱敏支付操作、Inbox/对账查询与账本是刻意划分的管理入口，不追求原始字段对等 |
| Cart、客户订单、报价创建/转单、Storefront 读取 | 客户身份与公开目录接口，不是管理员代客操作 API；不因为 authenticated 有执行权限就加入 MCP |
| `is_admin`、`current_customer_id`、校验函数和触发器 | 认证/内部设施，不是需要逐个注册的管理工具 |
| Worker、渠道绑定/捕获/事件入箱与恢复 | [执行授权](../supabase/migrations/20260912000005_security.sql) 和 [部署合同](../supabase/functions/README.md) 保持受信服务边界；不通过 MCP 暴露 service-role 身份 |
| 媒体删除、大文件、快照文件导出、设置消费端 | 仍是实际缺口，不能通过复用任意 URL、文件路径或多次无事务写入冒充已实现 |

建议后续按以下可独立验收的批次推进；除明确标注已接入的部分外，其余仍为规划：

1. **报价查询与取消已接入。** 取消沿用原 UUID 和数据库锁/资金保护，不把取消当作退款，也不代发 Capture。测试覆盖未转单、converted、completed、过期、陌生客户权限、重复取消及与支付竞争。没有版本前置条件，读取后仍可能转单，因此用户批准须涵盖连带取消订单；终态重放保留原原因，未知结果先重读而非自动重试。完整合同见 [报价取消](../docs/api.md#报价取消)。
2. **媒体生命周期。** 已完成对象发现/内容核验、显式 URL 引用登记、私有暂存/发布、受控私有删除/恢复，以及包含 pending 与 discarded 的分页查询。公开对象永久保留，pending 上传宁可保留也不凭超时释放删除资格。后续考虑运维汇总与单独的部署升级方案；大文件另行设计，不开放任意 URL 抓取或本地文件读取。
3. **独立扩展的收尾。** Metafield 定义删除须单独确定已有值的规则（拒绝还是转为无定义私有值），不能隐式级联；设置消费端属于 Storefront 工作，不是 MCP 再加一层写接口。快照导出需要不可变批次、敏感数据边界与有时限的文件访问，现有分页 JSON 不承诺跨页冻结。
4. **远程 MCP 身份设计与实现。** ADR-027 已定义身份映射、scope、撤销及隔离合同。[工具权限清单](src/permissions.ts) 已覆盖全部 112 个工具，支持受信宿主按初始 scopes 过滤发现、每次调用前重查权限、授权依赖失败时拒绝执行；stdio 写开关不变。这不是 HTTP 认证：工具列表仍为初始化快照，scope 变化后的列表/会话重建尚未接入。本地 Supabase Auth `v2.196.0` 的原生 resource/audience 与业务 scope 支持不满足合同，具体证据见 [ADR-027](../docs/architecture-decisions.md#adr-027远程-mcp-使用独立授权与逐用户下游身份)。下一批验证独立授权服务，再实现逐用户凭据代理、HTTP transport 与部署控制；必须覆盖错误 audience、过期/撤销令牌、管理员降级、跨用户会话复用及 SDK 客户端兼容。保持现有 SDK v2，不以更换 SDK 代替认证设计，不将当前进程级管理员 JWT 共享给网络用户。
5. **生产验收。** PayPal 真实 Sandbox、Worker/告警及部署安全按支付文档验收；需要真实外部配置和授权，不能用本地模拟结果替代。报价/媒体开发与 HTTP 设计可以分开推进，缺少远程认证不阻止本地 stdio 业务完善。

P0 验证基于媒体发现提交 `e4a409d` 的代码：`bun run test` 重建可丢弃本地库后，82 个文件共 726 项通过、0 失败（含 51 项单元测试）；SQL lint 检查 370 个函数/触发器上下文，0 问题；生成类型一致性、根目录类型检查、Storefront/Admin Svelte 检查和文档文件链接检查通过。本轮未发现需修改业务代码的缺陷，未执行构建、浏览器验收、真实 PayPal Sandbox 或生产部署验收。类型生成 CLI 有 MaxListenersExceededWarning，但退出成功且无类型漂移。

此前 715 项通过是输出合同收尾时的历史记录，不是固定测试数量。未重建、积累多轮测试数据的库曾触发客户分页测试的第一页假设；本次干净库全量通过不代表该历史测试隔离问题已修复，也不证明生产数据规模下的性能或稳定性。

## 验证

独立服务实验：`bun scripts/mcp-keycloak-compat.ts`（需要 Docker，首次下载固定版本及 digest 的 Keycloak 26.7.0 镜像）。只创建临时容器/realm，监听随机回环端口，结束删除容器和临时配置；不操作现有 Supabase。已验证 S256、Code/Refresh resource 绑定、scope 不升级、轮换重放、撤销与在线 introspection，以及两用户/两客户端的顺序隔离场景：同一用户跨客户端共享 sid，但权限分离，针对一组的撤销不影响另外三组。resource-indicators 仍是实验性 feature，sid 不等于本项目 grant_id；真实同意、并发、持久化及双身份关联尚未实现，不直接用于生产。脚本不包含在默认单测中。

下游身份保护：受信 host 可为 AdminBackend 提供 expectedUserId，每次调用核对 Supabase Auth 返回的 UUID，即使实际会话也是管理员，身份不符仍在业务访问前拒绝。已用两名本地管理员验证；绑定值不是工具输入，stdio 保持原行为。

grant 元数据已通过私有 PostgreSQL 表和 service-only `mcp_grant_command` 持久化，提供不可变批准、在线解析和终态撤销。完整身份元组唯一，已撤销记录不删除、不恢复；不同管理员、不同权限不能覆盖同一上游会话的批准，禁止通过重新创建让旧 token 继承新账号。底表不向 API 角色开放，不保存凭据，不增加 MCP 工具，店铺业务仍使用原用户 JWT。运行 `bun run test:current tests/mcp-grants.test.ts` 验证权限、重放、隔离、持久化和撤销竞争。当前没有远程 host、凭据代理或 HTTP 认证。详见 [内部 API 合同](../docs/api.md#mcp-授权记录受信服务内部接口) 和 ADR-027。

受信 host 的 [KeycloakGrantAuthorizer](src/authorization.ts) 已实现在线令牌校验与完整 binding 查询：固定 issuer/introspection/resource/project，强制 active、Bearer 类型、有效期和完整身份；仅向固定授权端点发送入站 token，仅向授权元数据 RPC 发送 service-role。权限取 token、grant、部署 scopes 的交集；currentScopes 每次重查两端，固定最初 grant/user UUID，不在旧会话中升级权限。所有运行时失败统一拒绝，不输出凭据或后端错误；没有缓存、重定向、自动重试或 JWT 解码降级。此实现依赖 Keycloak 的 typ/client_id/sid introspection 字段，不是通用 OIDC 适配器；默认 Docker 实验使用合成 grant，联合数据库模式见下文。运行 `bun test tests/unit/mcp-authorization.test.ts` 验证拒绝分支。下一步接可信账号关联和加密凭据；当前未接入 stdio/HTTP，不代表远程认证已可用。

联合隔离验收：在已初始化的可丢弃本地 Supabase 上运行 `bun scripts/mcp-keycloak-compat.ts --with-supabase`。显式从本项目 CLI 取得并验证回环连接，不继承任意环境 DB_URL，不重建数据库；除原协议实验外，[联合测试](../tests/support/mcp-authorization-integration.ts) 创建两名临时 Supabase 管理员，将四组真实上游 user/client token 分别批准为独立 grant，经 InMemory MCP transport 调用真实管理员读取。覆盖无 grant 拒绝、只读上下文隐藏/拒绝写工具、下游管理员串用、单个 grant 撤销、管理员降权和上游撤销；拒绝时检查没有业务后端请求，未受影响的上下文仍成功。finally 清理本次会话、grant/凭据、Auth/客户 fixture 和临时容器；客户不可删除保护只在本地清理事务的目标删除期间按现有测试惯例绕过。不要与数据库重建并行执行。此验收手工固定账号映射，不实现可信账号绑定；没有远程 HTTP、真实用户同意或生产凭据管理，也不证明并发撤销和生产部署安全。

凭据加密层：[createCredentialCipher](src/credentials.ts) 只处理下游 Supabase access/refresh token 与过期秒数，不保存它们、不发起刷新、不证明身份或授权。AES-256-GCM 使用随机 96-bit IV、128-bit tag；密文绑定受信项目、grant UUID、用户 UUID、凭据 revision 和 key ID。密钥由宿主单独提供，无默认值、不写入密文；新写使用 active key，读取可用保留的旧 key，删除旧 key 后拒绝旧密文。`bun test tests/unit/mcp-credentials.test.ts` 覆盖互操作、篡改、跨身份/修订号替换、大小边界和密钥轮换；联合实验以临时密钥封装真实本地会话，持久化后读取解密并执行 MCP。

密文持久化：service-only [mcp_credential_command](../docs/api.md#mcp-下游凭据密文受信服务内部接口) 已提供 read/write CAS，严格核对完整 grant 绑定及当前管理员，版本从 0 开始单调递增，过期版本重放拒绝。撤销 grant 在同一事务中删除密文，保留授权 tombstone。数据库只检查 envelope 结构，认证解密仍由宿主执行；revision 必须从数据库读取，不从密文自行采信。`bun run test:current tests/mcp-credential-store.test.ts` 覆盖持久化解密、权限、CAS、并发创建、旧快照与撤销竞争。

宿主凭据适配：KeycloakGrantAuthorizer.readCredentials/writeCredentials 已将在线授权与密文 RPC 串联。每次重新验证完整绑定，写前检查下游 access token 的真实管理员 UUID；只发送密文给存储，读取按数据库 revision 解密。写失败统一为 CREDENTIAL_WRITE_UNCONFIRMED，不自动重试，先重读确认是否已提交。`bun test tests/unit/mcp-credential-adapter.test.ts` 覆盖未初始化、错误身份、响应丢失、非法响应、旧密文和查询期间过期；`--with-supabase` 联合实验已改用真实凭据表，验证 CAS、新宿主实例读取后执行 MCP、本地撤销删除与上游撤销后禁止读取，结束清理临时凭据行。这些方法仅供受信宿主，不能暴露为客户端凭据接口；仍无生产密钥配置或可信账号关联，access token 校验本身不证明 refresh token 配对。显式刷新已接入下方方法，但未启用远程入口或自动续期调度。

刷新准入与宿主执行：密文 RPC 的 claim_refresh/complete_refresh 已接入 `KeycloakGrantAuthorizer.refreshCredentials(token,cipher,{expectedRevision,anonKey})`。成功领取当前版本后，解密原凭据并重查授权，只向固定 Supabase refresh 端点发送一次请求；验证同一次响应的新凭据、管理员 UUID 及原独占 Auth session，再加密、重查授权并用原回执完成下一版本。返回值仅有 revision，不返回 token，不自动重试业务操作。数据库测试覆盖并发领取、RC/RR 旧快照、回执跨 grant/重放及撤销后完成拒绝。完整合同见 [API](../docs/api.md#mcp-下游凭据密文受信服务内部接口)。

任何刷新失败统一 CREDENTIAL_REFRESH_UNCONFIRMED：领取响应丢失不会调用 Auth；刷新结果未知不会释放或接管持久记录；完成响应丢失先授权重读确认，不再次刷新。仍 pending 且原执行者无法完成时只能撤销并重新授权。单测覆盖错误用户/同用户另一会话、过期/畸形凭据、撤销、并发及两种回执丢失。真实本地 Auth/数据库集成测试验证两个宿主竞争只刷新一次、refresh token 轮换后原 session 不变、新宿主可读密文，以及 Auth 成功但响应丢失后无法再次领取；该测试模拟上游 introspection，不是完整远程 OAuth 验收。

下游会话归属：[mcp_bind_downstream_session](../docs/api.md#mcp-下游会话归属受信服务内部接口) 将真实 Auth session UUID 不可变地绑定到一个 grant，撤销/会话删除仍保留归属。writeCredentials 现通过下游用户 JWT 调用 get_mcp_downstream_session 取得已验证身份，再绑定并核对回执后保存；不自行解码 JWT，同一用户的不同会话也不能替换。凭据写入、已初始化读取和刷新准入均检查绑定会话存在；未初始化读取仍返回 revision=0。联合实验为四个 grant 分别登录，验证同用户会话替换拒绝；数据库测试验证删除会话后不再返回密文或完成刷新。归属检查本身不证明 refresh token 配对、完整超时策略或用户同意；仍须接通可信关联与远程宿主，不能因刷新方法可用就开放网络入口。

下游登录原语：[createDownstreamLogin](src/login.ts) 由受信宿主提供 browserSession 和固定 callbackUrl，生成私有 verifier、S256 challenge、随机 state 及含 state 的 redirectTo。exchange(callbackUrl,browserSession) 接收完整回调，校验固定 origin/path、唯一 code/state、无 fragment/未知参数和浏览器绑定，五分钟内单次兑换。非法回调返回 LOGIN_CALLBACK_REJECTED，不请求 Auth、不消耗原尝试；匹配后兑换结果未知不重试。`bun run test:current tests/mcp-login.test.ts tests/unit/mcp-login.test.ts` 验证真实邮件往返、重复/编码参数、目标替换、PKCE、串用、并发及过期。browserSession 必须来自宿主验证的受保护会话，不能取自回调参数；原语已接入下方 Request/Response 处理器，但尚无部署入口、用户同意或 grant 创建。进程重启须重新登录，token 不交给 MCP 客户端。

浏览器会话原语：[createLoginBrowserSessions](src/browser-sessions.ts) 为固定 HTTPS origin 签发五分钟 `__Host-` Cookie（Secure/HttpOnly/SameSite=Lax）及独立 CSRF token。GET 验证唯一、已签发且未过期的 Cookie；POST 另要求同源 Origin 和同会话 X-CSRF-Token，撤销后拒绝后续读取。内存容量为 1024，满时拒绝新会话，不驱逐活跃项；重启丢失，不支持多节点共享。它不代表认证或业务授权。`bun test tests/unit/mcp-browser-sessions.test.ts` 覆盖请求头校验、过期/撤销/容量和 PKCE 浏览器串用。

下游登录 HTTP 流程：[createLoginHttpHandler](src/login-http.ts) 提供 `handle(Request)`，不启动监听器，必须由宿主放在可信上游授权事务之后。`POST /login/session` 要求精确 Origin 与 X-Tera-Login:start，返回 Cookie/CSRF；单实例每分钟最多签发 20 次。`POST /login/email` 验证 Cookie/CSRF 和最多 1024 字节的严格 JSON `{email}`，只发一次真实 PKCE 邮件且禁止自动注册/重发；失败不返回提供方错误。固定 callbackUrl 的 GET 兑换后 303 到 `/login/status`；该地址只返回 pending/authenticated/consumed，不返回用户 UUID 或 token。`POST /login/cancel` 撤销本地事务。所有响应 no-store/no-referrer；回调路径不可位于保留的 `/login/` 路径下。

凭据仅暂存在服务端内存；`takeIdentity` 要求原会话带 CSRF 的 `POST /login/approve`，一次性交给内部宿主，handle 不服务该路径。此方法不是用户同意或 grant 创建，宿主仍需验证并绑定上游身份、展示批准范围并安全持久化。五分钟绝对期限无续期，访问/签发时清理过期记录，无后台定时擦除保证；取消/过期不回滚 Auth 已创建的会话。进程级节流不能替代边缘和上游身份限流，也不保证隐藏时序差异。Request/Response 测试及真实本地 SMTP/Auth 往返已通过；另用 agent-browser 在临时回环 HTTPS 服务验证 HttpOnly、自动携带 Cookie、CSRF 拒绝、回调跳转及取消（该浏览器检查使用模拟 Auth）。尚无登录页面、可信双身份关联、生产监听器或远程 MCP transport。

独立授权协议验证：`bun test tests/unit/oauth-provider.test.ts` 是快速回归，Bun 不是 provider 支持的部署运行时。另运行 `bun scripts/mcp-oidc-compat.ts`，在固定 digest 的 Node 22 LTS Docker 容器复用同一场景；容器无外部网络、不发布端口、非 root、只读，仅挂载临时构建产物和依赖。两种令牌格式均验证 Code/S256、resource/aud、业务 scopes、刷新轮换和 grant 撤销。错误 resource 的刷新可能消耗旧 token，重试导致 grant 撤销；JWT 签名仍有效不代表授权仍有效。实测该版本 JWT access token 的 introspection 返回 unsupported_token_type，因此生产方案选择 opaque token。内存 adapter、合成身份和自动同意仅用于测试，不连接真实账号或 Supabase，不是生产登录流程。

`GrantAuthorizer` 增加显式 `tokenProfile: 'oidc-provider'`，要求 active、Bearer、AccessToken 类型、精确 issuer/单一 resource、未过期时间、UUID sub、client_id 和 provider grant_id；本地批准的 user_id 必须等于 sub。数据库 binding.session_id 在此 profile 保存 provider grant_id（授权纪元），不使用 SSO sid，且不等于本地 grant UUID。真实 introspection 与合成批准存储的联合测试验证无批准拒绝、refresh token 拒绝、轮换保留绑定、撤销阻断旧上下文，以及新授权不能继承旧批准。profile 由可信配置决定，不从 token 选择；省略仍保留历史 Keycloak 行为，`KeycloakGrantAuthorizer` 为兼容别名。已有凭据读写/刷新共用此校验，但尚未完成 OIDC 与真实数据库、登录同意的完整联合验收。

provider 持久化已提供 [createOidcAdapter](src/oidc-adapter.ts) 与独立授权库 [storage.sql](auth/storage.sql)，使用固定版本 postgres 驱动，不经过 PostgREST、不添加店铺业务表或 MCP 工具。每个数据库仅服务一个 issuer；宿主负责连接、TLS、最小权限及池生命周期，DDL 必须显式应用，不由请求自动建表。完整 provider payload 持久化，Session uid / DeviceCode userCode 索引随更新/删除维护；过期查询拒绝，clockTolerance 须与 provider 配置一致。

所有写入在短事务内使用同一数据库 advisory lock，跨连接/进程串行化；事务内不调用外部服务。consume 只允许一次，竞争失败提交整组 grant 撤销后返回 invalid_grant；旧 save 不能清除 consumed、改换 grant 或复活已销毁 ID。Grant.destroy / revokeByGrantId 保留永久撤销标记并清除该组 payload，在途 upsert 不能重新创建其令牌。销毁记录也保留 ID；没有自动清理或容量治理，不能手工删标记来“恢复”。这不是消费与全部后继签发的单事务，崩溃后可能需重新授权，不自动重试。

`bun run test:current tests/mcp-oidc-storage.test.ts` 在已验证的可丢弃本地集群中新建随机独立数据库，结束关闭连接并删除该库；覆盖连接重建、过期/索引、双连接消费、撤销前后两种写入竞争和真实 provider opaque 协议，以及有屏障的并发 HTTP code/refresh 兑换。数据库 payload 含敏感授权信息，尚无应用层加密、清理和生产备份方案，不得把本地验证当成部署许可。

受支持运行时的持久化验收：`bun scripts/mcp-oidc-compat.ts --with-storage`。新建内部 Docker 网络、digest 固定的 PostgreSQL 17 容器（临时内存数据目录）和 Node 22 LTS 容器，不连接 Supabase、不继承 DB_URL、不发布端口；结束删除容器、网络和临时文件。初始化账号与运行账号密码独立，Node 仅持有非超级用户的授权 schema DML 凭据，测试确认建表返回 42501。两个依次执行的独立 Node 进程验证会话、已消费状态和撤销标记跨进程保留；另用真实 provider 的两个 HTTP 请求在 consume 前设置屏障，确保都读到未消费状态后竞争。最多一个响应成功，失败为 invalid_grant；竞争后该组所有返回的令牌都不可用，其他授权仍 active。

上述是存储进程重建和单 provider 进程内的 HTTP 并发验收，不是完整授权服务重启、数据库重启、多节点服务或崩溃恢复证明；合成身份/自动同意仍仅用于测试。下一步接真实 Supabase 登录/同意、本地授权与凭据保存，并补全签名密钥/Cookie 配置的服务重启验收，再接 Streamable HTTP、生产配置及客户端验收。Docker 命令不部署生产授权服务。详见 ADR-027。

首次批准原语 [createOidcApproval](src/oidc-approval.ts) 补齐“尚未签发 MCP token 时保存下游凭据”的路径。受信宿主为一个已验证 interaction 固定 client/resource/scopes，取得明确同意后将 `takeIdentity` 的结果交给一次性 approve：在线重查精确管理员 UUID/Auth session、新建 provider Grant、创建本地 grant、绑定独占 session、以 revision=1 加密保存，最后重查授权和凭据有效期。成功仅向内部宿主返回两个 grant ID，不返回凭据，不调用 interactionFinished 或签发授权码；宿主必须成功后才允许继续发码。本流程包含 openid/offline_access，宿主同意页须明确涵盖离线刷新，不得据此扩大 store scopes。

任何失败均消耗本次批准，不自动重试。尽力撤销上游及已知 ID 的本地 grant，正常本地撤销删除密文；创建响应丢失而未知本地 ID、撤销失败或回执异常返回 APPROVAL_CLEANUP_UNCONFIRMED，不能声称回滚完成。不得继续发码或复用本次登录会话，需要后续受信清理；进程崩溃没有持久化补偿调度。单测覆盖身份/会话替换、并发、畸形回执、结果丢失；`tests/mcp-login.test.ts` 用真实邮件登录、Auth 与数据库验证首次保存和已提交写响应丢失后的撤销。该集成在 Bun 执行，上游 Grant 使用真实库的内存 adapter；尚未串联浏览器同意、provider interaction 与 Node 持久化部署，也不构成完整远程授权流程。

后续已增加 [createOidcInteractionHandler](src/oidc-interaction.ts)：原生 Node HTTP handler，挂在 provider.callback 前，不启动监听器。`GET /interaction/:uid` 返回已验证的 client/redirect/resource/store scopes/offlineAccess；`POST .../start` 绑定登录 Cookie，`POST .../approve` 和 `POST .../cancel` 分别要求 `X-Tera-Consent: approve/deny`、同源 Origin 与登录 CSRF。start 另要求 `X-Tera-Login: start`，以上 POST 不接受正文。邮件与回调沿用 `/login/email`、配置的固定 callback、`/login/status`；独立 `/login/session`、`/login/approve`、`/login/cancel` 不对外开放。

每次交互操作用原生请求验证 provider 的签名 Cookie/Session，并比较路由 UID；client/resource/scopes 只取 provider interaction，不从用户正文取值。登录 bootstrap 固定 UID，身份交接必须匹配；五分钟内单次批准，存储开始后取消/再次批准拒绝。先保存两端 grant/加密凭据，再提交 login+consent 结果并返回 provider resume 地址；完成失败时撤销已保存批准，清理结果不明返回 503/APPROVAL_CLEANUP_UNCONFIRMED。已写 provider result 的交互不能重新启动，固定 authority 检查不信任 Forwarded 生成 URL。

`bun test tests/unit/mcp-oidc-interaction.test.ts` 及两种 `mcp-oidc-compat.ts` 模式均运行真实 provider HTTP/Cookie/发码/兑换，覆盖跨 interaction/Cookie 拼接、CSRF、scope 替换、到期、批准与取消竞争和完成回执丢失清理。Docker 持久化模式使用真实 provider PostgreSQL adapter，但此交互场景的 Supabase 响应仍为合成夹具；不是全链路真实数据库或 UI 验收。当前仅有 JSON 同意协议，没有用户可操作的登录/同意页；内存登录/交互状态限单实例，重启须重新登录，进程崩溃补偿、生产 TLS/proxy/密钥配置、Streamable HTTP 和真实客户端验收仍未完成。

真实数据库联合验收：`bun run test:current tests/mcp-oidc-interaction.test.ts`。临时独立 issuer 数据库与真实本地 Supabase/Auth/SMTP，走完整授权请求、邮件 PKCE、同意 POST、发码和兑换；在线 introspection + 本地授权解析后解密下游凭据，经实际 MCP SDK 内存 transport 调用店铺工具。两名管理员分别批准只读/读写，检查工具发现范围、精确 UUID/Auth session、撤销 A 阻断旧工具上下文而 B 仍可调用。Bun 模式另模拟 provider result 已保存但完成回执丢失，确认两端授权撤销、密文删除。

同一命令现在还运行 Node 服务模式：Linux Docker 中固定 digest 的 Node 22 LTS 执行真实 auth.ts 入口，非 root、只读文件系统、私有 0600 配置、临时最小权限数据库角色，经验证一次性证书的直接 HTTPS 请求，不模拟下游响应、不启用 provider.proxy。需要 Docker、OpenSSL 和本地 Supabase；容器使用 host 网络访问本机回环服务，授权监听仅绑定 127.0.0.1。测试客户端将 allowlist 中的固定 issuer authority 映射到随机本地端口，不测试公网 DNS/证书。结束删除容器、临时配置、账号、grant、issuer 数据库和角色。测试驱动及 MCP SDK 内存 transport 仍在 Bun；Node 模式未注入完成故障，未验证浏览器 UI、进程崩溃恢复或远程 MCP transport。

Node 联合场景另验证两次正常进程重建：用 SIGTERM 停止容器并要求退出码 0，重新使用同一私有配置和数据库启动真实入口。先消费 B 的原刷新令牌并撤销 A 的本地授权；第一次重启后 A 仍被拒绝，B 的旧访问令牌、grant 绑定、加密凭据及店铺调用仍有效，替代刷新令牌可继续轮换且权限不变。随后重放原刷新令牌返回 invalid_grant，整组授权失效；第二次重启后先检查访问令牌仍不可用，再确认最新刷新令牌被拒绝，旧 MCP 上下文也无法调用。此测试不重启数据库，不覆盖强制崩溃、SSO Cookie 恢复或密钥轮换。

在途批准退出验收复用上述 Node 场景：持有 issuer adapter 的写入 advisory lock，通过 pg_blocking_pids 确认批准已阻塞后发送 SIGTERM；观察监听器停止接收，同时数据库写入仍在等待，才释放屏障。保持连接的批准须返回 303，服务退出码须为 0，重启后用原 Cookie 和 resume 地址继续兑换授权码，验证本地 grant、加密凭据及店铺调用。

第三名管理员另覆盖批准等待期间主动断连再 SIGTERM：释放屏障并正常重启后，必须观察到本地 grant 已撤销、密文已删除、issuer 撤销标记已持久化。此回归曾复现断连后 grant 仍 active；响应发送现检查已销毁连接并触发现有批准失败清理，服务等待处理器完成后才关闭数据库。检查的是发送前已知断连，不保证客户端收到响应，也不覆盖发送后的断连、下游超时、其他登录阶段或强制崩溃补偿；不以固定睡眠推断并发顺序。

固定服务配置已集中到 [createOidcProvider](src/oidc-provider.ts)，真实数据库联合测试及 Node PostgreSQL 交互场景现使用它。输入为 `issuer/resource/scopes/signingKey/cookieKeys/clients/introspectionClient`，另由宿主传入持久化 adapter。要求 HTTPS 根 issuer、固定 HTTPS resource、完整 ES256/P-256 私有 JWK（含 kid/alg/use，并验证公私钥匹配）、1–3 个有序 Cookie 签名密钥和独立 introspection secret；后两类值均为 32 字节的规范 base64url，不生成默认密钥。clients 项为 `id/applicationType/redirectUris`：web 仅 HTTPS，native 首版仅 HTTP 字面 loopback（127.0.0.1/::1），不支持自定义 scheme、localhost、query/fragment 回调。native 端口匹配遵循 provider 的 loopback 规则。未知字段、重复 ID/范围/密钥/回调、缺失或不匹配的密钥统一拒绝为 INVALID_OIDC_PROVIDER_CONFIGURATION，不返回配置详情。

provider 禁用开发登录、userinfo 和动态注册，忽略数据库残留的非预注册 Client；只有指定 resource 客户端可 introspect 目标资源的 AccessToken，业务客户端只能撤销自己的 token。固定 Code/S256、opaque access token、刷新轮换与 grant 撤销；期限为 code 60 秒、access/ID token/interaction 300 秒、SSO session 8 小时、grant/refresh 30 天。新实例重复加载相同配置的 JWKS 已验证稳定，但这不是完整进程重启或密钥轮换验收。构造器不读取环境、不启动监听、不配置代理；**provider 的 endpoint URL 仍依赖请求 authority，服务入口必须先验证 Host/TLS 和受信代理，不能只设置 issuer 就直接开放 callback**。服务入口、秘密装载和进程生命周期仍是下一步。

远程版本后续按以下依赖顺序推进：

1. 固定 Node 授权服务配置与入口：预注册客户端、签名/Cookie/加密密钥、最小数据库权限、TTL、受信 TLS 代理及启动校验；把真实 Supabase 联合场景带入 Node，并验证服务重启与密钥恢复。
2. 用户登录/同意页面：展示真实 client/resource/scopes 和离线刷新，同源 Cookie/CSRF、拒绝/到期/失败状态；只用于用户授权，不用于 Agent 操作 Admin SPA。补真实浏览器验收。
3. 跨存储失败恢复：持久化批准进度或等价的可验证补偿，覆盖在途退出、创建回执未知、未完成交互与孤立密文清理；明确单实例限制及敏感 payload 保留期。
4. Bun Streamable HTTP 与 RFC 9728 元数据：逐请求在线校验、逐用户凭据读取/刷新、会话隔离与 scope 变化，不复用进程级管理员 JWT，不重放结果不明的写操作。
5. 真实远程客户端和部署验收：预注册兼容性、断线/并发/撤销/降级、限流、日志脱敏、容器健康/退出、备份和运维手册。完成这些才能称远程 MCP 可交付；部署本身另需明确授权。

```bash
bun run typecheck
bun run test:unit
bunx --no-install supabase functions serve --network-id tera-headless-loopback # 独立终端；新增函数后重载本地 Edge
bun run test:current tests/managed-media.test.ts # 含真实 Edge 网关，不仅直接调用 handler
bun run test:current tests/mcp.test.ts # 已启动并初始化的可丢弃本地 Supabase
bun run test:current tests/admin-categories.test.ts
bun run test:current tests/storage-admin.test.ts
bun run test:current tests/admin-customer-commands.test.ts
bun run test:current tests/admin-inventory-reads.test.ts
bun run test:current tests/admin-location-commands.test.ts
bun run test:current tests/inventory-transfer.test.ts
bun run test:current tests/admin-promotion-reads.test.ts
bun run test:current tests/admin-promotion-commands.test.ts
bun run test:current tests/admin-shipping-methods.test.ts
bun run test:current tests/admin-tax-rates.test.ts
bun run test:current tests/admin-metafield-reads.test.ts
bun run test:current tests/admin-metafield-commands.test.ts
bun run test:current tests/admin-metafield-values.test.ts
bun run test:current tests/admin-metaobject-reads.test.ts
bun run test:current tests/admin-metaobject-commands.test.ts
bun run test:current tests/admin-metaobject-entries.test.ts
bun run test:current tests/admin-metaobject-delete.test.ts
bun run test:current tests/admin-reviews.test.ts
bun run test:current tests/admin-order-operations.test.ts
bun run test:current tests/admin-checkout-quotes.test.ts
bun run test:current tests/admin-payment-operations.test.ts
bun run test:current tests/paypal-endpoints.test.ts
bun run test:current tests/admin-users.test.ts
bun run test:current tests/admin-shop-settings.test.ts
bun run test:current tests/admin-payment-summary.test.ts
bun run test:current tests/admin-order-summary.test.ts
bun run test:current tests/admin-order-export.test.ts
bun run test:current tests/admin-reconciliation.test.ts
bun run test:current tests/admin-operations-summary.test.ts
bun run docs:check
```

单测覆盖工具发现与写开关、schema 拒绝、禁止入口、凭据/错误处理、大整数与微秒游标。集成测试覆盖真实 stdio、商品版本冲突、库存/收款幂等、履约、退货/回库与资金分离、客户匿名化重试、运维 DTO 和角色撤销。未声称完成真实 PayPal Sandbox、HTTP OAuth 或所有后续管理域验收。

宿主边界原语见 [oidc-host](src/oidc-host.ts)：`readOidcProviderConfiguration` 仅读取绝对路径、非符号链接、组/其他用户无任何权限的普通文件（例如 0600/0400），限制 1–65536 字节、严格 UTF-8/JSON；读取后仍须交给 createOidcProvider 做语义校验。父目录也须由部署方保护；不支持通过符号链接装载的 Secret 卷，不保证在 JS 中擦除已解析字符串。

`createOidcTlsHandler` 包住 interaction 与 provider callback，首版仅直接 TLS、精确 Host，拒绝重复 Host、absolute-form 地址和所有 Forwarded/X-Forwarded-*；provider.proxy 必须始终为 false。无 TLS 的 HTTP 即使伪造正确 Host 也不能进入业务处理器。此函数不启动服务、不装载 TLS 证书、不管理数据库或进程退出；下面的服务入口负责装配。

授权服务入口：[auth.ts](src/auth.ts) 仅支持 Node 22 LTS，拒绝 Bun 运行时，只接受一个私有配置文件的绝对路径参数；[startOidcService](src/oidc-service.ts) 先校验配置、证书域名/有效期/私钥配对、加密密钥及数据库权限，最后监听直接 HTTPS。失败统一报 OIDC_SERVICE_START_FAILED，不打印秘密或底层错误。SIGINT/SIGTERM 停止接收连接，等待处理器后关闭连接池；在途批准保持连接及发送前断连的正常退出已按上文验证，其他登录阶段及崩溃恢复仍待验证。

配置是严格 JSON，必填字段如下（不提供默认秘密）：

- `provider`：上文 createOidcProvider 的完整配置。
- `databaseUrl`：独立 issuer PostgreSQL URL，含账号、密码和数据库，不接受查询参数；仅 localhost/字面回环允许明文，其余强制 verify-full TLS。提前显式应用 auth/storage.sql；运行角色必须拥有两表 SELECT/INSERT/UPDATE/DELETE，不得是超级用户、CREATEDB、CREATEROLE、BYPASSRLS 或有 oidc schema CREATE 权限。启动不建表、不执行迁移。
- `downstream`：`project/supabaseUrl/anonKey/serviceRoleKey/callbackUrl`，callback 必须符合现有登录宿主同源合同；service-role 仅用于内部授权与凭据保存，不用于店铺业务工具。
- `credentialKeys`：key ID 到规范 base64url AES-256 密钥的映射，最多八个；`activeCredentialKey` 指定当前写入密钥，旧密钥用于解密，不自动轮换。
- `tls`：`key/cert` 为 PEM 内容（保留换行），与其他秘密一起置于私有文件；`listen` 为 `host/port`，host 限 127.0.0.1、::1 或 0.0.0.0，port 为 0–65535（0 仅用于临时端口测试）。生产 issuer 必须与实际访问 authority 一致，不能接未经验证的 TLS 终止代理。

使用 Bun 将入口编译为 Node ESM，外置 oidc-provider 与 postgres，并随产物提供锁定版本依赖：`bun build mcp/src/auth.ts --target=node --format=esm --external=oidc-provider --external=postgres --outfile=dist/auth.mjs`。在受支持 Node 容器中执行 `node dist/auth.mjs /run/private/issuer.json`；这是入口用法，不是生产部署清单。

`bun scripts/mcp-oidc-compat.ts --with-storage` 现另用一次性 OpenSSL 证书和私有 tmpfs 配置验证真实 Node TLS discovery/JWKS、错误 Host、缺失加密密钥、只读角色、证书域名不匹配、端口冲突清理、重复 close，以及真实 CLI 同配置重启/JWKS 稳定和 SIGTERM 退出。Node 与临时 PostgreSQL 共享隔离网络命名空间，不发布端口。此服务烟测未调用真实下游账号，不证明旧 token/在途交互重启恢复；真实 Node 下游验收使用上文 test:current 命令。后续仍需登录/同意 UI、在途关闭及崩溃补偿、Streamable HTTP/RFC9728 和真实远程客户端验收。
