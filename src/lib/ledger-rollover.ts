import { accountBalanceCtes, nowStr, todayStr } from '../db.js';
import type { AccountRow, BatchStatement, Db, LedgerRow, SessionCardRow } from '../types.js';
import { debtBalancesCte, debtScope } from './debt-balances.js';

type ClosingAccount = AccountRow & { closing_cents: number };
type ClosingDebt = {
  direction: string; counterparty: string; currency: string;
  account_id: number | null; due_date: string | null; note: string | null; balance_cents: number;
};
type NextPeriod = { id: number; name: string; next_date: string; automatic: number; pending: number };
type NewYearTxn = { id: number; txn_date: string; type: string; amount_cents: number; currency: string; note: string | null };
type CardAction = { name: string; activity_date: string };

export class RolloverError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}

// Stored balances include live changes. Undo signed new-year deltas, excluding frozen KAP history.
const closingAccounts = `
  WITH scope(ledger_id, boundary) AS (VALUES (?, ?)),
  balance_txns AS (
    SELECT t.* FROM transactions t, scope s
    WHERE t.ledger_id = s.ledger_id AND t.deleted_at IS NULL AND t.txn_date >= s.boundary
      AND COALESCE(t.source, '') <> 'kap-import'
  ), ${accountBalanceCtes}
  SELECT a.*, a.balance_cents - COALESCE(t.delta, 0) AS closing_cents
  FROM accounts a JOIN scope s ON s.ledger_id = a.ledger_id LEFT JOIN totals t ON t.id = a.id
  WHERE a.created_at < s.boundary AND (a.is_archived = 0 OR a.balance_cents - COALESCE(t.delta, 0) <> 0)`;

const closingDebts = `${debtScope}${debtBalancesCte}
  SELECT * FROM outstanding_debts`;
const newYearTransactions = `SELECT id, txn_date, type, amount_cents, currency, note FROM transactions
  WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date >= ?`;
const unresolvedAccountTransactions = `SELECT id, txn_date, type, amount_cents, currency, note FROM transactions
  WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date < ? AND (
    (account_id IS NOT NULL AND account_amount_cents IS NULL AND (type <> 'invest_sell' OR to_account_id IS NOT NULL))
    OR (to_account_id IS NOT NULL AND to_account_amount_cents IS NULL AND type IN ('transfer','invest_buy','invest_sell'))
  )`;
const closingCards = `SELECT * FROM session_cards
  WHERE ledger_id = ? AND is_archived = 0 AND remaining_sessions > 0 AND (expires_at IS NULL OR expires_at >= ?)`;
const newYearCardActions = `
  SELECT id AS card_id, name, purchase_date AS activity_date FROM session_cards WHERE ledger_id = ? AND purchase_date >= ?
  UNION
  SELECT c.id, c.name, log.used_at FROM session_card_logs log JOIN session_cards c ON c.id = log.card_id
  WHERE log.ledger_id = ? AND log.used_at >= ?`;
const ruleItems = `json_each(CASE
  WHEN json_type(r.payload) = 'array' THEN r.payload
  WHEN json_type(r.payload, '$.items') = 'array' THEN json_extract(r.payload, '$.items')
  ELSE json_array(json(r.payload)) END)`;
const newYearAccounts = 'SELECT id FROM accounts WHERE ledger_id = ? AND created_at >= ?';
const newYearManualDebts = `SELECT id FROM debts WHERE ledger_id = ? AND created_at >= ?
  AND opening_cents = 0 AND note IS NOT '系统自动汇总'`;
const pendingPurges = `SELECT id FROM transactions WHERE ledger_id = ? AND purge_started = 1
  UNION ALL SELECT id FROM attachments WHERE ledger_id = ? AND delete_started = 1`;
const badRuleAccounts = `SELECT r.name FROM recurring_rules r
  WHERE r.ledger_id = ? AND r.is_active = 1 AND EXISTS (
    SELECT 1 FROM ${ruleItems} item
    WHERE (NULLIF(json_extract(item.value, '$.account_id'), '') IS NOT NULL OR
           ABS(json_extract(item.value, '$.amount_cents')) > 0)
      AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = r.ledger_id AND a.is_archived = 0
        AND a.id = json_extract(item.value, '$.account_id'))
      OR NULLIF(json_extract(item.value, '$.to_account_id'), '') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = r.ledger_id AND a.is_archived = 0
        AND a.id = json_extract(item.value, '$.to_account_id'))
  )`;
const badSubscriptionAccounts = `SELECT s.name FROM subscriptions s
  WHERE s.ledger_id = ? AND s.status IN ('active','trial') AND (
    (s.auto_renew = 1 AND s.account_id IS NULL)
    OR (s.account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id = s.account_id AND a.ledger_id = s.ledger_id AND a.is_archived = 0
    ))
  )`;
const recurringDate = `COALESCE((
    SELECT MIN(COALESCE(t.scheduled_period, t.txn_date)) FROM transactions t
    WHERE t.ledger_id = r.ledger_id AND t.source = 'recurring' AND t.deleted_at IS NOT NULL
      AND COALESCE(t.scheduled_period, t.txn_date) >= ? AND COALESCE(t.scheduled_period, t.txn_date) < r.next_run_at
      AND (t.recurring_rule_id = r.id OR (t.recurring_rule_id IS NULL AND EXISTS (
        SELECT 1 FROM ${ruleItems} item
        WHERE COALESCE(NULLIF(json_extract(item.value, '$.note'), ''), r.name) = t.note
          AND json_extract(item.value, '$.account_id') IS t.account_id
          AND COALESCE(json_extract(item.value, '$.type'), 'expense') = t.type
      )))
  ), r.next_run_at)`;
const recurringPeriods = `SELECT r.id, r.name, ${recurringDate} AS next_date, r.auto_post AS automatic, 1 AS pending
  FROM recurring_rules r WHERE r.ledger_id = ? AND r.is_active = 1`;
const subscriptionDate = `CASE WHEN s.status = 'trial' THEN MAX(s.next_charge_at, COALESCE(s.trial_ends_on, s.next_charge_at)) ELSE s.next_charge_at END`;
const chargePeriod = 'COALESCE(t.scheduled_period, t.txn_date)';
const removedNewYearCharges = `FROM transactions t
  WHERE t.ledger_id = s.ledger_id AND t.subscription_id = s.id AND t.deleted_at IS NOT NULL
    AND ${chargePeriod} >= ? AND ${chargePeriod} < ${subscriptionDate}`;
const resumedSubscriptionDate = `COALESCE((SELECT MIN(${chargePeriod}) ${removedNewYearCharges}), ${subscriptionDate})`;
const subscriptionPeriods = `SELECT s.id, s.name, ${resumedSubscriptionDate} AS next_date,
  CASE WHEN s.auto_renew = 1 THEN 1 ELSE 0 END AS automatic,
  (s.status = 'active' OR s.trial_ends_on IS NULL OR s.trial_ends_on < ?) AS pending
  FROM subscriptions s WHERE s.ledger_id = ? AND s.status IN ('active','trial')`;
const targetId = '(SELECT rolled_over_to_id FROM ledgers WHERE id = ?)';
const notice = '外部 OpenAPI 客户端请签发默认指向新账本的令牌。';

const readLedger = (db: Db, id: number) => db.get<LedgerRow>('SELECT * FROM ledgers WHERE id = ?', id);

export function rolloverPeriod(existingYear: number | null | undefined, requested?: number, today = todayStr()) {
  const currentYear = Number(today.slice(0, 4));
  const targetYear = requested ?? (existingYear == null ? currentYear : existingYear + 1);
  if (!Number.isInteger(targetYear) || targetYear < 1001 || targetYear > currentYear + 1 ||
      (existingYear != null && targetYear !== existingYear + 1)) {
    throw new RolloverError('请选择有效的相邻结转年度', 400);
  }
  const boundary = `${targetYear}-01-01`;
  const closingDay = `${targetYear - 1}-12-31`;
  return { targetYear, boundary, cutoffDate: `${closingDay} 23:59:59`, periodClosed: today >= boundary };
}

function defaultName(ledger: LedgerRow, targetYear: number) {
  const previousSuffix = ` ${ledger.rollover_year}`;
  const base = ledger.rollover_year && ledger.name.endsWith(previousSuffix)
    ? ledger.name.slice(0, -previousSuffix.length) : ledger.name;
  return `${base.slice(0, 25)} ${targetYear}`;
}

export async function previewLedgerRollover(db: Db, ledgerId: number, targetYear?: number) {
  if (!Number.isSafeInteger(ledgerId) || ledgerId < 1) throw new RolloverError('账本不存在', 404);
  const ledger = await readLedger(db, ledgerId);
  if (!ledger) throw new RolloverError('账本不存在', 404);
  const period = rolloverPeriod(ledger.rollover_year, targetYear);
  const { boundary } = period;
  const results = await db.batch([
    [`SELECT * FROM (${closingAccounts}) ORDER BY sort_order, id`, [ledgerId, boundary]],
    [`SELECT direction, counterparty, currency, account_id, due_date, note, balance_cents
      FROM (${closingDebts}) ORDER BY carry_kind, id`, [ledgerId, boundary]],
    [`${closingCards} ORDER BY id`, [ledgerId, boundary]],
    [`${recurringPeriods} ORDER BY next_date, id`, [boundary, ledgerId]],
    [`${subscriptionPeriods} ORDER BY next_date, id`, [boundary, boundary, ledgerId]],
    [`${newYearTransactions} ORDER BY txn_date, id`, [ledgerId, boundary]],
    [`SELECT * FROM (${newYearCardActions}) ORDER BY activity_date, card_id`, [ledgerId, boundary, ledgerId, boundary]],
    [`${unresolvedAccountTransactions} ORDER BY txn_date, id`, [ledgerId, boundary]],
    [newYearAccounts, [ledgerId, boundary]],
    [newYearManualDebts, [ledgerId, boundary]],
    [badRuleAccounts, [ledgerId]],
    [badSubscriptionAccounts, [ledgerId]],
    [pendingPurges, [ledgerId, ledgerId]],
  ]);
  const accounts = results[0].results as ClosingAccount[];
  const debts = results[1].results as ClosingDebt[];
  const sessionCards = (results[2].results as SessionCardRow[]).map((card) => ({
    ...card,
    carry_cost_cents: Math.round(card.total_cost_cents * card.remaining_sessions / card.total_sessions),
  }));
  const recurringRules = results[3].results as NextPeriod[];
  const subscriptions = results[4].results as NextPeriod[];
  const blockingTransactions = results[5].results as NewYearTxn[];
  const blockingCardActions = results[6].results as CardAction[];
  const unresolvedTransactions = results[7].results as NewYearTxn[];
  const blockingPeriods = [...recurringRules, ...subscriptions].filter((item) => item.pending && item.next_date < boundary);
  const blockers: string[] = [];
  if (ledger.is_archived) blockers.push('账本已归档');
  if (!period.periodClosed) blockers.push('旧年度尚未结束，元旦起可确认结转');
  if (unresolvedTransactions.length) blockers.push('请先补齐旧年度流水的账户原币金额');
  if (blockingTransactions.length) blockers.push('请先核对或清理旧账本中的新年度流水');
  if (blockingCardActions.length) blockers.push('请先核对旧账本中新年度的次卡购买、续费或核销记录');
  if (blockingPeriods.length) blockers.push('请先核对旧年度未处理的周期账单和订阅期次');
  if (results[8].results.length) blockers.push('请先清理旧账本中新年度创建的账户');
  if (results[9].results.length) blockers.push('请先清理旧账本中新年度创建的手工借贷');
  const badAccounts = [...results[10].results, ...results[11].results] as { name: string }[];
  if (badAccounts.length) blockers.push(`请先为以下周期账单或订阅更换不可用的账户：${badAccounts.map((item) => item.name).join('、')}`);
  if (results[12].results.length) blockers.push('请先完成流水或附件的永久删除');
  return {
    ledgerId, ledgerName: ledger.name, ...period, name: defaultName(ledger, period.targetYear),
    accounts, debts, sessionCards, recurringRules, subscriptions,
    blockingTransactions, unresolvedTransactions, blockingCardActions, blockingPeriods, blockers, canConfirm: blockers.length === 0,
  };
}

// Copy in source ID order. The corresponding row number gives each new ID inside the same transaction.
function copiedIds(table: 'accounts' | 'categories', source: string) {
  return `WITH source AS (${source}),
    old_ids AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM source),
    new_ids AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM ${table} WHERE ledger_id = ${targetId})
    SELECT old_ids.id AS old_id, new_ids.id AS new_id FROM old_ids JOIN new_ids USING(n)`;
}

export async function requireRolloverOwner(db: Db, ledgerId: number, userId: number) {
  if (!Number.isSafeInteger(ledgerId) || ledgerId < 1) throw new RolloverError('账本不存在', 404);
  const ledger = await db.get<LedgerRow>(
    `SELECT l.* FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
     WHERE l.id = ? AND l.owner_id = ? AND m.user_id = l.owner_id AND m.role = 'owner'`, ledgerId, userId,
  );
  if (!ledger) throw new RolloverError('仅账本所有者可执行年度结转', 403);
  return ledger;
}

export async function executeLedgerRollover(
  db: Db, ledgerId: number, userId: number, options: { targetYear?: number; name?: string } = {},
) {
  const ledger = await requireRolloverOwner(db, ledgerId, userId);
  const existing = async (source: LedgerRow) => {
    if (source.rolled_over_to_id == null) return null;
    const target = await readLedger(db, source.rolled_over_to_id);
    if (!target) throw new RolloverError('该账本已结转，目标账本已被删除', 409);
    if (options.targetYear !== undefined && options.targetYear !== target.rollover_year) {
      throw new RolloverError('该账本已结转至其他年度', 409);
    }
    return { ledgerId: target.id, targetYear: target.rollover_year!, alreadyCompleted: true, message: notice };
  };
  const previous = await existing(ledger);
  if (previous) return previous;

  const { boundary, periodClosed, targetYear } = rolloverPeriod(ledger.rollover_year, options.targetYear);
  const name = options.name?.trim() || defaultName(ledger, targetYear);
  if (name.length > 30) throw new RolloverError('账本名称不能超过 30 字', 400);
  if (!periodClosed) throw new RolloverError('旧年度尚未结束，元旦起可确认结转', 409);
  if (ledger.is_archived) throw new RolloverError('账本已归档', 409);

  const stamp = nowStr();
  const accountSource = [ledgerId, boundary];
  const accountMap = copiedIds('accounts', closingAccounts);
  const categoryMap = copiedIds('categories', 'SELECT id FROM categories WHERE ledger_id = ?');
  const statements: BatchStatement[] = [
    // Abort the batch if an earlier writer committed an incompatible change.
    [`INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, sort_order, created_at, rollover_year)
      SELECT CASE WHEN is_archived = 0 AND owner_id = ? AND rolled_over_to_id IS NULL
        AND EXISTS (SELECT 1 FROM ledger_members m WHERE m.ledger_id = ledgers.id AND m.user_id = owner_id AND m.role = 'owner')
        AND NOT EXISTS (${newYearTransactions})
        AND NOT EXISTS (${unresolvedAccountTransactions})
        AND NOT EXISTS (${newYearCardActions})
        AND NOT EXISTS (${newYearAccounts})
        AND NOT EXISTS (${newYearManualDebts})
        AND NOT EXISTS (${badRuleAccounts})
        AND NOT EXISTS (${badSubscriptionAccounts})
        AND NOT EXISTS (${pendingPurges})
        AND NOT EXISTS (SELECT 1 FROM (${recurringPeriods}) WHERE next_date < ?)
        AND NOT EXISTS (SELECT 1 FROM (${subscriptionPeriods}) WHERE pending AND next_date < ?)
        THEN ? END, kind, currency, icon, color, owner_id, note, sort_order, ?, ?
      FROM (SELECT 1) LEFT JOIN ledgers ON ledgers.id = ?`,
      [userId, ledgerId, boundary, ledgerId, boundary, ledgerId, boundary, ledgerId, boundary,
        ledgerId, boundary, ledgerId, boundary, ledgerId, ledgerId, ledgerId, ledgerId,
        boundary, ledgerId, boundary, boundary, boundary, ledgerId, boundary,
        name, stamp, targetYear, ledgerId]],
    ['UPDATE ledgers SET rolled_over_to_id = last_insert_rowid(), is_archived = 1 WHERE id = ?', [ledgerId]],
    [`INSERT INTO ledger_members (ledger_id, user_id, role, nickname, joined_at)
      SELECT ${targetId}, user_id, role, nickname, ? FROM ledger_members WHERE ledger_id = ?`, [ledgerId, stamp, ledgerId]],
    [`INSERT INTO tags (ledger_id, name, color) SELECT ${targetId}, name, color FROM tags WHERE ledger_id = ?`, [ledgerId, ledgerId]],
    [`INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day,
        due_day, institution, card_no, note, include_in_net, is_archived, sort_order, created_at)
      SELECT ${targetId}, name, type, icon, currency, closing_cents, closing_cents, credit_limit, bill_day,
        due_day, institution, card_no, note, include_in_net, is_archived, sort_order, ?
      FROM (${closingAccounts}) ORDER BY id`, [ledgerId, `${boundary} 00:00:00`, ...accountSource]],
    [`INSERT INTO categories (ledger_id, parent_id, name, kind, icon, color, is_system, is_archived, sort_order)
      SELECT ${targetId}, NULL, name, kind, icon, color, is_system, is_archived, sort_order
      FROM categories WHERE ledger_id = ? ORDER BY id`, [ledgerId, ledgerId]],
    [`WITH mapping AS (${categoryMap})
      UPDATE categories AS c SET parent_id = COALESCE(
        (SELECT new_id FROM mapping WHERE old_id = original.parent_id),
        (SELECT id FROM categories WHERE id = original.parent_id AND ledger_id IS NULL)
      )
      FROM mapping m JOIN categories original ON original.id = m.old_id
      WHERE c.id = m.new_id AND original.parent_id IS NOT NULL`, [ledgerId, ledgerId]],
    [`WITH accounts_map AS (${accountMap})
      INSERT INTO debts (ledger_id, direction, counterparty, currency, account_id, due_date, note,
        principal_cents, balance_cents, opening_cents, status, created_at)
      SELECT ${targetId}, d.direction, d.counterparty, d.currency, a.new_id, d.due_date, d.note,
        d.balance_cents, d.balance_cents, d.balance_cents, 'open', ?
      FROM (${closingDebts}) d LEFT JOIN accounts_map a ON a.old_id = d.account_id ORDER BY d.carry_kind, d.id`,
      [...accountSource, ledgerId, ledgerId, `${boundary} 00:00:00`, ledgerId, boundary]],
    [`INSERT INTO session_cards (ledger_id, name, icon, merchant, total_sessions, remaining_sessions,
        total_cost_cents, currency, purchase_date, expires_at, note, created_at, updated_at)
      SELECT ${targetId}, name, icon, merchant, remaining_sessions, remaining_sessions,
        ROUND(1.0 * total_cost_cents * remaining_sessions / total_sessions), currency, ?, expires_at, note, ?, ?
      FROM (${closingCards})`, [ledgerId, boundary, stamp, stamp, ledgerId, boundary]],
    [`WITH accounts_map AS (${accountMap}), category_map AS (${categoryMap})
      INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, weekday,
                                    next_run_at, last_run_at, auto_post, created_by_user_id, created_at)
      SELECT ${targetId}, r.name, json_object(
        'user_id', CASE WHEN json_type(r.payload) = 'object' THEN json_extract(r.payload, '$.user_id') END,
        'items', json((SELECT json_group_array(json_set(item.value,
          '$.account_id', a.new_id, '$.to_account_id', b.new_id,
          '$.category_id', COALESCE(c.new_id, global.id)
        ) ORDER BY item.key)
        FROM ${ruleItems} item
        LEFT JOIN accounts_map a ON a.old_id = json_extract(item.value, '$.account_id')
        LEFT JOIN accounts_map b ON b.old_id = json_extract(item.value, '$.to_account_id')
        LEFT JOIN category_map c ON c.old_id = json_extract(item.value, '$.category_id')
        LEFT JOIN categories global ON global.id = json_extract(item.value, '$.category_id') AND global.ledger_id IS NULL
        ))
      ), r.frequency, r.interval_n, r.day_of_month, r.weekday, ${recurringDate}, r.last_run_at, r.auto_post, r.created_by_user_id, ?
      FROM recurring_rules r WHERE r.ledger_id = ? AND r.is_active = 1`,
      [...accountSource, ledgerId, ledgerId, ledgerId, ledgerId, boundary, stamp, ledgerId]],
    [`WITH accounts_map AS (${accountMap}), category_map AS (${categoryMap})
      INSERT INTO subscriptions (ledger_id, name, icon, plan, vendor_url, amount_cents, currency, cycle, cycle_n,
        anchor_month, anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at, last_charge_at,
        reminder_days, charge_count, status, note, created_by_user_id, created_at)
      SELECT ${targetId}, s.name, s.icon, s.plan, s.vendor_url, s.amount_cents, s.currency, s.cycle, s.cycle_n,
        s.anchor_month, s.anchor_day, a.new_id, COALESCE(c.new_id, global.id),
        CASE WHEN s.auto_renew = 1 THEN 1 ELSE 0 END, s.trial_ends_on,
        ${resumedSubscriptionDate},
        CASE WHEN EXISTS (SELECT 1 ${removedNewYearCharges} AND ${chargePeriod} = s.last_charge_at) THEN (
          SELECT MAX(${chargePeriod}) FROM transactions t
          WHERE t.ledger_id = s.ledger_id AND t.subscription_id = s.id AND t.deleted_at IS NULL
        ) ELSE s.last_charge_at END, s.reminder_days,
        MAX(0, s.charge_count - (SELECT COUNT(DISTINCT ${chargePeriod}) ${removedNewYearCharges})),
        s.status, s.note, s.created_by_user_id, ?
      FROM subscriptions s LEFT JOIN accounts_map a ON a.old_id = s.account_id
      LEFT JOIN category_map c ON c.old_id = s.category_id
      LEFT JOIN categories global ON global.id = s.category_id AND global.ledger_id IS NULL
      WHERE s.ledger_id = ? AND s.status IN ('active','trial')`,
      [...accountSource, ledgerId, ledgerId, ledgerId, ledgerId, boundary, boundary, boundary, stamp, ledgerId]],
    ['UPDATE recurring_rules SET is_active = 0 WHERE ledger_id = ? AND is_active = 1', [ledgerId]],
    ["UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE ledger_id = ? AND status IN ('active','trial')", [stamp, ledgerId]],
  ];

  try {
    const [created] = await db.batch(statements);
    if (created.meta.changes !== 1) throw new RolloverError('账本不存在', 404);
    return { ledgerId: Number(created.meta.last_row_id), targetYear, alreadyCompleted: false, message: notice };
  } catch (error) {
    const source = await requireRolloverOwner(db, ledgerId, userId);
    const completed = await existing(source);
    if (completed) return completed;
    const preview = await previewLedgerRollover(db, ledgerId, targetYear);
    if (!preview.canConfirm) throw new RolloverError(preview.blockers.join('。'), 409);
    throw error;
  }
}
