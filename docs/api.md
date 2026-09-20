# API 使用参考

RPC 路径为 `/rest/v1/rpc/<name>`，Edge Function 路径为 `/functions/v1/<name>`，均使用 POST。
PostgREST 请求携带 `apikey`；客户/管理员命令另携带 `Authorization: Bearer <user-jwt>`。
参数名与默认值见 [生成类型](../types/database.ts)，业务约束见 [ADR](architecture-decisions.md)。
所有商品、运费、固定金额优惠、订单、收款和退款均以 **USD** 计价；`product_listing.currency` 显式返回 `USD`，不提供币种切换或自动换汇。

## 阅读导航

| 任务 | 章节 |
| --- | --- |
| 商品与目录管理 | [读取](#storefront--admin-商品读取合同)、[原子编辑](#原子商品编辑)、[底表查询](#现有底表查询)、[促销与扩展](#促销范围与扩展字段管理) |
| 客户与身份 | [Customer](#customer-与登录身份)、[游客结账](#游客自行结账)、[升级注册](#游客验证邮箱后注册)、[邮箱变更](#注册账户改邮箱重发与过期)、[客户管理](#客户管理查询) |
| 购物袋与结账 | [可选持久 Cart](#持久-cart可选)、[Quote 流程](#推荐结账流程)、[商业行](#商业行身份)、[金额](#价格明细与税务依据)、[地址](#地址合同) |
| 订单与售后 | [查询](#客户后台订单查询)、[支付退款](#支付与退款)、[退货收货](#return--receipt--disposition)、[管理命令](#客户与管理员命令)、[便捷下单／手工交易](#便捷下单与手工命令) |

本页维护调用合同，不保证示例前台已实现全部功能；前台能力见 [Storefront](../storefront/README.md)，支付 UI 状态和 SDK 流程见 [PayPal 接入](storefront-paypal.md)。

## Storefront / Admin 商品读取合同

新客户端优先使用以下显式 DTO，而不是把底表结构作为商城合同。RPC 均位于 `public`；命名不授予权限，数据库独立验证身份、发布状态和输出字段。

| RPC | 参数 | 返回 / 权限 |
| --- | --- | --- |
| `list_storefront_products` | `page_size` 默认 20，1–100；可选 `after_id`、`category_id` | `{items,next_cursor}`；匿名可用，只含 active 商品；分类精确匹配且须启用，不包含子分类闭包 |
| `get_storefront_product` | `product_id` | 商品详情或 null；匿名可用，草稿/归档/不存在均返回 null |
| `get_admin_product` | `product_id` | 管理详情或 null；仅 admin/service，包含草稿、停用子资源、成本及内部扩展值 |
| `list_admin_products` | `page_size` 默认 20，1–100；可选 `status_filter/category_id/search/after_cursor` | `{items,next_cursor}`；仅 admin/service；更新时间倒序的管理摘要 |

Storefront 列表以 UUID 升序分页，将 `next_cursor` 传给下一次 `after_id`；无后续页时为 null。并发新增商品可能落在已翻过的范围，游标不保证跨请求快照。卡片包含 `id/slug/name/currency/price_from/in_stock/primary_image`，不返回精确库存。

详情包含基本商品/SEO 字段、`variants`、`options`、`images`、`categories` 和 `metafields`。变体通过 `option_value_ids` 对应选项值；商品/变体扩展值使用 `{namespace,key,type,value}`。Storefront 隐藏停用变体及其专属图片、停用分类、内部扩展字段和成本；**管理员调用 Storefront 也不会扩大输出范围**。库存仍只看默认仓可用量及有效 Quote 预占，不承诺后续结账成功。

Admin 详情增加商品状态/时间戳、编辑版本 `revision` 及变体 `cost/is_active/track_inventory`；精确库存继续使用管理员 `get_inventory_availability`，不是将 Storefront 切换为“管理员模式”。公共扩展引用不会自动递归展开，需按 Metaobject ID 读取其受保护资源。

底表/视图仍按原授权开放，扩展字段同样受下文可见性规则约束。Storefront RPC 尚无搜索或运营排序；示例前台的价格／名称排序仅作用于已加载目录。

### Admin 商品列表

`list_admin_products` 默认包含 draft/active/archived，`status_filter` 可选其中一个。`category_id` 精确匹配商品关联，允许停用分类，不包含子分类；不存在的分类返回空集合。所有筛选以 AND 组合。

`search` 最多 200 字符，去除首尾空格后为空表示不筛选；按名称或任一变体 SKU 不区分大小写的字面子串匹配（包含停用变体），`%`、`_` 不是通配符。不搜索描述、标签、条码或扩展字段，不提供模糊纠错或相关性排序。

摘要包含 `id/slug/name/status/updated_at/revision/currency/price_from/price_to/variant_count/primary_image`。价格范围和数量包含全部变体，无变体时价格为 null、数量为 0；主图取全部图片中 `(position,id)` 最小者的 URL，无图为 null。不返回成本、精确库存或完整子资源，不计算精确总数。

按 `(updated_at DESC,id DESC)` 分页，将返回的 `next_cursor:{updated_at,id}` 原样传入下一次 `after_cursor`，无后续页时为 null。不要经 JavaScript Date 转换时间戳，否则会丢失微秒；修改筛选条件时清除游标。游标不提供跨请求快照：并发编辑可能将未读商品移到游标之前，刷新列表才能看到；列表 revision 也可能立即过期，进入编辑页应重新读取管理详情。

```http
POST /rest/v1/rpc/list_admin_products

{"page_size":20,"status_filter":"draft","search":"shirt"}
```

默认排序有复合索引，先限定当前页再聚合价格/数量。子串搜索及低命中率筛选仍可能扫描较多候选，不承诺目录规模无关的延迟，也不是全文搜索引擎。

### 原子商品编辑

`create_product(product_id, changes)` 仅 admin/service 可用：调用方生成并保留新的商品 UUID，`changes.product` 必须包含字符串 slug/name；其余分组与下方 `update_product` 完全相同。默认创建 draft；提供 status=active 时须在同一请求构建完整目录。返回 Admin 商品详情及当前 revision，失败不留下商品或子资源，不创建库存数量。

创建不是 upsert，也没有历史响应缓存；重复 UUID 或 slug 返回 409 / `23505`，不覆盖已有数据。响应丢失时先用保留的 UUID 调用 `get_admin_product` 核对结果；确认不存在后仍复用原 UUID 重试，不生成新 UUID 盲目重建。创建成功后使用 `update_product` 修改。

`update_product(product_id, expected_revision, changes)` 仅 admin/service 可用，返回与 `get_admin_product` 相同的管理 DTO。先读取管理详情，将其 `revision` 原样作为 `expected_revision`。在售商品可以直接保存，全部修改在一个事务提交，其他请求不会读到半成品；任何字段、归属或发布校验失败均回滚全部修改及版本。

`changes` 是 PATCH 对象，不是完整详情替换；仅接受以下字段：

| 分组 | 可编辑内容 |
| --- | --- |
| `product` | 对象：`slug/name/description/status/vendor/product_type/tags/seo_title/seo_description` |
| `options` | 数组：`id/name/position` |
| `option_values` | 数组：`id/option_id/value/position`；已有值不可改所属 option |
| `variants` | 数组：`id/sku/barcode/price/compare_at_price/cost/track_inventory/position/is_active` |
| `variant_options` | 数组：`{id:变体UUID,option_value_ids:[选项值UUID]}`，完整替换该变体的规格关联 |
| `images` | 数组：`id/variant_id/url/alt/position` |
| `category_ids` | 分类 UUID 数组，完整替换商品的分类关联；允许关联停用分类，不修改分类本身 |
| `metafields` | 数组：`{namespace,key,type,value,variant_id?}`；不传 variant_id 表示当前商品，传入时必须是本商品的变体 |

- 省略分组或字段保持原值；可空字段传 null 才清空。普通资源数组为空不删除任何行；`option_value_ids:[]` 清除该变体全部关联，仍须通过最终发布校验。
- 子资源必须提供 UUID；已有 ID 更新，不存在的 ID 创建且保留未指定列的数据库默认值。新变体须提供价格，SKU 可空；新选项值须指定本商品的 option_id。删除使用 `{id,delete:true}`，不能带其他字段；仅 options/option_values/variants/images 支持，商品归档使用 status。删除遵守现有级联和交易引用约束。
- `category_ids` 省略保留，`[]` 清空；只增删差异，重复保存同一集合不推进版本。不存在的分类由 FK 拒绝（409 / `23503`），不是版本冲突。
- Metafield 使用 `(商品或变体,namespace,key)` 定位，不接受行 ID、owner_type/owner_id 或 access。每次新增/更新须提供 type 和 value，复用定义、类型和引用校验；删除使用 `{namespace,key,variant_id?,delete:true}`，要求已存在且不得附带 type/value。`metafields:[]` 不清空，JSON null 是字段值而不是删除指令（仅允许接纳该值的类型）。
- 固定处理顺序为 product → options → option_values → variants → variant_options → images → category_ids → metafields；每组按输入顺序执行。可在同一请求创建变体并写其扩展值，不能写本次已删除变体的扩展。选项组合可原子互换，但 SKU/选项名称等即时唯一约束不会延迟，不能直接互换冲突的唯一值。
- `changes` 按 PostgreSQL JSONB 文本表示最多 256 KiB，每个资源数组最多 500 条，同组 ID 或 Metafield 定位不可重复（UUID 大小写视为相同）。未知字段拒绝，不可提交 DTO 的身份、库存数量或派生字段。
- `revision` 是数据库维护的并发令牌，不是“一次保存恰好 +1”的计数；商品、变体（包括价格/SKU）、规格/值/关联、图片、分类关联及商品/变体 Metafield 的旧写表路径也推进版本。库存、分类内容、扩展定义和 Metaobject 内容不在该版本范围。`changes:{}` 不推进版本。
- 版本过期返回 HTTP 409 / `PT409`，不存在返回 404，非法输入拒绝。收到版本冲突应重新读取并让管理员核对差异，不可自动换新版本覆盖。没有幂等重放缓存；响应丢失先重读确认。锁竞争 `55P03` 或旧快照 `40001` 应重试整笔事务，仍保留原 expected_revision。

```http
POST /rest/v1/rpc/update_product

{"product_id":"<商品UUID>","expected_revision":7,"changes":{"product":{"name":"Updated shirt"},"variants":[{"id":"<变体UUID>","price":29.50}],"images":[{"id":"<图片UUID>","delete":true}]}}
```

分类和扩展可与上述字段合并保存，例如 `"changes":{"category_ids":["<分类UUID>"],"metafields":[{"namespace":"custom","key":"material","type":"text","value":"Cotton"}]}`。保存值不会建立或公开定义；没有公开定义的值继续仅管理端可读。分类树、Metafield 定义/可见性、Metaobject 内容仍独立管理。

### 现有底表查询

```http
GET /rest/v1/product_listing?select=id,slug,name,price_from,in_stock
GET /rest/v1/products?slug=eq.xxx&select=id,name,description,product_variants(id,sku,price),product_images(url,alt)
```

使用显式字段选择，不对变体使用 `select=*`：`cost` 有列权限保护。精确库存仅管理员可读，商城使用 `in_stock`。
商品子资源继承发布状态；分类拉取平铺列表后在客户端组树，列表视图仅包含启用分类。

管理员优先使用 `create_product` / `update_product` 原子编辑。多个底表请求须先转 `draft`，完成变体、规格关联和图片后再发布；草稿也不允许跨商品关联。发布完整性见 [ADR-013](architecture-decisions.md#adr-013目录完整性与发布)。并发修改遇到 `55P03` / `40001` 时重试整笔事务，不绕过约束。

### 管理员分类管理

以下 RPC 仅 admin/service 可用，也作为同名 MCP 工具开放。DTO 明确返回 `id/slug/name/description/parent_id/image_url/position/is_active/created_at/updated_at`，不递归嵌套商品或子分类。

| RPC | 参数与合同 |
| --- | --- |
| `get_admin_category` | `category_id`；不存在返回 null，包含停用分类 |
| `list_admin_categories` | `page_size=20`（1–100）、`after_id`、`parent_id`、`root_only=false`、`active`、`search`；返回 `{items,next_cursor}` |
| `create_category` | 调用方保留的 `category_id` UUID、`changes`；必须包含字符串 `slug/name`，默认启用 |
| `update_category` | `category_id`、读取时的原始 `expected_updated_at`、`changes` PATCH；返回更新后 DTO |

列表按 UUID 升序分页，将 `next_cursor` 原样传入 `after_id`；null 表示末页。不保证跨请求快照。`parent_id` 精确查询直接子分类，不含孙辈；`root_only=true` 只查根分类，不可同时指定 parent_id。两者省略则查询全部层级。active 省略包含启用与停用；search 至多 200 字符，按名称或 slug 不区分大小写的字面子串查询，`%/_` 不作通配符。客户端分页获取后按 parent_id 组树，再以 `(position,id)` 排列同级节点；`position` 不控制翻页顺序。

`changes` 只允许 `slug/name/description/parent_id/image_url/position/is_active`；省略保留，只有 parent_id/image_url 可传 null。position 为有符号 32 位整数。PATCH JSONB 文本最多 256 KiB；不允许改 ID、时间戳或注入其他表字段。移动到根传 `parent_id:null`，停用传 `is_active:false`；**停用不会停用子分类或商品，也不删除关联**。图片 URL 只保存，不负责上传或抓取。

更新必须保留 updated_at 的微秒精度，不经 JavaScript Date 转换；旧时间戳返回 `PT409`，应重新读取并确认意图，不能自动覆盖。无变化 PATCH 不推进时间戳；底表正常更新仍由既有 trigger 更新时间。数据库保护自环、祖先循环、悬空父节点和唯一 slug；任意失败回滚全部字段。锁竞争 `55P03` / 旧快照 `40001` 应重试完整请求，保留原时间戳。

创建不是 upsert；重复 UUID/slug 为 `23505`，响应丢失先按原 UUID 查询，不换 UUID 盲目重建。更新无历史响应缓存，结果未知先重新读取；不存在为 `PT404`，非法字段为 `22023`，非管理员为 `42501`。这组工具不提供级联删除分类树，删除和批量重组需另行明确业务合同。

## Customer 与登录身份

`customers.id` 是独立商业 UUID，**不等于 Auth user ID**。`auth_user_id` 是唯一、可空的登录关联；联系邮箱非唯一，不用邮箱或客户端 metadata 自动认领/合并客户。注册创建新 Customer，后台 `create_customer` 可创建无账号客户；目前没有客户合并、账号重关联或为无账号客户代下单的 RPC。

- `current_customer_id()` 返回当前活跃客户 UUID；无关联或已匿名化返回 null，授权失败关闭。
- `orders` / Quote / 地址 / 评价 / 优惠用量 / 客户 metafield 使用 Customer ID；角色、`set_user_role.user_id` 和审计 `actor_id` 仍使用 Auth ID。
- `/rest/v1/customers` 仅本人/admin/service 可读；可 PATCH `email`、`full_name`、`phone`，不可写身份、Auth 关联、匿名化状态。`profiles` 仅保存账户邮箱/角色等，不再保存姓名/电话，也不提供自助 PATCH。
- Auth 邮箱变化不覆盖客户联系邮箱。删除 Auth 只解除关联，不删除 Customer 或订单；新同邮箱账号不会接管旧记录。
- `anonymize_customer` 清客户联系信息、地址、客户 metafield 与全部 Cart，禁止恢复这些客户自有内容；`anonymize_user` 另清 profile 和审计 actor。两者都不等于删除 Auth、撤销登录凭据或擦除订单地址/属性、评价正文等历史数据。

### 游客自行结账

只支持客户自行线上下单，不提供后台代客下单。游客使用 Supabase `auth.signInAnonymously()`（HTTP `POST /auth/v1/signup`，body `{}`）取得匿名会话，无需注册、密码或验证邮箱。只在没有现有会话时创建；已有账号会话直接复用，不要每次结账更换身份。匿名 Auth 用户使用 `authenticated` 数据库角色和独立 Customer，**不是公开 anon key，也不是 Cart token**。

1. 开始结账时取得/保留会话，用 `current_customer_id()` 获取商业 ID。
2. PATCH 自己的 Customer 联系邮箱；新报价和新订单要求非空、至多 320 字符且符合基本邮箱格式。只校验格式，不证明邮箱所有权；姓名和配送地址沿用现有合同。
3. 若此前使用 token Cart，先以匿名会话调用 `claim_cart`；也可直接以匿名会话创建客户 Cart（需 idempotency_key），或不使用 Cart 直接报价。
4. 以同一会话调用 Quote、转单、PayPal 创建/捕获和客户订单查询。权限、配额、预占期限及重试规则与注册客户一致。

订单 email 在首次建单时从 Customer 取值、去除首尾空格并保存快照，不是 Quote 锁价内容；报价后修改联系邮箱会影响尚未建的订单，既有订单和幂等重放不变。格式错误返回 400 / `22023`，事务回滚。

联系邮箱可与注册客户相同，绝不因此合并或授权历史。切换到已有账户不会迁移匿名会话的客户 Cart、Quote 或订单，应在结账前选择身份；原 token Cart 只能认领一次。匿名会话丢失、退出或换设备后，目前没有邮件查单、订单找回或客户合并接口，不得凭邮箱/订单号自动恢复。若未来需要跨设备查单，须另建可撤销、限时的验证流程。

匿名会话的访问/刷新凭据按登录凭据保护、刷新，勿放 URL/日志；匿名页面与会话响应不可共享缓存。上线前必须配置 CAPTCHA/匿名注册及 RPC 限流和匿名 Auth 清理策略，参见[支付与部署](../supabase/functions/README.md)。

### 游客验证邮箱后注册

在**原匿名会话**上使用 Supabase Auth 原生身份绑定，不新建 Customer、不调用 signUp 创建另一身份，也不增加自制注册 RPC。本地启用 manual linking 和邮箱确认；生产需要相同 Auth 设置及可用 SMTP。

1. 使用当前匿名会话调用 `auth.updateUser({email}, {emailRedirectTo: '<允许的注册回调地址>'})`，HTTP 为 `PUT /auth/v1/user`。联系邮箱可预填，但不能当作已验证邮箱；只传 email，不同时设置密码。
2. 用户点击 Auth 发出的确认链接，或使用自定义邮件模板的 OTP 调用 `auth.verifyOtp({email,token,type:'email_change'})`。默认模板提供确认链接；本地从 Mailpit 获取。Storefront 负责配置允许的回调地址、接收并持久化验证后的会话（PKCE 接入按 SDK 流程交换 code），本仓库不含注册页面/回调 UI。
3. 用 `auth.getUser()` 确认绑定完成（`is_anonymous=false`，Auth ID 与原身份一致），再调用 `auth.updateUser({password})`。确认前设置密码被 Auth 拒绝；不能由 service role 代设 `email_confirm=true` 绕过。
4. 之后可用 `auth.signInWithPassword({email,password})` 登录。Auth UUID、Customer UUID 不变，原购物车、订单、资金归属保持；后台 has_account 变为 true。

邮箱确认完成时身份已转为非匿名，即便尚未设置密码；不要仅凭 has_account 判断密码设置完成。登录邮箱更新只同步 profiles.email，不改 customers.email 或 orders.email；绑定邮箱不必与历史联系邮箱相同。若页面在确认后关闭，可沿用有效会话设置密码，或通过 Auth 密码找回流程恢复。

邮箱已被注册时绑定被拒绝，提示登录已有账户；不自动迁移或合并游客记录。丢失匿名会话且尚未发起绑定，仍不能只凭联系邮箱找回订单。生产 SMTP 未配置/验证前不开放升级入口，但游客结账无需邮件验证，可以独立使用。

### 注册账户改邮箱、重发与过期

注册账户同样用当前会话 `auth.updateUser({email})` 请求更换登录邮箱。当前 `double_confirm_changes=false`，只需确认新地址；确认前旧邮箱仍可登录，新邮箱不可登录，确认后反转。Auth/Customer ID 不变，profile 邮箱跟随 Auth，客户联系邮箱及历史订单快照不变。占用邮箱拒绝，不隐式合并客户。生产是否启用新旧邮箱双重确认需另行决定，本地此项回归不代表双确认已经启用。

- 注册确认使用 `auth.resend({type:'signup',email})`；改邮箱重发使用 `auth.resend({type:'email_change',email:当前登录邮箱})`，邮件发送到待确认的新邮箱。HTTP 均为 `POST /auth/v1/resend`。
- 密码找回通过 `auth.resetPasswordForEmail(email)` / `POST /auth/v1/recover` 再次请求，不向 resend 传 recovery 类型。
- 本地同类邮件冷却配置为 60 秒；命中返回 429 / `over_email_send_rate_limit`，不新增邮件，也不废弃原令牌。全局发信限额和生产策略另计。
- 成功重发替换同类旧令牌，即使旧令牌尚未过期也不能再用；应使用最新邮件。三个流程的本地令牌期限均为 3600 秒，从该类邮件发送时间计算；过期或成功使用后的重放返回 403 / `otp_expired`。该错误也涵盖无效令牌，不能据此推断是哪一种原因。

### 客户管理查询

`get_admin_customer(customer_id)` 与 `list_admin_customers` 仅 admin/service 可用；ID 是商业 Customer UUID，不是 Auth ID。详情不存在返回 null。

- `list_admin_customers(page_size=20, search=null, anonymized=null, after_cursor=null)` 返回 `{items,next_cursor}`，page_size 为 1–100。按 `(created_at DESC,id DESC)` 分页，游标 `{created_at,id}` 原样传回，保留微秒；修改筛选时清除游标，不承诺跨请求快照。
- search 最多 200 字符，去除首尾空格后为空表示不筛选；匹配姓名、联系邮箱或电话的不区分大小写字面子串。`%/_` 不是通配符；电话不自动规范化，同邮箱客户不合并。anonymized 为 null 包含全部，true 仅匿名化客户，false 仅未匿名化客户；与 search 按 AND 组合。
- 列表返回 `id/email/full_name/phone/has_account/anonymized_at/created_at/updated_at`，不加载地址、订单、扩展值或总数。has_account 表示关联非匿名 Auth 账户；游客会话为 false，不证明该账号当前可登录或未匿名化。
- 详情增加 `addresses`（默认地址优先、再按 UUID 排序）和 `metafields`；不暴露 Auth ID、角色、凭据或 Auth 登录邮箱。匿名化后不从订单历史回填联系资料；客户地址为空不代表历史订单地址已擦除。
- 查询客户订单使用 `list_admin_orders(customer_id=...)`，不在客户详情无限嵌套订单。子串搜索成本仍随客户数量增长，不是全文检索或已验证的生产性能承诺。

### 管理员客户资料与地址命令

以下 RPC 仅 admin/service 可用，也作为同名 MCP 工具开放，成功均返回最新 `get_admin_customer` DTO。普通客户修改自己的资料仍沿用 RLS 表接口，这些命令不扩大自助权限。

| RPC | 参数与合同 |
| --- | --- |
| `update_customer` | `customer_id, expected_updated_at, changes`；只改联系 `email/full_name/phone` |
| `create_customer_address` | `customer_id, address_id, changes`；保留调用方 UUID，必填 `recipient_name/country/line1`，默认非默认地址 |
| `update_customer_address` | `customer_id, address_id, expected_updated_at, changes`；地址必须属于所传客户 |
| `delete_customer_address` | `customer_id, address_id, expected_updated_at`；删除地址簿记录，不选替代默认地址 |

客户更新使用客户 DTO 的 updated_at；地址更新/删除使用 `addresses[]` 对应项新增的 updated_at，**不是客户时间戳**。原样保留微秒，不经 Date 转换。过期令牌为 `PT409`，不存在/地址归属不符为 `PT404`；行锁竞争可能为 `55P03`，旧事务快照可能为 `40001`，重试时保留原令牌并重新确认意图。不自动替换令牌覆盖新状态；无变化 PATCH 不推进时间戳。

PATCH 省略保留，只允许显式字段，JSONB 文本最多 256 KiB。客户 email/phone 可 null，full_name 不可 null；沿用底表长度规则（邮箱按 SQL btrim 后为 1–320 字符、姓名最多 200、电话最多 50），实际保存时不自动清空或 trim 联系字段，不代表验证邮箱归属。不会改变 Auth 邮箱、身份关联、角色或历史订单快照；已匿名化客户拒绝更新。

地址白名单为 `label/recipient_name/phone/country/region/city/line1/line2/postal_code`；phone/region/city/line2/postal_code 可 null，其他不可。国家沿用既有规范化规则，保存两位大写码；收件人和 line1 不可空白。不能修改 ID、归属、时间戳或 is_default；默认地址使用已有 `set_default_address`。地址创建、修改和删除仅允许活跃客户，按客户→地址加锁，与匿名化及默认地址命令协调。新增/实际修改/删除会推进客户 updated_at；删除默认地址允许留下零个默认地址。

创建不是 upsert，重复 UUID 为 `23505`，非法字段或类型为 `22023`，任意失败原子回滚。响应丢失先按原客户读取地址列表核对 UUID，不能换 ID 盲目重建。编辑/删除没有历史响应缓存，删除后的重试为 `PT404`；先读取事实判断结果。地址簿 CRUD 不修改已保存的 Quote 或订单地址快照。

## 客户／后台订单查询

| RPC | 参数与权限 |
| --- | --- |
| `get_customer_order` | order_id；仅当前活跃登录客户自己的订单，其他归属或不存在返回 null；管理员调用也不扩大范围 |
| `get_admin_order` | order_id；仅 admin/service，不存在返回 null |
| `list_customer_orders` | page_size 默认 20、after_order_number、status_filter、financial_status_filter、fulfillment_status_filter；只查当前客户，无 customer_id 参数 |
| `list_admin_orders` | 同上，另可传 customer_id 筛选；仅 admin/service，不传客户则查全店 |

列表返回 `{items,next_cursor}`，page_size 为 1–100；按不可变、唯一的 order_number 倒序，将 next_cursor 传给下一次 after_order_number，末页为 null。订单号顺序不等于事务提交时间，不承诺跨页快照；状态变化也可能改变筛选结果。状态筛选均为精确匹配、以 AND 组合；使用现有 status（open/completed/cancelled）、financial_status（pending/paid/partially_refunded/refunded/voided）、fulfillment_status（unfulfilled/partially_fulfilled/fulfilled），未知值拒绝。

客户列表仅返回 `id/order_number/status/financial_status/fulfillment_status/currency/total/created_at`；后台列表另有 customer_id 和下单时的 email 快照。不加载商品行、地址、内部备注或精确总数。

详情复用下单返回的安全订单头、持久化 `pricing` 明细和 `fulfillments`（物流字段及关系化 order_item_id/quantity 行）；目录改价不会重算订单快照。Admin 详情额外返回 admin_note。两者不返回支付渠道操作信息；资金账本、退款/退货、履约余额继续用已有专项 RPC，并各自检查权限。

客户查询必须能解析出当前活跃 Customer，无会话、失去 Auth 关联或已匿名化均拒绝；有效游客会话可查询自己的订单。不能用请求体客户 ID 或 service role 无身份调用来冒充客户。管理员仍可按商业 Customer ID 查询匿名化客户的历史订单，此数据继续受订单保留政策约束。

## 持久 Cart（可选）

Cart 保存购买意向，不保存价格、锁价或占库存。可以为空，每个活跃 Cart 最多 50 条规范化商业行/100 件；同变体/属性合并，已有行 ID 在改数量时保留。停售/价格、库存、优惠资格在预览/转 Quote 时重新核验，不把 Cart 当可支付对象。

本表的“登录客户”包括有效匿名 Auth 会话；“游客 token”指尚未取得会话的 capability Cart。两者不可混用。

| RPC | 参数 / 行为 |
| --- | --- |
| `create_cart` | 登录客户必须传 `idempotency_key`；游客不传键，返回一次 `guest_token`。可选 `ttl_seconds`，默认 604800，范围 60–2592000 |
| `get_cart` | `cart_id`；游客另传 `guest_token`，客户 Cart 只认登录归属 |
| `list_carts` | 登录客户的未过期 active Cart，不含游客或其他客户对象 |
| `update_cart` | `cart_id`、`expected_version`、完整 `items`；可选 `address`、`shipping_method_id`、`discount_code`、`note`、`guest_token` |
| `preview_cart` | `cart_id`、可选 `guest_token`；返回 `{cart_id,version,pricing}`，空 Cart 的 pricing 为 null |
| `claim_cart` | 登录后传 `cart_id`、`expected_version`、原 `guest_token`；显式认领，不合并其他 Cart；旧游客凭据立即失效 |
| `abandon_cart` | `cart_id`、`expected_version`、可选 `guest_token`；清行/地址/备注并终结编辑，不释放 Quote 库存 |
| `checkout_cart` | 仅登录客户，传 `cart_id`、`expected_version`；原子创建 Quote、预占库存并将 Cart 设为 converted，返回 Quote DTO |

`update_cart` 是**完整替换**，不是 PATCH：未传的地址/配送/优惠码/备注会清空，`items:[]` 清行。地址可只填国家以预估，正式结账仍须姓名/line1/国家；地址 JSON 至多 16 KiB，备注至多 2000 字符，优惠码至多 100 字符。行输入使用下文商业行合同，不可把包含行 `id`/价格的响应直接回传。

```http
POST /rest/v1/rpc/update_cart

{"cart_id":"<uuid>","guest_token":"<仅游客需要的凭据>","expected_version":1,"items":[{"variant_id":"<uuid>","quantity":1,"attributes":{"engraving":"Alice"}}],"address":{"recipient_name":"Alex","line1":"123 Example Street","country":"US"}}
```

- 每次编辑/认领/终结版本 +1；版本冲突为 HTTP 409，不静默覆盖。最近一次完全相同的规范化命令重试返回当前结果；更早的重试需 `get_cart` 恢复，不无限保留全部 mutation 历史。创建幂等也只在 Cart 保留期内有效。
- 每客户最多 5 个未过期 active Cart，创建与认领共用配额；这与 5 个活跃 checkout 是两套不同资源上限。转 Quote 仍需满足原 checkout 配额/库存/价格规则，任何失败都不改变 Cart。
- Cart 的期限固定，读取、编辑、认领均不续期。converted / abandoned 不可重新编辑；再次购买创建新 Cart。转 Quote 会清 Cart 地址/备注，但保留商业行；Quote 行重新分配 UUID、沿用 `line_key`，再将 Quote UUID 沿用到订单行。
- 游客凭据是 256 位随机 bearer capability，只授权一个 Cart，不授权 Customer、订单、Quote 或支付。数据库只保存 SHA-256；只有创建响应带明文，丢失后不能取回。放弃后的空 Cart 仍可凭原凭据读取直到到期，认领/到期后旧凭据不可用。
- 始终用 HTTPS/POST；不要把 token 放 URL、日志、埋点或公开存储。BFF 推荐 Secure/HttpOnly/SameSite cookie 并防 CSRF；直接浏览器接入须管理 XSS/凭据存储风险。共享游客凭据就等于共享编辑和认领权。
- 到期立即拒绝访问，`purge_expired_carts` 负责物理删除。访客没有稳定账号可用于总量配额；上线必须在覆盖直接 RPC 的网关部署创建/读取/预览/写入限流，当前数据库限制不等于匿名防滥用或隐私合规验证。

## 推荐结账流程

1. `price_checkout` 预览价格（匿名可用），不占库存，也不保证之后价格不变。
2. 取得注册或匿名会话、填写 Customer 联系邮箱后，`create_checkout_quote` 生成报价并预占库存；使用 token Cart 时先认领，再调用 `checkout_cart`。
3. `create_order_from_quote` 再次校验价格；正金额订单待支付并继续持有预占，零元订单直接原子消费预占、扣库存并返回 `financial_status:"paid"`。
4. 仅待支付的正金额订单调用渠道支付入口；渠道确认成功后，数据库原子扣库存并推进订单。零元订单不创建支付意图或资金流水，也无需管理员确认。

```http
POST /rest/v1/rpc/create_checkout_quote

{"idempotency_key":"checkout-attempt-id","items":[{"variant_id":"<uuid>","quantity":1}],"address":{"recipient_name":"Alex Morgan","country":"US","region":"NY","city":"New York","line1":"123 Example Street","line2":"Apt 4B","postal_code":"10001"},"ttl_seconds":900}
```

```http
POST /rest/v1/rpc/create_order_from_quote

{"quote_id":"<uuid>"}
```

`price_checkout` 接受 `items`、`address`、`shipping_method_id`、`discount_code`。
不传地址时仅预估商品价格，不计目的地税；选择配送方式必须显式传国家。传入地址时 `country` 不可省略。
Quote 还支持 `address_id`、`note`；价格变化时需新建 Quote，不会静默重定价。
同一业务重试复用幂等键，不同参数必须使用新键。
价格预览（包括匿名）、Cart 编辑、建单与报价均限制 50 条规范化商业行/100 件。原始 `items` 数组最多 100 项，PostgreSQL JSONB 文本表示最多 1 MiB UTF-8 字节，在逐行规范化前拒绝超限；100 条相同输入仍可合并成一行，总件数不能因拆行绕过。预算错误返回 400；该字节限制不替代网关 HTTP 请求体上限、超时和限流。
每客户最多 5 个活跃 checkout（未转单 Quote + 未过期未付款订单）；转单及幂等重试不重复占名额。订单 DTO 的 `payment_expires_at` 是固定付款期限，不可延长。

| RPC | 参数 / 用途 |
| --- | --- |
| `get_checkout_quote` | `quote_id` |
| `get_order_checkout_quote` | `order_id` |
| `cancel_checkout_quote` | `quote_id`、可选 `reason` |
| `cancel_order` | `order_id`、可选 `reason`；仅未支付未发货且无捕获保护的订单 |
| `cancel_zero_value_order_item` | `order_id`、`order_item_id`、正整数 `quantity`、`idempotency_key`、可选 `reason`；已结算订单的零对价未发货行取消 |
| `get_order_ledger` | `order_id`；安全交易账本 DTO，退款含金额组成 |
| `get_order_pricing` | `order_id`；客户本人/admin/service 可读的价格、优惠、税与配送快照 |
| `get_order_fulfillment_balance` | `order_id`；每行订购/履约/取消/退款预留/可履约数量，及订单级 `payment_hold` |
| `update_order_address` | 遗留入口；当前客户订单均有 Quote 快照，拒绝原地改址，须取消后重新结账 |

查询限制订单/Quote 归属，部分接口另允许管理员。所有客户订单自建单起冻结商业快照，不可原地改价或改地址，支付失败也不解除快照保护。

零对价取消允许订单本人/admin/service 调用，只接受 open、已结算订单中 `line_total=0` 且税额为零的商品行；数量不能占用已履约或退款请求预留部分。订单范围内同键同参数返回原取消事实 DTO（`id/order_id/order_item_id/quantity/restocked_quantity/created_at`），异参拒绝；reason 最多 2000 字符。依据原始扣库事实回库，不创建零金额 capture/refund。零总额订单全部商品取消后状态为 cancelled，financial_status 保持 paid；混合履约/取消覆盖全部商品时正常完成。

关联订单的渠道资金存在 `action_required` 时，`payment_hold=true`，可履约数量显示为零；新增履约和 pending → shipped 都被拒绝。暂停由资金对账状态推导，没有面向客户的解除开关。

## 商业行身份

所有计价、报价和便捷建单入口共用以下 `items` 合同：

```json
[
  {"variant_id":"<同一个 SKU 的 uuid>","quantity":1,"attributes":{"engraving":"Alice"}},
  {"variant_id":"<同一个 SKU 的 uuid>","quantity":1,"attributes":{"engraving":"Bob"}}
]
```

- `attributes` 可省略，默认为 `{}`；必须是文本值对象，最多 20 个键、键长 1–64 字符且非空白、值长至多 500 字符，JSON 文本总长至多 8192 UTF-8 字节。
- 相同变体和完全相同属性才合并数量；属性键顺序、UUID 大小写及输入重排不改变结果。文本大小写、空格仍有意义，不自动改写定制内容。
- `line_key` 由服务器按变体/属性计算，与数量无关；响应会返回它，重传时必须匹配。其他未声明字段拒绝，不能提交自定价格、目录 `options` 或尚未实现的购买计划。
- 预览返回 `line_key` / `attributes`；Quote 另返回独立行 `id`，所有建单入口均沿用为 `order_items.id`。履约和退款继续传 `order_item_id`，不能用 SKU 代替行 ID。
- 库存按变体/仓库汇总；优惠先按变体确定，再按商业行分摊，不能通过添加属性放大促销收益。

订单明细可查询 `/rest/v1/order_items?order_id=eq.<uuid>&select=id,line_key,variant_id,attributes,quantity,line_total`。
属性是不可变交易快照中的客户文本，不是服务端授权指令；前端显示时必须转义，不应包含密钥或不必要的个人信息。终态 Quote 的地址/备注清理不包含行属性。
这些属性只是商业文本配置，不包含收费定制、订阅或套装；Cart 与交易快照的生命周期不同。

## 价格明细与税务依据

预览、Quote 和 `get_order_pricing` 使用相同的金额口径：

- `lines[].discount_allocations[]`：`promotion_id`、`label`、`amount`，合计等于该商业行 `discount_total`。
- `promotions[].snapshot`：实际使用的规则类型、参数、优先级、目标和 `application_index`；不是指向可变规则的实时视图。
- `shipping_line`：当前最多一条，含毛运费 `gross_amount`、减免 `discount_total`、配送政策减免 `threshold_discount`、净运费 `total`，以及政策、优惠分摊和税明细。免邮仍保存原收费与减免；满额包邮不虚构促销。
- 商品行和配送行的 `tax_lines[]`：规则 ID、名称、适用国家/`*`、比例 `rate`、折后计税基数 `taxable_amount`、税额 `amount`。订单明细另有稳定 `id`，退款组件引用它。
- `tax_context`：`not_calculated`（无目的地预览）、`no_rule`（无匹配规则）、`calculated`（包括显式零税率），保存目的地、实际规则与算法 `country_rate_variant_line_v1`。`unrecorded` 仅供无税额的受信订单构建，不是免税证明。

税先按 SKU/配送、再按商业行进行整数分最大余数分配，合计等于折后应税基数乘单一税率的舍入结果。拆属性不能改变 SKU 税额。当前不支持多税种、含税价格、州/邮编税、免税证书或税务发票。
商品净额 + 净运费 + 税 = 订单总额；促销免邮收益不重复计入商品折扣。被订单明细引用的税率、运法、促销应停用，不可删除；修改配置不会改写订单快照。未付款改地址须取消后重新结账，新 Quote 重新计算目的地税、优惠与运费。

## 支付与退款

SSG 页面、游客会话、PayPal 返回页及错误重试见 [Storefront PayPal 接入合同](storefront-paypal.md)。

支付读取统一使用 `get_order_ledger(order_id)` 的 `transactions`：实收 `kind=capture`，退款 `kind=refund`，返回交易 ID、父交易 ID、意图 ID、金额、币种、状态和渠道引用。仅订单客户、管理员及 service 可读，不返回任意 metadata 或原始 payload。
`/rest/v1/payments` 已移除，`commerce.payment_transactions` 不向 PostgREST 暴露；不可用直写表替代收付款命令。service-only 的 `capture_payment_intent` 仅接收 `payment_intent_id`、`provider_reference`、`idempotency_key`，不再接收 `raw`；生产通过已验证的渠道事件链调用。

| Edge Function | 调用方 | 请求 |
| --- | --- | --- |
| `paypal-client-token` | 客户 | `{}`；卡支付启用时返回 SDK v6 `client_token` 与 `expires_in`，不得静态缓存 |
| `paypal-create-order` | 客户 | `order_id`、`idempotency_key`、可选 `payment_method`（默认 `paypal` 或 `card`）；钱包返回 `approve_url`，卡由 SDK 提交 `provider_reference` |
| `paypal-capture-order` | 客户 | 买家批准后传 `payment_intent_id` |
| `paypal-create-refund` | 管理员 | `order_id`、`idempotency_key`、可选 `items`、`shipping_amount` 或互斥的 `amount`，以及 `restock`、`reason` |

退款示例：

```json
{"order_id":"<uuid>","idempotency_key":"refund-command-id","items":[{"order_item_id":"<uuid>","quantity":1}],"restock":true,"reason":"取消未发货商品"}
```

手工 `refund_order` 与 PayPal 使用同一组成合同：

- `items` 按独立 `order_item_id` / 数量退**商品净额及对应税**。净额仍在 `refund_lines.amount`，税另列组件，不能把两者重复相加。
- `shipping_amount` 是明确选退的**折后运费、不含税**，可单独传或与 `items` 同传；系统另退对应配送税。省略不退运费，免邮没有正运费可退。
- `amount` 与 `items` / `shipping_amount` 互斥，保存为 `unallocated`，不猜税、运费或商品数量；三者全省略表示退当前可退余额，同样是未分配金额。
- 金额必须是有限正 USD、至多两位小数。各净额/税分别按比例舍入并钳制剩余额度，最后一份吸收余数；总额必须大于零且不超过实收可退余额。`restock=true` 必须有商品行，且**只释放本次取消的未发货数量**。已发货部分不会因退款成功自动回库，必须使用下方 Return / Receipt / Disposition。
- `get_order_ledger.refunds[].lines` 的 `cancelled_quantity` 是未发货取消量，`restocked_quantity` 是其中实际释放的库存量；后者不大于前者。退款恢复库存记 `cancel` 流水，不冒充实物退回。
- `get_order_ledger.refunds[].components` 与退款请求 DTO 的 `components` 返回 `tax` / `shipping` / `unallocated`、来源 ID、金额；商品行金额 + 组件金额 = 退款总额。异步成功使用请求时的原分摊，不按最新税率或剩余请求重算。

例如只退 4 USD 净运费，传 `{"order_id":"<uuid>","idempotency_key":"shipping-refund-1","shipping_amount":"4.00"}`；若原配送税为 13%，渠道实际收到的本次退款额为 4.52 USD（未发生余数调整时）。

退款请求被接受不等于渠道退款成功；确认前仅预留可退额度/数量，不回库。已发出的退款即使尚无渠道 ID，也不能无确认取消或释放额度。
PayPal 创建 Order 的客户端幂等键按订单隔离；不同订单可以复用同一个键。支付/退款响应 `pending_reconciliation=true` 也可能表示可重试的本地数据库故障，不能当作已完成交易。
渠道密钥、Webhook 和 Worker 接入见 [支付与部署](../supabase/functions/README.md)。

## Return / Receipt / Disposition

三种事实与资金退款分开：Return 是管理员的退货授权，Receipt 是实际收货，Disposition 是验收后处置。当前每个 Return 对应**一次已 shipped/delivered 的 fulfillment**，通过 `order_item_id` 定位该次发货中的商业行；跨发货退回需多个 Return。客户自助申请/审批、退货面单、换货补发、序列号/批次与退货政策自动判定尚未实现。

| RPC | 权限 | 参数 / 行为 |
| --- | --- | --- |
| `create_return` | admin | `fulfillment_id`、`items:[{order_item_id,quantity}]`、`idempotency_key`、可选 `reason`；创建 open 授权，不改库存/资金 |
| `receive_return` | admin | `return_id`、明确的活跃 `location_id`、`items:[{return_line_id,quantity}]`、`idempotency_key`、可选 `note`；可分批实收，不增加可售库存 |
| `dispose_return_receipt` | admin | `receipt_line_id`、`quantity`、`disposition:"restock"` 或 `"discard"`、`idempotency_key`、可选 `note`；每次处理一条实收行的部分或全部数量 |
| `close_return` | admin | `return_id`、可选 `cancel`（默认 false）；关闭剩余待收量，true 仅允许取消尚无实收的授权 |
| `get_order_returns` | 本人 / admin / service | `order_id`；发货行的可退余额、授权/实收、嵌套收货与处置 DTO |

创建/收货每次接受 1–100 条输入行，只允许相应 ID/正整数 quantity，相同 ID 合并，重排/UUID 大小写不影响指纹；未知字段拒绝。reason 至多 500 字符，note 至多 2000 字符，均为客户可见文本，不应存后台秘密。幂等键 1–200 字符，分别按 fulfillment、Return、receipt line 隔离；相同参数返回同一记录（DTO 可包含后续进展），不同参数拒绝。

```http
POST /rest/v1/rpc/receive_return

{"return_id":"<退货 UUID>","location_id":"<实际收货地点 UUID>","idempotency_key":"receipt-1","items":[{"return_line_id":"<授权行 UUID>","quantity":2}]}
```

收到的商品可以先待验收；`undisposed_quantity` 是实收量减去已处置量。随后分别调用 `dispose_return_receipt`，例如一件 `restock`、一件 `discard`。这不是所有仓库不可售库存的总账；received_at 是本系统记录收货的时间，不接收任意回填时刻。

- 尚无按 Return 自动生成退款的 RPC。既有按商品数量退款仍**优先取消未发货部分**；不能因为创建了 Return 就假定退款会改为“仅退已发货”。若要保留未发货履约量，可另行选择纯金额退款，但它是 unallocated，不推断商品/税的归属。
- 发货可退量 = 有效发货数量 − 所有 Return 实收量 − open Return 尚未实收的授权量。退款数量不占用/释放这个独立余额；已退款、纯金额退款或零价商品仍可依法按店铺政策处理退货。
- 每条授权的累计实收不能超量；每条实收的累计处置不能超量。`restock` 必须有该订单的原始库存扣减事实，增加**实收地点**的可售库存并关联唯一库存流水；不参考变体现在的 track_inventory，也不自动调拨到默认仓（商城结账仍只使用默认仓）。`discard` 不改库存，没有扣减事实的商品不能凭收货新造可售库存。
- 原始扣减覆盖的恢复总量是额外上限。退款只释放未发货取消量，实收处置只处理已发货退回量；先退款/先收货、事件重放或并发不能重复回库。退货、收货、处置从不自动调用退款，也不重算原价/税。
- close 释放未实收授权，保留实收占用；即使尚未验收，也可关闭收货后继续处置已有实收。cancel 只允许无实收时使用。终态不可重开/再收货；新退货仍受剩余可退量限制。
- 存在 open 授权或任何实收的 fulfillment 不可撤销；退回商品不会把原发货改为 cancelled，也不重新赋予发货额度。
- 事实不可删除/改写，仅审计 actor 可单向匿名化。SQLSTATE `55P03` / `40001` / `40P01` 重试整笔事务。事件 `return.open/closed/cancelled/received/disposed` 进入 Outbox，消费者须幂等；数据库保护见 [ADR-018](architecture-decisions.md#adr-018退货授权实际收货处置与资金分离)。

## 地址合同

地址簿及下单/改地址请求共用字段：

- 必填：`recipient_name`、`line1`、`country`（两位国家码，规范化为大写）。不根据 USD、语言或服务器位置推断国家。
- 可选：`line2`、`city`、`region`（州/省/其他行政区）、`postal_code`、`phone`。不强制所有国家采用同一行政区、邮编或电话号码格式。
- 地址簿另有 `label`、`is_default`。配送商和支付渠道可提出额外的地区字段要求。

## 客户与管理员命令

| RPC | 权限 | 主要参数 / 限制 |
| --- | --- | --- |
| `current_customer_id` | 所有角色 | 当前活跃 Customer UUID 或 null |
| `create_customer` | admin / service | 必填 `idempotency_key`；可选 `email`、`full_name`、`phone`；不附带登录权限 |
| `anonymize_customer` | admin / service | `customer_id`；不删除交易历史 |
| `set_default_address` | 地址归属人 / admin / service | `address_id`、`make_default`（默认 true） |
| `create_fulfillment` | admin | `order_id`、`items`、`idempotency_key`、可选物流信息 |
| `update_fulfillment` | admin | `fulfillment_id`、`expected_version`、`changes`、`idempotency_key`；仅状态与物流字段 |
| `adjust_inventory` | admin | 必填 `variant_id`、`delta`、`idempotency_key`；可选 `reason`（默认 adjust）、`note`、`location_id`（默认仓） |
| `transfer_inventory` | admin | 必填 `variant_id`、`from_location_id`、`to_location_id`、`quantity`、`idempotency_key`；可选 `note`；即时原子调拨，见下文 |
| `moderate_review` | admin | `review_id`、`status` |
| `set_user_role` | admin | `user_id`、`role`；最后一名 admin 不可降级 |
| `anonymize_user` | admin | `p_user_id` 为 Auth ID；匿名化关联客户，另清 profile PII 与审计 actor；不是完整账号删除 |

地址内容可直接 PATCH，身份/归属/时间戳不可改；既有地址的默认值必须走 RPC。新建地址仍可传 `is_default=true`。
普通客户创建评价只能为 pending，作者修改内容后重新待审。首次管理员由可信 SQL 引导，后续走角色 RPC。
管理员与客户同属数据库 `authenticated` 角色；订单状态、支付、履约、库存等交易写入必须走受控命令，不能绕过流程直写表。

`create_customer`、`adjust_inventory`、`mark_order_paid` 分别使用独立的店铺级幂等范围，不按管理员隔离。键去除首尾空白后必须为 1–200 字符；同一操作的网络重试必须复用原键及参数，不能每次生成新键。同键并发只提交一次副作用；业务写入与幂等记录同事务提交，失败不占用键。重放仍校验当前权限，并读取资源当前状态，而非返回历史响应快照。

客户创建只规范化邮箱首尾空白及空串，不按邮箱合并客户；匿名化后的重放不会恢复或返回旧 PII。库存首次成功绑定实际仓库，之后默认仓变化不改变重放目标；省略仓库与显式指定仓库是不同请求。手工收款重放可返回已退款订单，不再次记账。这三个命令的键格式错误为 `22023`，同键参数冲突为 `PT409`，权限不足为 `42501`，已绑定资源不存在为 `PT404`；其他业务校验仍遵循各命令原有错误合同。

### 管理员仓库与库存流水查询

以下只读 RPC 仅 admin/service 可用，同时作为同名 MCP 工具。普通客户即使能读取部分仓库底表，也不能调用这组管理员入口。

- `get_admin_location(location_id)`：不存在返回 null，包含停用仓库。DTO 为 `id/code/name/address/is_default/is_active/revision/created_at`，不返回库存。address 为既有 JSON 值，不保证特定地址格式；编辑令牌为 revision，不是 created_at。
- `list_admin_locations(page_size=20, after_id=null, active=null, search=null)`：UUID 升序分页，返回 `{items,next_cursor}`；active 省略包含启用与停用，search 按名称/code 不区分大小写的字面子串搜索，去除首尾普通空格，最多 200 字符，`%/_` 不作通配符。is_default 与 is_active 分开表达；默认仓必须同时启用才用于新结账。
- `list_admin_inventory_movements(page_size=20, after_id=null, variant_id=null, location_id=null, order_id=null, reason_filter=null)`：按流水 bigint ID 倒序返回 `{items,next_cursor}`，筛选按 AND 组合；reason_filter 为 `order/cancel/restock/adjust/return/transfer_out/transfer_in`。每行显式返回 `id/variant_id/location_id/delta/on_hand_after/reason/order_id/actor_id/note/transfer_id/created_at`。actor_id 是可为 null 的 Auth ID，不是客户 ID；note 是不可信商家文本。仅调拨流水带 transfer_id。

两种列表 page_size 为 1–100，末页 next_cursor 为 null，修改筛选应清除游标。流水 id、next_cursor 和 after_id **均为十进制字符串**，不能转 Number；after_id 范围 1–9223372036854775807，不接受符号、空白或前导零。非法分页/筛选为 `22023`。列表不保证跨请求快照；流水 ID 是分配顺序，不是提交顺序，迟提交行可能被翻页跳过，不能用作可靠消费队列。

`on_hand_after` 是该流水记录的历史实物库存，不代表当前可用量；预占及释放未必产生实物流水。当前精确库存与预占仍查 `get_inventory_availability`，不能只加总一页流水。不提供流水修改工具。

### 即时库存调拨

`transfer_inventory(variant_id, from_location_id, to_location_id, quantity, idempotency_key, note=null)` 与 `get_inventory_transfer(transfer_id)` 仅 admin 可调用，均有同名 MCP 工具；写入需开启 MCP 写开关。不跟踪在途、发运或收货状态。

- 每次移动一个跟踪库存的变体，明确指定两个不同且启用的仓库；quantity 为 1–2147483647 整数，note 最多 2000 字符。来源可用量为实物库存减有效预留，不允许挪用预留；不受 allow_backorder 放宽。不迁移预留、不切换默认仓。
- 同一事务锁定仓库与库存行，扣来源、加目标，创建共用 transfer_id 的 `transfer_out` / `transfer_in` 两条不可变流水；数据库延迟约束保证同变体、不同仓库、数量守恒。目标没有库存行时自动创建；任何失败全部回滚。
- 幂等键使用独立的店铺级 `inventory.transfer` 范围，不按管理员隔离；数据库去除首尾普通空格后要求 1–200 字符。同键同参数返回原调拨事实，同键改参数为 `PT409`，失败不占用键。重放仍校验当前权限，不因后续停用仓库或库存变化重复执行。actor 匿名化后返回 null，不恢复旧身份。
- 两个 RPC 返回 `{id,variant_id,from_location_id,to_location_id,quantity,from_on_hand_after,to_on_hand_after,out_movement_id,in_movement_id,actor_id,note,created_at}`；流水 ID 为字符串，两个余额是调拨当时的历史值。查询不存在返回 null；列表通过库存流水筛选调出或调入后取得 transfer_id。
- 非法参数/非跟踪变体为 `22023`，变体不存在为 `PT404`，仓库不存在/停用、可用量不足或幂等冲突为 `PT409`，整数溢出为 `22003`，权限不足为 `42501`。调拨要求 PostgREST 默认的 `READ COMMITTED`；直接 SQL 使用其他隔离级别拒绝为 `25001`，避免等待锁后仍读取陈旧预留快照。
- 不提供撤销或修改调拨。需要移回时，经确认后创建反向调拨，重新校验当前可用量；不能删除原始流水。网络结果不明时保留原键和全部参数，重试原请求，不生成新键。

### 管理员仓库命令

以下 RPC 仅 admin/service 可用，同名 MCP 工具需启用写开关；均返回目标仓库 DTO。

| RPC | 参数与合同 |
| --- | --- |
| `create_location` | `location_id, changes`；保留调用方 UUID，必填字符串 code/name，默认启用、非默认仓，不创建库存 |
| `update_location` | `location_id, expected_revision, changes`；修改 code/name/address/is_active |
| `set_default_location` | `location_id, expected_revision, expected_default_id`；目标必须已启用；expected_default_id 是读取时启用中的默认仓 ID，省略/null 表示断言当前没有启用中的默认仓 |

PATCH 仅允许上述四个字段，省略保留；address 接受既有任意 JSON，null 清空；code/name 不可 null 或全普通空格，不自动 trim；is_active 必须 boolean。JSONB 文本最多 256 KiB。不能设置 ID、created_at、revision 或 is_default。revision 由触发器维护，旧的直接表写入同样推进版本，不能伪造；无变化 PATCH 不推进版本。创建可能因附加字段初始化推进版本，客户端以返回值为准。

切换默认仓在单事务清除其他仓库（包括停用仓）的默认标记并设置目标。启用中的默认仓不能经 update_location 停用，需先切换；重新启用带有历史默认标记的仓库会清除该标记，不隐式恢复默认。唯一索引仍只限制最多一个**启用中的**默认仓；旧的表接口权限不在本次收紧，上述命令保护不等于禁止管理员经旧表接口清空默认仓。

仓库配置命令先取得 `SHARE ROW EXCLUSIVE NOWAIT` 表锁，再取行锁，和旧的直接表写入串行，普通查询不被表锁阻塞。这适用于低频配置，不是并行批量仓库编辑接口。锁冲突为 `55P03`，旧版本或旧默认选择为 `PT409`，不存在为 `PT404`，非法 PATCH 为 `22023`，重复 UUID/code 为 `23505`；旧事务快照可能为 `40001`。失败整体回滚，不自动重试或替换预期值。

创建不是 upsert，命令不缓存历史响应，结果未知先读取原 UUID 和当前默认选择。切换/停用不搬库存、不重写历史订单或既有预占，也不清理库存流水；切换影响后续默认仓解析，原预占/订单继续使用其记录的仓库。不提供仓库删除工具，引用中的仓库应停用而不是强删。

## 管理员配送方式管理

以下 RPC 仅 admin/service 可调用，均有同名 MCP 工具；MCP 只使用管理员用户 JWT，写命令须启用写开关。

| RPC | 参数与返回 |
| --- | --- |
| `get_admin_shipping_method` | `shipping_method_id`；返回当前配置 DTO，包含停用方式，不存在为 null |
| `list_admin_shipping_methods` | `page_size=20, after_id=null, active=null, country=null, search=null`；返回 `{items,next_cursor}` |
| `create_shipping_method` | `shipping_method_id, changes`；必填 name 和显式 price，默认停用、不限国家、无免邮门槛；可显式 is_active=true 原子发布 |
| `update_shipping_method` | `shipping_method_id, expected_revision, changes`；版本化原子 PATCH，返回最新 DTO |

DTO 为 `id/revision/name/description/countries/price/free_above/estimated_days/position/is_active/created_at/updated_at`。列表按 UUID 升序，**不是 position 展示顺序**；页大小 1–100，末页游标 null。active 省略时包含停用方式；country 规范化后匹配指定国家或空 countries；search 为名称的不区分大小写字面子串，去除首尾普通空格，最多 200 字符，`%/_` 不是通配符。筛选以 AND 组合，无精确总数或跨请求快照，不替代实际结账报价。

changes 只允许 name/description/countries/price/free_above/estimated_days/position/is_active，序列化 JSON 最大 256 KiB。省略字段保持不变，name 不可仅为空格。countries 必须为字符串数组，替换整个范围；代码去空格转大写并校验两个英文字母，不校验真实承运商服务范围。**`countries:[]` 表示不限国家，不是停用；null 拒绝**。price/free_above 必须为非负 USD JSON 数字，最多两位小数且不大于 9999999999.99，不接受字符串或自动舍入；只有 free_above 可以为 null。position 为 int32；description/estimated_days 是商家文本，不是承运商时效承诺。

`free_above:null` 移除门槛，0 对非负商品净额均免运费；结账按**商品小计减商品优惠**达到门槛（含等号）时免邮，不含运费与税。例如商品 22.50、优惠 3.01，门槛 19.50 时仍收费，19.49 时免邮。配置变更不重写已创建订单的收费快照；旧 Quote 转单仍校验当前定价，变化时须重新报价。订单改地址仍受现有目的地校验规则约束。

revision 由 trigger 在每次实际表 UPDATE 时推进，旧 SPA/service 直写也不可伪造；创建时使用返回的版本，不假定固定值。命令空 PATCH 或完全相同值不 UPDATE。使用行级 `FOR NO KEY UPDATE NOWAIT`，缺失为 `PT404`，过期版本为 `PT409`，锁竞争为 `55P03`，旧事务快照可能为 `40001`；非法字段/金额为 `22023`，重复 UUID 为 `23505`。任何失败整笔回滚。创建不是 upsert，不缓存历史响应；结果不明先读取原 UUID，冲突后须重新读取并确认意图，不自动替换版本。没有删除、承运商 API、面单购买或历史订单重定价工具。

## 管理员税率配置

以下 RPC 仅 admin/service 可调用，均有同名 MCP 工具；MCP 使用管理员 JWT，写操作须启用写开关。

| RPC | 参数与返回 |
| --- | --- |
| `get_admin_tax_rate` | `tax_rate_id`；返回当前 DTO，包含停用规则，不存在为 null |
| `list_admin_tax_rates` | `page_size=20, after_id=null, active=null, country=null, search=null`；返回 `{items,next_cursor}` |
| `create_tax_rate` | `tax_rate_id, changes`；必须显式提供 name/country/rate，默认停用、不对运费计税；显式 is_active=true 可原子发布 |
| `update_tax_rate` | `tax_rate_id, expected_revision, changes`；原子 PATCH，返回最新 DTO |

DTO 为 `id/revision/name/country/rate/include_shipping/is_active/created_at`。列表按 UUID 升序，页大小 1–100，末页游标 null，无精确总数或跨请求快照。active 省略包含停用规则；country 去空格转大写后**精确匹配**，JP 不包含 `*` 兜底规则，查询兜底需显式传 `*`；这是配置查询，不是目的地税额预览。search 为名称不区分大小写的字面子串，去首尾普通空格，最多 200 字符；各筛选以 AND 组合。

changes 只允许 name/country/rate/include_shipping/is_active，最大 256 KiB；省略不变，所有字段拒绝 null，name 不可仅为空格。country 为两个英文字母或 `*`，不验证税务管辖合法性。**rate 为 0–1 的比例而不是百分数：0.13 表示 13%**；最多四位小数，拒绝字符串、越界及超精度输入，不静默舍入。include_shipping 表示对折后净运费计税。

现有唯一索引保证同一国家（包括 `*`）最多一条启用规则；国家专属规则优先于兜底，不叠加。启用的零税率仍是已匹配规则，覆盖兜底；停用国家规则可能启用兜底，不等于免税。无规则时 tax_context 为 no_rule，显式零税率为 calculated。配置修改不改写既有订单的税额与规则快照；旧 Quote 转单仍校验当前定价。这里只管理既有单一国家税率模型，不支持复合税、含税价格、州/邮编规则、免税证明或税务合规判断。

每次实际表 UPDATE 由 trigger 推进 revision，旧 SPA/service 直写不能伪造版本。空 PATCH 或规范化后相同的值不 UPDATE；使用创建返回的版本，不假定固定值。行锁采用 `FOR NO KEY UPDATE NOWAIT`；缺失为 `PT404`，旧版本为 `PT409`，行锁竞争为 `55P03`，旧事务快照可能为 `40001`，无效 PATCH 为 `22023`，重复 UUID/启用国家冲突为 `23505`。唯一索引竞争仍可能等待；所有失败整笔回滚。不提供删除或跨规则原子替换工具；修改现有启用规则可避免先停后启的空窗。结果不明先读取原 UUID，不能换 UUID 重建或自动替换版本。

## 促销范围与扩展字段管理

### 管理员促销查询

以下 RPC 仅 admin/service 可调用，均接入同名只读 MCP 工具；不修改规则或用量，不代表当前购物车的优惠资格，也不代替订单定价快照。

| RPC | 参数与返回 |
| --- | --- |
| `get_admin_promotion` | `promotion_id`；返回当前规则 DTO，不存在返回 null，包含停用/未开始/过期规则 |
| `list_admin_promotions` | `page_size=20, after_id=null, active=null, type_filter=null, code_only=null, search=null`；返回规则 DTO 分页 |
| `list_admin_promotion_targets` | 必填 `promotion_id`；可选 `page_size=20, after_id=null, role_filter=null`，role 为 apply/get；返回配置目标分页 |
| `list_admin_discount_redemptions` | 必填 `promotion_id`；可选 `page_size=20, after_id=null, customer_id=null, order_id=null`；返回当前优惠码占用分页 |

三个列表均按 UUID 升序返回 `{items,next_cursor}`，page_size 为 1–100，末页 next_cursor 为 null；所有筛选按 AND 组合，无精确总数、无跨请求快照。目标/占用列表在父活动不存在时返回空页，需要区分不存在与空集合时另查详情。非法分页/筛选和 null 父 ID 为 `22023`，非管理员为 `42501`。

规则 DTO 字段为 `id/revision/name/code/type/params/priority/stackable/apply_scope/get_scope/usage_limit/used_count/per_customer_limit/starts_at/ends_at/is_active/created_at/updated_at`。type_filter 接受 `order_percentage/order_fixed/item_percentage/buy_x_get_y/free_shipping`。active 仅筛选存储的启用标记，不自动计算时间、名额或购物车资格；code_only=true 为优惠码，false 为自动促销，省略包含两者。search 是名称/码的不区分大小写字面子串，去除首尾普通空格，最多 200 字符，`%/_` 不是通配符。params 与名称为不可信商家数据。

目标 DTO 为 `id/promotion_id/role/product_id/category_id/variant_id`，三种引用恰好一个非 null；详情不内嵌无界目标数组，须单独翻页。这里返回配置引用，不展开商品、分类后代或有效购物车匹配结果，不能只凭一页目标推断整体范围。

占用 DTO 为 `id/promotion_id/customer_id/order_id/created_at`，不附带客户 PII；customer_id 是 Customer ID，不是 Auth ID。**used_count 包含自动促销和优惠码的订单占用，但 discount_redemptions 只记录优惠码，且可能在付款前产生、在取消/过期后删除。** 它不是已付款销售报表或不可变历史；历史规则、分摊与金额应读取订单定价/账本。读取不保留占用、不改变资格。

### 管理员促销原子命令

`create_promotion(promotion_id, changes)` 与 `update_promotion(promotion_id, expected_revision, changes)` 仅 admin/service 可调用，同名 MCP 写工具需显式开启；均返回最新规则 DTO，目标另行分页查询。使用既有五类规则，不新增优惠算法或条件 DSL。

- 创建保留调用方 UUID，必填 name/type/params，**默认停用**；明确传 `is_active:true` 可在规则及目标完整保存后原子发布。创建不是 upsert，重复 UUID 为 `23505`。不提供删除，引用中的规则应停用；历史订单快照不重写。
- changes 白名单为 `name/code/type/params/priority/stackable/apply_scope/get_scope/usage_limit/per_customer_limit/starts_at/ends_at/is_active/targets`，整体 JSON 文本最多 256 KiB。省略字段保持原值；code/usage_limit/starts_at/ends_at 的 null 清空字段，其他字段不接受 null。规则参数 params 是**整体替换的对象**，不做深层合并；传 type 必须同时传完整 params。百分比、买赠数量等仍由原有数据库验证器校验；未知参数并不自动成为新条件。
- targets 省略保留全部关联；数组为**两个角色的完整替换**，最多 100 条。每条仅允许 role（必填 apply/get）及 product_id/category_id/variant_id，引用恰好一个非 null；不传关联 id，成功替换会重新生成它们。重复关联或无效 FK 导致整个请求回滚，包括规则、目标和版本。
- 提供非空角色目标会自动将其范围收窄为 selected；若同时显式指定冲突的 all/same_as_apply，拒绝为 `22023`。`targets:[]` 清空目标但保留范围，selected/empty 不会自动变全店；恢复范围须显式传 scope。删除目标、修改范围及加入新目标在同一事务内完成，没有中途公开全店规则的窗口。
- revision 由触发器维护，不可伪造；旧表更新、关联增删改、结账占用/释放均推进版本，一次聚合编辑可能推进多次。编辑必须传回读到的 revision，冲突 `PT409`，不存在 `PT404`，父行正在修改则 `55P03`，旧事务快照可能 `40001`。不能用 updated_at 替代版本。空 patch 不写库；提供 targets 即执行替换，不保证 no-op。
- 替换前读取规则和**所有目标页**，再读规则确认 revision 未变；不能用第一页覆盖完整集合。大于 100 条的既有集合仍可修改元数据，但本命令不支持保留超过 100 条的整组替换，不应截断后提交。
- 不接受 used_count/id/revision/时间戳等托管字段，不重置占用记录；usage_limit 不能降至已占用量以下。权限不足为 `42501`，非法输入为 `22023` 或原有类型/规则/数据库约束错误。与结账共用父行锁；报价转单若发现规则变化仍拒绝旧报价，不能自动接受新的价格。
- 结果未知时先按原 UUID 读取规则与目标，保留原参数和版本；不能换 UUID 重建、自动替换过期版本或假定相同调用幂等成功。

### 范围与扩展字段规则

商品百分比及买赠的 `promotions.apply_scope` 为 `all`（默认）或 `selected`；买赠的 `get_scope` 为 `same_as_apply`（默认）或 `selected`。定向活动应以 selected 或 inactive 创建，再配置目标，避免先公开全店优惠。INSERT `promotion_targets` 自动将对应范围收窄为 selected，删除最后一条仍匹配零商品；扩大范围须先删除对应目标，再显式 PATCH scope。规则、范围与目标一起进入交易快照。整单百分比/固定金额与免邮仍按原有整单语义执行，不借此改变算法或增加条件 DSL。

买赠购买与赠送单位互斥，属性拆行不改变收益；集合重叠与赠品选择算法见 [ADR-005](architecture-decisions.md#adr-005促销计算)。

`metafields` 继续写 owner_type / owner_id / type / value，未知类型拒绝；任意 JSON 使用 `type:"json"`。响应中的 `owner_*_id` 是不可直写的生成 FK 路由；商品、变体、分类删除会级联清理其 metafields。Customer/Order 不可删除及匿名化的既有合同不变。

同一 owner_type/namespace/key 的定义和值并发修改可能返回 `55P03` / `40001`；重试整个编辑请求，不只重试其中某条 SQL。无定义的值仍允许写入且默认私有，新建定义也必须与既有值类型一致。

`metafield_definitions.access` 默认 `admin`：

- `admin`：仅管理员/service 可读定义及其值。未建立定义的值也只在管理端可见。
- `public`：仅适用于 product/variant/category/shop；产品、变体、分类仍须满足原发布/启用条件。
- `customer`：仅适用于 customer/order；有活跃 Customer 的账号可读定义，值仍仅归属客户及管理员/service 可读，不向其他客户公开。

`metaobject_definitions.access` 为 `admin`（默认）或 `public`。公开条目还要求自身 active、定义 is_active；修改/删除定义的可见性会在后续查询中立即生效。公开/客户可见的类型化 Metaobject 引用仅在全部目标条目及定义均可公开读取时返回；任一目标私有、停用、草稿或不存在，整个引用字段隐藏，管理员仍可读取修复。任意 JSON/文本不是权限语言，不自动发现或删除其中的敏感内容。

这些规则同时约束底表 RLS 与新 Storefront DTO，不能用旧接口绕过；字段可见性仅管理员/service 可配置。seed 的洗护/材质/尺码表/重量显式公开，礼品留言显式为 customer；其他新增定义不得依赖旧的默认公开行为。

## 便捷下单与手工命令

以下命令各只有一个公开签名，不保留版本后缀或非幂等重载；需要先展示报价再确认下单时采用上面的 Quote 流程。

- `create_order`：必填 `items`、`idempotency_key`，地址等参数与 Quote 一致。单事务创建并转换 15 分钟 Quote，返回订单 DTO；这是当前客户下单入口，不是管理员代客下单接口。付款、零元及过期语义与 [推荐结账流程](#推荐结账流程) 相同，库存定义见 [ADR-024](architecture-decisions.md#adr-024单一下单管线与简化库存语义)。
- 下单重试返回原订单当前状态，不新建 Quote、不延长期限。其幂等范围与显式报价独立；取消/过期后同键重试仍返回原订单，需要重新结账时使用新键。
- `create_fulfillment`：必填 `order_id`、`items`、`idempotency_key`；所有订单均须先付款，创建即 shipped，返回含 `version` 的履约 DTO，行明细通过订单详情或账本读取。
- `update_fulfillment`：必填 `fulfillment_id`、`expected_version`、`changes`、`idempotency_key`；更新状态和物流信息，返回当前履约 DTO。详细合同见下文。
- `mark_order_paid`：必填 `order_id`、`idempotency_key`，可选 `provider`（默认 manual）、`provider_ref`；仅手工收款记账，即使 provider 填 paypal 也不发起渠道 Capture，线上意图仍可扣款时禁止使用。
- `refund_order`：必填 `order_id`、`idempotency_key`；同步手工/测试退款，不代表真实渠道已退款；不能穿透活跃异步退款请求。

上述命令的 `idempotency_key` 去除首尾空白后必须为 1–200 字符。一次业务操作生成一个键，网络重试复用原键；相同键配不同请求指纹会报错。下单按客户隔离，履约、手工收款和手工退款各使用独立店铺级命令范围；不同管理员重试同一操作应复用同一键。不要在每次网络重试时生成新键。

`update_order_address` 不能修改正常 Quote 转单的地址快照；未付款改址需要取消并重新结账。RPC 位于 public schema 不代表管理员或匿名用户都有执行权限，客户端必须同时遵循授权与业务状态限制。

金额口径：`order_items.total` 为毛额，`line_total` 为扣行折扣后的净额；`orders.discount_total` 只含商品折扣。
免邮收益记录于促销应用与配送分摊中，`shipping_total` 为减免后的运费；`payment_transactions.amount` 恒正，方向由 `kind` 表达。退款不等于退货收货：退款 `restock` 仅释放未发货取消量，已发货商品由实际收货后的 disposition 驱动回库。

### 履约状态与物流更新

`update_fulfillment` 仅允许管理员调用，不开放履约表直写权限。先读取创建响应、`get_order_ledger` 中的履约 DTO 或履约表的 `version`，再将其作为 `expected_version` 提交。

```json
{
  "fulfillment_id": "<fulfillment UUID>",
  "expected_version": 1,
  "changes": { "carrier": "Example carrier", "tracking_number": "TRACK-123", "tracking_url": null },
  "idempotency_key": "<one key per operation>"
}
```

- `changes` 必须是非空对象，只允许 `status`、`carrier`、`tracking_number`、`tracking_url`；省略字段不变，只有 `tracking_url` 可传 null 清空，其余字段必须为字符串。商品行、订单归属、时间戳和版本不可由该命令写入。
- 状态沿用现有状态机：pending → shipped/cancelled，shipped → delivered/cancelled；delivered/cancelled 不可回退。创建入口仍直接 shipped，不新增 pending 创建流程。终态允许修正物流信息。
- 取消履约只重算订单履约状态，不退款、不自动回库。存在活跃退货授权、收货事实、商品行退款或活跃退款请求时，仍受原有取消保护约束；实际退货入库走 Return/Receipt/Disposition。
- 每次实际 UPDATE 由数据库推进版本，service 直写也不例外；命令无变化时不 UPDATE、不递增版本、不发事件。版本冲突返回 `PT409`，应重新读取并确认修改意图，不能自动换版本覆盖。
- service 直接修改状态或物流时，trigger 以 NOWAIT 获取父订单锁，避免与管理员命令反向等待；竞争返回 `55P03`，调用方应重试整个事务，失败不会留下版本或审计变化。
- 店铺级 `fulfillment.update` 幂等范围独立于创建；同键参数冲突为 `PT409`。成功重放先校验权限，返回资源当前状态，不再校验旧版本、不重复写入。失败不占键；网络结果不明时必须复用原键、原版本和原参数。
- 无效键、版本或字段形状返回 `22023`，资源不存在为 `PT404`，非管理员为 `42501`；状态机、退货与退款限制沿用原业务错误。状态事件与 `fulfillment_tracking_updated`（含修改前后物流字段、actor、版本）和 Outbox 在同一事务提交。物流 URL 是外部输入，不表示服务端已验证或抓取该地址。

## 管理员运维查询与恢复

以下查询使用管理员 JWT，不开放 commerce 表权限，也不授予 Worker 能力。非管理员返回 `42501`；页大小为 1–100，默认 20，无效页大小或状态为 `22023`。

| RPC | 筛选与分页 | 返回 |
| --- | --- | --- |
| `list_admin_outbox_events` | `page_size`、`status_filter`（pending/processing/published/failed/exhausted）、可选 `aggregate_id`、`after_id`（text，正 bigint 字符串；无效或越界为 `22023`） | `{items,next_after_id}`；按内部 id 降序；id 和下一页游标为十进制字符串，原样传回，不经 JS Number 转换 |
| `list_admin_payment_provider_events` | `page_size`、`status_filter`（received/processed/ignored/failed）、可选 `resource_id`、`after_cursor` | `{items,next_cursor}`；按 created_at/id 降序；游标为 `{created_at,id}` |

游标为 null 表示末页。翻页需保持筛选条件；状态可能在两次请求间变化，这不是跨请求快照。监控刷新应从首页开始，不把分页游标当作增量消费 checkpoint。`resource_id` 是 Inbox 已关联的意图、交易、退款请求或外部资金记录 ID，不是订单 ID；尚未关联事件须不带此筛选查询。

两类 DTO 仅返回事件身份、状态、累计尝试次数、处理时间和关联 ID；错误只给 `has_error`，不返回原始错误文本。Outbox 另含 retry_start、租约到期时间及最近重投审计，不返回 payload、幂等键、当前 worker 或 lease_token；Inbox 不返回 data、payload_hash、object_reference，`automatic_retry_exhausted` 仅在未终结且 attempts ≥ 25 时为 true。诊断原始内容仍须使用受信运维流程。

管理员调用 `redrive_outbox_event` 时传 `event_id`、`expected_attempt`、`reason`，省略 `worker_id`。数据库将审计操作者设为 `admin:<Auth UUID>`，拒绝客户端指定身份；service 调用保持原合同，必须提供 worker_id。reason 去空白后为 1–4000 字符，不要放凭据或客户 PII。

只允许在当前 exhausted 且累计 attempts 等于 expected_attempt 时开启新 25 次重试窗口。资源不存在或状态／次数不匹配返回 false；相同事件、耗尽次数、操作者及原因的成功重放返回 true，不重置后续 processing/published 状态。不同管理员或原因不能冒充同一次重放；每次调用重新验证权限。此操作只重新入队，不表示消息已成功投递。

`claim_outbox_events`、`complete_outbox_event`、`retry_payment_provider_events` 和 `ingest_payment_provider_event` 仍为 service-only。Inbox 只开放查询，不提供管理员重跑资金记账入口；恢复步骤见 [支付运维](../supabase/functions/README.md#outbox-与-inbox-恢复)。
