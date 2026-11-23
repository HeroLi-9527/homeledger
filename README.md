# 家账簿 HomeLedger

基于 **Cloudflare Workers + TypeScript + Hono 4 + D1 + R2 + Cron Triggers** 的极简低读写自托管家庭记账系统，提供网页手动记账、AI 截图/文本双引擎记账（含纯离线规则兜底）、全离线服务端 SVG 报表与聊天机器人开放 API。

## 核心特性

- **全品类记账**：覆盖支出、收入、转账、借出、借入、收款、还款、报销入账、退款、手续费、利息、投资买入、投资卖出、余额校准 **14 种交易类型**、**10 种账户类型**、**209 个内置分类**（176 支出 + 33 收入）、多币种折算与 AA 分账 / 报销标记。
- **AI 智能记账（双引擎 + R2 原图存档）**：支持拖放或 `Ctrl+V` 粘贴最多 6 张账单截图及一句话自然语言输入；已配置 OpenAI 兼容多模态模型时走视觉/文本解析，未配置或调用失败时自动降级为纯离线中文关键词规则引擎。原图保存在 R2 并关联流水，删除流水时同步删除 R2 对象。
- **家庭多账本协同**：支持多账本隔离、邀请码加入（`/join/:code`）、四档成员角色（`owner` / `admin` / `member` / `viewer`）与报表按成员拆分。
- **理财规划与每 4 小时自动任务**：支持多周期预算（含上期结余滚存结转）、周期账单、订阅扣费（试用期跟踪、月/年摊销测算、到期自动入账）、借贷台账同步与储蓄目标。
- **全离线服务端 SVG 报表**：收支柱状趋势、近 12 个月净资产折线、分类构成环形图与消费日历热力图全部由 Workers 服务端直接渲染内联 SVG，零第三方图表库依赖。
- **账单导入导出**：支持支付宝 / 微信 CSV 自动识别 UTF-8 / GBK 编码与订单号去重导入、UTF-8 BOM CSV 导出及管理员全库 JSON 备份恢复。
- **Technical Ledger 界面设计**：基于 Google Stitch 重新设计的轻量服务端渲染 HTML + 原生 CSS/JS（严格 nonce CSP、浅色/深色主题切换、PWA 离线 manifest、浮动 AI 助手面板）。

## Cloudflare 免费额度低读写架构设计

为避免参考实现中的过度防御白白消耗 Cloudflare D1 / R2 免费额度，系统在架构上做了以下裁剪：

- **零额外日志与限流表**：彻底移除 `sessions`、`rate_limits`、`login_attempts`、`audit_logs`、`notification_dedup` 五张高频写入表（公网防刷交由 Cloudflare WAF / Rate Limiting 承担）。
- **无状态会话鉴权**：浏览器鉴权使用 HMAC-SHA256 签名的 `hl.sid` Cookie，服务端通过 `users.token_version` 校验证书有效性；修改密码或管理员禁用/重置用户时自增 `token_version` 并吊销 `api_tokens`，实现零 D1 会话写消耗与全局即时踢出。
- **迁移期一次性种子**：209 个系统分类、10 条默认汇率与站点初始配置通过 `migrations/0002_seed.sql` 一次性落库，移除运行时每请求 `ensureSeeded` / `bootstrapAdmin` 查询；首次部署通过 `/setup` 引导创建首个管理员。
- **通知去重内联唯一索引**：直接在 `notifications(user_id, dedupe_key)` 建立部分唯一索引并配合 `INSERT OR IGNORE`，以单条语句完成提醒幂等去重。
- **OpenAPI 零写库鉴权**：`/api/open/*` Bearer Token（SHA-256 摘要存储）鉴权全程仅做只读联合查询，不写入 `last_used_at`。
- **4 小时 Cron 与无全量扫描清理**：`wrangler.toml` 定时触发器设为 `0 */4 * * *`（每天 6 次）；定时任务不扫描 R2 `list()`，仅在删除流水或附件时同步删除已知 R2 key，并提供管理员手动清理孤儿对象的 `/admin/cleanup-r2` 入口；JSON 备份恢复也不额外向 R2 写入 `pre-restore` 冗余快照。

## 快速开始与一键部署

### 1. 本地开发与验证

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run typecheck
npm test
npm run dev
```

首次访问 `http://localhost:8787` 会自动引导进入 `/setup` 创建管理员账户与默认账本。

### 2. 部署到 Cloudflare Workers

```bash
# 1. 创建 D1 数据库与 R2 存储桶，并将输出的 database_id 填入 wrangler.toml
npx wrangler d1 create homeledger-db
npx wrangler r2 bucket create homeledger-attachments

# 2. 配置会话签名密钥（至少 16 位随机字符串，推荐 32+ 位）
npx wrangler secret put SESSION_SECRET

# 3. 执行远程数据库建表与 209 条系统分类初始化，并发布 Worker
npm run db:migrate
npm run deploy
```

> 建议在生产环境开启 Cloudflare 域名代理与基础 WAF / Rate Limiting 规则保护 `/login`、`/setup` 与 `/api/open/*`。

## 开放 API（`/api/open/*`）

在网页「系统设置 → 开放 API 令牌」生成一次性明文 `Bearer Token`（格式 `hl_...`，仅生成时返回一次并附带 `Cache-Control: no-store`）。请求头携带：

```http
Authorization: Bearer hl_xxxxxxxxxxxxxxxx
```

常用端点：

- `GET /api/open/ping`：校验令牌连通性与当前绑定账本信息（纯只读，零 D1 写入）
- `GET /api/open/overview` / `GET /api/open/summary` / `GET /api/open/reports`：月度汇总、资产负债概览与报表聚合
- `GET /api/open/transactions` / `GET /api/open/transactions/recent` / `GET /api/open/transactions/:id`：查询流水明细
- `POST /api/open/transactions` / `PUT|PATCH /api/open/transactions/:id` / `DELETE /api/open/transactions/:id`：写入或软删流水（同步更新账户余额与 R2 附件）
- `POST /api/open/ai/bill`：上传文本或 base64 账单截图，自动识别并按 `auto_save` 入库（默认入库并存档原图）
- `GET /api/open/attachments/:id`：读取 R2 存档的账单截图二进制
- `GET|POST /api/open/accounts`、`GET /api/open/categories`、`GET /api/open/tags`、`GET /api/open/budgets`、`GET /api/open/subscriptions`、`GET /api/open/recurring`、`GET /api/open/debts`（别名 `/loans`）、`GET /api/open/goals`、`GET /api/open/export`
