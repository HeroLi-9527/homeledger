# 家账簿 HomeLedger

基于 **Cloudflare Workers + TypeScript + Hono 4 + D1 + R2 + Cron Triggers** 构建的自托管家庭记账系统，零构建前端、全离线服务端 SVG 图表、AI 截图/文本双引擎记账与开放 API 一体化部署。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HeroLi-9527/homeledger)

---

## 核心特性

- **全品类记账与细粒度检索**：
  - 覆盖支出、收入、转账、借出、借入、收款、还款、报销入账、退款、手续费、利息、投资买入、投资卖出、余额校准 **14 种交易类型**。
  - 内置 **209 个系统分类**（176 支出 + 33 收入），支持按账本自定义一级/二级分类（含层级校验与防误删保护）、多币种汇率折算、标签、AA 分账、报销追踪及回收站恢复。
  - `/transactions` 与 `/search` 支持多维筛选与全条件保留分页，记账日历提供按日明细与热力分布。
- **三层账户体系与次卡台账**：
  - 按**资金账户**（现金、储蓄卡、电子钱包、投资、应收、其他）、**充值账户**（储值余额卡）与**信用账户**（信用卡、花呗、白条、应付、借款）三层组织资产负债。
  - 信用账户支持总额度、剩余可用额度、使用率进度条、账单日/还款日倒计时、还款日前 3 天自动提醒以及「去还款」预填转账。
  - 独立**次卡台账**（洗车卡、理发卡、健身卡等）：支持购卡联动支出或存量老卡补录、防超扣原子核销、撤销回补、同卡续费加次以及到期/余次不足提醒。
- **AI 截图与文本双引擎记账 + 凭证闭环**：
  - 支持拖放或 `Ctrl+V` 粘贴最多 6 张账单截图（单张 ≤ 8MB，PNG/JPG/WebP/GIF/BMP 等）与自然语言描述；配置 OpenAI 兼容多模态模型时自动识图解析，未配置或调用异常时自动降级为纯离线中文关键词规则引擎。
  - 原图存档至 Cloudflare R2 并绑定流水；交易编辑页支持查看原图、补传多图与单删，侧栏提供 `/attachments` 附件统一存档与流水跳转；删流水时同步清理关联 R2 对象。
- **家庭多账本与权限安全**：
  - 支持多账本隔离、账本改名/归档，以及账本所有者输入账本名称二次确认后的**全子表与 R2 级联永久删除**（同步吊销绑定该账本的 API 令牌）。
  - 支持 `owner` / `admin` / `member` / `viewer` 四档成员角色；在关闭全站自助注册时仍可通过一次性邀请链接 `/join/:code` 定向注册加入，或由站点管理员在 `/admin` 直接建号与执行 `Cache-Control: no-store` 一次性密码重置。
- **理财规划与每 4 小时自动任务**：
  - 支持多周期预算（含上期结余滚存结转）、周期账单（支持多明细编辑）、借贷台账（自动汇总借贷支持设到期日并在重算时保留）、储蓄目标与订阅扣费（试用期跟踪、月/年摊销测算、历史扣费明细与删规则留流水）。
  - 通知中心自动标记已读，点击通知支持跨账本安全校验与静默切换直达目标页面。
- **全离线报表与导入导出备份**：
  - 收支柱状图、近 12 个月净资产折线、分类构成环形图（支持一级/二级分类下钻及穿透流水）与消费日历热力图全部由 Workers 服务端输出内联 SVG。
  - 支持支付宝 / 微信 CSV 自动识别 UTF-8 / GBK 编码与订单号去重导入、UTF-8 BOM CSV 导出，以及站点管理员全库 JSON 备份导出与前置校验原子恢复（恢复后全端强制重登）。

---

## Cloudflare 免费额度友好架构与安全设计

系统面向个人与家庭在 Cloudflare 免费套餐下的长期稳定运行而设计，尽量压缩不必要的边缘读写开销：

1. **无状态 HMAC-SHA256 会话鉴权**：浏览器会话通过 `SESSION_SECRET` 签名的 `hl.sid` Cookie 携带 `{ uid, lid, tv, csrf, exp }` 载荷，正常页面浏览无需读写会话表；配合 `users.token_version`，在修改密码、管理员重置密码/停用账号或全库恢复时即可即时令全端旧会话与 API 令牌同时失效。
2. **迁移一次性初始化**：数据库结构、209 个系统分类、10 条默认汇率与站点默认配置由 `migrations/0001_init.sql`–`0003_session_cards.sql` 一次性落库，运行期免除初始化探测查询；首次访问 `/setup` 创建首个站点管理员。
3. **单表通知幂等去重**：`notifications(user_id, dedupe_key)` 使用部分唯一索引配合 `INSERT OR IGNORE`，单条 SQL 完成周期、订阅、预算、借贷、目标、信用账期与次卡提醒去重。
4. **只读 OpenAPI 鉴权**：`/api/open/*` 使用 SHA-256 摘要存储的 Bearer Token 鉴权，鉴权阶段仅执行只读联合查询。
5. **每 4 小时 Cron 与精准 R2 回收**：`wrangler.toml` 定时触发器配置为 `0 */4 * * *`（每天 6 次）；删除流水或单个附件时按已知 key 精准同步删除 R2 对象，不在定时任务中扫描整桶，仅保留管理员在 `/admin` 按需手动触发的孤儿文件清理入口。
6. **纵深安全边界**：全站启用每请求随机 `cspNonce` 严格 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`；Web 写入受同步提交 CSRF 令牌保护；`/uploads/*` 对非头像附件校验所属账本成员权限并附加 `Content-Security-Policy: sandbox`；令牌生成、JSON 导出与重置密码结果页均附带 `Cache-Control: no-store`。

---

## 本地开发与验证

```bash
# 1. 安装依赖并准备本地环境变量
npm install
cp .dev.vars.example .dev.vars

# 2. 初始化本地 D1（应用 migrations/0001–0003）
npm run db:migrate:local

# 3. 静态类型检查与全量单元测试 / 端到端测试
npm run typecheck
npm test

# 4. 启动本地 Workers 开发服务
npm run dev
```

首次访问 `http://localhost:8787` 会自动引导至 `/setup` 创建管理员账户与默认账本。

---

## 生产部署清单（Cloudflare Workers）

### 环境变量与绑定说明

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `DB` | D1 绑定 | 是 | 在 `wrangler.toml` 配置 `database_id`（库名默认 `homeledger-db`） |
| `ATTACHMENTS` | R2 绑定 | 是 | 在 `wrangler.toml` 配置 R2 存储桶（默认 `homeledger-attachments`） |
| `ASSETS` | Assets 绑定 | 是 | 静态资源目录 `./public` |
| `SESSION_SECRET` | Secret | 是 | 会话与 CSRF 签名密钥，**至少 16 位**（建议 32+ 位随机串） |
| `TZ` | Var | 否 | 时区，默认 `Asia/Shanghai` |
| `SITE_NAME` | Var | 否 | 默认站点标题（可在网页系统设置中动态覆盖），默认 `家账簿` |
| `COOKIE_SECURE` | Var / Secret | 否 | 默认开启 `Secure` Cookie；仅纯 HTTP 本地调试时在 `.dev.vars` 设为 `false` |

### 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HeroLi-9527/homeledger)

1. **前置条件**：确保 Cloudflare 账号已开通 **R2**（提供每月 10GB 免费额度，首次启用需在控制台开通）。
2. 点击上方 **Deploy to Cloudflare** 按钮并授权 GitHub，Cloudflare 会自动克隆仓库、创建 D1 数据库与 R2 存储桶，并在部署阶段通过 `npm run deploy` 自动执行 `migrations/0001–0003` 完成建表与初始化数据写入。
3. 在部署向导或部署后的 Worker 面板 **Settings → Variables and Secrets** 中新增 **Secret** 类型变量 `SESSION_SECRET`（**至少 16 位**，建议 32 位以上随机字符串）。若未配置，访问应用时会展示 503 配置引导页并阻止不安全的半初始化。
4. 访问部署域名，按引导在 `/setup` 创建首个站点管理员账户与默认账本。

### 手动 CLI 部署步骤

```bash
# 1. 登录 Cloudflare（如尚未登录）
npx wrangler login

# 2. 创建远程 D1 数据库与 R2 存储桶
npx wrangler d1 create homeledger-db
npx wrangler r2 bucket create homeledger-attachments

# 3. 将上一步返回的 database_id 填入 wrangler.toml 的 [[d1_databases]] 区块

# 4. 生成并写入生产环境 SESSION_SECRET（建议 ≥ 32 位）
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET

# 5. 应用全部远程迁移（0001_init、0002_seed、0003_session_cards）并发布 Worker
# （npm run deploy 已内置执行 `wrangler d1 migrations apply DB --remote && wrangler deploy`）
npm run deploy
```

### 上线后检查

1. 打开部署域名，按引导在 `/setup` 创建首个站点管理员（密码至少 8 位）。
2. 进入「系统设置」按需配置站点名称、是否开放注册、本位币汇率，以及 AI 模型 `Base URL / API Key / 模型名`（点击「测试连接」验证）。
3. 建议在 Cloudflare 域名面板开启代理并配置基础 **WAF / Rate Limiting** 规则，重点保护 `/login`、`/setup`、`/register`、`/join/*` 与 `/api/open/*`。
4. 后续版本更新时，先拉取代码并执行部署（`npm run deploy` 会自动先应用远程 D1 迁移再发布；也可单独执行 `npm run db:migrate`）：

```bash
npm run deploy
```

---

## 开放 API（`/api/open/*`）

在网页「系统设置 → 开放 API 令牌」生成一次性明文 `Bearer Token`（格式 `hl_...`，创建时附带 `Cache-Control: no-store`）。请求头携带：

```http
Authorization: Bearer hl_xxxxxxxxxxxxxxxx
```

支持在请求头 `x-ledger-id` 或查询参数 `ledger_id` 中指定有权限的目标账本（默认使用令牌绑定账本）。

常用端点：

- `GET /api/open/ping`：校验令牌连通性与当前绑定账本信息
- `GET /api/open/overview` / `GET /api/open/summary` / `GET /api/open/reports`：月度汇总、资产负债概览与报表聚合
- `GET /api/open/transactions` / `GET /api/open/transactions/recent` / `GET /api/open/transactions/:id`：查询流水明细
- `POST /api/open/transactions` / `PUT|PATCH /api/open/transactions/:id` / `DELETE /api/open/transactions/:id`：写入、编辑或软删流水（同步更新账户余额与 R2 附件）
- `POST /api/open/ai/bill`：上传文本或 base64 账单截图，自动识别并按 `auto_save` 入库并存档原图
- `GET /api/open/attachments/:id`：读取 R2 存档的账单截图
- `GET|POST /api/open/accounts`、`PUT|PATCH /api/open/accounts/:id`：查询三层账户与信用指标、新建或编辑账户元数据
- `GET|POST /api/open/session-cards`、`GET /api/open/session-cards/:id`、`POST /api/open/session-cards/:id/use`、`POST /api/open/session-cards/:id/topup`、`POST /api/open/session-cards/:id/logs/:logId/undo`：次卡台账查询、开卡、核销、续费与撤销
- `GET /api/open/categories`、`GET /api/open/tags`、`GET /api/open/budgets`、`GET /api/open/subscriptions`、`GET /api/open/recurring`、`GET /api/open/debts`（别名 `/api/open/loans`）、`GET /api/open/goals`、`GET /api/open/export`
