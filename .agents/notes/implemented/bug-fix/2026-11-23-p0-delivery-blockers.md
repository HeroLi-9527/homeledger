# Agent Note: P0 部署交付阻断项修复（邀请注册闭环、AI 配置与前后端契约）

Status: implemented

## Problem

在完成对 HomeLedger 首版 Workers 代码的部署前审计时，发现 5 个导致核心功能不可用或运行期 500 崩溃的 P0 阻断缺陷：

1. **AI 配置开关保存与读取格式不匹配**：`POST /settings/ai` 将 `ai.enabled`、`ai.vision`、`ai.auto_save` 写入 `'1'` / `'0'`，而 `migrations/0002_seed.sql` 与 `getAiConfig` 判断 `=== 'true'`，导致后台保存后在线 AI 功能永久失效。
2. **关闭自助注册时的成员邀请死锁**：`site.allow_register` 默认值为 `'false'`，但 `GET /join/:code` 强制登录且后台缺少管理员新建用户入口，家庭成员无法通过邀请链接注册账号。
3. **AI 快速记账无账户名时必报 400**：`/api/ai/chat` 与 `/api/open/ai/bill` 直接传入空的 `account_id`，在 `createTransaction` 阶段被账户必填校验拒绝。
4. **前后端字段命名不一致**：AI 解析响应返回 `category_name` 而前端消费 `category_path`；CSV 导入预览返回 `category_hint` / `account_hint` 而前端消费 `guess_category` / `guess_account`，导致界面展示为空。
5. **无活跃账本时多页面直接抛出 500**：`GET /transactions/deleted`、`/accounts/:id`、`/categories`、`/tags`、`/budgets`、`/recurring`、`/debts`、`/goals`、`/subscriptions` 仅校验 `requireLogin` 而未拦截空 `ctx.ledger`。

## Decision

在保持 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 既定 D1 极简低读写红线不变的前提下，对上述 5 类问题执行统一修复：

1. **统一 AI 设置布尔存储格式**：`src/routes/admin.ts` 在 `POST /settings/ai` 中通过 `toBoolSetting` 统一写入 `'true'` / `'false'`，与 `migrations/0002_seed.sql` 及 `src/lib/ai.ts#getAiConfig` 保持单一语义，不添加多余兼容层。
2. **AI 分类完整路径与默认账户兜底**：
   - `src/lib/ai.ts` 提供 `resolveCategory` 同时返回 `{ id, path }` 并在 `NormalizedBillItem` 输出 `category_path`；
   - 新增 `resolveDefaultAccount` 按 `preferredId`（若有）或账本首个未归档账户（`ORDER BY sort_order, id LIMIT 1`）兜底，`analyzeBill` 对未识别出账户的条目自动填充默认账户并写入提示 `warnings`，`POST /api/open/ai/bill` 支持可选 `account_id` 透传；
   - `public/js/app.js` 与 `public/js/assistant.js` 同步兼容 `category_path || category_name`。
3. **CSV 导入预览字段对齐与默认账户兜底**：`POST /api/import/preview` 在 `sample` 中同时输出 `guess_category` 与 `guess_account`；`POST /api/import/commit` 通过 `resolveDefaultAccount` 为无账户列记录提供默认账户兜底；前端预览表容错读取字段。
4. **开放基于有效邀请码的注册入口与管理员建号**：
   - 未登录用户访问有效且未使用的 `GET /join/:code` 时渲染 `joinRegisterPage`，可通过 `POST /join/:code/register` 直接创建账号并原子抢占 `ledger_invites`（`WHERE id = ? AND used_by IS NULL`），即使关闭全站自助注册（`site.allow_register = 'false'`）仍可邀请家庭成员加入；
   - 已登录用户加入（`POST /join/:code`）同样对未使用邀请执行原子抢占，若抢占失败回退或提示失效，防止并发复用同一邀请码；
   - `/admin` 面板新增 `POST /admin/users` 入口供站点管理员直接创建账号并自动初始化默认账本与账户。
5. **统一缺失账本拦截**：`src/routes/helpers.ts` 中的 `requireLedger` 对 GET 请求在缺少 `ctx.ledger` 时重定向至 `/`（引导新建账本），JSON 请求返回 400 JSON 错误；依赖账本的页面路由（`/transactions/deleted`、`/accounts/:id`、`/categories`、`/tags`、`/budgets`、`/recurring`、`/debts`、`/goals`、`/subscriptions`）统一改用 `requireLedger`。

## Alternatives considered

- **在 `getAiConfig` 中同时兼容 `'1'` 与 `'true'`**：实现最快但会长期保留两种真值编码并掩盖迁移种子与后台写入的分歧，因此选择从写入端统一为 `'true'` / `'false'`。
- **邀请新成员时强制开启全站 `site.allow_register = 'true'`**：会暴露全站任意注册面，与家庭自托管默认关闭公开注册的安全边界冲突，因此改为凭有效一次性邀请码定向注册。
- **在 `/api/ai/chat` 与 `/api/open/ai/bill` 各自手写查库兜底账户**：会在多处路由重复相同查询逻辑，因此在 `src/lib/ai.ts` 集中导出 `resolveDefaultAccount` 供 AI 解析与 CSV 导入共用。

## Consequences

- **收益**：后台 AI 开关配置即刻生效；AI 助手、OpenAPI 快捷记账与 CSV 导入预览均可在零额外配置下完整展示分类并完成记账；家庭成员可在关闭公开注册时凭邀请链接或管理员建号完成开户入驻；无活跃账本状态下所有依赖路由不再触发 500 崩溃。
- **代价与约束**：`POST /join/:code/register` 属于未登录表单端点，与 `/login`、`/setup` 一致依赖 `isSameOriginRequest` 同源检查与 Cloudflare 边缘 WAF / Rate Limiting 防刷；`requireLedger` 将无账本 GET 请求统一导向首页提示页，访问体验一致但要求首页 `/` 始终保持无需 `ctx.ledger` 即可渲染。

## Verification

- 通过 `test/e2e.test.ts` 新增的 P0 回归测试验证：AI 设置开关真值保存/回读、`/api/ai/chat` 与 `/api/open/ai/bill` 返回 `category_path` 且无账户名时自动落入默认账户、CSV 导入预览包含 `guess_category` / `guess_account` 并成功提交、`allow_register = 'false'` 下的邀请码定向注册与防复用、管理员直接建号登录，以及归档全部账本后全业务页面无 500 崩溃。
- 全量门禁 `npm run verify-notes`、`npm run typecheck`、`npm test` 与 `npx wrangler deploy --dry-run` 均通过。
