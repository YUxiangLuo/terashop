# Tera Admin

独立的 Svelte 5 / SvelteKit CSR 管理端，与 [Storefront](../storefront/README.md) 共用 Bun workspace、lockfile 和依赖安装。根 layout 关闭 SSR/prerender，adapter-static 输出 SPA fallback。没有服务端路由，也不新增 Edge Function。

## 本地运行

先按根目录 [快速开始](../README.md#快速开始) 安装依赖并初始化可丢弃的本地 Supabase。已有开发环境需要重新 `bun run setup` 才会应用管理员 Storage 策略；这会清空本地数据库。

```bash
bun run admin:dev       # http://127.0.0.1:5174
bun run admin:check     # 不需要数据库
bun run admin:build
bun run admin:preview   # http://127.0.0.1:4175
```

开发/预览只监听回环地址。端口冲突时以终端输出为准。`PUBLIC_SUPABASE_URL` 与 `PUBLIC_SUPABASE_ANON_KEY` 均未设置时自动读取本项目本地服务；远程构建必须同时提供两个公开变量。可用 `bun --env-file=.env scripts/frontend.ts admin build` 读取根环境文件，变量会写入浏览器产物；绝不使用 service-role、S3 secret 或 PayPal secret。

## 第一个管理员

不提供默认密码、自动提升角色或公开管理员注册。对于可丢弃的本地环境：

1. 在本地 Studio `http://127.0.0.1:54323` 的 Authentication 用户管理中创建一个邮箱/密码用户，确认该用户邮箱；只对本地测试账号使用人工确认。
2. 复制该用户的 Auth UUID，在本地 Studio SQL 编辑器执行以下操作（替换占位值）：

```sql
update public.profiles set role = 'admin' where id = '<AUTH_USER_UUID>'::uuid;
```

3. 在 Admin 登录。后续管理员角色管理使用现有 `set_user_role` 合同，不接受客户端 user_metadata 声明的角色。

生产账号必须由受信任运维按身份验证流程创建并授权，不照搬本地人工确认步骤。上线前需要补齐管理员 MFA、密码恢复和相应 Auth 配置。reset 后账号也会消失，需要重新初始化。

## MVP 范围

- 邮箱密码登录、会话恢复、退出；不同于 Storefront 的独立会话存储 key。通过 `is_admin()` 验证数据库角色后才挂载管理页面，后端仍独立验证每个 RPC/Storage 请求。刷新 token、窗口重新聚焦时重新检查权限。
- 商品列表通过 `list_admin_products` 搜索名称/SKU、筛选状态、按服务端游标加载更多；编辑时重新读取详情。
- 创建和编辑商品名称、slug、描述、vendor、product type，以及图片 alt、排序、关联删除；支持 draft / active / archived 切换，发布或撤回前要求确认。
- 商品规格支持选项/值的增删改、逐变体组合选择，以及按指定 USD 价格生成缺失组合（最多 500 个变体）。已有变体 ID、SKU、价格不被重新生成，停用组合也不自动重新启用；可编辑 SKU、价格、启停与库存跟踪。删除选项/值会清除对应组合选择，发布前校验完整性与唯一性。仅新建未保存的变体可移除，已有变体通过停用保留交易历史。
- 图片可关联全部变体或指定变体；分类可搜索、分页选择和取消关联，搜索不丢失已有选择。允许保留/关联停用分类，不提供批量导入或变体永久删除。
- `/categories` 支持按层展开、分页加载的分类树，加载后的同级分类按 position/ID 排列；搜索/状态筛选保存在 URL，筛选结果平铺显示，不隐藏停用父分类下的匹配子分类。支持新建（默认停用）、编辑名称/slug/描述/图片 URL、父分类、同级排序与启停。不提供分类删除。停用不级联停用子分类或商品，不移除商品关联；修改仍需重新构建静态 Storefront。
- 分类保存保留原始 `updated_at` 微秒令牌；循环、冲突或未知结果必须显式重读，不能换令牌覆盖。新建 UUID 保留在 URL，未知创建结果按同一 UUID 核对。父分类搜索/分页不会丢失当前选择。
- 使用 `create_product` / `update_product` 原子保存商品、规格、变体、图片和分类，保留成本、条码及扩展等未编辑字段。更新携带读取时的 revision；冲突或失败不会自动换版本重试。先重新读取并核对保存结果，再编辑。创建 UUID 保留在 URL，刷新仍读取同一商品，不盲目生成新 UUID 重试。
- `/inventory` 提供跨商品名称/SKU 子串搜索、商品分页和选中商品的库存操作，不一次加载全店变体或库存。商品详情下也提供同一库存区：按已保存的 tracked variant 和活跃仓库查询 on_hand / reserved / available，支持正负整数调整及备注，独立于商品保存。先保存或放弃商品编辑，再调整库存。
- 库存流水按当前变体、仓库及原因查询，按原始字符串 ID 分页，支持刷新和订单跳转；调整成功后刷新库存及流水。历史 `on_hand_after` 不是当前可用量，预占/释放未必产生流水。库存页面与商品页面共用同一待决调整记录。不提供调拨或停用仓库流水查询 UI。
- `/locations` 支持仓库名称/编码搜索、启停筛选、分页和 URL 筛选保留；可创建（默认停用）、编辑编码/名称/JSON 地址、启停和切换默认仓库。地址支持保留自定义字段及以 `null` 清空。库存页面重新进入时加载活跃仓库；仓库配置不搬移库存或清除预占，不提供删除。
- 仓库更新携带读取时的 `revision`，切换默认还携带读取时的默认仓库 ID；冲突或未知结果锁定命令，要求显式重读，不自动换版本重试。默认仓库必须先切换才能停用，未保存或停用仓库不能设为默认。新建 UUID 留在 URL，刷新按同一 ID 核对创建结果。
- `/shipping` 支持配送方式名称/状态/目的地国家筛选、UUID 游标分页及 URL 筛选保留。可创建（默认停用）、编辑名称/描述/预计时效、适用国家、USD 运费/免邮门槛、展示排序及启停。列表按 ID 分页，不冒充 position 排序或结账报价。国家留空表示全球适用；代码格式校验不代表承运商覆盖。
- 配送金额最多两位小数，不自动舍入；免邮门槛留空为 `null`（无门槛），0 为始终免邮，按折后商品净额达到门槛（含等号）计算，不含运费和税。活跃配置保存需确认，使用原 `revision`；冲突或未知结果锁定保存，须显式重读，新建 URL 保留同一 UUID。修改可能使旧报价失效，不重写历史订单金额。不提供删除、承运商接入或面单购买。
- `/orders` 按订单、支付和履约状态组合筛选，使用原始字符串订单号游标分页。详情展示历史价格、地址、客户备注和发货记录；内部备注按原值比较保存，支持单独清空。
- 订单详情按后端返回的可履约余额记录部分或全部发货，可填写承运商和跟踪号。确认即记录 shipped，不购买面单、不发送邮件、不修改订单快照；付款未完成或资金对账 hold 时不可发货。不提供退款、支付捕获、订单取消、权限管理或报表 UI。
- 未保存字段只在内存中，离开页面会提示；退出或丢失会话会清除编辑界面。不要把浏览器提示当作持久草稿。创建时先保存商品，再上传图片。

P2：已有发货记录可更新承运商、单号、跟踪链接，已发货记录可确认送达或取消。使用原 version 和持久化幂等键；未知结果只重试原请求，版本冲突须重新读取。取消发货不退款、不回库，不能修改商品或数量。

`/customers` 支持姓名/邮箱/电话搜索、匿名化筛选与游标分页。详情可修改联系方式、查看只读地址和关联订单；匿名化记录只读。更新原样携带 `updated_at`，冲突或结果未知须显式重读。联系方式修改不改变登录账号或历史订单快照；本批不提供客户新建、匿名化、地址写入。

完整 RPC 参数和错误语义见 [API](../docs/api.md#原子商品编辑)。草稿不会出现在公开 API；发布后需重新构建 Storefront SSG 才能更新静态页面。保存不会自动触发远程构建或部署。

### 库存与发货的失败恢复

库存调整、发货创建和发货更新命令先在 `sessionStorage` 保存完整参数及幂等键，按管理员 UUID、操作类型与商品/订单/发货记录隔离；存储失败不发送请求。未知结果保留原请求、锁定新操作，刷新页面后仍可显式重试同一请求，不自动重试或换键。首次明确数据库拒绝允许修正；已未知请求的重试被拒绝不证明原操作失败，仍保留原请求。成功回执通过归属检查后才清除。

操作记录包含库存备注或物流信息，不含 Auth token、客户地址；退出不清除未决记录，供同一管理员恢复。**只保证当前标签页的恢复，不是服务端任务队列或跨标签页去重。** 关闭标签页、清除浏览器数据或换设备后，必须先核对后台事实，不能重新创建同一操作。长期无法恢复的请求需受信运维核查，不直接删记录盲重试。界面显示的库存或发货记录不是外部物流/资金到账证明。

## 图片权限与失败处理

迁移配置 `catalog-media` 为公开读、JPEG/PNG/WebP、最大 5 MiB。管理员使用自己的 Auth 会话直接调用 Storage SDK，新增路径：

```text
products/<product UUID>/<image UUID>.jpg|png|webp
```

UUID 使用小写标准格式。Storage RLS 仅允许管理员在此 bucket 的上述路径 INSERT；不授予 UPDATE/DELETE，`upsert:false`。不限制图片源供应商的数据库 URL 字段仍保持通用。MIME/扩展名限制不等于内容检测或重新编码；不要允许不受信任的用户上传。

上传后将公开 URL 暂存在编辑表单，点击保存才原子写入商品图片关联。上传成功不等于商品保存成功，失败或放弃编辑可能留下孤立对象；界面会提示，网络错误时保留对象路径用于排查，不自动删除。商品图与数据库不在一个事务中。

每次上传使用新 UUID 路径，缓存一年；替换通过上传新图再移除旧关联完成。旧文件保留，由受信任运维在确认无数据库引用且旧 SSG/缓存不再使用后清理。**公开 bucket 内的草稿图片也可凭 URL 访问，不适合保密素材。** 客户和匿名访问者不能写入，管理员也不能修改 bucket 设置。

## 静态部署与验收

发布 `admin/build/`，使用独立 HTTPS 域名的根路径。静态托管必须将 `/` 和未知页面路径回退到 `200.html`（状态 200），已有 JS/CSS 文件正常提供，支持 `/products/<UUID>`、`/orders/<UUID>` 直接打开和刷新。例如 Nginx：

```nginx
location / {
    try_files $uri /200.html;
}
```

构建只写入公开配置，不从数据库预取商品、管理员资料或会话。远程 Supabase 与图片 URL 必须可由浏览器访问，不能发布 localhost 构建。关闭索引的 meta 标记不是访问控制；实际授权依赖 Auth、数据库和 Storage RLS。

分类浏览器回归：启动本地 Supabase 与 Admin 后运行 `bun scripts/admin-categories-smoke.ts`（需要 `agent-browser`；默认访问 `http://127.0.0.1:5174`，可用 `ADMIN_URL` 指定其他本地端口）。脚本验证创建、展开树、父级/状态/排序、URL 筛选、并发冲突锁定与显式重读、移至根级，以及商品分类选择跨搜索保留；只创建并清理本次临时账号和分类，不保存测试商品。桌面、移动端和列表截图写入 `/tmp/admin-category-*.png`。分类数据库回归：`bun run test:current tests/admin-categories.test.ts`。

仓库浏览器回归：相同环境运行 `bun scripts/admin-locations-smoke.ts`，验证创建、JSON 地址校验/保留/清空、启停、旧版本默认切换和编辑拒绝、显式重读及 URL 筛选；只写入并清理临时仓库和账号，不切换现有默认仓库。截图写入 `/tmp/admin-warehouse-*.png`。默认切换成功、并发竞争、权限和分页由 `bun run test:current tests/admin-location-commands.test.ts tests/admin-inventory-reads.test.ts` 覆盖；该数据库测试会临时切换本地默认仓库并恢复选择。

配送浏览器回归：相同环境运行 `bun scripts/admin-shipping-smoke.ts`，验证金额拒绝、创建后原 URL 恢复、0/空免邮门槛、国家筛选及全球范围、启停、冲突锁定与重读；只写入并清理临时账号和配送方式。截图写入 `/tmp/admin-shipping-*.png`。解析单元测试：`bun test tests/unit/admin-shipping.test.ts`；数据库及报价/历史订单合同回归：`bun run test:current tests/admin-shipping-methods.test.ts`。

自动检查：`admin:check`、`admin:build`、`bun test tests/unit/admin-commands.test.ts tests/unit/admin-catalog.test.ts`；数据库回归可运行 `bun run test:current tests/product-edit.test.ts tests/admin-order-operations.test.ts tests/admin-retry.test.ts tests/storage-admin.test.ts`。浏览器验收应包含登录失败、普通客户拒绝、管理员恢复会话、创建/发布/归档、规格组合增删及原 ID 保留、图片上传和变体归属、分类跨搜索保留、库存搜索/流水分页、仓库/变体切换、备注冲突、部分发货、未知写结果刷新后原键重试，以及桌面/移动端与深链接刷新。整个回归套件会写入额外目录数据；恢复演示环境需重新 setup（会清空账号）并构建 Storefront。
