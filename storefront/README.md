# Atelier Tera storefront

女装示例站，使用 Svelte 5、SvelteKit 和 adapter-static。与根项目共用 Bun workspace/lockfile，不复制 node_modules；前端保留兼容 svelte-check 的 TypeScript 5 工具链。后端 schema、RPC 和交易规则保持通用。

在仓库根目录运行：

```bash
bun install
bun run start
bun run setup              # 只用于可丢弃的本地数据库，会清空数据
bun run storefront:dev
bun run storefront:check
bun run storefront:build
bun run storefront:preview
```

构建产物位于 `storefront/build/`，可部署到支持目录 index.html 的静态托管服务。不需要 Node/Bun 服务端，也没有 SPA fallback。开发和构建默认使用本地 Supabase；远程构建须同时提供 `PUBLIC_SUPABASE_URL` 与 `PUBLIC_SUPABASE_ANON_KEY`，仅使用公开 anon key，绝不传入 service-role 或 PayPal secret。生产浏览器须使用 HTTPS。

- 构建时通过公开目录接口枚举商品、分类并预渲染详情；目录变更后重新构建。价格显示为 USD。构建失败不会默默发布空目录。
- 商品页加载及加入购物袋前重新检查公开价格/库存；购物袋只在浏览器保存商品、变体 ID 和数量，不保存可信金额，不与后端 Cart 同步，不跨设备恢复。
- 报价时恢复或创建匿名 Auth 会话，向后端提交变体、数量、地址；由数据库计算运费、税费、总价并预占库存。同一请求的网络重试复用幂等键。
- **目前没有下单、钱包或信用卡支付 UI**。Quote 不代表订单，库存预占有有效期；后台仍需运行到期清理 Worker。后续接入遵循 [支付合同](../docs/storefront-paypal.md)。
- 默认 seed 是 10 款女装、60 个变体；旧目录仅存在测试夹具中。集成测试会安装测试商品，预览前可重置可丢弃的本地库并重新构建。
- `static/images/` 为 Microsoft MAI-Image-2.6 通过 OpenRouter 生成并压缩的商品示意图，非真实商品摄影，每款一张，不随颜色切换。seed 使用 storefront 相对路径；其他客户端可配置对应资源源站，真实商店建议使用自己的 Storage/CDN URL。

上线前仍需补齐真实商品图片与尺码表、配送和税务配置、隐私/退换货政策、CAPTCHA、覆盖直连 RPC 的网关限流、匿名会话与过期预占清理，以及真实 PayPal Sandbox 和支付恢复验收。这是可运行的开发示例，不是可直接收款的生产商店。
