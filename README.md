# tera-headless

基于 Supabase 的 Headless 电商项目。PostgreSQL 承担通用交易逻辑与权限控制，TypeScript Edge Functions 适配 PayPal；`storefront/` 提供女装 SvelteKit SSG 示例，不包含管理后台。

一个 Supabase 项目承载一个店铺，统一使用 **USD**，结账使用默认仓。后端支持游客线上交易；前台目前只实现目录、实时库存、购物袋和库存预占报价，**没有下单或支付 UI，尚未完成真实 PayPal Sandbox 验收**。

## 快速开始

需要 Docker 和 Bun（版本见 `package.json`）。以下命令仅用于可重置的本地开发数据库：

```bash
bun install
bun run start             # API :54321 / Studio :54323 / DB :54322
bun run setup             # 重放迁移 + 演示数据 + 上传 Storage 图片，会清空本地数据库
bun run storefront:dev   # 打开终端显示的前台地址
```

使用 `bun run start` 而非直接调用 Supabase CLI：项目网络将发布端口限制到 `127.0.0.1`，包括含验证邮件的 Mailpit。已有全网卡监听容器须先 `bun run stop` 再启动；不更改系统防火墙。

种子数据为 10 款女装、60 个颜色/尺码变体，不安装默认促销或税率；价格、运费和 AI 图片均为演示内容。测试会写入额外商品，勿将测试后的目录当作纯女装 seed。构建、配置与恢复演示目录见 [Storefront 使用说明](storefront/README.md)。

## 功能与结构

| 模块 | 能力 |
| --- | --- |
| 商品 | 无环分类、规格/图片归属与发布校验、多仓库存数据；当前结账使用默认仓 |
| 购物车与结账 | 持久 Cart、游客限时凭据/登录认领、独立商业行、价格明细快照、Quote 预占与幂等转单 |
| 交易 | 支付、含税部分退款/显式运费退款、履约、关系化账本、Inbox / Outbox |
| 退货 | 发货行退货授权、分批实收、验收回库/报废；与退款独立 |
| 支付渠道 | PayPal Order / Capture；异步退款与对账入口 |
| 客户与内容 | 独立 Customer / 可选 Auth 关联、地址簿、匿名化、评价审核、Metafields / Metaobjects |

```text
storefront/             SvelteKit 静态女装站
supabase/migrations/   六个初始化基线文件；开发期可直接修改并重建
supabase/functions/    支付入口与共享适配代码
supabase/seed.sql      本地演示数据
tests/                 API、handler、金额和数据库并发回归
types/database.ts      自动生成的数据库类型，不手改
```

## 文档入口

- [Storefront](storefront/README.md)：运行、静态部署、当前能力与限制。
- [API 使用参考](docs/api.md)：参数、权限、返回值与调用重试。
- [架构决策](docs/architecture-decisions.md)：金额、库存、权限、支付与退款不变量及演进边界。
- [数据库开发](docs/database.md)：基线文件职责、SQL 检查和历史审阅证据。
- [测试指南](docs/testing.md)：运行/筛选/重跑、夹具清理与覆盖边界。
- [PayPal 前台接入](docs/storefront-paypal.md)：SDK、返回页、支付状态与浏览器恢复。
- [支付与部署](supabase/functions/README.md)：渠道配置、Webhook、必需 Worker 和发布验证。
- [.env.example](.env.example)：环境变量模板，不包含有效凭据。

## 开发检查

```bash
bun run typecheck         # 无数据库的快速检查
bun run storefront:check  # Svelte / 前台类型检查，无需数据库
bun run test:unit         # 支付适配、共享逻辑与测试设施单测；不需要 Supabase
bun run docs:check        # 本地 Markdown 文件链接检查
```

数据库重建、完整测试和类型漂移检查见 [测试指南](docs/testing.md) 与 [数据库开发](docs/database.md)。`setup` / `test` 会清空本项目本地库，只用于可丢弃环境。

项目尚未部署。上线前须配置真实商品、配送与税务，完成身份安全、Worker、告警和渠道验收；未匹配税率得到零税额不代表免税。具体要求见 [支付与部署](supabase/functions/README.md)，不要将本地测试通过视为生产可用。
