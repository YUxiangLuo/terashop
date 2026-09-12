# tera-headless

基于 Supabase 的 Headless 电商后端。PostgreSQL 承担交易逻辑与权限控制，TypeScript Edge Functions 适配 PayPal；不包含商城前台和管理后台。

面向全球客户的单店后端，统一使用 **USD** 定价和结账，不做多币种或自动换汇。美元不代表美国地址：收货国家必须显式提供，不预设任何国家或税率。当前税务仅支持可配置的国家级比例规则，复杂税务及自动争议/结算对账不在范围内。

## 快速开始

需要 Docker 和 Bun（版本见 `package.json`）。以下命令仅用于可重置的本地开发数据库：

```bash
bun install
bun run start             # API :54321 / Studio :54323 / DB :54322
bun run setup             # 重放迁移 + 演示数据，会清空本地数据库
bun run test:current      # 使用已准备的本地数据库，测试会写入数据
```

种子商品、促销和运费均为 USD 演示配置，不代表真实物流报价；不自动安装税率。上线前必须配置配送范围与适用税务规则，未匹配规则时计算为零并不表示免税。
Google OAuth 默认关闭；启用前必须吊销并轮换历史已暴露的凭据，通过环境变量提供新 Secret。支付配置见 [支付与部署](supabase/functions/README.md)。

## 功能与结构

| 模块 | 能力 |
| --- | --- |
| 商品 | 无环分类、规格/图片归属与发布校验、多仓库存数据；当前结账使用默认仓 |
| 购物车与结账 | 持久 Cart、游客限时凭据/登录认领、独立商业行、价格明细快照、Quote 预占与幂等转单 |
| 交易 | 支付、含税部分退款/显式运费退款、履约、关系化账本、Inbox / Outbox |
| 支付渠道 | PayPal Order / Capture；异步退款与对账入口 |
| 客户与内容 | 独立 Customer / 可选 Auth 关联、地址簿、匿名化、评价审核、Metafields / Metaobjects |

```text
supabase/migrations/   六个初始化基线文件；开发期可直接修改并重建
supabase/functions/    支付入口与共享适配代码
supabase/seed.sql      本地演示数据
tests/                 API、handler、金额和数据库并发回归
types/database.ts      自动生成的数据库类型，不手改
```

Cart 只保存可编辑购买意向，不锁价、不占库存；登录认领后才能转 Quote，当前不开放游客下单/支付，也不按邮箱自动合并客户。游客写入上线前须部署网关限流与过期清理。

`public` 提供业务表/API，`private` 存放内部函数与同步哨兵，`commerce` 保存隐藏的购物车与交易事实。项目尚未部署，不维护历史兼容承诺；`api` / `admin_api` 合同仍在演进。

## 文档入口

- [API 速查](docs/api.md)：目录查询、结账流程、客户与管理命令。
- [架构决策](docs/architecture-decisions.md)：金额、库存、权限、支付与退款不变量及演进边界。
- [数据库开发](docs/database.md)：基线文件职责、修改和重建流程。
- [支付与部署](supabase/functions/README.md)：渠道配置、Webhook、必需 Worker 和发布验证。
- [.env.example](.env.example)：环境变量模板，不包含有效凭据。

## 开发检查

```bash
bun run test              # 重置本地数据库后运行完整测试
bun run db:lint           # public / private / commerce 函数与触发器检查
bun run types:check       # 数据库生成类型漂移检查
bun run typecheck         # TypeScript 静态检查
bun run types:generate    # 有意更新数据库类型时使用
bun run stop
```

无数据库时可运行支付适配与共享逻辑的独立测试：

```bash
bun test tests/paypal-edge.test.ts tests/payment-shared.test.ts
```

完整测试需要本地 Supabase；handler 回归使用真实 Auth/PostgreSQL，仅 mock 渠道 HTTP，并以事务屏障验证锁竞争。它们不能替代真实渠道 Sandbox 和部署后网关测试。

开发期 schema 变更后直接重建本地数据库，不维护旧迁移升级路径。`setup` / `test` 会清空本地数据，仅用于可丢弃的开发环境。首次上线前再固定迁移历史，并落实 Worker 调度、Outbox 消费和对账告警。
