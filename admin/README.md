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

## 第一版范围

- 邮箱密码登录、会话恢复、退出；不同于 Storefront 的独立会话存储 key。通过 `is_admin()` 验证数据库角色后才挂载管理页面，后端仍独立验证每个 RPC/Storage 请求。刷新 token、窗口重新聚焦时重新检查权限。
- 商品列表通过 `list_admin_products` 搜索名称/SKU、筛选状态、按服务端游标加载更多；编辑时重新读取详情。
- 创建和编辑草稿的名称、slug、描述、vendor、product type，以及图片 alt、排序、关联删除。在售/归档商品只读，不包含发布、规格、库存、订单、支付或报表 UI。
- 使用 `create_product` / `update_product`，保留未编辑的规格、分类、扩展等资源。更新携带读取时的 revision；冲突或失败不会自动换版本重试。先重新读取并核对保存结果，再编辑。创建 UUID 保留在 URL，刷新仍读取同一商品，不盲目生成新 UUID 重试。
- 未保存字段只在内存中，离开页面会提示；退出或丢失会话会清除编辑界面。不要把浏览器提示当作持久草稿。创建时先保存草稿，再上传图片。

完整 RPC 参数和错误语义见 [API](../docs/api.md#原子商品编辑)。当前草稿不会出现在 Storefront；后续通过完整目录管理流程发布并重新构建 SSG 后才可展示。保存不会自动触发远程构建或部署。

## 图片权限与失败处理

迁移配置 `catalog-media` 为公开读、JPEG/PNG/WebP、最大 5 MiB。管理员使用自己的 Auth 会话直接调用 Storage SDK，新增路径：

```text
products/<product UUID>/<image UUID>.jpg|png|webp
```

UUID 使用小写标准格式。Storage RLS 仅允许管理员在此 bucket 的上述路径 INSERT；不授予 UPDATE/DELETE，`upsert:false`。不限制图片源供应商的数据库 URL 字段仍保持通用。MIME/扩展名限制不等于内容检测或重新编码；不要允许不受信任的用户上传。

上传后将公开 URL 暂存在编辑表单，点击保存才原子写入商品图片关联。上传成功不等于商品保存成功，失败或放弃编辑可能留下孤立对象；界面会提示，网络错误时保留对象路径用于排查，不自动删除。商品图与数据库不在一个事务中。

每次上传使用新 UUID 路径，缓存一年；替换通过上传新图再移除旧关联完成。旧文件保留，由受信任运维在确认无数据库引用且旧 SSG/缓存不再使用后清理。**公开 bucket 内的草稿图片也可凭 URL 访问，不适合保密素材。** 客户和匿名访问者不能写入，管理员也不能修改 bucket 设置。

## 静态部署与验收

发布 `admin/build/`，使用独立 HTTPS 域名的根路径。静态托管必须将 `/` 和未知页面路径回退到 `200.html`（状态 200），已有 JS/CSS 文件正常提供，支持 `/products/<UUID>` 直接打开和刷新。例如 Nginx：

```nginx
location / {
    try_files $uri /200.html;
}
```

构建只写入公开配置，不从数据库预取商品、管理员资料或会话。远程 Supabase 与图片 URL 必须可由浏览器访问，不能发布 localhost 构建。关闭索引的 meta 标记不是访问控制；实际授权依赖 Auth、数据库和 Storage RLS。

自动检查：`admin:check`、`admin:build`、`bun run test:current tests/storage-admin.test.ts`。浏览器验收应包含登录失败、普通客户拒绝、管理员恢复会话、创建草稿、上传/排序/移除图片、保存后刷新、并发冲突和深链接刷新。整个回归套件会写入额外目录数据；恢复演示环境需重新 setup（会清空账号）并构建 Storefront。
