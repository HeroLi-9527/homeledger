# Agent Note: 补齐关于页、规划细节、AI/CSV 加固、OpenAPI 兼容与 PWA 移动端体验

Status: implemented

## Problem

在完成基础账本与 [openapi-full-crud](../../implemented/feature/2026-11-24-openapi-full-crud.md) 后，当前 Workers 版在若干交互与防呆细节上仍与单机参考实现存在差距：缺少 `/about` 介绍与更新日志页、缺少多表账户删前引用检查与单笔报销核销、AI 文本解析/聊天助手在多图落盘清理与自然键去重上存在孤儿风险、首页/搜索/报表缺少部分筛选项与星期支出维度、预算/订阅/周期/目标在日期交叉与试用期边界缺少强校验、CSV 导入预览缺少有效期限制且导出受 200 条分页上限截断、OpenAPI 对部分旧端点的字段/路径兼容仍不完整，且 PWA 图标文件与移动端底部导航栏尚未补齐。

## Decision

在严守 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 与 [p1-predeploy-hardening](../../implemented/feature/2026-11-23-p1-predeploy-hardening.md) 建立的低读写、零额外状态表及严苛 CSP 约束下，系统现已落地以下完整补齐方案：

### 1. 关于页、PWA 图标与移动端响应式交互
- 新增 `src/lib/about.ts` 与 `src/routes/about.ts` 提供受登录保护的 `GET /about`（版本特性、更新日志与技术栈链接，外链统一 `noopener noreferrer`），并在侧边栏、移动端底部 5 键导航栏（区分可写/只读账本成员）及 `manifest.webmanifest` / `sw.js`（`PRECACHE = 'homeledger-static-v2'`）中接入实存 PNG 图标（`public/icons/icon-192.png`、`icon-512.png`、`icon-512-maskable.png`）。
- 仅当当前账本角色可写（`canWrite(ctx.ledger.role)`）时渲染 `#aiFab`、`#aiPanel` 并加载 `/js/assistant.js`；在 `public/js/app.js` 中统一挂载分类父级快速跳转、AI 模型 `dataset.vision` 自动同步及 `autoSave` 自动入账、`Escape` 关闭、轻量图片灯箱 `[data-zoom]`（替代原 `<a target="_blank">` 外链跳转）与头像菜单直接触发上传。

### 2. 账户删前防呆、分类/标签编辑与单笔报销修复
- 在 `src/lib/accounts.ts` 提供 `findAccountReferences`、`formatAccountRefError` 与原子条件删除辅助 `deleteAccountIfUnreferenced`，Web 端与 OpenAPI 的账户删除在查流水前先校验 6 张引用表（`transactions`、`subscriptions`、`recurring_rules`、`budgets`、`goals`、`debts`），并在 `DELETE` 语句附带 `NOT EXISTS` 守卫防止并发竞态。
- Web 端补齐自定义分类行内编辑（`POST /categories/:id`，拒绝系统或跨账本分类）与标签行内改名（`POST /tags/:id`，重名拦截）。
- 交易编辑页为未报销的可报销支出提供单笔一键报销入口（`POST /transactions/:id/reimburse`），`markReimbursed` 将报销入账插入、原支出 `reimbursed_at` + `related_id` 更新与余额变动合并进同一 D1 批次；在 `src/lib/scheduler.ts` 新增 `repairReimbursedLinks(db)` 随每 4 小时定时任务以纯 SQL 仅清理明确指向无效/已删报销单的 `related_id IS NOT NULL` 孤儿标记。

### 3. AI 记账加固、仪表盘/搜索/报表补全与规划边界校验
- `src/routes/ai.ts` 与 OpenAPI `POST /api/open/ai/bill` 统一限制文本上限 4000 字符，在调用模型前先行完成 `data:` URL 格式/MIME/魔数/大小校验（`validateRawImages`），有条目时再以 `pending` 状态尽力存图（且 D1 写入失败时立即反向删 R2），部分落账成功仍返回实际写入结果并关联图片，全失败时清理孤儿图；草稿确认保留并可编辑识别 `currency` 且仅按 `draft_id` 判重，无草稿自动入账接口使用同账户、同币种、同金额 120 秒防抖窗口并排除当次同批已入账 ID。
- `GET /` 补全本月收入分类 TOP6、今日记账笔数与未来 4 笔定期账单预告；`GET /search` 补齐 `member_id`、`tag_id`、`source`、`min`/`max` 并保留于分页链接；`GET /reports` 支持 `custom` 自定义日期范围、`year` 年份选择及周一至周日「星期分布（支出）」统计。
- 预算创建/编辑支持 `trigger_type`/`currency`（均校验汇率存在并换算为本位币后再与支出/结转比较）与自定义 `start_date <= end_date` 校验；Web 预算/周期/订阅/目标写入均复用同账本账户与分类校验，并在相关 `LEFT JOIN` 中限定账本隔离；订阅在试用期内拦截手动提前扣费；储蓄目标存入采用 `saved_cents` 乐观锁与相对增量回滚，防止并发更新丢失。

### 4. CSV 导入/导出加固与 OpenAPI 兼容扩展
- CSV 导入预览写入 `created_at` 时间戳并在 `/api/import/commit` 执行 2 小时 TTL 校验（过期即删除预览 R2 对象并拒绝提交；生产部署建议配合对 R2 `imports/preview-` 前缀设置自动生命周期过期以回收弃置预览），预览响应补齐 `neutralSample`、`skippedDates` 与 `guess_account_missing`。
- `src/lib/txn.ts` 新增基于 `(txn_date, id)` 键集游标的 `iterateAllForExport` 与 `listAllForExport`，`GET /export/csv` 与 `GET /api/open/export` 均通过 `ReadableStream` 分批流式输出全量流水，移除 200 行截断与 `OFFSET` 偏移重漏风险。
- OpenAPI 新增 `POST /api/open/recurring/:id/pay` 兼容别名（支持 `kind` 分流；未传 `kind` 且 ID 同时命中周期规则与订阅时返回 `409` 消除歧义），在 `POST /api/open/transactions` 支持中文 `type` 别名、`date`、`category`/`category_name` 与先校验/先截断再按需 `account` 自动创建（入账失败时补偿删除新建空账户），扩展 `/api/open/overview` 与 `/api/open/reports` 字段并保留既有键名向后兼容，新增管理员专属 `GET /api/open/export?scope=full` 全库 JSON 导出。

## Alternatives considered

- **通过新增独立 D1 表（如 `ai_sessions` 或 `import_previews`）存储 AI 对话与 CSV 预览元数据**：可减轻 R2 与前端状态依赖，但会额外引入表结构与清理成本，且导入预览仅属于短时临时对象。利用现有 `attachments`（`pending`/`linked` 状态机 + 4 小时清理）与预览 JSON 内的 `created_at` 即可零新增表完成生命周期管理。
- **使用客户端独立第三方前端框架或图标生成库在线构建图标**：会破坏项目零构建步骤、纯 Workers 原生部署与严格 CSP 模型，因此将离线生成的多尺寸静态 PNG 图标直接纳入 `public/icons/` 并通过原生 JS 事件委托完成前端增强。

## Consequences

- **收益**：核心 Web 功能、AI 账单助手、CSV 导入导出、OpenAPI 生态兼容及移动端 PWA 体验均达到完整可用标准，全链路继续保持零新增 D1 表与极低日常读写。
- **代价与约束**：`assistant.js` 与 `app.js` 承担了轻量交互增强逻辑，后续调整 DOM ID 或 API JSON 键名时需同步核对脚本选择器；CSV 预览依赖内置 `created_at` 超过 2 小时自动失效，大批量导出按 1000 行分批执行以避免 Worker 单次内存峰值过高。

## Verification

- 在 `test/core.test.ts` 补充 `parseReportRange` 自定义/反转日期与 `about` 模块元数据的单元测试。
- 在 `test/e2e.test.ts` 新增端到端回归用例覆盖 `/about`、静态 PNG 图标、多表账户删前阻断、自定义分类/标签编辑、单笔报销与孤立引用修复、AI 4000 字拦截/零孤儿图/自然键去重、搜索/报表新维度、试用期订阅阻断扣费、CSV 预览 TTL 与超 200 行全量导出，以及 OpenAPI 兼容别名、中文字段创建、丰富总览/报表与全库导出权限控制。
- 提交前通过 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 全部门禁。
