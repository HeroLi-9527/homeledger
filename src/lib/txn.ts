import { activeDebtScope, debtBalancesCte } from './debt-balances.js';
import {
  accountAmounts,
  baseExchangeRates,
  balanceDeltaStmts,
  getSetting,
  nowStr,
  todayStr,
  txnEffects,
  TXN_TYPE_MAP,
} from '../db.js';
import type { AccountRow, BatchStatement, Db, Env, TxnRow } from '../types.js';
import * as attach from './attachments.js';
import { lastMonths, monthEnd, toBase, WEEKDAYS } from './util.js';

let stampSeq = 0;
const stampMs = (): string => {
  const d = new Date();
  stampSeq = (stampSeq + 1) % 100000;
  const rnd = new Uint16Array(1);
  crypto.getRandomValues(rnd);
  return `${nowStr(d)}.${String(d.getMilliseconds()).padStart(3, '0')}-${String(stampSeq).padStart(5, '0')}-${rnd[0]!.toString(16).padStart(4, '0')}`;
};

export const INCOME_TYPES = ['income', 'interest', 'refund', 'reimburse'] as const;
export const EXPENSE_TYPES = ['expense', 'fee'] as const;

export const TXN_SELECT = `
SELECT t.*,
  c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
  pc.name AS category_parent,
  a.name AS account_name, a.icon AS account_icon, a.type AS account_type, a.currency AS account_currency,
  ta.name AS to_account_name, ta.icon AS to_account_icon, ta.currency AS to_account_currency,
  u.display_name AS member_name, u.avatar_color AS member_color,
  (SELECT GROUP_CONCAT(tg.name, ' ') FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id AND (c.ledger_id IS NULL OR c.ledger_id = t.ledger_id)
LEFT JOIN categories pc ON pc.id = c.parent_id AND (pc.ledger_id IS NULL OR pc.ledger_id = t.ledger_id)
LEFT JOIN accounts a ON a.id = t.account_id AND a.ledger_id = t.ledger_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id AND ta.ledger_id = t.ledger_id
LEFT JOIN users u ON u.id = t.user_id
`;

export function decorate(t: TxnRow | undefined): TxnRow | undefined {
  if (!t) return t;
  const meta = TXN_TYPE_MAP[t.type];
  t.type_label = meta?.label || t.type;
  t.type_icon = meta?.icon || '•';
  t.type_color = meta?.color || '#8c8c8c';
  t.flow = meta?.flow || 'out';
  t.category_path = t.category_parent ? `${t.category_parent}/${t.category_name}` : t.category_name || '未分类';
  t.is_income = (INCOME_TYPES as readonly string[]).includes(t.type);
  t.is_expense = (EXPENSE_TYPES as readonly string[]).includes(t.type);
  return t;
}

export interface TxnFilter {
  types?: string[];
  type?: string;
  kind?: 'expense' | 'income';
  categoryId?: number;
  accountId?: number;
  memberId?: number;
  source?: string;
  tagId?: number;
  month?: string;
  from?: string;
  to?: string;
  minCents?: number;
  maxCents?: number;
  keyword?: string;
  reimbursable?: 'yes' | 'done';
  page?: number;
  pageSize?: number;
  sort?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
}

function buildWhere(ledgerId: number, f: TxnFilter = {}) {
  const where = ['t.ledger_id = ?', 't.deleted_at IS NULL'];
  const params: unknown[] = [ledgerId];

  if (f.types && f.types.length) {
    where.push(`t.type IN (${f.types.map(() => '?').join(',')})`);
    params.push(...f.types);
  } else if (f.type) {
    where.push('t.type = ?');
    params.push(f.type);
  } else if (f.kind === 'expense') {
    where.push(`t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')})`);
    params.push(...EXPENSE_TYPES);
  } else if (f.kind === 'income') {
    where.push(`t.type IN (${INCOME_TYPES.map(() => '?').join(',')})`);
    params.push(...INCOME_TYPES);
  }

  if (f.categoryId) {
    where.push('(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
    params.push(f.categoryId, f.categoryId);
  }
  if (f.accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    params.push(f.accountId, f.accountId);
  }
  if (f.memberId) {
    where.push('t.user_id = ?');
    params.push(f.memberId);
  }
  if (f.source === 'import') {
    where.push("t.source IN ('import', 'homeledger_csv', 'alipay', 'wechat')");
  } else if (f.source) {
    where.push('t.source = ?');
    params.push(f.source);
  }
  if (f.tagId) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id = ?)');
    params.push(f.tagId);
  }
  if (f.month) {
    where.push("strftime('%Y-%m', t.txn_date) = ?");
    params.push(f.month);
  }
  if (f.from) {
    where.push('t.txn_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('t.txn_date <= ?');
    params.push(f.to);
  }
  if (f.minCents) {
    where.push('t.amount_base_cents >= ?');
    params.push(f.minCents);
  }
  if (f.maxCents) {
    where.push('t.amount_base_cents <= ?');
    params.push(f.maxCents);
  }
  if (f.keyword) {
    where.push(
      '(t.note LIKE ? OR t.merchant LIKE ? OR c.name LIKE ? OR pc.name LIKE ? OR a.name LIKE ? OR CAST(t.amount_base_cents AS TEXT) LIKE ?)',
    );
    const kw = `%${f.keyword}%`;
    params.push(kw, kw, kw, kw, kw, kw);
  }
  if (f.reimbursable === 'yes') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NULL');
  if (f.reimbursable === 'done') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NOT NULL');
  return { sql: where.join(' AND '), params };
}

export async function listTransactions(db: Db, ledgerId: number, f: TxnFilter = {}) {
  const { sql, params } = buildWhere(ledgerId, f);
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 30, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const sortMap: Record<string, string> = {
    date_desc: 't.txn_date DESC, t.id DESC',
    date_asc: 't.txn_date ASC, t.id ASC',
    amount_desc: 't.amount_base_cents DESC',
    amount_asc: 't.amount_base_cents ASC',
  };
  const order = sortMap[f.sort || ''] || sortMap.date_desc;

  const [totalRow, rows, sum] = await Promise.all([
    db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`,
      ...params,
    ),
    db.all<TxnRow>(
      `${TXN_SELECT} WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ),
    db.get<{ income: number; expense: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
         COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`,
      ...INCOME_TYPES,
      ...EXPENSE_TYPES,
      ...params,
    ),
  ]);
  const total = Number(totalRow?.c || 0);
  const decoratedRows = rows.map((r) => decorate(r)!);
  return {
    rows: decoratedRows,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sum: { income: Number(sum?.income || 0), expense: Number(sum?.expense || 0) },
  };
}

export interface TxnDateGroup {
  date: string;
  items: TxnRow[];
  income: number;
  expense: number;
}

export async function groupByDate(rows: TxnRow[], db: Db): Promise<TxnDateGroup[]> {
  const groups: TxnDateGroup[] = [];
  let cur: TxnDateGroup | null = null;
  for (const r of rows) {
    if (!cur || cur.date !== r.txn_date) {
      cur = { date: r.txn_date, items: [], income: 0, expense: 0 };
      groups.push(cur);
    }
    cur.items.push(r);
    if ((INCOME_TYPES as readonly string[]).includes(r.type)) cur.income += Number(r.amount_base_cents);
    if ((EXPENSE_TYPES as readonly string[]).includes(r.type)) cur.expense += Number(r.amount_base_cents);
  }
  await attach.attachCounts(db, rows);
  return groups;
}

export async function getTransaction(db: Db, id: number, ledgerId: number): Promise<TxnRow | undefined> {
  const t = await db.get<TxnRow>(
    `${TXN_SELECT} WHERE t.id = ? AND t.ledger_id = ? AND t.deleted_at IS NULL`,
    id,
    ledgerId,
  );
  return decorate(t);
}

async function pickAccount(
  db: Db,
  ledgerId: number,
  id: number | string | null | undefined,
  allowArchivedId: number | null = null,
): Promise<number | null> {
  if (!id) return null;
  const a = await db.get<{ id: number; is_archived: number }>(
    'SELECT id, is_archived FROM accounts WHERE id = ? AND ledger_id = ?',
    Number(id),
    ledgerId,
  );
  if (!a) return null;
  if (a.is_archived && Number(id) !== Number(allowArchivedId)) return null;
  return Number(a.id);
}

async function pickCategory(
  db: Db,
  ledgerId: number,
  id: number | string | null | undefined,
  kind: 'income' | 'expense' | null,
): Promise<number | null> {
  if (!id) return null;
  const c = await db.get<{ id: number; kind: string }>(
    'SELECT id, kind FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    Number(id),
    ledgerId,
  );
  if (!c) return null;
  if (kind && c.kind !== kind) throw new Error('分类类型与记账类型不匹配');
  return Number(c.id);
}

const ACCOUNT_REQUIRED_TYPES = [
  'expense',
  'income',
  'lend',
  'borrow',
  'repay_pay',
  'repay_receive',
  'fee',
  'interest',
  'reimburse',
  'adjust',
];

export function validateAccounts(type: string, accountId: number | null, toAccountId: number | null): void {
  if (ACCOUNT_REQUIRED_TYPES.includes(type) && !accountId) throw new Error('请选择账户');
  if (type === 'transfer' && (!accountId || !toAccountId)) throw new Error('转账需要选择转出与转入账户');
  if (type === 'transfer' && accountId === toAccountId) throw new Error('转出与转入账户不能相同');
  if ((type === 'invest_buy' || type === 'invest_sell') && (!accountId || !toAccountId)) {
    throw new Error('投资交易需要选择资金账户与投资账户');
  }
  if ((type === 'invest_buy' || type === 'invest_sell') && accountId === toAccountId) {
    throw new Error('资金账户与投资账户不能相同');
  }
}

export function kindOfType(type: string): 'income' | 'expense' | null {
  if ((INCOME_TYPES as readonly string[]).includes(type)) return 'income';
  if ((EXPENSE_TYPES as readonly string[]).includes(type)) return 'expense';
  return null;
}

export async function resolveRate(
  db: Db,
  currency: string | null | undefined,
  rateInput?: number | string | null,
): Promise<number> {
  const cur = String(currency || 'CNY').toUpperCase();
  const base = String((await getSetting(db, 'site.currency', 'CNY')) || 'CNY').toUpperCase();
  if (cur === base) return 1;
  if (rateInput === undefined || rateInput === null || rateInput === '') {
    const row = await db.get<{ rate: number }>('SELECT rate FROM exchange_rates WHERE base = ? AND quote = ?', cur, base);
    if (row && Number(row.rate) > 0) return Number(row.rate);
    throw new Error(`缺少 ${cur} 兑 ${base} 的汇率，请填写汇率`);
  }
  const r = Number(rateInput);
  if (Number.isFinite(r) && r > 0) return r;
  throw new Error('汇率无效，请填写大于 0 的汇率');
}

export interface SplitInput {
  user_id?: number | null;
  member_name?: string;
  share_cents: number;
}

function checkSplitsTotal(splits: SplitInput[], expectedCents: number): void {
  for (const s of splits) {
    if (Math.round(Number(s.share_cents) || 0) <= 0) throw new Error('分账金额必须大于 0');
  }
  const sum = splits.reduce((a, s) => a + Math.round(Number(s.share_cents) || 0), 0);
  if (Math.abs(sum - Math.round(Number(expectedCents) || 0)) > 1) {
    throw new Error(`分账合计 ${(sum / 100).toFixed(2)} 与记账金额 ${(Number(expectedCents) / 100).toFixed(2)} 不一致`);
  }
}

export interface TxnWriteInput {
  type?: string;
  amount_cents: number;
  currency?: string;
  rate?: number | string | null;
  account_id?: number | string | null;
  to_account_id?: number | string | null;
  category_id?: number | string | null;
  txn_date?: string;
  note?: string | null;
  merchant?: string | null;
  status?: string;
  is_reimbursable?: number | boolean;
  group_id?: string | null;
  source?: string;
  ai_json?: string | null;
  tags?: string;
  splits?: SplitInput[];
  account_amount_cents?: number | null;
  to_account_amount_cents?: number | null;
  expectedBalanceCents?: number;
  updated_at?: string;
}

export const activeLedgerGuard = 'EXISTS (SELECT 1 FROM ledgers WHERE id = ? AND is_archived = 0)';

export async function prepareTransactionWrites(
  db: Db, ledgerId: number, userId: number, d: TxnWriteInput, extraGuard?: BatchStatement,
  settlement?: { debtId: number; automatic: boolean; stamp: string },
): Promise<BatchStatement[]> {
  const type = d.type && TXN_TYPE_MAP[d.type] ? d.type : 'expense';
  const amount = type === 'adjust' ? Math.round(Number(d.amount_cents) || 0) : Math.abs(Math.round(Number(d.amount_cents) || 0));
  if (!amount) throw new Error('金额必须大于 0');
  const currency = String(d.currency || 'CNY').trim().toUpperCase();
  const rate = await resolveRate(db, currency, d.rate);
  const accountId = await pickAccount(db, ledgerId, d.account_id);
  const toAccountId = await pickAccount(db, ledgerId, d.to_account_id);
  const categoryId = await pickCategory(db, ledgerId, d.category_id, kindOfType(type));
  validateAccounts(type, accountId, toAccountId);
  if (d.splits && d.splits.length) checkSplitsTotal(d.splits, amount);

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? String(d.txn_date) : todayStr();
  const baseCents = toBase(amount, rate);
  const effect = { type, amount_base_cents: baseCents, account_id: accountId, to_account_id: toAccountId };
  const amounts = await accountAmounts(db, ledgerId, { ...d, ...effect, currency, amount_cents: amount });
  const newTxn = { ...effect, ...amounts };
  const stamp = nowStr();
  const expected = d.expectedBalanceCents;
  const guard = extraGuard ? `${activeLedgerGuard} AND (${extraGuard[0]})` : activeLedgerGuard;
  const guardArgs = [ledgerId, ...(extraGuard?.[1] ?? [])];
  const balanceArgs = [accountId, ledgerId, expected];
  const stmts: BatchStatement[] = [
    [
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
        user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at, account_amount_cents, to_account_amount_cents, settlement_debt_id, settlement_auto)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE ${guard}
       ${expected === undefined ? '' : 'AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND ledger_id = ? AND balance_cents = ? AND is_archived = 0)'}`,
      [
        ledgerId,
        type,
        amount,
        currency,
        rate,
        baseCents,
        accountId,
        toAccountId,
        categoryId,
        userId,
        txnDate,
        d.note ? String(d.note).slice(0, 300) : null,
        d.merchant ? String(d.merchant).slice(0, 60) : null,
        d.status === 'pending' ? 'pending' : 'cleared',
        d.is_reimbursable ? 1 : 0,
        d.group_id || null,
        d.source || 'manual',
        d.ai_json || null,
        stamp,
        settlement?.stamp ?? stamp,
        amounts.account_amount_cents,
        amounts.to_account_amount_cents,
        settlement?.debtId ?? null,
        Number(settlement?.automatic ?? false),
        ...guardArgs,
        ...(expected === undefined ? [] : balanceArgs),
      ],
    ],
  ];
  for (const [sql, args = []] of balanceDeltaStmts([[newTxn, 1]])) {
    stmts.push(expected === undefined ? [`${sql} AND ${guard}`, [...args, ...guardArgs]] : [
      `${sql} AND ledger_id = ? AND balance_cents = ? AND is_archived = 0 AND ${guard}`, [...args, ledgerId, expected, ...guardArgs],
    ]);
  }
  return stmts;
}

export async function createTransaction(db: Db, ledgerId: number, userId: number, d: TxnWriteInput): Promise<number> {
  const stmts = await prepareTransactionWrites(db, ledgerId, userId, d);
  const expected = d.expectedBalanceCents;
  const results = await db.batch(stmts);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    throw new Error(expected === undefined ? '账本已归档，只能查阅和导出' : '账户余额已变动或账本已归档，请刷新后重试');
  }
  const id = Number(results[0]?.meta?.last_row_id || 0);
  if (!id) throw new Error('记账失败，未能获取交易 ID');
  try {
    await applyTags(db, id, ledgerId, d.tags);
  } catch (e) {
    console.error('applyTags failed for txn', id, e);
  }
  if (d.splits && d.splits.length) {
    try {
      await saveSplits(db, ledgerId, id, d.group_id || null, d.splits);
    } catch (e) {
      console.error('saveSplits failed for txn', id, e);
    }
  }
  try {
    await syncDebts(db, ledgerId);
  } catch (e) {
    console.error('syncDebts failed after create txn', id, e);
  }
  return id;
}

export async function settleDebt(
  db: Db, ledgerId: number, userId: number,
  debt: { id: number; direction: string; currency: string; counterparty: string; balance_cents: number; opening_cents: number; note: string | null },
  input: { amount_cents: number; account_id: number; txn_date: string; note: string; source: string },
): Promise<number> {
  const automatic = debt.opening_cents === 0 && debt.note === '系统自动汇总';
  const stamp = stampMs();
  const inserted: BatchStatement = [
    'EXISTS (SELECT 1 FROM transactions WHERE ledger_id = ? AND settlement_debt_id = ? AND updated_at = ?)',
    [ledgerId, debt.id, stamp],
  ];
  // Ordinary repayments can commit before rebuilding the displayed debt balance.
  const currentBalance = automatic ? 'SELECT balance_cents FROM auto_state WHERE direction = ? AND counterparty = ?'
    : debt.opening_cents > 0 ? 'SELECT balance_cents FROM opening_state WHERE id = ?' : null;
  const actualBalanceGuard = currentBalance
    ? `AND (${inserted[0]} OR (${activeDebtScope()}${debtBalancesCte} ${currentBalance}) = ?)` : '';
  const actualBalanceArgs = currentBalance ? [
    ...inserted[1]!, ledgerId, ...(automatic ? [debt.direction, debt.counterparty] : [debt.id]), debt.balance_cents,
  ] : [];
  const guard: BatchStatement = [
    `EXISTS (SELECT 1 FROM debts WHERE id = ? AND ledger_id = ? AND status = 'open' AND balance_cents = ?
       AND direction = ? AND counterparty = ? AND currency = ?)
     AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND ledger_id = ? AND is_archived = 0)
     ${actualBalanceGuard}`,
    [debt.id, ledgerId, debt.balance_cents, debt.direction, debt.counterparty, debt.currency,
      input.account_id, ledgerId, ...actualBalanceArgs],
  ];
  const writes = await prepareTransactionWrites(db, ledgerId, userId, {
    ...input,
    type: debt.direction === 'receivable' ? 'repay_receive' : 'repay_pay',
    currency: debt.currency || undefined,
    merchant: debt.counterparty,
  }, guard, { debtId: debt.id, automatic, stamp });
  if (debt.opening_cents === 0 && !automatic) writes.push([
    `UPDATE debts SET manual_balance_cents = balance_cents
     WHERE id = ? AND manual_balance_cents IS NULL AND ${inserted[0]}`,
    [debt.id, ...inserted[1]!],
  ]);
  writes.push(...debtSyncWrites(ledgerId, inserted));
  const [created] = await db.batch(writes);
  if (created.meta.changes !== 1) throw new Error('借贷或账户已变更，或账本已归档，请刷新后重试');
  return Number(created.meta.last_row_id);
}

export async function updateTransaction(
  db: Db,
  id: number,
  ledgerId: number,
  _userId: number,
  d: TxnWriteInput,
): Promise<number> {
  const old = await db.get<TxnRow>(
    'SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL',
    id,
    ledgerId,
  );
  if (!old) throw new Error('记录不存在');
  const type = d.type && TXN_TYPE_MAP[d.type] ? d.type : old.type;
  const amount = type === 'adjust' ? Math.round(Number(d.amount_cents) || 0) : Math.abs(Math.round(Number(d.amount_cents) || 0));
  if (!amount) throw new Error('金额必须大于 0');
  const currency = String(d.currency || old.currency).trim().toUpperCase();
  const rate = d.rate == null && currency === old.currency ? Number(old.rate) : await resolveRate(db, currency, d.rate);
  const accountId = await pickAccount(db, ledgerId, d.account_id, old.account_id);
  const toAccountId = await pickAccount(db, ledgerId, d.to_account_id, old.to_account_id);
  const categoryId = await pickCategory(db, ledgerId, d.category_id, kindOfType(type));
  validateAccounts(type, accountId, toAccountId);
  if (d.splits && d.splits.length) checkSplitsTotal(d.splits, amount);

  const valuationChanged = amount !== Number(old.amount_cents) || currency !== old.currency || rate !== Number(old.rate);
  if (old.settlement_debt_id != null && (
    valuationChanged || type !== old.type || (d.merchant ? String(d.merchant).slice(0, 60) : null) !== old.merchant
  )) throw new Error('借贷结算流水不能修改金额、币种、汇率、类型或往来对象，请删除后重新结算');
  const baseCents = valuationChanged ? toBase(amount, rate) : Number(old.amount_base_cents);
  const accountChanged = valuationChanged || type !== old.type || accountId !== old.account_id;
  const toAccountChanged = valuationChanged || type !== old.type || toAccountId !== old.to_account_id;
  const effect = { type, amount_base_cents: baseCents, account_id: accountId, to_account_id: toAccountId };
  const accountAmountChanged = d.account_amount_cents != null && d.account_amount_cents !== old.account_amount_cents;
  const toAccountAmountChanged = d.to_account_amount_cents != null && d.to_account_amount_cents !== old.to_account_amount_cents;
  if ((old.reimbursed_at || old.type === 'reimburse') && (accountAmountChanged || toAccountAmountChanged)) {
    throw new Error('报销关联流水不能修改账户原币金额');
  }
  const amounts = accountChanged || toAccountChanged || accountAmountChanged || toAccountAmountChanged
    ? await accountAmounts(db, ledgerId, {
      ...effect, currency, amount_cents: amount,
      account_amount_cents: d.account_amount_cents ?? (accountChanged ? undefined : old.account_amount_cents),
      to_account_amount_cents: d.to_account_amount_cents ?? (toAccountChanged ? undefined : old.to_account_amount_cents),
    })
    : { account_amount_cents: old.account_amount_cents, to_account_amount_cents: old.to_account_amount_cents };
  const newTxn = { ...effect, ...amounts };

  if (old.reimbursed_at) {
    const moneyChanged =
      type !== old.type ||
      amount !== Number(old.amount_cents) ||
      currency !== old.currency ||
      rate !== Number(old.rate) ||
      accountId !== Number(old.account_id) ||
      (toAccountId ?? null) !== (old.to_account_id ?? null);
    if (moneyChanged) throw new Error('该笔已报销，请先删除报销入账记录后再修改金额');
  }
  if (old.type === 'reimburse') {
    const changed =
      type !== 'reimburse' ||
      amount !== Number(old.amount_cents) ||
      (currency || 'CNY') !== (old.currency || 'CNY') ||
      Number(rate || 1) !== Number(old.rate || 1) ||
      accountId !== Number(old.account_id) ||
      (toAccountId ?? null) !== (old.to_account_id ?? null);
    if (changed) throw new Error('报销入账记录只能修改备注、分类、日期或状态，请先删除后重新报销');
  }

  const expectedToken =
    d.updated_at !== undefined && d.updated_at !== null && String(d.updated_at) !== ''
      ? String(d.updated_at)
      : old.updated_at;
  const stamp = stampMs();
  const delta = balanceDeltaStmts([[old, -1], [newTxn, 1]]);
  const [upd] = await db.batch([
    [`UPDATE transactions SET type=?, amount_cents=?, currency=?, rate=?, amount_base_cents=?, account_id=?,
       to_account_id=?, category_id=?, txn_date=?, note=?, merchant=?, status=?, is_reimbursable=?,
       account_amount_cents=?, to_account_amount_cents=?, updated_at=?
       WHERE id=? AND ledger_id=? AND deleted_at IS NULL AND updated_at=? AND ${activeLedgerGuard}`,
    [type,
    amount,
    currency,
    rate,
    baseCents,
    accountId,
    toAccountId,
    categoryId,
    /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? d.txn_date : old.txn_date,
    d.note ? String(d.note).slice(0, 300) : null,
    d.merchant ? String(d.merchant).slice(0, 60) : null,
    d.status === 'pending' ? 'pending' : 'cleared',
    d.is_reimbursable ? 1 : 0,
    amounts.account_amount_cents,
    amounts.to_account_amount_cents,
    stamp,
    id,
    ledgerId,
    expectedToken, ledgerId]],
    ...delta.map(([sql, params = []]): BatchStatement => [
      `${sql} AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND ledger_id = ? AND updated_at = ?)`,
      [...params, id, ledgerId, stamp],
    ]),
  ]);
  if (Number(upd?.meta?.changes || 0) !== 1) throw new Error('记录已被他人修改，请刷新后重试');
  try {
    if (d.tags !== undefined) await applyTags(db, id, ledgerId, d.tags, true);
  } catch (e) {
    console.error('applyTags failed for txn', id, e);
  }
  if (d.splits) {
    try {
      await saveSplits(db, ledgerId, id, old.group_id, d.splits);
    } catch (e) {
      console.error('saveSplits failed for txn', id, e);
    }
  }
  try {
    await syncDebts(db, ledgerId);
  } catch (e) {
    console.error('syncDebts failed after update txn', id, e);
  }
  return id;
}

export async function softDelete(
  db: Db,
  id: number,
  ledgerId: number,
  opts: { skipSync?: boolean } = {},
): Promise<boolean> {
  const pre = await db.get<TxnRow>(
    'SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL',
    id,
    ledgerId,
  );
  if (!pre) return false;
  if (pre.reimbursed_at) throw new Error('该笔已报销，请先删除报销入账记录后再删除');
  const stamp = stampMs();
  const delGuardSql = ' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at = ? AND updated_at = ?)';
  const delGuardParams = [id, ledgerId, stamp, stamp];
  const stmts: BatchStatement[] = [
    [
      `UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND ledger_id = ?
        AND deleted_at IS NULL AND updated_at = ? AND ${activeLedgerGuard}`,
      [stamp, stamp, id, ledgerId, pre.updated_at, ledgerId],
    ],
    ...balanceDeltaStmts([[pre, -1]]).map(([sql, params = []]): BatchStatement => [`${sql}${delGuardSql}`, [...params, ...delGuardParams]]),
  ];
  if (pre.type === 'reimburse') {
    stmts.push([
      `UPDATE transactions SET reimbursed_at = NULL, related_id = NULL WHERE related_id = ? AND ledger_id = ?${delGuardSql}`,
      [id, ledgerId, ...delGuardParams],
    ]);
  }
  const results = await db.batch(stmts);
  if (Number(results[0]?.meta?.changes || 0) !== 1) {
    const cur = await db.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM transactions WHERE id = ? AND ledger_id = ?',
      id,
      ledgerId,
    );
    if (!cur || cur.deleted_at) return false;
    throw new Error('记录已被他人修改，请刷新后重试');
  }
  if (!opts.skipSync) {
    try {
      await syncDebts(db, ledgerId);
    } catch (e) {
      console.error('syncDebts failed after delete txn', id, e);
    }
  }
  return true;
}

export async function bulkDelete(
  db: Db,
  ids: number[],
  ledgerId: number,
) {
  let n = 0;
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    try {
      if (await softDelete(db, Number(id), ledgerId, { skipSync: true })) n++;
      else skipped.push({ id: Number(id), reason: '记录不存在或已删除' });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({ id: Number(id), reason });
    }
  }
  try {
    await syncDebts(db, ledgerId);
  } catch (e) {
    console.error('syncDebts failed after bulkDelete', e);
  }
  return { deleted: n, skipped };
}

export async function restoreTransaction(db: Db, id: number, ledgerId: number): Promise<boolean> {
  const t = await db.get<TxnRow>(
    'SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NOT NULL AND purge_started = 0',
    id,
    ledgerId,
  );
  if (!t) throw new Error('记录不存在或未删除');
  if (t.type === 'reimburse') throw new Error('报销入账记录删除后不可恢复，请重新报销');
  for (const aid of [t.account_id, t.to_account_id]) {
    if (!aid) continue;
    const acc = await db.get<{ id: number; is_archived: number }>(
      'SELECT id, is_archived FROM accounts WHERE id = ? AND ledger_id = ?',
      Number(aid),
      ledgerId,
    );
    if (!acc) throw new Error('原账户已被删除，无法恢复');
    if (acc.is_archived) throw new Error('原账户已归档，无法恢复');
  }
  const stamp = stampMs();
  const restoreGuardSql = ' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL AND updated_at = ?)';
  const balStmts: BatchStatement[] = balanceDeltaStmts([[t, 1]]).map(([sql, params = []]): BatchStatement => [
    `${sql}${restoreGuardSql}`,
    [...params, id, ledgerId, stamp],
  ]);
  const results = await db.batch([
    [`UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id = ? AND ledger_id = ?
      AND deleted_at IS NOT NULL AND purge_started = 0 AND ${activeLedgerGuard}`, [stamp, id, ledgerId, ledgerId]],
    ...balStmts,
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) throw new Error('记录已被恢复或删除，请刷新后重试');
  try {
    await syncDebts(db, ledgerId);
  } catch (e) {
    console.error('syncDebts failed after restore txn', id, e);
  }
  return true;
}

export async function purgeTransaction(db: Db, env: Pick<Env, 'ATTACHMENTS'>, id: number, ledgerId: number): Promise<void> {
  const claim = await db.run(
    `UPDATE transactions SET purge_started = 1 WHERE id = ? AND ledger_id = ? AND deleted_at IS NOT NULL AND ${activeLedgerGuard}`,
    id, ledgerId, ledgerId,
  );
  if (!claim.changes) throw new Error('回收站中找不到该流水，或账本已归档');
  const rows = await db.all<{ rel_path: string }>(
    'SELECT rel_path FROM attachments WHERE txn_id = ? AND ledger_id = ?', id, ledgerId,
  );
  if (rows.length && !env.ATTACHMENTS) throw new Error('附件存储未配置，无法永久删除');
  await attach.deleteKeysFromR2(env, rows.map((row) => row.rel_path), { throwOnError: true });
  await db.batch([
    ['DELETE FROM transaction_tags WHERE transaction_id = ?', [id]],
    ['DELETE FROM splits WHERE transaction_id = ? AND ledger_id = ?', [id, ledgerId]],
    ['DELETE FROM attachments WHERE txn_id = ? AND ledger_id = ?', [id, ledgerId]],
    ['UPDATE transactions SET related_id = NULL WHERE related_id = ? AND ledger_id = ?', [id, ledgerId]],
    ['UPDATE session_card_logs SET txn_id = NULL WHERE txn_id = ? AND ledger_id = ?', [id, ledgerId]],
    ['UPDATE session_cards SET purchase_txn_id = NULL WHERE purchase_txn_id = ? AND ledger_id = ?', [id, ledgerId]],
    ['DELETE FROM transactions WHERE id = ? AND ledger_id = ? AND purge_started = 1', [id, ledgerId]],
  ]);
}

export async function bulkRestore(db: Db, ids: number[], ledgerId: number) {
  let n = 0;
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    try {
      if (await restoreTransaction(db, Number(id), ledgerId)) n++;
    } catch (e) {
      skipped.push({ id: Number(id), reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { restored: n, skipped };
}

export async function bulkUpdateCategory(
  db: Db,
  ids: number[],
  ledgerId: number,
  categoryId: number,
) {
  if (!ids.length) throw new Error('请先选择流水');
  if (!categoryId) throw new Error('请选择目标分类');
  const cat = await db.get<{ id: number; kind: 'expense' | 'income'; is_archived: number }>(
    'SELECT id, kind, is_archived FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    categoryId,
    ledgerId,
  );
  if (!cat || cat.is_archived) throw new Error('目标分类不存在或已归档');

  const rows = await db.all<{ id: number; type: string; deleted_at: string | null }>(
    `SELECT id, type, deleted_at FROM transactions WHERE ledger_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const targetIds: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    const row = byId.get(Number(id));
    if (!row || row.deleted_at) {
      skipped.push({ id: Number(id), reason: '记录不存在或已删除' });
      continue;
    }
    const kind = kindOfType(row.type);
    if (kind !== cat.kind) {
      skipped.push({ id: Number(id), reason: '交易类型与目标分类收支类型不匹配' });
      continue;
    }
    targetIds.push(Number(id));
  }
  if (targetIds.length) {
    await db.run(
      `UPDATE transactions SET category_id = ?, updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL AND id IN (${targetIds.map(() => '?').join(',')}) AND ${activeLedgerGuard}`,
      Number(cat.id),
      stampMs(),
      ledgerId,
      ...targetIds,
      ledgerId,
    );
  }
  return { updated: targetIds.length, skipped };
}

export async function bulkAddTags(
  db: Db,
  ids: number[],
  ledgerId: number,
  tagsInput: string,
) {
  if (!ids.length) throw new Error('请先选择流水');
  const names = String(tagsInput || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!names.length) throw new Error('请输入或选择至少一个标签');

  const rows = await db.all<{ id: number; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM transactions WHERE ledger_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const targetIds: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    const row = byId.get(Number(id));
    if (!row || row.deleted_at) {
      skipped.push({ id: Number(id), reason: '记录不存在或已删除' });
      continue;
    }
    targetIds.push(Number(id));
  }
  const cleanTags = names.join(' ');
  for (const tid of targetIds) {
    await applyTags(db, tid, ledgerId, cleanTags, false);
  }
  if (targetIds.length) {
    await db.run(
      `UPDATE transactions SET updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL AND id IN (${targetIds.map(() => '?').join(',')}) AND ${activeLedgerGuard}`,
      stampMs(),
      ledgerId,
      ...targetIds,
      ledgerId,
    );
  }
  return { updated: targetIds.length, skipped };
}

export async function bulkMarkReimbursable(
  db: Db,
  ids: number[],
  ledgerId: number,
) {
  if (!ids.length) throw new Error('请先选择流水');
  const rows = await db.all<{
    id: number;
    type: string;
    deleted_at: string | null;
    reimbursed_at: string | null;
    is_reimbursable: number;
  }>(
    `SELECT id, type, deleted_at, reimbursed_at, is_reimbursable FROM transactions WHERE ledger_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const targetIds: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    const row = byId.get(Number(id));
    if (!row || row.deleted_at) {
      skipped.push({ id: Number(id), reason: '记录不存在或已删除' });
      continue;
    }
    if (row.reimbursed_at) {
      skipped.push({ id: Number(id), reason: '已完成报销入账' });
      continue;
    }
    if (!(EXPENSE_TYPES as readonly string[]).includes(row.type)) {
      skipped.push({ id: Number(id), reason: '仅支出或手续费可标记待报销' });
      continue;
    }
    targetIds.push(Number(id));
  }
  if (targetIds.length) {
    await db.run(
      `UPDATE transactions SET is_reimbursable = 1, updated_at = ? WHERE ledger_id = ? AND deleted_at IS NULL AND reimbursed_at IS NULL AND id IN (${targetIds.map(() => '?').join(',')}) AND ${activeLedgerGuard}`,
      stampMs(),
      ledgerId,
      ...targetIds,
      ledgerId,
    );
  }
  return { updated: targetIds.length, skipped };
}

export async function markReimbursed(
  db: Db,
  ids: number[],
  ledgerId: number,
  userId: number,
  accountId: number,
) {
  if (!ids || !ids.length) throw new Error('没有可报销的记录');
  if (!accountId) throw new Error('请选择报销入账账户');
  const account = await db.get<{ id: number }>(
    'SELECT id FROM accounts WHERE id = ? AND ledger_id = ?',
    Number(accountId),
    ledgerId,
  );
  if (!account) throw new Error('请选择报销入账账户');
  const rows = await db.all<TxnRow>(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND reimbursed_at IS NULL
     AND is_reimbursable = 1 AND type IN ('expense','fee') AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId,
    ...ids,
  );
  const skipped: Array<{ id: number; reason: string }> = [];
  const foundIds = new Set(rows.map((r) => Number(r.id)));
  const missingIds = ids.map(Number).filter((x) => !foundIds.has(x));
  if (missingIds.length) {
    const missing = await db.all<TxnRow>(
      `SELECT * FROM transactions WHERE ledger_id = ? AND id IN (${missingIds.map(() => '?').join(',')})`,
      ledgerId,
      ...missingIds,
    );
    const byId = new Map(missing.map((r) => [Number(r.id), r]));
    for (const mid of missingIds) {
      const m = byId.get(mid);
      skipped.push({
        id: mid,
        reason: !m
          ? '记录不存在'
          : m.deleted_at
            ? '已删除'
            : m.reimbursed_at
              ? '已报销'
              : '不可报销（仅支出/手续费且标记可报销的记录可以报销）',
      });
    }
  }
  const total = rows.reduce((a, b) => a + Number(b.amount_base_cents), 0);
  if (!rows.length || !total) {
    throw new Error('没有可报销的记录' + (skipped.length ? `（${skipped[0].reason}）` : ''));
  }
  const stamp = stampMs();
  const note = `报销 ${rows.length} 笔，合计 ${(total / 100).toFixed(2)}`;
  const currency = String(await getSetting(db, 'site.currency', 'CNY'));
  const effect = { type: 'reimburse', amount_base_cents: total, account_id: Number(accountId), to_account_id: null };
  const reimburseTxn = { ...effect, ...await accountAmounts(db, ledgerId, { ...effect, currency, amount_cents: total }) };
  const inList = rows.map(() => '?').join(',');
  const rowIds = rows.map((r) => r.id);
  const eligible = `ledger_id = ? AND deleted_at IS NULL AND reimbursed_at IS NULL
    AND is_reimbursable = 1 AND type IN ('expense','fee') AND id IN (${inList})`;
  const inserted = `EXISTS (SELECT 1 FROM transactions WHERE id = last_insert_rowid()
    AND ledger_id = ? AND type = 'reimburse' AND updated_at = ?)`;
  const results = await db.batch([
    [
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
        user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at, account_amount_cents)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE ${activeLedgerGuard} AND (SELECT COUNT(*) = ? AND SUM(amount_base_cents) = ?
         FROM transactions WHERE ${eligible})`,
      [
        ledgerId,
        'reimburse',
        total,
        currency,
        1,
        total,
        Number(accountId),
        null,
        null,
        userId,
        todayStr(),
        note,
        null,
        'cleared',
        0,
        null,
        'manual',
        null,
        nowStr(),
        stamp,
        reimburseTxn.account_amount_cents,
        ledgerId, rows.length, total, ledgerId, ...rowIds,
      ],
    ],
    [
      `UPDATE transactions
       SET reimbursed_at = ?, related_id = last_insert_rowid()
       WHERE ${eligible} AND ${activeLedgerGuard} AND ${inserted}`,
      [nowStr(), ledgerId, ...rowIds, ledgerId, ledgerId, stamp],
    ],
    ...balanceDeltaStmts([[reimburseTxn, 1]]).map(([sql, args = []]): BatchStatement => [
      `${sql} AND ${activeLedgerGuard} AND ${inserted}`, [...args, ledgerId, ledgerId, stamp],
    ]),
  ]);
  if (results[0].meta.changes !== 1) throw new Error('部分记录已被删除或报销，或账本已归档，请刷新后重试');
  const txnId = Number(results[0].meta.last_row_id);
  return { txnId, total, count: rows.length, skipped };
}

function colorFromName(name: string): string {
  const palette = ['#4f7cff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#fa541c'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return palette[h % palette.length];
}

export async function applyTags(
  db: Db,
  txnId: number,
  ledgerId: number,
  tagsInput: string | undefined | null,
  replace = false,
): Promise<void> {
  const names = String(tagsInput || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (replace) await db.run(`DELETE FROM transaction_tags WHERE transaction_id = ? AND ${activeLedgerGuard}`, txnId, ledgerId);
  if (!names.length) return;
  for (const name of names) {
    let tag = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    if (!tag) {
      await db.run(`INSERT OR IGNORE INTO tags (ledger_id, name, color) SELECT ?,?,? WHERE ${activeLedgerGuard}`, ledgerId, name, colorFromName(name), ledgerId);
      tag = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    }
    if (tag) {
      await db.run(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) SELECT ?,? WHERE ${activeLedgerGuard}`, txnId, tag.id, ledgerId);
    }
  }
}

export async function saveSplits(
  db: Db,
  ledgerId: number,
  txnId: number,
  groupId: string | null,
  splits: SplitInput[],
): Promise<string | null> {
  if (!splits || !splits.length) {
    await db.batch([
      [`DELETE FROM splits WHERE transaction_id = ? AND ${activeLedgerGuard}`, [txnId, ledgerId]],
      [`UPDATE transactions SET group_id = NULL WHERE id = ? AND ${activeLedgerGuard}`, [txnId, ledgerId]],
    ]);
    return null;
  }
  const gid = groupId || `sp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const stmts: BatchStatement[] = [[`DELETE FROM splits WHERE group_id = ? AND ledger_id = ? AND ${activeLedgerGuard}`, [gid, ledgerId, ledgerId]]];
  const now = nowStr();
  for (const s of splits) {
    const share = Math.round(Number(s.share_cents) || 0);
    if (share <= 0) throw new Error('分账金额必须大于 0');
    stmts.push([
      `INSERT INTO splits (group_id, transaction_id, ledger_id, user_id, member_name, share_cents, created_at)
       SELECT ?,?,?,?,?,?,? WHERE ${activeLedgerGuard}`,
      [gid, txnId, ledgerId, s.user_id || null, String(s.member_name || '成员').slice(0, 30), share, now, ledgerId],
    ]);
  }
  stmts.push([`UPDATE transactions SET group_id = ? WHERE id = ? AND ${activeLedgerGuard}`, [gid, txnId, ledgerId]]);
  await db.batch(stmts);
  return gid;
}

export async function splitsOf(db: Db, txnId: number) {
  return db.all('SELECT * FROM splits WHERE transaction_id = ? ORDER BY id', txnId);
}

function debtSyncWrites(ledgerId: number, guard?: BatchStatement): BatchStatement[] {
  const scope = activeDebtScope(guard?.[0]);
  const args = [ledgerId, ...(guard?.[1] ?? [])];
  return [
    [`${scope}${debtBalancesCte}, changed_balances AS (
        SELECT id, balance_cents FROM opening_state
        UNION ALL
        SELECT id, balance_cents FROM manual_state WHERE manual_balance_cents IS NOT NULL AND current_balance <> balance_cents
      )
      UPDATE debts AS d SET balance_cents = b.balance_cents,
        status = CASE WHEN b.balance_cents = 0 THEN 'closed' ELSE 'open' END
      FROM changed_balances b WHERE d.id = b.id
        AND (d.balance_cents <> b.balance_cents OR d.status <> CASE WHEN b.balance_cents = 0 THEN 'closed' ELSE 'open' END)`,
      args],
    // Capture existing due dates before removing the previous derived rows.
    [`${scope}${debtBalancesCte}
      INSERT INTO debts (ledger_id, direction, counterparty, currency, account_id, due_date, note, principal_cents,
                         balance_cents, status, created_at)
      SELECT ?, direction, counterparty, currency, account_id, due_date, note, principal_cents, balance_cents,
             CASE WHEN balance_cents = 0 THEN 'closed' ELSE 'open' END, ?
      FROM auto_state`, [...args, ledgerId, nowStr()]],
    [`${scope} DELETE FROM debts AS d WHERE ledger_id = (SELECT ledger_id FROM scope) AND opening_cents = 0 AND note = '系统自动汇总'
      AND EXISTS (SELECT 1 FROM ledgers WHERE id = d.ledger_id AND is_archived = 0)
      AND (NOT EXISTS (
        SELECT 1 FROM transactions t WHERE t.ledger_id = d.ledger_id AND t.deleted_at IS NULL
          AND t.type = CASE WHEN d.direction = 'receivable' THEN 'lend' ELSE 'borrow' END
          AND COALESCE(NULLIF(t.merchant, ''), '未指定') = d.counterparty
      ) OR EXISTS (
        SELECT 1 FROM debts n WHERE n.id > d.id AND n.ledger_id = d.ledger_id AND n.opening_cents = 0
          AND n.note = d.note AND n.direction = d.direction AND n.counterparty = d.counterparty
      ))`, args],
  ];
}

export async function syncDebts(db: Db, ledgerId: number): Promise<void> {
  await db.batch(debtSyncWrites(ledgerId));
}

export function rangeOf(month: string) {
  return { start: `${month}-01`, end: monthEnd(month), month };
}

export async function summary(db: Db, ledgerId: number, start: string, end: string) {
  const row = await db.get<{ income: number; expense: number; count: number }>(
    `SELECT
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?`,
    ...INCOME_TYPES,
    ...EXPENSE_TYPES,
    ledgerId,
    start,
    end,
  );
  const income = Number(row?.income || 0);
  const expense = Number(row?.expense || 0);
  return { income, expense, net: income - expense, count: Number(row?.count || 0) };
}

export async function categoryBreakdown(
  db: Db,
  ledgerId: number,
  start: string,
  end: string,
  kind: 'expense' | 'income' = 'expense',
) {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  const rows = await db.all<{ name: string; icon: string; color: string; total: number; cnt: number }>(
    `SELECT COALESCE(pc.name, c.name, '未分类') AS name,
            COALESCE(pc.icon, c.icon, '🏷️') AS icon,
            COALESCE(pc.color, c.color, '#8c8c8c') AS color,
            SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type IN (${types.map(() => '?').join(',')})
     GROUP BY COALESCE(pc.id, c.id, 0)
     ORDER BY total DESC`,
    ledgerId,
    start,
    end,
    ...types,
  );
  return rows.map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

export async function subcategoryBreakdown(
  db: Db,
  ledgerId: number,
  start: string,
  end: string,
  kind: 'expense' | 'income' = 'expense',
  topName: string | null = null,
) {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  let sql = `SELECT c.id AS category_id,
                    COALESCE(c.name, '未分类') AS name,
                    COALESCE(c.icon, '🏷️') AS icon,
                    COALESCE(c.color, pc.color, '#8c8c8c') AS color,
                    COALESCE(pc.name, c.name, '未分类') AS parent,
                    SUM(t.amount_base_cents) AS total,
                    COUNT(*) AS cnt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
         AND t.type IN (${types.map(() => '?').join(',')})`;
  const params: unknown[] = [ledgerId, start, end, ...types];
  if (topName) {
    sql += " AND COALESCE(pc.name, c.name, '未分类') = ?";
    params.push(topName);
  }
  sql += ' GROUP BY COALESCE(c.id, 0) ORDER BY total DESC';
  const rows = await db.all<{
    category_id: number | null;
    name: string;
    icon: string;
    color: string;
    parent: string;
    total: number;
    cnt: number;
  }>(sql, ...params);
  return rows.map((r) => ({
    ...r,
    category_id: r.category_id != null ? Number(r.category_id) : null,
    total: Number(r.total),
    cnt: Number(r.cnt),
  }));
}

export async function monthlyTrend(
  db: Db,
  ledgerId: number,
  months = 6,
  ref: Date | string = todayStr(),
) {
  const list = lastMonths(months, ref);
  const from = `${list[0]}-01`;
  const to = monthEnd(list[list.length - 1]);
  const rows = await db.all<{ m: string; income: number; expense: number }>(
    `SELECT strftime('%Y-%m', txn_date) AS m,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY m`,
    ...INCOME_TYPES,
    ...EXPENSE_TYPES,
    ledgerId,
    from,
    to,
  );
  const map = new Map(rows.map((r) => [r.m, r]));
  return list.map((m) => {
    const r = map.get(m) || { income: 0, expense: 0 };
    return { month: m, income: Number(r.income), expense: Number(r.expense) };
  });
}

export async function memberBreakdown(db: Db, ledgerId: number, start: string, end: string) {
  const rows = await db.all<{ id: number; name: string; color: string; expense: number; income: number; cnt: number }>(
    `SELECT u.id, u.display_name AS name, u.avatar_color AS color,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COUNT(*) AS cnt
     FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
     GROUP BY u.id ORDER BY expense DESC`,
    ...EXPENSE_TYPES,
    ...INCOME_TYPES,
    ledgerId,
    start,
    end,
  );
  return rows.map((r) => ({ ...r, expense: Number(r.expense), income: Number(r.income), cnt: Number(r.cnt) }));
}

export async function dailyBreakdown(db: Db, ledgerId: number, start: string, end: string) {
  const rows = await db.all<{ date: string; expense: number; income: number; count: number }>(
    `SELECT txn_date AS date,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY txn_date ORDER BY txn_date`,
    ...EXPENSE_TYPES,
    ...INCOME_TYPES,
    ledgerId,
    start,
    end,
  );
  return rows.map((r) => ({
    date: r.date,
    expense: Number(r.expense),
    income: Number(r.income),
    count: Number(r.count),
  }));
}

export async function accountOverview(db: Db, ledgerId: number) {
  const accounts = await db.all<AccountRow>(
    'SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id',
    ledgerId,
  );
  const { code, rates } = await baseExchangeRates(db);
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts.filter((x) => x.include_in_net)) {
    const rate = rates.get(a.currency.toUpperCase());
    if (rate === undefined) continue;
    const b = toBase(Number(a.balance_cents), rate);
    if (b >= 0) assets += b;
    else liabilities += Math.abs(b);
  }
  const missingCurrencies = [...new Set(accounts.filter((a) => !rates.has(a.currency.toUpperCase())).map((a) => a.currency))];
  return { accounts, assets, liabilities, net: assets - liabilities, baseCurrency: code, rates, missingCurrencies };
}

export async function netWorthTrend(db: Db, ledgerId: number, months = 6) {
  const list = lastMonths(months, todayStr());
  const [allTxns, accounts, { rates }] = await Promise.all([
    db.all<Pick<TxnRow, 'txn_date' | 'type' | 'amount_base_cents' | 'account_id' | 'to_account_id' | 'account_amount_cents' | 'to_account_amount_cents'>>(
      `SELECT txn_date, type, amount_base_cents, account_id, to_account_id, account_amount_cents, to_account_amount_cents FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY txn_date`,
      ledgerId,
    ),
    db.all<Pick<AccountRow, 'id' | 'initial_cents' | 'include_in_net' | 'created_at' | 'balance_cents' | 'currency'>>(
      'SELECT id, initial_cents, include_in_net, created_at, balance_cents, currency FROM accounts WHERE ledger_id = ? AND is_archived = 0',
      ledgerId,
    ),
    baseExchangeRates(db),
  ]);
  const included = new Map(accounts.filter((a) => a.include_in_net).map((a) => [Number(a.id), a]));
  const sortedAccts = [...included.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const out: Array<{ month: string; value: number }> = [];
  let cum = 0;
  const running = new Map<number, number>();
  const addNative = (id: number, delta: number) => {
    const rate = rates.get(included.get(id)!.currency.toUpperCase()) ?? 0;
    const prior = running.get(id) ?? 0;
    const next = prior + delta;
    cum += Math.round(next * rate) - Math.round(prior * rate);
    running.set(id, next);
  };
  let idx = 0;
  let aidx = 0;
  for (const m of list) {
    const end = monthEnd(m);
    while (aidx < sortedAccts.length && String(sortedAccts[aidx].created_at).slice(0, 10) <= end) {
      const account = sortedAccts[aidx];
      addNative(Number(account.id), Number(account.initial_cents));
      aidx++;
    }
    while (idx < allTxns.length && allTxns[idx].txn_date <= end) {
      for (const e of txnEffects(allTxns[idx])) if (included.has(e.accountId)) addNative(e.accountId, e.delta);
      idx++;
    }
    out.push({ month: m, value: cum });
  }
  if (out.length) {
    out[out.length - 1].value = [...included.values()].reduce((s, a) => s + Math.round(Number(a.balance_cents) * (rates.get(a.currency.toUpperCase()) ?? 0)), 0);
  }
  return out;
}

export async function weekdayExpenseBreakdown(db: Db, ledgerId: number, start: string, end: string) {
  const rows = await db.all<{ wd: number; expense: number; cnt: number }>(
    `SELECT CAST(strftime('%w', txn_date) AS INTEGER) AS wd,
            COALESCE(SUM(amount_base_cents), 0) AS expense,
            COUNT(*) AS cnt
     FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
       AND type IN (${EXPENSE_TYPES.map(() => '?').join(',')})
     GROUP BY wd`,
    ledgerId,
    start,
    end,
    ...EXPENSE_TYPES,
  );
  const byWd = new Map(rows.map((r) => [Number(r.wd), { expense: Number(r.expense), cnt: Number(r.cnt) }]));
  return [1, 2, 3, 4, 5, 6, 0].map((wd) => {
    const found = byWd.get(wd);
    return {
      wd,
      label: WEEKDAYS[wd],
      expense: found?.expense || 0,
      cnt: found?.cnt || 0,
    };
  });
}

export async function* iterateAllForExport(
  db: Db,
  ledgerId: number,
  chunkSize = 1000,
  filter: TxnFilter = {},
): AsyncGenerator<TxnRow[]> {
  const { sql, params } = buildWhere(ledgerId, filter);
  let cursorDate: string | null = null;
  let cursorId = 0;
  while (true) {
    const rows: TxnRow[] = cursorDate === null
      ? await db.all<TxnRow>(
          `${TXN_SELECT} WHERE ${sql} ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`,
          ...params,
          chunkSize,
        )
      : await db.all<TxnRow>(
          `${TXN_SELECT} WHERE ${sql} AND (t.txn_date < ? OR (t.txn_date = ? AND t.id < ?)) ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`,
          ...params,
          cursorDate,
          cursorDate,
          cursorId,
          chunkSize,
        );
    if (!rows.length) break;
    yield rows.map((r) => decorate(r)!);
    if (rows.length < chunkSize) break;
    const last = rows[rows.length - 1];
    cursorDate = last.txn_date;
    cursorId = Number(last.id);
  }
}

export async function listAllForExport(
  db: Db,
  ledgerId: number,
  chunkSize = 1000,
  filter: TxnFilter = {},
): Promise<TxnRow[]> {
  const all: TxnRow[] = [];
  for await (const batch of iterateAllForExport(db, ledgerId, chunkSize, filter)) {
    all.push(...batch);
  }
  return all;
}
