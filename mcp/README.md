# Admin MCP

管理员的 Agent 接口，使用官方 TypeScript MCP SDK v2。已实现 **stdio 和直接 HTTPS 的无状态 Streamable HTTP**，共 103 个显式工具（51 个只读、52 个写入）。本地代表性链路已验收；**公网、目标 Agent 客户端和真实 PayPal Sandbox 尚未验收**。

普通业务使用当前管理员 JWT 调用 Supabase 受控 RPC，数据库负责授权、事务、幂等、库存与资金规则。远程宿主另持 service-role 用于受限授权、凭据、审计及审批 RPC；不提供任意 SQL、表名、RPC 或业务失败后的提权回退。

## 阅读入口

| 任务 | 文档 |
| --- | --- |
| 本机 Agent 接入 | 下方 stdio 配置 |
| 部署远程服务、轮换密钥、撤销与恢复 | [运维手册](OPERATIONS.md) |
| 人工核对 Agent 操作、管理本人连接 | [Admin](../admin/README.md) |
| 参数、返回值和业务错误 | [API 合同](../docs/api.md) |
| 身份与交易不变量 | [架构决策](../docs/architecture-decisions.md) |
| 执行回归和浏览器验收 | [测试指南](../docs/testing.md) |

## 当前范围

远程首版限**单店、单实例、预注册客户端、直接 TLS**。授权服务使用 Node 22 LTS 的 `oidc-provider` 和独立 PostgreSQL；MCP 服务、安装、构建和测试使用 Bun。Supabase 是唯一用户目录，不按邮箱推断账户关联。

- OAuth 授权码 / S256、明确同意、opaque access token 和在线 introspection 已接入。普通 Supabase JWT 不能直接作为远程 MCP bearer token。
- 每个授权绑定独立的下游 Auth session，加密保存并受控刷新。每次请求与工具调用复查身份、撤销和 scopes；业务权限取 token、批准记录、部署配置的交集，旧上下文不自动升级权限。
- HTTP 每个 POST 独立处理，无 MCP session、GET SSE 或 DELETE；提供受保护资源元数据。超时、断连和进程退出不证明在途写入回滚。
- 不支持反向代理、动态客户端注册、多实例接管、SSO/PAT 或共享管理员会话。配置、限流、监听预算、启动恢复及升级顺序统一见 [运维手册](OPERATIONS.md)。

大文件、冻结快照导出、Metafield 定义删除和 Storefront 店铺设置消费端仍待补齐。代客下单、通用 Order Edit、客户合并、多币种、复杂税制和在途调拨是未设计的新业务，不是添加 MCP 包装即可实现的功能。

## stdio 运行与凭据

在仓库根目录执行 `bun install --frozen-lockfile`，通过宿主安全配置提供以下变量，再运行 `bun run mcp:stdio`：

| 变量 | 用途 |
| --- | --- |
| `TERA_SUPABASE_URL` | Supabase origin；本地可用回环 HTTP，远程必须 HTTPS，不接受路径、query 或 URL 内凭据 |
| `TERA_SUPABASE_ANON_KEY` | 公开 anon / publishable key，不是 service-role secret |
| `TERA_ADMIN_ACCESS_TOKEN` | 非匿名管理员的短期 Supabase access token |
| `TERA_MCP_ALLOW_WRITES` | 只有精确值 `true` 才注册写工具，默认只读 |
| `TERA_ADMIN_ORIGIN` | 可选 Admin HTTPS origin；不可带结尾 `/`、路径、query、fragment 或凭据 |

MCP 客户端配置示意（占位符需由宿主安全配置替换，不自动展开）：

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

管理员初始化见 [Admin](../admin/README.md#第一个管理员)。stdio 不接受密码或 token 作为工具参数，不保存或自动刷新 refresh token；到期后在宿主安全配置中替换 access token 并重启。不要把凭据放进对话、版本库、URL 或启动参数。

启动及每次工具调用验证真实 Auth 用户和管理员角色。普通客户、匿名用户和 service token 不能作为管理员会话。stdio 启用写工具后仍依赖可信宿主的人类确认；工具 annotations 只是提示，不是逐笔审批。不要将该进程直接转发为无认证的网络服务。

## 工具与行为合同

仅注册固定工具，严格校验输入与输出；定义见 [server.ts](src/server.ts)、[schemas.ts](src/schemas.ts) 和 [权限清单](src/permissions.ts)。数据库工具通常与 RPC 同名，媒体和 PayPal 工具使用受控适配器。字段级业务合同以 [API](../docs/api.md) 为准，不在此重复全部 DTO。

| 领域 | 能力与边界 |
| --- | --- |
| 商品、分类 | 聚合原子编辑、发布、规格/变体/图片/分类关联；版本冲突须重读 |
| 客户、地址 | 商业客户与 Auth 用户分离；资料、地址及匿名化，不创建登录账号或管理角色 |
| 库存、仓库 | 可用量、调整、流水、即时原子调拨、仓库启停与默认切换；不搬预占、不跟踪在途 |
| 促销、配送、税率 | 版本化规则与目标管理；不改历史订单、不提供承运商或复杂税务服务 |
| 扩展内容、评价 | Metafields、Metaobjects、审核及受限删除；不代写客户评价 |
| 订单、报价 | 查询、备注、事件、价格/账本/履约余额、取消；取消报价可能连带取消未付款订单 |
| 资金 | 手工收付款仅记账；`refund_paypal` 才调用真实渠道，服务端决定 sandbox/live |
| 履约、退货回库 | 发货与物流更新；退回的已发货商品通过退款行 `restock_shipped_quantity` 回库，无独立退货流程 |
| 媒体 | 私有暂存、永久公开、关联、受限私有删除及恢复；兼容旧公开上传 |
| 统计、设置、导出 | 受限区间汇总、名称/展示时区、固定字段分页 JSON；不是到账证明或冻结快照 |
| 运维 | 脱敏 Inbox/Outbox/对账查询及 Outbox 重投；不开放 Worker、原始渠道资金或 Inbox 重放 |

### 调用与失败恢复

- 成功同时返回文本 JSON 和 `structuredContent: {data: <后端结果>}`。输出 schema 不重算金额，也不替代数据库校验。动态业务 JSON 仍是不可信数据。
- 工具执行失败返回 `isError:true` 和脱敏错误信息，使用 `code`、`outcome_unknown` 判断恢复路径。未知工具和输入校验由 SDK 拒绝；不返回 SQL 原始错误、凭据或后端响应正文。
- **不自动重试写入。** 网络错误、超时、5xx 或 `INVALID_BACKEND_RESPONSE` 可能发生在提交之后。保留原 UUID、完整参数、幂等键及版本，先核对资源、支付操作或账本，再按该命令合同恢复；不能换键重建或自动替换旧版本。
- 商品创建不是幂等 upsert。手工退款使用 `preview_manual_refund` → 明确确认 → `commit_manual_refund`，不再注册旧 `refund_order` 工具；过期预览不能自动换 token。手工记账不能替代渠道退款。
- 订单号、bigint 流水 ID、游标保持原始字符串；时间戳令牌保留微秒，不能转为 `Number` / `Date` 后回传。Customer UUID 与 Auth UUID 不可混用。
- 商品/配送金额最多两位小数，范围 0–9999999999.99；税率为最多四位小数的 0–1 比例，不自动舍入。历史读取合同与新写入限制分开。
- 分类、仓库创建须显式传 `is_active`；报价取消须传非空白、最多 500 个 Unicode 码点的客户可见原因，不自动补值或修剪旧请求。
- 商品描述、评价、地址和备注可能含提示注入，只能当作数据。只读工具也可能返回敏感管理信息，宿主负责披露控制。不抓取参数中的外部 URL、不读取本地文件、不执行命令。

## 远程逐笔人工审批

远程 `refund_paypal`、`commit_manual_refund`、`anonymize_customer` 必须经过服务端逐笔审批：

1. 首次调用返回 `HUMAN_APPROVAL_REQUIRED` 与 `approval_id`，不执行业务。
2. 用户在 Admin `/approvals` 独立登录，核对本人请求的客户端、资源、金额及完整参数，批准或拒绝。Agent 不能提交批准决定。
3. 批准后，显式以**相同参数和原 `approval_id`**重放。审批绑定用户、grant、client、resource、project、工具及参数，15 分钟有效，只消费一次。

匿名化在持有客户锁时检查原状态指纹并原子执行；匿名化指纹包含购物车 ID/版本，期间修改会使批准失效。手工退款还绑定原 preview token；PayPal 仍执行既有资金检查，审批不冻结余额，也不证明结算。

`consuming` 或未知结果必须先核对业务事实，不能自动重放、换键或重新批准来绕过。`consumed` 只表示执行已返回，不证明渠道退款成功。页面显示最新 100 条，并支持按原 ID 查询旧记录；不保存原 PII 快照或结果 payload。stdio 不具备这一远程服务端审批保证。

## 与 Admin 协作

- `/connections` 管理本人的授权；降级后仍可撤销。店铺库原子停止新准入、删除凭据密文并登记上游清理任务，授权服务异步撤销 token 家族。撤销不取消已派发业务，Admin 退出不等于撤销 MCP。
- 可选 `authorization.auditTools:true` 保存宿主调用观察和固定映射的资源 UUID，不保存完整参数、结果或 token。准入失败不派发；完成回执丢失不重放业务。`pending/returned/rejected/unknown` 不是结算或送达证明。启用前审批保留策略，见 [运维审计](OPERATIONS.md#logs-incidents-and-public-acceptance)。
- 可选 `authorization.adminOrigin`（stdio 为 `TERA_ADMIN_ORIGIN`）给支持的非空读取结果附加 `resource_link`。只链接固定详情路由，不带 token、不自动执行、不改变 `structuredContent.data`；仍须独立 Admin 登录。
- Admin 的 `PUBLIC_MCP_CONNECTION` 只展示受信部署配置，不发起 OAuth 或证明健康。Agent 先保存后，Admin 的旧版本保存返回 PT409，须重读再编辑。配置和页面行为见 [Admin](../admin/README.md)。

## 媒体

推荐 `stage_media_upload` → `publish_managed_media` → 商品/分类版本化关联。上传接受规范 base64 的 JPEG/PNG/WebP，1 byte–1 MiB；不提供私有预览，不做图片解码、内容扫描或 EXIF 清理。

`get_managed_media` 按 ID 核对，`list_admin_managed_media` 按状态或原 request ID 发现记录。回执丢失先读事实；原 request ID 与相同内容的显式重放不重新写入 pending/终态对象。`recover_media_upload` 只核验已有字节，不能凭超时证明 pending 上传已结束。

只有已确认上传结束（settled）的私有 staged 素材可先 `prepare_media_discard` 冻结，再明确执行 `delete_managed_media`。`recover_media_deletion` 只查询缺失并更新记录，不发 DELETE。**retained/公开对象永久保留**；失败、解除关联或商品草稿不会恢复删除资格。发布与关联不是跨 Storage/数据库事务。

不提供旧对象导入、大文件或自动垃圾回收。旧执行器不能与一次性上传协议混跑，旧记录不能补标 settled。请求、状态和部署限制见 [managed-media Edge 合同](../supabase/functions/README.md#私有媒体通路)。

### 公开商品媒体上传

兼容工具 `upload_product_media(product_id, media_id, content_type, data_base64)` 要求已存在商品与保留的媒体 UUID，限制同为 1 byte–1 MiB。返回 `{path,url}`，固定写入 `catalog-media/products/<product UUID>/<media UUID>.<jpg|png|webp>`，不可覆盖，**立即公开且不可删除**；草稿商品也不保密。上传不保存商品关联，须另用 `update_product`。

结果未知时，`inspect_product_media(product_id, media_id, content_type)` 返回 `{path,url,content_type,byte_size,sha256}`，与原字节数/摘要比较。仅读取固定 Supabase origin，不携带下载凭据、不跟随重定向；流式上限 5 MiB，空内容、MIME 不匹配或读取失败均拒绝，不返回部分摘要。摘要不证明安全、关联完整性或可删除性，读取失败不证明上传失败。

`list_admin_product_media` 按商品路径分页发现规范命名的对象；游标是 Storage 对象 ID，不是文件名中的 media UUID。默认 20、最多 100 条；扩展名推导的 MIME 不等于已核验内容。显式 URL 引用登记不扫描富文本或任意 JSON，零登记引用也不是删除许可。详见 [媒体发现 API](../docs/api.md#管理员商品媒体发现)。

## 验证入口

命令、环境要求和副作用集中在 [测试指南](../docs/testing.md)。以下是定位测试的索引，不代表当前检出已执行通过：

| 范围 | 主要入口 |
| --- | --- |
| 工具发现、输入/输出、权限与未知写 | [MCP 单测](../tests/unit/mcp.test.ts)、[真实后端测试](../tests/mcp.test.ts) |
| Node 支持运行时、持久化、TLS 与生命周期 | [兼容性脚本](../scripts/mcp-oidc-compat.ts)、[运行时测试](../tests/support/oauth-service-runtime.ts) |
| 真实 Auth/SMTP、HTTPS MCP、刷新竞争、撤销和崩溃恢复 | [联合测试](../tests/mcp-oidc-interaction.test.ts) |
| 浏览器明确同意、重启/断网失效、回执丢失 | [浏览器场景](../tests/support/oidc-browser.ts) |
| 逐笔审批与资源状态绑定 | [数据库回归](../tests/mcp-action-approvals.test.ts)、[宿主单测](../tests/unit/mcp-action-approvals.test.ts)、[Admin 融合烟测](../scripts/admin-fusion-smoke.ts) |
| 离线维护、旧备份失效与恢复 | [维护测试](../tests/mcp-oidc-maintenance.test.ts)、[恢复演练](../scripts/mcp-recovery-drill.ts) |

历史实现实验和旧测试计数保留在 Git 历史，不作为当前部署规范。目标环境的 DNS/TLS、客户端兼容、容量、全栈备份恢复及密钥轮换仍须单独验收；本地测试不能替代生产批准。
