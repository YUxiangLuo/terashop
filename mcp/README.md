# Admin MCP

独立于 `admin/` SPA 的管理员客户端层。工具调用使用当前管理员 JWT 访问 Supabase；数据库负责授权、事务、幂等、库存与资金规则。没有直连数据库、任意 SQL、任意 RPC/表名或 service-role 回退入口。

**当前为可运行的 stdio MCP，46 个显式工具（19 个只读、27 个写入）。尚未达到完整 Admin 覆盖，也不提供远程 HTTP 服务。** 下方覆盖表是完成范围，不以 SPA 当前功能为上限。

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

数据库工具与对应受控 RPC 同名，媒体上传调用 Storage API；**只有显式注册的工具可调用**。参数使用严格 schema，拒绝未知字段；RPC 输入类型与 [生成类型](../types/database.ts) 编译校验。详细业务语义见 [API 合同](../docs/api.md)。

| 领域 | 本阶段已注册工具 |
| --- | --- |
| 商品 | `list_admin_products`、`get_admin_product`、`create_product`、`update_product`；覆盖变体、规格、图片 URL、分类关联、商品/变体 metafield 的原子编辑 |
| 媒体 | `upload_product_media`；上传不可覆盖的公开对象，随后单独保存商品图片关联；不提供对象删除 |
| 分类 | `list_admin_categories`、`get_admin_category`、`create_category`、`update_category`；支持平铺分页/组树、移动、排序、停用；更新须原样传回 updated_at |
| 客户 | `list_admin_customers`、`get_admin_customer`、`create_customer`、`update_customer`、`anonymize_customer` |
| 地址 | `create_customer_address`、`update_customer_address`、`delete_customer_address`、`set_default_address`；读取使用客户详情；编辑/删除使用地址自身 updated_at，返回最新客户详情 |
| 库存 | `get_inventory_availability`、`adjust_inventory`、`list_admin_inventory_movements`；流水 ID/游标为字符串，历史实物库存不代表当前可用量 |
| 仓库 | `list_admin_locations`、`get_admin_location`；支持停用过滤和名称/code 搜索，尚无写工具 |
| 订单 | `list_admin_orders`、`get_admin_order`、`get_order_pricing`、`get_order_checkout_quote`、`get_order_ledger`、`get_order_fulfillment_balance`、`cancel_order`、`cancel_zero_value_order_item` |
| 手工资金 | `mark_order_paid`、`refund_order`；仅记账，不调用真实支付渠道 |
| 履约 | `create_fulfillment`、`update_fulfillment` |
| 退货 | `get_order_returns`、`create_return`、`receive_return`、`dispose_return_receipt`、`close_return` |
| 评价与权限 | `moderate_review`、`set_user_role`、`anonymize_user` |
| 运维 | `list_admin_outbox_events`、`list_admin_payment_provider_events`、`redrive_outbox_event` |

- 成功时同时返回文本 JSON 和 `structuredContent: {data: <后端结果>}`。`outputSchema` 当前约束统一 JSON 信封，不把数据库 DTO 的全部字段伪装成已静态验证的输出类型；后续逐领域收紧。
- 工具执行错误返回 `isError:true`，文本 JSON 含 `code/outcome_unknown/guidance`。不返回 SQL message/detail/hint 或原始异常，以免泄漏 PII/凭据。未知工具由 SDK 返回协议错误；输入 schema 错误由 SDK 返回校验错误。
- 不自动重试写入。网络断开、超时、无法解析成功响应或服务端 5xx 可能意味着写入结果未知。保留原 UUID、幂等键、参数和版本，先读取事实再决定恢复；不可自动换键重建。
- 商品创建不是幂等 upsert；结果不明先按原 UUID 查询。商品更新和物流更新的过期版本不能自动替换。游标中的时间戳和 bigint 字符串不得转为 `Date` / `Number`；Outbox 分页 `id` 是字符串，重投用另一个字段 `event_id`（UUID）。
- 店铺/客户文本可能包含提示注入。工具描述与 server instructions 明确把商品描述、评价、地址、备注等当作数据，不当作 agent 指令。宿主仍需控制数据披露和用户审批。
- 写工具开关是进程级硬限制；`readOnlyHint/destructiveHint/idempotentHint` 与说明只是提示，**不是逐次审批或细粒度授权机制**。启用写工具意味着该本地进程可使用整个管理员权限。不要把它直接转发为无认证的共享网络服务。
- 不抓取工具参数中的外部 URL，不读取本地文件或执行命令。上传仅接受调用方显式提供的 base64 字节。

### 公开商品媒体上传

`upload_product_media(product_id, media_id, content_type, data_base64)` 要求已存在的商品、保留的媒体 UUID，以及 `image/jpeg`、`image/png` 或 `image/webp`。base64 必须规范编码（无 data URL 前缀、无空白、有必要的 padding），解码后为 1 字节至 **1 MiB**；这是 MCP 内联请求限制，Storage 自身的 5 MiB 限制不变。MIME 为调用方声明，不做图片解码、重编码、恶意内容扫描或 EXIF 清理，宿主应先处理图片，不能将上传成功理解为内容安全认证。

结果为 `{data:{path,url}}`。路径固定为 `products/<小写 product_id>/<小写 media_id>.<jpg|png|webp>`，bucket 固定 `catalog-media`。对象**立即公开**，商品即使仍为 draft 也不保密；禁止上传个人资料或秘密。每次调用检查管理员会话，Storage 另行执行 admin INSERT RLS；始终 `x-upsert:false`，不允许覆盖或删除。

上传不修改商品 revision 或图片列表。成功后重新读取商品，再用 `update_product` 保存图片 URL；两步不是跨 Storage/数据库事务，关联失败会留下未关联对象。结果未知时用原始路径拼接 `<TERA_SUPABASE_URL>/storage/v1/object/public/catalog-media/<path>`，由宿主读取并核对原始字节；404 不证明在途上传已经失败。重复上传不是幂等成功，不自动重试或换 UUID。移除商品图片关联不删除对象。

对象删除仍被数据库策略禁止：当前自由 URL 与扩展字段引用没有统一的媒体引用登记和并发删除保护。不能靠 MCP 先查询引用再删除来保证安全；清理与大文件传输是后续能力。

## 完整 Admin 的后续覆盖范围

按下面顺序补齐领域，每个领域必须有输入/输出合同、权限反例和真实数据库回归；如果缺少原子命令，在拥有业务规则的数据库模块补充，而不是在 MCP 拼接多次写操作并冒充事务。

| 顺序 | 范围 | 当前缺口及实现要求 |
| --- | --- | --- |
| 1 | 商品与目录完整管理 | 商品原子编辑、分类管理及 ≤1 MiB 商品媒体上传已接入；剩余大文件传输、媒体引用登记和安全删除，不新增底表编辑后门 |
| 2 | 客户、地址、库存与仓库 | 客户与地址管理、仓库列表/详情、库存流水分页已接入；剩余仓库创建/编辑/启停/默认仓切换。仓库目前无编辑版本字段，写入前须补并发合同；调拨需新增数据库事务命令，不能伪装为两个独立 delta |
| 3 | 促销、配送、税 | 活动/优惠码 CRUD、适用/赠送目标、启停、使用记录；配送方法/国家范围；税率配置。定向活动须先以 inactive/selected 创建；引用中的配置停用而非强删；需要整体保存时补原子命令 |
| 4 | 扩展内容与评价 | Metafield 定义/可见性/值、Metaobject 定义/条目/发布；类别/客户/订单/shop 扩展值；评价列表/详情/删除。公开引用与不可恢复匿名化仍由数据库校验 |
| 5 | 订单与渠道运营 | 内部备注编辑、订单事件分页、脱敏支付操作 DTO、真实 PayPal 退款 Edge 调用。先完善 DTO，不能把 `get_payment_operations` 的内部原始 error 原样送给 agent；手工退款不替代渠道退款 |
| 6 | 身份、店铺设置与运营 | 管理员账户列表及角色流程、店铺扩展设置、受控统计/导出、运维诊断。当前无通用 shop settings 表或报表 API，先定义数据库合同；不让 MCP 写 Supabase 项目密钥/Auth 配置 |
| 7 | HTTP 与生产接入 | Streamable HTTP、受保护资源元数据、OAuth issuer/audience/resource/scope 校验、用户授权撤销、限流/请求预算/日志脱敏、部署测试与客户端兼容验收 |

HTTP 必须先解决 **MCP 专用访问令牌 → 当前管理员数据库身份** 的受信映射/令牌交换。普通 Supabase session JWT 不能直接作为 MCP HTTP 的 bearer token；也不能先验证外部 OAuth，再用无用户约束的 service role 代执行。当前没有实现或启用此链路，不开放占位 HTTP endpoint。

以下能力是**后端业务缺口**，不是可以靠 MCP 包装补齐的功能：后台代客下单、通用 Order Edit、客户合并/账户重关联、换货补发、退货面单、复杂税制、多币种。完整覆盖现有 Admin 管理域不意味着这些新业务已经实现；新增时需单独设计数据库不变量与审核流程。

Worker 的 claim/complete、Inbox ingest/retry、原始渠道资金处理始终属于受信服务，不进入管理员 MCP。管理员 Outbox 重投已经可用，不扩张为 Worker 身份模拟。

## 验证

```bash
bun run typecheck
bun run test:unit
bun run test:current tests/mcp.test.ts # 已启动并初始化的可丢弃本地 Supabase
bun run test:current tests/admin-categories.test.ts
bun run test:current tests/storage-admin.test.ts
bun run test:current tests/admin-customer-commands.test.ts
bun run test:current tests/admin-inventory-reads.test.ts
bun run docs:check
```

单测覆盖工具发现与写开关、schema 拒绝、禁止入口、凭据/错误处理、大整数与微秒游标。集成测试覆盖真实 stdio、商品版本冲突、库存/收款幂等、履约、退货/回库与资金分离、客户匿名化重试、运维 DTO 和角色撤销。未声称完成真实 PayPal Sandbox、HTTP OAuth 或所有后续管理域验收。
