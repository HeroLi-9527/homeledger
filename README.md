# 家账簿 HomeLedger

基于 **Cloudflare Workers + TypeScript + Hono 4 + D1 + R2 + Cron Triggers** 构建的自托管家庭记账系统，零构建前端、全离线服务端 SVG 图表、AI 截图/文本双引擎记账与开放 API 一体化部署。

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
  - 原图存档至 Cloudflare R2 并绑定流水。流水移入回收站后，标签、AA 分账和凭证随流水保留，附件从存档页隐藏。永久删除流水或单独删除附件时同步清理对应 R2 对象。
- **家庭多账本与权限安全**：
  - 支持多账本隔离、账本改名/归档，以及账本所有者输入账本名称二次确认后的**全子表与 R2 级联永久删除**（同步吊销绑定该账本的 API 令牌）。
  - 支持 `owner` / `admin` / `member` / `viewer` 四档成员角色；在关闭全站自助注册时仍可通过一次性邀请链接 `/join/:code` 定向注册加入，或由站点管理员在 `/admin` 直接建号与执行 `Cache-Control: no-store` 一次性密码重置。
- **理财规划与每 4 小时自动任务**：
  - 支持多周期预算（含上期结余滚存结转）、周期账单（支持多明细编辑）、借贷台账（自动汇总借贷支持设到期日并在重算时保留）、储蓄目标与订阅扣费（试用期跟踪、月/年摊销测算、历史扣费明细与删规则留流水）。
  - 通知中心自动标记已读，点击通知支持跨账本安全校验与静默切换直达目标页面。
- **全离线报表与导入导出备份**：
  - 收支柱状图、近 12 个月净资产折线、分类构成环形图（支持一级/二级分类下钻及穿透流水）与消费日历热力图全部由 Workers 服务端输出内联 SVG。
  - 支持支付宝、微信及 HomeLedger 导出的 CSV 导入。单账本全量 JSON 可导入为新账本。网页全库 JSON 保存 D1 数据，整站归档命令同时保存 R2 凭证和头像原图。

---

## Cloudflare 免费额度友好架构与安全设计

系统面向个人与家庭在 Cloudflare 免费套餐下的长期稳定运行而设计，尽量压缩不必要的边缘读写开销：

1. **无状态 HMAC-SHA256 会话鉴权**：浏览器会话通过 `SESSION_SECRET` 签名的 `hl.sid` Cookie 携带 `{ uid, lid, tv, csrf, exp }` 载荷，正常页面浏览无需读写会话表；配合 `users.token_version`，在修改密码、管理员重置密码/停用账号或全库恢复时即可即时令全端旧会话与 API 令牌同时失效。
2. **迁移一次性初始化**：版本迁移初始化数据库结构、209 个系统分类、10 条默认汇率与站点默认配置；首次访问 `/setup` 创建首个站点管理员。
3. **单表通知幂等去重**：`notifications(user_id, dedupe_key)` 使用部分唯一索引配合 `INSERT OR IGNORE`，单条 SQL 完成周期、订阅、预算、借贷、目标、信用账期与次卡提醒去重。
4. **只读 OpenAPI 鉴权**：`/api/open/*` 使用 SHA-256 摘要存储的 Bearer Token 鉴权，鉴权阶段仅执行只读联合查询。
5. **每 4 小时 Cron 与精准 R2 回收**：`wrangler.toml` 定时触发器配置为 `0 */4 * * *`（每天 6 次）。永久删除流水、删除附件或删除账本时按已知 key 清理 R2。孤儿文件扫描由管理员在 `/admin` 按需手动触发。
6. **纵深安全边界**：全站启用每请求随机 `cspNonce` 严格 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`；Web 写入受同步提交 CSRF 令牌保护；`/uploads/*` 对非头像附件校验所属账本成员权限并附加 `Content-Security-Policy: sandbox`；令牌生成、JSON 导出与重置密码结果页均附带 `Cache-Control: no-store`。

---

## 本地开发与验证

```bash
# 1. 安装依赖并准备本地环境变量
npm install
cp .dev.vars.example .dev.vars

# 2. 初始化本地 D1（应用全部 migrations）
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

### 手动部署步骤

**前置条件**：本地已安装 Node.js（≥ 20），且 Cloudflare 账号已在控制台提前开通 **R2**（提供每月 10GB 免费额度）。

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/HeroLi-9527/homeledger.git
cd homeledger
npm install

# 2. 登录 Cloudflare（如尚未登录）
npx wrangler login

# 3. 创建远程 D1 数据库与 R2 存储桶
npx wrangler d1 create homeledger-db
npx wrangler r2 bucket create homeledger-attachments

# 4. 复制配置模板并将 database_id 填入本地配置（避免把个人库名与 ID 误提交到 Git）
cp wrangler.toml.example wrangler.local.toml   # 已加入 .gitignore；使用独立配置文件时以下各步需传 -c wrangler.local.toml
# （若直接修改受跟踪的 wrangler.toml，建议执行：git update-index --skip-worktree wrangler.toml）

# 5. 生成并写入生产环境 SESSION_SECRET（至少 16 位，建议 ≥ 32 位）
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
# （如使用 wrangler.local.toml：openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET -c wrangler.local.toml）

# 6. 应用全部远程迁移并发布 Worker
# （npm run deploy 作用于默认的 wrangler.toml；若使用 wrangler.local.toml，请分两条命令执行：）
#   npx wrangler d1 migrations apply DB --remote -c wrangler.local.toml
#   npx wrangler deploy -c wrangler.local.toml
npm run deploy
```

> 若发布前遗漏配置 `SESSION_SECRET` 或长度不足 16 位，访问应用时会返回 503 配置引导页并阻止 `/setup` 半初始化；通过 `npx wrangler secret put SESSION_SECRET` 或在 Cloudflare 控制台 **Workers & Pages → Settings → Variables and Secrets** 中补齐后刷新页面即可恢复。

### 运维工具脚本（D1 CLI）

- **管理员/用户密码重置**（同时递增 `token_version` 并吊销 `api_tokens`）：
  ```bash
  npm run ops:reset-password -- --local                  # 重置本地最早管理员并生成随机密码
  npm run ops:reset-password -- --remote --username admin --password 'NewStrongPassword123'
  npm run ops:reset-password -- --dry-run                # 仅预览生成的 SQL
  ```
- **演示数据初始化**（含示例家庭账本、4 类账户、流水、预算、订阅、目标、借贷与次卡；远程执行须显式传 `--confirm-remote` 与独立的 `--password`，禁止使用默认演示弱密码）：
  ```bash
  npm run ops:seed-demo -- --local
  npm run ops:seed-demo -- --remote --confirm-remote --password '<请替换为至少8位强密码>' --config wrangler.local.toml
  npm run ops:seed-demo -- --dry-run
  ```

### 上线后检查

1. 打开部署域名，按引导在 `/setup` 创建首个站点管理员（密码至少 8 位）。
2. 进入「系统设置」按需配置站点名称、是否开放注册、本位币汇率，以及 AI 模型 `Base URL / API Key / 模型名`（点击「测试连接」验证）。
3. 建议在 Cloudflare 域名面板开启代理并配置基础 **WAF / Rate Limiting** 规则，重点保护 `/login`、`/setup`、`/register`、`/join/*` 与 `/api/open/*`。
4. 后续版本更新时，先拉取代码并执行部署（`npm run deploy` 会自动先应用远程 D1 迁移再发布；也可单独执行 `npm run db:migrate`）：

```bash
npm run deploy
```

### 外币账户与数据恢复

- 应用 `0005_account_amounts_and_trash.sql` 前先备份。余额、期初金额、校准值及信用额度使用账户原币，净资产和账户小计使用站点本位币。历史净资产曲线统一用当前汇率估值。迁移用流水原币或已保存的本位币金额回填，第三种币种的历史侧金额需要在账户详情逐笔核对。曾更改站点本位币的旧库还应核对历史折算金额。已有流水时，站点本位币和相关账户的币种保持固定。
- HomeLedger CSV 导入按账户名和分类路径匹配，预览会指出首个无法映射的行。新版 CSV 同时带上站点本位币、汇率和账户侧金额。同一份 CSV 可以重试，导入记录不会重复记账。
- 在「导出备份」下载未筛选的全量账本 JSON，再从「多账本管理」导入为新账本。导入者成为新账本所有者，导入后重新核对并开启自动记账规则。单账本 JSON 不含凭证文件和站点用户。
- 推荐在暂停记账、修改头像和运行定时任务的维护窗口创建或恢复整站归档。归档目录含数据库快照、R2 原图与 SHA-256 清单，应按敏感账本数据保管。目标站点应先部署当前版本并可用管理员登录。恢复会覆盖目标 D1，并吊销旧会话和开放 API 令牌。已替换或因失败留下的 R2 对象可从管理员后台手动清理。

```bash
# 从管理员已登录会话取得 hl.sid 的值，通过本地环境变量 HOMELEDGER_ARCHIVE_SESSION 传给命令
npm run ops:backup -- create ./homeledger-backup --url https://账本站点 --bucket homeledger-attachments --remote
npm run ops:backup -- verify ./homeledger-backup
npm run ops:backup -- restore ./homeledger-backup --url https://目标站点 --bucket 目标存储桶 --remote --confirm-overwrite
```

恢复前使用目标站点的管理员会话更新 `HOMELEDGER_ARCHIVE_SESSION`。本地测试可用 `--local`，并传入与本地 Worker 相同的 `--config` 和 `--persist-to`。整站恢复使用网页恢复的 20MB JSON 上限，原图单独搬运。

---

## 开放 API（`/api/open/*`）

在网页「系统设置 → 开放 API 令牌」生成一次性明文 `Bearer Token`（格式 `hl_...`，创建时附带 `Cache-Control: no-store`）。请求头携带：

```http
Authorization: Bearer hl_xxxxxxxxxxxxxxxx
```

支持在请求头 `x-ledger-id` 或查询参数 `ledger_id` 中指定有权限的目标账本（默认使用令牌绑定账本）。

常用端点（写操作兼容 `*_cents` 整数分与元单位金额，编辑同时支持 `PUT` 与 `PATCH`）：

- `GET /api/open/ping`：校验令牌连通性与当前绑定账本信息
- `GET /api/open/overview` / `GET /api/open/summary` / `GET /api/open/reports`：月度汇总、资产负债概览与报表聚合
- `GET /api/open/transactions` / `GET /api/open/transactions/recent` / `GET /api/open/transactions/:id`：查询流水明细
- `POST /api/open/transactions` / `PUT|PATCH /api/open/transactions/:id` / `DELETE /api/open/transactions/:id`：写入、编辑或软删流水。转账可传 `account_amount_cents` 和 `to_account_amount_cents` 指定两端实际原币金额。软删保留凭证，永久删除在网页回收站操作。
- `POST /api/open/ai/bill`：上传文本或 base64 账单截图，自动识别并按 `auto_save` 入库并存档原图
- `GET /api/open/attachments/:id`：读取 R2 存档的账单截图
- `GET|POST /api/open/accounts`、`GET|PUT|PATCH|DELETE /api/open/accounts/:id`、`POST /api/open/accounts/:id/archive`、`POST /api/open/accounts/:id/adjust`：账户分层查询（支持 `?include_archived=1`）、新建、编辑、归档切换、余额校准与删除
- `GET|POST /api/open/session-cards`、`GET|PUT|PATCH|DELETE /api/open/session-cards/:id`、`POST /api/open/session-cards/:id/archive`、`POST /api/open/session-cards/:id/use`、`POST /api/open/session-cards/:id/topup`、`POST /api/open/session-cards/:id/logs/:logId/undo`：次卡台账查询、开卡、编辑、归档、删除、核销、续费与撤销
- `GET|POST /api/open/categories`、`GET|PUT|PATCH|DELETE /api/open/categories/:id`：分类查询与当前账本自定义一/二级分类增删改
- `GET|POST /api/open/tags`、`GET|PUT|PATCH|DELETE /api/open/tags/:id`：标签查询与增删改
- `GET|POST /api/open/budgets`、`GET|PUT|PATCH|DELETE /api/open/budgets/:id`：预算管理与周期进度查询（默认返回启用项，支持 `?include_inactive=1`）
- `GET|POST /api/open/recurring`、`GET|PUT|PATCH|DELETE /api/open/recurring/:id`、`POST /api/open/recurring/:id/run`：周期账单增删改与立即执行
- `GET|POST /api/open/subscriptions`、`GET|PUT|PATCH|DELETE /api/open/subscriptions/:id`、`POST /api/open/subscriptions/:id/charge`、`POST /api/open/subscriptions/:id/skip`：订阅管理、扣费历史查询、手动扣费与跳过本期
- `GET|POST /api/open/debts`、`GET|PUT|PATCH|DELETE /api/open/debts/:id`、`POST /api/open/debts/:id/settle`（全量提供 `/api/open/loans*` 别名）：借贷台账增删改与收/还款结清
- `GET|POST /api/open/goals`、`GET|PUT|PATCH|DELETE /api/open/goals/:id`、`POST /api/open/goals/:id/deposit`：储蓄目标增删改与存入/取出
- `GET /api/open/export`：全量流水 JSON 导出
