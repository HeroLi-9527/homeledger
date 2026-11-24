# Agent Note: 部署前 P1 核心交互与数据安全加固

Status: implemented

## Problem

在完成账户分层与次卡台账后，针对部署前的交互闭环与数据安全审计暴露出五类缺口：
1. **交易附件无法在常规编辑链路管理**：`GET /transactions/:id/edit` 未渲染已有凭证，不支持直接补传与单删；侧栏缺少 `/attachments` 入口，附件页也缺少回跳与流水跳转。
2. **筛选分页丢参、搜索缺分页且通知不可点**：`/transactions` 分页链接仅保留 `month`/`type`，丢失 `kind`、`category_id`、`account_id`、`q` 等筛选条件；`/search` 缺少分页控件；`/notifications` 未读取 `link` 与 `ledger_id`，通知标题不可点击跳转。
3. **报表二级分类与规划编辑能力不全**：`/reports` 虽已查询 `subcats` 却未渲染下钻明细；`/categories` 缺少自定义二级分类新建与删除；`/recurring`、`/debts`、`/goals` 缺少编辑入口，且借贷勾选联动流水时会丢失 `due_date`；`/subscriptions` 列表缺少删除按钮，编辑页未展示历史扣费流水。
4. **账本删除存在孤儿数据与 R2 泄露风险**：`POST /ledgers/:id/delete` 仅删除 3 张表，遗漏其余 16 张关联表（含无 `ledger_id` 列的 `transaction_tags`）、绑定账本的 `api_tokens` 与已知 R2 对象。
5. **高危管理链路防御不足**：`/admin` 缺少密码重置入口且此前将明文新密码写入 `hl.flash` Cookie；`POST /backup/restore` 缺少前置结构与活跃管理员校验、仅依 `rows[0]` 推断列并分批提交，中途失败会破坏全库完整性且恢复后不断开旧会话。

## Decision

在严格遵守 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 的 D1 低读写、零禁表与零定时 R2 `list()` 红线以及 [account-taxonomy-and-session-cards](../../implemented/feature/2026-11-23-account-taxonomy-and-session-cards.md) 的基础上，实施以下 5 项加固：

### 1. 交易编辑页附件闭环与 `/attachments` 入口
- 侧栏「记账」分组加入 `/attachments` 入口，`/attachments` 展示缩略图与可点击的未删除关联流水链接。
- `GET /transactions/:id/edit` 查询已有附件并渲染「凭证与附件」卡片，支持浏览原图、单删（复用 `POST /attachments/:id/delete` 并通过 `u.safeInternalPath` 校验安全回跳）与补传。
- `src/lib/attachments.ts` 抽离 `saveBufferImage`，同时服务 JSON `dataUrl` 与 `multipart/form-data` 上传；`POST /transactions/:id/attachments` 先对全部上传图片执行 MIME 白名单、8MB 上限、魔数与单笔 6 张上限预检，再直写带 `txn_id` 的附件记录，避免部分写入或二次 `UPDATE`。

### 2. 分页保留筛选、搜索分页与安全通知跳转
- `src/views/layout.ts` 提供公共组件 `paginationHtml`，基于 `URLSearchParams` 保留全部有效筛选条件，统一用于 `/transactions`（同时隐藏传递非表单筛选条件并提供清空入口）与 `/search`（类型下拉框改用 `TXN_TYPE_MAP` 全量中文标签）。
- `/notifications` 关联读取账本名称、类型与 `link`，并统一通过 `GET /notifications/:id/open` 跳转：`safeInternalPath` 仅放行单斜杠站内相对路径（拦截 `//`、`javascript:` 与控制字符）；当通知隶属用户其他未归档账本时，先只读校验成员权限并重签 `hl.sid` 切换账本后再重定向，避免跨账本跳转 404。

### 3. `/reports` 二级分类下钻与流水穿透
- `src/lib/txn.ts#subcategoryBreakdown` 输出 `category_id`，修复无分类与自定义一级分类在 `COALESCE` 筛选下的匹配问题。
- `src/views/reports.ts` 将一级分类占比渲染为可点击下钻行（`?cat=`），并新增「二级分类下钻明细」卡片，支持按所属大类筛选重置以及携带时间范围与 `category_id` 直达 `/transactions`；切换收支类型自动清空 `cat`。

### 4. 二级分类管理、规划实体编辑与订阅详情
- **分类管理**：`POST /categories` 在指定 `parent_id` 时校验归属、禁止三级嵌套并继承父级 `kind` 与 `color`；自定义二级分类渲染行内删除按钮，`POST /categories/:id/delete` 禁止删除内置分类及仍有子分类或活跃流水的分类。
- **周期账单 / 储蓄目标编辑**：补齐 `GET/POST /recurring/:id`（支持增删改明细行与动态行模板）与 `GET/POST /goals/:id`（按 `saved_cents >= target_cents` 同步状态，明确提示不自动生成流水）。
- **借贷台账编辑**：手工借贷支持全字段编辑（禁用 `'系统自动汇总'` 保留备注）；「系统自动汇总」行保持金额与方向由流水派生只读，允许通过 `/debts/:id/edit` 设置或清空 `due_date`，`syncDebts` 重建前保留已有 `(direction, counterparty) -> due_date` 映射，`POST /debts` 勾选联动流水时同步写入 `due_date`。
- **订阅删除与扣费历史**：列表增加带确认提示的「删除」按钮（只删订阅规则、保留历史扣费流水）并展示已扣期数；`/subscriptions/:id/edit` 调用 `chargesOf` 展示历史扣费明细表与流水跳转链接。

### 5. 账本级联删除、`/admin` 密码重置与全库 JSON 恢复加固
- **账本改名与级联删除**：新增 `GET /ledgers/:id/edit`（`owner`/`admin` 可改名/图标/类型/备注；仅 `owner` 可见删除卡片）。`POST /ledgers/:id/delete` 强制要求 `confirm_name === ledger.name`，删除前仅按 `attachments.rel_path` 与 `import_jobs`（`failed > 10`）收集已知 R2 key，随后在**单次 `db.batch()`** 内先按子查询删除无 `ledger_id` 列的 `transaction_tags`、其余 18 张账本子表与 `ledgers` 本身，并同步吊销绑定该账本的 `api_tokens`（写 `revoked_at`），最后删除已知 R2 对象并在删当前账本时重签 `hl.sid` 切换至剩余账本或空账本引导态（允许删除最后一个账本）。
- **`/admin` 重置密码**：用户行提供重置密码表单（支持留空随机 12 位或自定义 ≥6 位），更新密码后自增 `token_version` 并吊销全部 `api_tokens`，页面请求直接返回 `Cache-Control: no-store` 的一次性结果页展示明文新密码，不再通过 `hl.flash` Cookie 传递。
- **全库 JSON 恢复加固**：抽离 `src/lib/backup.ts`，`POST /backup/restore` 先执行 20MB 体积上限检查、JSON 解析、`app === 'homeledger'` 与 `version ∈ {1, 2}` 检查、活跃站点管理员存在性检查、非空分类检查、全行键并集与 `PRAGMA table_info` 必填列校验及内存主键/唯一键冲突预检，任意失败立即返回 400（零写库）；通过后按单句 ≤95 绑定参数拼装多行 `INSERT`，连同倒序清表与全局 `UPDATE users SET token_version = COALESCE(token_version, 1) + 1` 在**单次 `db.batch()` 事务**内原子提交，随后重算各账本余额并清除响应会话 Cookie 强制全端重新登录。

## Alternatives considered

- **将「系统自动汇总」借贷设为完全不可编辑**：可避免任何直接修改 `debts` 表的代码，但用户从记账生成的借出/借入默认无 `due_date`，完全禁编会导致无法补充到期提醒日期。因此保留金额/方向只读不变量，仅开放 `due_date` 编辑并在 `syncDebts` 中保留。
- **账本删除仅用浏览器 `confirm` 且将关联 `api_tokens.ledger_id` 置 `NULL`**：操作步骤更少，但误点删库风险极高，且令牌 `ledger_id` 置 `NULL` 后在 OpenAPI 中会静默回退到用户其他活跃账本造成越权写入。因此采用输入账本名称确认并自动吊销绑定令牌的硬边界。
- **重置密码沿用 `hl.flash` 重定向展示与全库恢复保持现有会话不断开**：实现更简单，但 `hl.flash` 会把明文密码写入明文 Cookie 随跳转回传，且 JSON 恢复可能替换全部用户或回退安全状态；改用 `no-store` 一次性结果页与恢复后全员自增 `token_version` 消除了这两类会话风险。

## Consequences

- **收益**：形成交易附件闭环、完整筛选/搜索分页与安全通知跳转、报表二级分类下钻、规划与分类完整增删改、安全的账本级联清理（无 D1 孤儿行与 R2 泄露）及原子化备份恢复，同时全部保持零禁表与零额外高频 D1/R2 读写。
- **代价与约束**：`POST /backup/restore` 受限于单次 D1 `db.batch()` 原子提交及多行参数上限（每句 ≤95 参数），超大备份体积已限制在 20MB 以内，且恢复后所有已登录端（含当前管理员）均需重新登录；测试夹具 `createSqliteD1.batch` 同步包裹 `BEGIN/COMMIT/ROLLBACK` 以真实模拟 D1 事务回滚语义。

## Verification

- 单元测试（`test/core.test.ts`）验证 `safeInternalPath` 路径防篡改拦截以及 `validateAndBuildRestorePlan` 对非法元数据、缺活跃管理员、空分类、缺必填列、重复主键/用户名、异构行键并集、宽表参数分块及 `token_version + 1` 的行为。
- 端到端全链路测试（`test/e2e.test.ts`）覆盖：交易编辑页 JSON/multipart 补传、6 张上限与单删同步删 R2；`/transactions` 与 `/search` 分页保参；`/notifications` 点击跳转、跨账本切账本与伪协议拦截；`/reports` 一级/二级分类下钻及未分类穿透；自定义二级分类增删与三级/有流水拦截；周期/借贷（含自动汇总 `due_date` 保留）/目标编辑；订阅删规则留流水与历史扣费展示；账本改名、名称核验拦截与 19 表+R2+令牌级联清理；`/admin` 重置密码 `no-store` 与旧会话失效；`/backup/restore` 坏包零污染原子拒绝与恢复后全端重登。
- 全量门禁 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 均通过。
