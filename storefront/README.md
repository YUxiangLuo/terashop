# Atelier Tera storefront

女装示例站，使用 Svelte 5、SvelteKit 和 adapter-static。与根项目共用 Bun workspace/lockfile，不复制 node_modules；前端保留兼容 svelte-check 的 TypeScript 5 工具链。后端 schema、RPC 和交易规则保持通用。

## 本地运行与构建

首次安装和初始化见 [快速开始](../README.md#快速开始)。以下命令均在仓库根目录运行：

```bash
bun run storefront:dev     # 长驻开发服务器，停止后再执行下面的命令
bun run storefront:check   # 无需数据库
bun run storefront:build
bun run storefront:preview
```

开发默认端口为 5173，预览默认 4173，冲突时以终端输出为准。当前脚本监听 `0.0.0.0`，不同于仅回环开放的本地 Supabase；不要把开发服务器当作生产部署。

## 公开配置与静态部署

开发和构建在两个公开变量均未设置时自动读取本项目本地 Supabase；只设置其中一个会报错。远程构建在 shell 或 CI 同时设置以下变量（占位值须替换）：

```bash
PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co \
PUBLIC_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY \
bun run storefront:build
```

变量会写入浏览器产物，**绝不使用 service-role key 或 PayPal secret**。模板见 [`.env.example`](../.env.example)；文件本身不配置远程 Edge secrets。使用环境文件时可从根目录运行 `bun --env-file=.env scripts/storefront.ts build`，不要仅在 `storefront/.env` 放置配置并假设根脚本能读取。

发布 `storefront/build/` 到支持目录 `index.html` 的静态托管服务，使用域名根路径和 HTTPS。不需要 Node/Bun 服务端，也没有 SPA fallback。Supabase URL 必须能被买家浏览器访问，不能发布指向开发机 localhost 的构建。目录或公开配置变更后重新构建；个人信息和会话只在浏览器运行时处理，不进入构建或共享缓存。

## 当前能力与演示数据

- 构建时通过公开目录接口枚举商品、分类并预渲染详情；目录变更后重新构建。价格显示为 USD。构建失败不会默默发布空目录。
- 商品页加载及加入购物袋前重新检查公开价格/库存；购物袋只在浏览器保存商品、变体 ID 和数量，不保存可信金额，不与后端 Cart 同步，不跨设备恢复。
- 报价时恢复或创建匿名 Auth 会话，向后端提交变体、数量、地址；由数据库计算运费、税费、总价并预占库存。同一请求的网络重试复用幂等键。
- **目前没有下单、钱包或信用卡支付 UI**。Quote 不代表订单，库存预占有有效期；后台仍需运行到期清理 Worker。后续接入遵循 [支付合同](../docs/storefront-paypal.md)。
- 默认 seed 是 10 款女装、60 个变体；旧目录仅存在测试夹具中。集成测试会安装测试商品，预览前可重置可丢弃的本地库并重新构建。
- `static/images/` 为 Microsoft MAI-Image-2.6 通过 OpenRouter 生成并压缩的商品示意图，非真实商品摄影，每款一张，不随颜色切换。seed 使用 storefront 相对路径；其他客户端可配置对应资源源站，真实商店建议使用自己的 Storage/CDN URL。

需要恢复纯女装目录时，先确认本地数据可丢弃，再运行 `bun run setup && bun run storefront:build`；reset 会清空订单、会话及测试数据，浏览器旧购物袋和登录状态也需清理。

上线前补齐真实商品、尺码表和隐私/退换货政策；配送、税务、身份安全、Worker 与支付验收见 [支付与部署](../supabase/functions/README.md)。这不是可直接收款的生产商店。
