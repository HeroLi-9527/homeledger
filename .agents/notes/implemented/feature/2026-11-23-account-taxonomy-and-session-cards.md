# Agent Note: 资产账户分层体系与次卡支持

Status: implemented

## Problem

系统此前在 `src/constants.ts` 中将 `accounts.type` 扁平划分为 10 种类型（`cash`、`debit`、`credit`、`virtual`、`prepaid`、`investment`、`receivable`、`payable`、`loan`、`other`），虽然在内部以 `nature: 'asset' | 'liability'` 区分资产与负债，但存在三处明显缺口：

1. **账户分组与日常心智脱节**：家庭记账习惯按「资金账户 / 充值账户 / 信用账户」三层组织，10 个平铺选项混在一起，且账单导入仅识别名称含「信用」的账户，无法将花呗、白条与各类预付储值卡准确归类。
2. **信用账户与元数据编辑缺失**：`accounts` 表虽预留 `credit_limit`、`bill_day`、`due_day`、`institution`、`card_no`、`note` 列，但缺少账户编辑入口、信用额度/可用额度/倒计时展示、「去还款」快捷入口与还款日自动提醒。
3. **缺少按次计费的「次卡」台账**：洗车卡、理发卡、私教课等按次数核销的预付消费无法直接记录总次数、剩余次数、核销记录、有效期与过期/余次提醒。

## Decision

在严格遵守 [homeledger-worker-architecture](../../implemented/architecture/2026-11-23-homeledger-worker-architecture.md) 的 D1 低读写与零禁表红线的前提下，落地三层账户分组、账户元数据编辑、信用账户能力与次卡台账：

### 1. 三层账户元数据分组（向后兼容底层 `accounts.type`）
- `src/constants.ts` 保留全部 10 个底层 `accounts.type` key 不变，新增 `ACCOUNT_GROUPS` 与 `accountGroupOf(type)` / `isCreditGroupType(type)` 映射为三组：
  - **资金账户（`funds`）**：`cash`、`debit`、`virtual`、`investment`、`receivable`、`other`；
  - **充值账户（`prepaid`）**：`prepaid` 储值余额账户，并在 `/accounts` 与次卡台账并列展示；
  - **信用账户（`credit`）**：`credit`（标签为「信用卡 / 花呗 / 白条」）、`payable`、`loan`。
- `src/lib/accounts.ts` 提供 `accountOptionsHtml`，将交易表单、批量报销与搜索筛选的账户下拉框按 `<optgroup>` 三层分组展示；`src/lib/importers.ts` 增强 `ensureAccount` 自动建户识别「花呗 / 白条 / 分期」为 `credit`、「储值 / 充值 / 预付 / 会员卡 / 礼品卡」为 `prepaid`。
- 新建账本默认仍创建 5 个预设账户（现金、支付宝、微信钱包、银行卡、信用卡）；新建账户表单提供「信用卡 / 花呗 / 白条」快捷预设，新建信用组账户在 Web 端录入正数「当前待还」，后台统一取负存入 `initial_cents` 与 `balance_cents`。
- 总览页 `/` 账户卡片顶部展示三层摘要与有效次卡余次入口；`/accounts` 按三大区块展示分组小计与明细，底部折叠归档账户及已归档/用完次卡。

### 2. 账户编辑与信用账户指标/还款/提醒
- `GET/POST /accounts/:id/edit`（及 `/accounts/:id` 详情页）开放名称、类型、图标、币种、机构/平台、卡号后四位、排序、备注、是否计入净资产及信用字段（`credit_limit` 以分存储、`bill_day` / `due_day` 1–31）编辑；编辑不直接改写 `initial_cents` 与 `balance_cents`，余额修正继续统一走 `/accounts/:id/adjust` 生成 `adjust` 流水以保持 `recalcBalances` 一致。
- `creditMetrics` 计算当前待还、总额度、剩余可用额度、使用率进度条与 `nextMonthlyDay` 账单日/还款日倒计时（月末如 31 日自动按目标月天数截断）；信用卡片提供「去还款」按钮跳转至预填转账页 `/transactions/new?type=transfer&to_account_id=<id>&amount=<待还>`，且路由在未指定 `account_id` 时自动选取非目标资金账户作为默认转出账户。
- 每 4 小时 Cron 在 `checkCreditAccounts` 中仅扫描 `is_archived = 0 AND due_day BETWEEN 1 AND 31 AND balance_cents < 0` 的账户，在还款日前 3 天内通过 `notifications.dedupe_key`（`credit-due:<id>:<cycleKey>`）推送当期幂等提醒。

### 3. 次卡（Session Cards）独立台账与生命周期
- 新增迁移 `migrations/0003_session_cards.sql` 建立 `session_cards` 与 `session_card_logs` 两张业务表，并加入 `src/routes/admin.ts` 的 `BACKUP_TABLES` 纳入全库 JSON 备份与恢复。
- 次卡采用**「购卡即一次性支出（可选联动）+ 核销仅作次数台账、不计入净资产」**财务口径：
  - 开卡支持默认勾选「同步记一笔购卡支出」（同流程写入 `expense` 流水并记录 `purchase_txn_id`），取消勾选可直接补录存量老卡（允许 `remaining_sessions < total_sessions`）；
  - 核销使用 `UPDATE session_cards SET remaining_sessions = remaining_sessions - ? ... WHERE ... AND is_archived = 0 AND remaining_sessions >= ?` 条件原子扣减，确认 `changes === 1` 后再写 `session_card_logs`，防止并发超扣产生孤儿日志；
  - 详情页 `/session-cards/:id` 支持核销 N 次、同卡续费/加次（可选同步记支出）、编辑元数据、撤销历史核销（原子删日志并回补余次）、归档与删除（删除次卡仅删次卡及日志，不级联删除已产生的购卡支出流水）；过期次卡展示「已过期」徽章但不硬锁死核销；
  - 每 4 小时 Cron 的 `checkSessionCards` 对未归档且有余次的次卡分别在到期前 7 天、已过期仍有余次、以及 `total_sessions > 2 && remaining_sessions <= 2` 时发送幂等通知。

### 4. OpenAPI 同步扩展
- `src/routes/openapi.ts` 扩展 `GET /api/open/accounts`（附加 `group`、`credit` 与 `groups` 汇总，保留原字段兼容）、扩展 `POST /api/open/accounts`（支持信用字段与 `debt` / `debt_cents`，兼容原 `initial_cents` / `balance`）、新增 `PATCH/PUT /api/open/accounts/:id`，并新增 `/api/open/session-cards` 查询、开卡、核销、续费与撤销端点，维持 Bearer 鉴权纯只读红线。

账户原币、余额校准与重算按[账户币种与恢复边界](../bug-fix/2026-11-25-ledger-integrity-and-recovery.md)执行。

## Alternatives considered

- **在 `accounts` 表直接新增次卡字段并按次核销摊销生成 `expense` 流水**：共用 `accounts` 表可复用现有账户列表与权限逻辑，但把「按次计数」塞进人民币 `balance_cents` 与净资产汇总，且核销摊销必须在购卡时先做 `transfer` 资产转移并处理末次分位尾差、报销与预算双重口径冲突。经访谈对齐后，选择独立 `session_cards` + `session_card_logs` 两张表并将财务口径定为「购卡即支出、核销仅作次数台账」，彻底解耦净资产与余次管理。
- **在 `accounts.type` 中拆出 `huabei`、`baitiao` 等新类型 key**：可区分更细的互联网信用品牌，但会增加交易类型/图表/导入判断分支并改变历史数据语义；保留 `credit` 底层 key 并结合 `institution` 字段与三层元数据分组已能满足展示与向后兼容。
- **允许账户编辑页直接改写 `initial_cents`**：适合修正建卡录入错误但不留调账记录，但破坏「余额变动皆有流水可溯」与 `recalcBalances` 审计链路，因此编辑页限定为元数据修改，余额修正统一通过 `/accounts/:id/adjust`。

## Consequences

- **收益**：`/accounts`、总览卡片与记账账户选择器实现资金/充值/信用三层清晰组织；花呗/白条/信用卡具备额度管理、账期倒计时、预填还款与到期提醒；次卡支持开卡联动支出、老卡补录、原子扣减防超扣、撤销回补、同卡续费与过期/余次提醒，且不污染净资产与现有 14 种交易逻辑。
- **代价与约束**：数据库新增 `session_cards` 与 `session_card_logs` 两张表，已部署环境需执行 `migrations/0003_session_cards.sql`；购卡费用在开卡/续费当期一次性计入支出，不按核销月份分摊，适合家庭轻量消费记账，不适用于企业权责发生制摊销核算。

## Verification

- 通过 `test/core.test.ts` 验证 `accountGroupOf`、`isCreditGroupType`、`nextMonthlyDay`（含 2 月月末截断与跨月跨年）、`creditMetrics` 与 `decorateCard`。
- 通过 `test/e2e.test.ts` 验证：新建信用账户正数待还自动取负、`/accounts` 三层分区与「去还款」预填转账、账户元数据编辑保持 `initial_cents`/`balance_cents` 不变、CSV 导入自动识别花呗/白条为 `credit`、次卡开卡联动支出与老卡补录、核销原子防超扣与撤销回补、续费加次、删卡不删历史流水、OpenAPI 账户编辑与次卡核销、Cron 信用与次卡提醒幂等去重、JSON 全库备份恢复保留次卡数据以及无账本防 500 保护。
- 全量门禁 `npm run verify-notes`、`npm run typecheck` 与 `npm test` 均通过。
