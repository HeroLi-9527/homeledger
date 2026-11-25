# Agent Note: 对齐上游 v1.0.0 全量业务缺口、OpenAPI/OpenClaw 兼容与 D1 运维闭环

Status: implemented

## Problem

在完成 [openapi-full-crud](../../implemented/feature/2026-11-24-openapi-full-crud.md) 与 [feature-parity-hardening](../../implemented/feature/2026-11-24-feature-parity-hardening.md) 后，Cloudflare Workers 版本相较上游单机基线仍存在 12 项明确缺口：预算新建页无法选择收入分类与币种；OpenAPI 缺少 OpenClaw Skill 文档与 `confirm=false` 纯预览、双字段响应及 `to_account`/`default_account` 自动建户；交易明细缺乏多维批量操作、完整筛选项与批量恢复；导出缺少按区间/类型/账户筛选及普通成员单账本结构化 JSON 导出；AI 设置页仍回填占位密码且缺少 `clear_api_key`、`ai.timeout_ms` 与头安全校验；账户详情硬截断前 30 条流水；`viewer` 桌面顶栏与流水行仍渲染只写入口；`transactions(subscription_id)` 缺少索引；关于页原型仓库链接与统计卡片不完整；缺少 D1 运维脚本、`wrangler.toml.example` 与 push/PR CI；报表页趋势仍限 6 个月且缺每日支出折线与账户余额一览；预算/订阅/导入/搜索/分类标签/个人资料/用户转交删除/成员昵称/账本统计等管理细节尚未补齐。

## Decision

在严守 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 确立的无状态 HMAC Cookie、只读 OpenAPI Bearer 鉴权与低 D1 读写红线，以及 [manual-cloudflare-deploy](../../implemented/process/2026-11-24-manual-cloudflare-deploy.md) 手动 CLI 部署约束下，系统现已落地以下设计与实现：

### 1. 规划、账务与角色界面完整对齐
- **预算与订阅**：`GET /budgets` 提供收支全部分类与 `currency` 字段，展示 4 项月度与预算指标以及每条预算的剩余额度与「日均可用额度」；订阅模块在 `overview()` 中计算 `thisMonthPending`，按试用/生效/暂停/取消分组渲染，提供 12 个常用服务快选（通过 `data-sub-preset` 与 `public/js/app.js` 绑定以满足严格 CSP）。
- **流水、账户、搜索与报表**：`/transactions` 对齐全量筛选项（`account_id`、`member_id`、`tag_id`、`source`、`from`、`to`、`sort` 与快捷芯片）、批量改分类/加标签/标记待报销与回收站批量恢复；`/accounts/:id` 支持日期区间筛选、区间收支小计、分页及 `/transactions/new?account_id=...` 预选入口；`GET /search` 支持 4 种排序与结果收支小计；`GET /reports` 展示 12 个月收支趋势、X 轴自动抽稀的每日支出折线图、账户余额一览表及当前区间的 CSV 导出链接。
- **只读与个人/管理体验**：桌面顶栏与流水行统一受 `canWrite(ctx.ledger.role)` 控制对 `viewer` 隐藏只写入口；导入页渲染 `#imp-default-acc` 与支付宝/微信导出指引；分类与标签页展示使用统计（分类近 1 年统计按子节点向上聚合至一级分类）与颜色选色器（以 `colorFor(name)` 与父级颜色替代硬编码色值）；个人资料支持修改 `username` 与 `avatar_color`；成员页展示本月统计并支持 `POST /members/:id/nickname`；账本管理展示笔数/成员数/账户数并支持 `business`/`project`、颜色、备注与「跳过默认账户」。

### 2. 数据安全、导出与用户转交原子边界
- **AI 配置与导入导出**：AI 设置页输入框不再回填 `'••••••••'`，新增 `clear_api_key` 与 `ai.timeout_ms`（钳位在 `5000`–`300000` ms）；`POST /settings/ai` 在 `.trim()` 之前对原始 `api_key`、`base_url` 与 `model` 执行 `isHeaderSafe` 校验（拦截图/头尾换行与制表符等 ASCII 控制字符），校验通过后再裁剪存储；`/export/csv` 复用 `TxnFilter` 支持起止日期、类型与账户筛选，`csvEscape` 对以公式字符（`=`、`+`、`@`、`-\D`、`\t`、`\r` 及前导空白接风险符号）开头的值加前缀单引号中和（保留纯合法负金额），同时补全 `\r` 引号转义；面向普通成员开放零凭据脱敏的单账本 `GET /export/ledger.json`（管理员全库 `/export/json` 保持不变）。
- **流水并发状态机、OpenAPI 回滚与站点用户转交**：`stampMs()` 追加随机后缀保证令牌全局唯一，流水 `softDelete` 与 `restoreTransaction` 在单次 `db.batch` 中为账户余额与关联表操作追加 `EXISTS (... updated_at = stamp)` 守卫，杜绝并发恢复或并发删除重复变更余额；`POST /api/open/transactions` 将两次 `createAutoAccount` 均纳入回滚 `try/catch` 作用域，避免二次建户失败残留孤儿账户；`deleteUserAndTransfer` 在转交账本所有权并删除用户后显式向上传递 R2 头像删除结果并在失败时向管理员发出告警提示，同时 `cleanupOrphanR2` 纳入现存 `users.avatar_path` 白名单并支持手工回收孤儿头像。

### 3. OpenAPI / OpenClaw 双向兼容契约
- 新增适配 Cloudflare Workers 架构的 `openclaw-skill/homeledger-bookkeeping/SKILL.md`。
- `GET /api/open/ping` 补充 `app` 与 `today`（保留 `user`、`token` 结构）；`GET /api/open/transactions/recent` 补充 `transactions`、`count` 与每笔 `images` 数组（保留 `items`、`total`）；`POST /api/open/transactions` 支持 `to_account`/`to_account_name` 自动建户并同时返回 `accounts_created`（仅实际新建时输出 `created_accounts`）与 `category_resolved`；`POST /api/open/ai/bill` 支持 `confirm:false` 纯草稿预览（零 D1/R2 写入）、`save_images` 开关、`default_account`/`default_account_name` 自动建户以及 `drafts`、`confirmed` 与图片 `path`/`txn_id` 映射。

### 4. 数据库迁移与 CI / D1 运维闭环
- 遵循迁移不可变约定新增 `migrations/0004_txn_subscription_idx.sql`（创建 `idx_txn_subscription`），不改写已应用的 `0001`–`0003`。
- 关于页按 `HOMELEDGER_GITHUB_REPO` 与 `UPSTREAM_GITHUB_REPO` 分离渲染自身链接与 `sucraft-hub/homeledger` 原址链接，并补充用户级 4 项统计卡片。
- 新增 `.github/workflows/ci.yml` 在 `push` / `pull_request` 执行类型检查、全量测试与笔记校验；新增 `wrangler.toml.example`（含完整 `HOMELEDGER_GITHUB_REPO` URL 示例与两段式部署指引）、`scripts/reset-password.ts` 与 `scripts/seed-demo.ts`（统一使用 `ACCOUNT_TYPES` 枚举 `'debit'`/`'virtual'`，远程模式强制传入 `--confirm-remote` 与非默认强密码）。

角色只读范围、CSV 往返和余额口径见[账户币种与恢复边界](../bug-fix/2026-11-25-ledger-integrity-and-recovery.md)。

## Alternatives considered

- **直接覆盖已有的 `0001_init.sql` 追加索引或将新接口直接替换掉现有 OpenAPI 返回字段**：直接改写早期迁移会导致已通过 Wrangler 记录迁移历史的远程 D1 库跳过索引创建；而移除既有 `items` / `created_accounts` 字段虽能精简载荷，但会破坏既有 OpenAPI 客户端契约。因此选择追加独立 `0004` 迁移文件并在 OpenAPI 采用双字段并行输出，仅在确有新建账户时保留 `created_accounts`。
- **在 `scripts/seed-demo.ts` 与 `scripts/reset-password.ts` 中使用 `BEGIN TRANSACTION` / `COMMIT` 或允许远程 seed 使用默认演示口令**：包裹显式事务块在某些情况下虽便于本地批处理回滚，但 Cloudflare `wrangler d1 execute` 拒绝包含显式事务控制语句的脚本；远程允许默认弱口令或模板保留个人 D1 ID 均会引入公网暴露风险。故改用幂等顶层 SQL、远程强制独立强密码门禁及 `wrangler.toml.example` + `.gitignore` 忽略 `wrangler.local.toml`。

## Consequences

- **收益**：除刻意架构差异与 4 项存疑条目外，业务功能、OpenClaw 集成、多维数据安全（并发状态守卫、CSV 公式防护、头控制字符拦截）、及 D1 日常运维与 CI 均达成完整闭环，同时维持零新增运行时状态表与低 D1 读写。
- **代价与约束**：OpenAPI 双字段响应增加了返回体体积；已部署的远程 D1 环境需通过 `npm run db:migrate`（或 `npx wrangler d1 migrations apply DB --remote`）主动应用 `0004` 迁移；本地使用 `wrangler.local.toml` 时需对 `secret put`、`d1 migrations apply` 与 `wrangler deploy` 分别显式传入 `-c wrangler.local.toml`（`npm run deploy` 仍作用于默认 `wrangler.toml`）。

## Verification

- `test/core.test.ts` 覆盖 `about` 模块仓库元信息与推导逻辑、`csvEscape` 公式中和与合法负金额保留，以及现有核心单元断言。
- `test/e2e.test.ts` 新增第 1 至第 12 项及复核加固回归用例（含并发恢复/软删余额不重算、OpenAPI 二次建户失败回滚、`source=import` 导入流水筛选实证、CSV 公式中和、AI 密钥控制字符拦截、远程 seed 强密码校验、删除用户 R2 异常告警与手动孤儿头像回收）。
- 交付前统一运行 `npm run typecheck`、`npm test` 与 `npm run verify-notes`。
