# Agent Note: OpenAPI 账本全资源 CRUD 与业务动作补全

Status: implemented

## Problem

此前系统在 `/api/open/*` 中仅对 `transactions` 与 `session-cards`（创建与核销/续费/撤销）提供了完整写操作，`accounts` 缺少单条查询、归档、校准与删除，`categories` 与 `tags` 缺少写接口，而五大规划模块（`budgets`、`recurring`、`subscriptions`、`debts`/`loans`、`goals`）仅提供只读 `GET` 列表，导致外部客户端、快捷指令与自动化脚本无法完成完整的账本业务闭环。

## Decision

在严格遵守 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 的 Bearer 鉴权零 D1 写入红线，以及 [account-taxonomy-and-session-cards](../../implemented/feature/2026-11-23-account-taxonomy-and-session-cards.md) 与 [p1-predeploy-hardening](../../implemented/feature/2026-11-23-p1-predeploy-hardening.md) 建立的领域不变量的前提下，将 `/api/open/*` 扩展至全部 9 类账本业务资源的完整 CRUD 与核心业务动作：

### 1. 模块组织与公共解析/归属校验层
- 新增 `src/routes/openapi-helpers.ts` 统一封装 `requireWriteApi`、`readJsonObject`、`parsePositiveIntId`、`parseBoolFlag`、`parseOptionalDate`、`parseOptionalRefId`、`parseOptionalIntRange`、`parseAmountField` 以及跨账本外键隔离校验（`assertAccountInLedger`、`assertCategoryInLedger`）。
- 所有金额写入同时兼容整数分（`*_cents`，优先）与元单位字段，所有 `PUT`/`PATCH` 均采用部分字段合并更新（未传字段保持原值）。
- 新增 `src/routes/openapi-planning.ts` 集中承载五大规划模块路由，通过 `registerPlanningOpenApi(openapiRoutes)` 挂载于 `openapiRoutes` 鉴权中间件之后，保持 Bearer Token 鉴权零写库及只读角色（`viewer`）`403` 拦截不变；多账本、成员、站点设置与全库备份恢复仍保留在 Web 端。

### 2. 五大规划模块 CRUD 与动作端点
- **预算（`/budgets`）**：支持 `GET /budgets`（默认仅返回启用项，传 `?include_inactive=1` 返回全部）、`GET /:id`、`POST`、`PUT|PATCH /:id`、`DELETE /:id`；强制校验 `category`/`account` 作用域对应的账本内引用与自定义周期 `start_date <= end_date`。
- **周期账单（`/recurring`）**：列表与单条查询在保留 `payload` 原字段的同时返回解析后的 `items` 数组，支持 `?is_active=0|1` 过滤、完整 CRUD 以及 `POST /:id/run`（先校验账户可用性再以 `next_run_at` 乐观锁抢占并批处理写入流水，重复执行返回 `409`，写库失败自动回滚抢占）。
- **订阅扣费（`/subscriptions`）**：支持 `?status=` 过滤、`GET /:id` 联带返回最近 50 条 `charges` 历史扣费记录、完整 CRUD（支持 `trial` 必填 `trial_ends_on`、`canceled` 维护 `canceled_at` 及恢复重算下次扣费日）、`POST /:id/charge`（先检账户可用性、乐观锁抢占防重返 `409`、失败回滚并发异常告警）、`POST /:id/skip` 与保留历史扣费流水的 `DELETE /:id`。
- **借贷台账（`/debts` 与 `/loans` 别名）**：支持 `?status=` 与 `?direction=` 过滤、完整 CRUD 及 `POST /:id/settle`（部分/全额结清并写入 `repay_receive`/`repay_pay` 流水）。创建时传 `create_txn: true` 联动生成 `lend`/`borrow` 流水并同步 `due_date`；对 `note = '系统自动汇总'` 的派生台账保持金额/方向只读（仅允许改 `due_date`、禁止直接删除），并在自动汇总行结清后按 `(ledger_id, direction, counterparty, note)` 重查最新行返回。
- **储蓄目标（`/goals`）**：支持 `?status=` 过滤、完整 CRUD 与 `POST /:id/deposit`（正数存入或负数按当前 `saved_cents` 上限截断取出，可选 `create_txn: true` 联动生成流水并在记账异常时回滚进度，首次达标推送幂等 `goal-done:${id}` 通知）。

### 3. 账户、次卡、分类与标签补全
- **账户（`/accounts`）**：新增 `?include_archived=1`、`GET /:id`、`PATCH` 支持 `is_archived`、`POST /:id/archive`、`POST /:id/adjust`（乐观锁校准并写 `adjust` 流水，已归档账户禁止校准）、`DELETE /:id`（存在未删除流水返回 `400`）。
- **次卡（`/session-cards`）**：补齐 `PUT|PATCH /:id`、`POST /:id/archive` 与保留购卡支出流水的 `DELETE /:id`。
- **分类（`/categories`）**：补齐 `GET /:id`、`POST`（校验两级上限并继承父级类型）、`PUT|PATCH /:id` 与 `DELETE /:id`（严格拦截内置系统分类与存在子分类或活跃流水的分类）。
- **标签（`/tags`）**：补齐 `GET /:id`、`POST`、`PUT|PATCH /:id`（同账本重名返回 `409`）与 `DELETE /:id`（同事务清理 `transaction_tags` 关联）。

## Alternatives considered

- **仅在 OpenAPI 中补齐 5 个规划模块的纯 CRUD，不开放业务动作端点与账户/次卡/分类/标签写接口**：实现面更小，但外部集成仍无法完成周期账单触发、订阅手动扣费/跳过、借贷结清、目标存取及账户余额校准与删改等高频场景，也不符合既有 `session-cards` 已提供动作端点的风格。因此一并补齐 9 类账本资源与对应动作端点，同时继续将账本/成员/站点等系统级管理边界留在 Web 端。
- **在规划写接口中新增独立的 D1 请求限流或令牌写操作审计**：可细化 API 调用风控，但违背项目极简低读写与禁止 `rate_limits`/`audit_logs` 表的红线。维持无状态鉴权零写库并将频率防护交由 Cloudflare 边缘 WAF 承担。

## Consequences

- **收益**：`/api/open/*` 全面覆盖单账本内全部 9 类业务资源的查询、增删改与核心动作流转；原有列表响应结构与过滤默认值全部保持向后兼容；所有外键引用受账本归属隔离，只读令牌统一受 `403` 拦截。
- **代价与约束**：API 端新增了若干写入入口与路由文件（`openapi-helpers.ts`、`openapi-planning.ts`），后续调整 Web 端领域规则（如借贷汇总逻辑、订阅状态机、分类层级限制）时需同步保持 `src/routes/openapi*.ts` 一致。

## Verification

- 在 `test/e2e.test.ts` 新增「OpenAPI 全资源 CRUD、业务动作与权限/跨账本隔离回归」端到端用例，覆盖 `viewer` 只读令牌 403/200、9 类资源全套 CRUD 与动作端点、重复抢占 `409`、自动汇总借贷防篡改、删订阅/次卡保留历史流水、以及账本间读写/引用隔离。
- 提交前通过 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 全部门禁。
