# Agent Note: HomeLedger Cloudflare Workers 极简低读写架构

Status: implemented

## Problem

参考项目 `homeledger-worker` 从 Node/SQLite 迁移至 Cloudflare Workers 时，为了追求通用并发与防御式安全，引入了大量针对每一条 HTTP 请求和定时任务的数据库/对象存储读写开销：
- 每次请求都会查询 `settings` 与 `users` 检查种子和管理员初始化（`ensureSeeded` + `bootstrapAdmin`）；
- 每次页面请求都会读写 D1 `sessions` 表，匿名表单页也曾触发写入；
- 每次 OpenAPI 调用都会写 `rate_limits` 限流表并更新 `api_tokens.last_used_at`；
- 每次登录失败都往 `login_attempts` 写库；大量操作往 `audit_logs` 写流水账；
- 单独维护 `notification_dedup` 表并在 `notifications.body` 末尾拼接 `|key` 字符串；
- Cron 每 30 分钟运行一次（48 次/天），且每次遍历 R2 三个前缀做全量 `list()` 扫描；
- 背负旧版 `homeledger.db` 的 `scrypt-js` 兼容升级与历史附件路径回退代码。

对于个人或家庭在 Cloudflare 免费额度（D1 每日 10 万次行写 / 500 万次行读，R2 每月 100 万次 Class A 操作）下的自托管场景，这些过度防御造成了显著的免费额度浪费与边缘往返延迟。

## Decision

本项目采用 **TypeScript + Hono 4 + Cloudflare D1 + R2 + Cron Triggers** 从零构建自托管家庭记账系统，完整保留 14 种交易类型、10 种账户类型、209 个内置分类、多币种与 AA 分账、AI 截图/文本双引擎记账、家庭共享、理财规划、服务端离线 SVG 报表与完整 OpenAPI，并实施极简低读写架构：

### 1. 数据层与冗余表裁剪
- 系统数据库 Schema（`migrations/0001_init.sql`）仅包含 21 张业务表，不包含 `sessions`、`rate_limits`、`login_attempts`、`audit_logs` 与 `notification_dedup`；公网防刷交由 Cloudflare WAF / Rate Limiting 承担。
- 209 个内置分类（176 支出 + 33 收入）、10 条默认汇率与 10 条默认设置由 `migrations/0002_seed.sql` 一次性写入，运行时零 `ensureSeeded` 与 `bootstrapAdmin` 查询；首次启动无用户时由 `/setup` 引导创建管理员。
- 通知幂等去重通过 `notifications(user_id, dedupe_key)` 部分唯一索引 `idx_notif_dedupe` 配合 `INSERT OR IGNORE` 在单条语句内完成。
- OpenAPI 路由组（`src/routes/openapi.ts`）挂载在全局 CSRF 与 Cookie 中间件之前，Bearer Token SHA-256 鉴权仅执行只读联合查询，不更新 `last_used_at`。
- 日常记账、编辑、软删除及周期/订阅自动入账通过 `balanceDeltaStmts` 计算余额增量并与交易语句合并于同一 `db.batch()` 提交；`recalcBalances` 仅在 CSV 批量导入与全库 JSON 备份恢复后调用。
- 密码哈希统一使用 WebCrypto PBKDF2-SHA256（10 万次迭代），不含 `scrypt-js` 与旧版 SQLite 兼容包袱；全库 JSON 恢复（`/backup/restore`）不自动向 R2 写入 `pre-restore` 冗余备份。

### 2. 无状态会话与安全边界
- 浏览器会话使用 `hl.sid` Cookie，承载经 `SESSION_SECRET` HMAC-SHA256 签名的载荷 `{ uid, lid, tv, csrf, exp }`，满足 7 天刷新阈值时自动滑动续期。
- `loadContext` 核对用户 `status = 'active'` 与 `users.token_version === sess.tv`，用户改密、管理员停用或重置密码时自增 `token_version` 并吊销 `api_tokens`，使全部旧会话与 API 令牌即时失效。
- 全站应用每请求独立随机 `cspNonce`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`；`/uploads/*` 对非头像附件校验所属账本成员权限、限制白名单图片扩展名并附加 `Content-Security-Policy: sandbox`；令牌生成与 JSON 导出附加 `Cache-Control: no-store`。

### 3. 每 4 小时 Cron 与 R2 生命周期
- `wrangler.toml` 定时触发器设为 `0 */4 * * *`（每天 6 次），驱动 `runScheduled`（`src/lib/scheduler.ts`）执行周期账单、订阅扣费、预算/借贷/目标提醒与轻量 DB 过期行清理（过期邀请码、90 天前已读通知、7 天前未关联的 `pending` AI 附件及对应已知 key）。
- 定时任务不执行 R2 `list()` 全前缀扫描；删除交易或附件时同步删除已知 R2 key，孤儿清理仅保留管理员手动入口 `POST /admin/cleanup-r2`（调用 `cleanupOrphanR2`）。

### 4. Technical Ledger 视觉重设计与离线渲染
- 基于 Google Stitch 完成新版「Technical Ledger」界面设计，落实到 `public/css/app.css`（#F8FAFC 表面色调、#0F766E 翡翠主色、#BE123C 支出警示、`tabular-nums` 等宽账务数字、248px 固定侧栏 + 移动端抽屉与浅/深主题变量）与 `src/views/*.ts` 模块化视图。
- `src/lib/charts.ts` 与前端零第三方图表面向离线使用，收支柱状图、12 个月净资产折线图、分类环形图与日历热力图全部由 Workers 服务端输出内联 SVG。

## Alternatives considered

- **继续使用 D1 `sessions` 表**：在多设备精细踢出（单会话吊销）和服务端直接清空指定会话上有天然优势。但家庭记账场景下每次网页浏览都多一次 D1 读（以及滑动续期时的写），匿名页面还可能触发无效写入；采用无状态 HMAC Cookie + `token_version` 在不牺牲改密/禁号全局失效能力的前提下，消除了会话表的存储与读写消耗。
- **保留 D1 限流表与审计表**：在纯 Worker 边界且未配置 Cloudflare WAF 时可提供应用层爆破防护与操作留痕。但 D1 按行计费且免费版每日 10 万行写额度宝贵，把暴力破解计数器与每次读写审计放进 D1 会让恶意扫描放大免费额度消耗，因此改由平台层 WAF/Rate Limiting 承担限流，不建 D1 限流与审计表。
- **保持每 30 分钟 Cron 触发**：账单与扣费通知实时性更强（最大延迟 30 分钟）。但家庭日度记账与订阅扣费对分钟级精度不敏感，每 30 分钟空跑一次全表扫描（48 次/天）会放大免费额度与 Worker 触发消耗，因此调整为每 4 小时 1 次（6 次/天）。
- **前后端分离 SPA**：可借助现代前端框架实现复杂客户端交互，但违背离线可用、服务端 SVG 渲染、零前端构建与一键 Worker 部署的极简目标，且增加包体积与维护链条，因此坚持 Hono 服务端渲染 HTML + 轻量原生 CSS/JS。

## Consequences

- **免费额度开销显著降低**：常规浏览页面仅做零写入的只读上下文查询，OpenAPI 调用零 D1 写，Cron 触发频次从每天 48 次降至 6 次且消除周期性 R2 `list()` Class A 调用。
- **单设备独立踢出受限**：无状态 Cookie 不记录逐设备会话 ID，挂失设备需通过改密或后台重置（自增 `token_version`）使全部端同时重登，适合家庭自托管场景。
- **强依赖部署秘钥与平台防护**：`SESSION_SECRET` 缺失或不足 16 位时应用拒绝签发并显式报错；防爆破限流与访问审计由 Cloudflare 边缘层接入策略承担，应用层不再重复记录。
- **孤儿 R2 对象延迟回收**：异常中断留下的未关联 CSV 导入预览或上传碎片不再于后台定时扫桶删除，需由管理员在 `/admin` 面板按需手动触发 `/admin/cleanup-r2`。

## Verification

- 通过 `wrangler d1 migrations apply homeledger-db --local` 验证建表与 209 个系统分类、10 条默认汇率、10 条系统设置初始化一致。
- 单元测试（`test/core.test.ts`）覆盖 PBKDF2 哈希校验、无状态 HMAC 会话验签/防篡改/过期/滑动续期、14 种交易类型 `txnEffects`、离线 AI 中文规则引擎、订阅月末锚点推进与 4 类离线 SVG 图表生成。
- 端到端全链路测试（`test/e2e.test.ts`，基于真实迁移 SQL 与内存 R2）验证禁表核查、冷启动 `/setup`、22 个 GET 页面 200、CSRF 403 拒绝、交易记账余额联动与报表 SVG、AI 离线分析与删流水同步删 R2、改密令旧 Cookie 与 API 令牌同步失效、OpenAPI 鉴权读写与定时任务运行。
- 构建与文档检查通过 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 门禁验证。
