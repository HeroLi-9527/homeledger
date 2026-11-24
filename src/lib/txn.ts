import {
  balanceDeltaStmts,
  getSetting,
  nowStr,
  todayStr,
  txnEffects,
  TXN_TYPE_MAP,
} from '../db.js';
import type { AccountRow, BatchStatement, Db, Env, TxnRow } from '../types.js';
import * as attach from './attachments.js';
import { lastMonths, monthEnd, toBase } from './util.js';

let stampSeq = 0;
const stampMs = (): string => {
  const d = new Date();
  stampSeq = (stampSeq + 1) % 100000;
  return `${nowStr(d)}.${String(d.getMilliseconds()).padStart(3, '0')}-${String(stampSeq).padStart(5, '0')}`;
};

export const INCOME_TYPES = ['income', 'interest', 'refund', 'reimburse'] as const;
export const EXPENSE_TYPES = ['expense', 'fee'] as const;

export const TXN_SELECT = `
SELECT t.*,
  c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
  pc.name AS category_parent,
  a.name AS account_name, a.icon AS account_icon, a.type AS account_type,
  ta.name AS to_account_name, ta.icon AS to_account_icon,
  u.display_name AS member_name, u.avatar_color AS member_color,
  (SELECT GROUP_CONCAT(tg.name, ' ') FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
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
  if (f.source) {
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
];

function validateAccounts(type: string, accountId: number | null, toAccountId: number | null): void {
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

function kindOfType(type: string): 'income' | 'expense' | null {
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
  skipBalanceDelta?: boolean;
  updated_at?: string;
}

export async function createTransaction(db: Db, ledgerId: number, userId: number, d: TxnWriteInput): Promise<number> {
  const type = d.type && TXN_TYPE_MAP[d.type] ? d.type : 'expense';
  const amount = type === 'adjust' ? Math.round(Number(d.amount_cents) || 0) : Math.abs(Math.round(Number(d.amount_cents) || 0));
  if (!amount) throw new Error('金额必须大于 0');
  const currency = d.currency || 'CNY';
  const rate = await resolveRate(db, currency, d.rate);
  const accountId = await pickAccount(db, ledgerId, d.account_id);
  const toAccountId = await pickAccount(db, ledgerId, d.to_account_id);
  const categoryId = await pickCategory(db, ledgerId, d.category_id, kindOfType(type));
  validateAccounts(type, accountId, toAccountId);
  if (d.splits && d.splits.length) checkSplitsTotal(d.splits, amount);

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? String(d.txn_date) : todayStr();
  const baseCents = toBase(amount, rate);
  const newTxn = { type, amount_base_cents: baseCents, account_id: accountId, to_account_id: toAccountId };
  const stamp = nowStr();
  const stmts: BatchStatement[] = [
    [
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
        user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        stamp,
      ],
    ],
  ];
  if (!d.skipBalanceDelta) stmts.push(...balanceDeltaStmts([[newTxn, 1]]));
  const results = await db.batch(stmts);
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
  const currency = d.currency || old.currency;
  const rate = await resolveRate(db, currency, d.rate);
  const accountId = await pickAccount(db, ledgerId, d.account_id, old.account_id);
  const toAccountId = await pickAccount(db, ledgerId, d.to_account_id, old.to_account_id);
  const categoryId = await pickCategory(db, ledgerId, d.category_id, kindOfType(type));
  validateAccounts(type, accountId, toAccountId);
  if (d.splits && d.splits.length) checkSplitsTotal(d.splits, amount);

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
  const baseCents = toBase(amount, rate);
  const upd = await db.run(
    `UPDATE transactions SET type=?, amount_cents=?, currency=?, rate=?, amount_base_cents=?, account_id=?,
       to_account_id=?, category_id=?, txn_date=?, note=?, merchant=?, status=?, is_reimbursable=?,
       updated_at=? WHERE id=? AND ledger_id=? AND deleted_at IS NULL AND updated_at=?
       AND type=? AND amount_cents=? AND currency=? AND rate=? AND IFNULL(account_id, -1) = IFNULL(?, -1)
       AND IFNULL(to_account_id, -1) = IFNULL(?, -1)`,
    type,
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
    stamp,
    id,
    ledgerId,
    expectedToken,
    old.type,
    old.amount_cents,
    old.currency,
    old.rate,
    old.account_id,
    old.to_account_id,
  );
  if (upd.changes !== 1) throw new Error('记录已被他人修改，请刷新后重试');

  const newTxn = { type, amount_base_cents: baseCents, account_id: accountId, to_account_id: toAccountId };
  const delta = balanceDeltaStmts([
    [old, -1],
    [newTxn, 1],
  ]);
  if (delta.length) await db.batch(delta);
  try {
    await applyTags(db, id, ledgerId, d.tags, true);
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
  opts: { skipSync?: boolean; env?: Pick<Env, 'ATTACHMENTS'> } = {},
): Promise<boolean> {
  const pre = await db.get<TxnRow>(
    'SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL',
    id,
    ledgerId,
  );
  if (!pre) return false;
  if (pre.reimbursed_at) throw new Error('该笔已报销，请先删除报销入账记录后再删除');
  const attRows = opts.env?.ATTACHMENTS
    ? await db.all<{ rel_path: string }>('SELECT rel_path FROM attachments WHERE txn_id = ? AND ledger_id = ?', id, ledgerId)
    : [];
  const stamp = stampMs();
  const stmts: BatchStatement[] = [
    [
      'UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL AND updated_at = ?',
      [stamp, stamp, id, ledgerId, pre.updated_at],
    ],
    ...balanceDeltaStmts([[pre, -1]]),
    ['DELETE FROM transaction_tags WHERE transaction_id = ?', [id]],
    ['DELETE FROM attachments WHERE txn_id = ? AND ledger_id = ?', [id, ledgerId]],
  ];
  if (pre.group_id) stmts.push(['DELETE FROM splits WHERE group_id = ?', [pre.group_id]]);
  if (pre.type === 'reimburse') {
    stmts.push([
      'UPDATE transactions SET reimbursed_at = NULL, related_id = NULL WHERE related_id = ? AND ledger_id = ?',
      [id, ledgerId],
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
  if (attRows.length && opts.env?.ATTACHMENTS) {
    await attach.deleteKeysFromR2(opts.env, attRows.map((a) => a.rel_path));
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
  opts: { env?: Pick<Env, 'ATTACHMENTS'> } = {},
) {
  let n = 0;
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    try {
      if (await softDelete(db, Number(id), ledgerId, { skipSync: true, env: opts.env })) n++;
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
    'SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NOT NULL',
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
  const results = await db.batch([
    ['UPDATE transactions SET deleted_at = NULL, updated_at = ? WHERE id = ? AND ledger_id = ? AND deleted_at IS NOT NULL', [stamp, id, ledgerId]],
    ...balanceDeltaStmts([[t, 1]]),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) throw new Error('记录已被恢复或删除，请刷新后重试');
  try {
    await syncDebts(db, ledgerId);
  } catch (e) {
    console.error('syncDebts failed after restore txn', id, e);
  }
  return true;
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
  const stamp = nowStr();
  const note = `报销 ${rows.length} 笔，合计 ${(total / 100).toFixed(2)}`;
  const reimburseTxn = { type: 'reimburse', amount_base_cents: total, account_id: Number(accountId), to_account_id: null };
  const inList = rows.map(() => '?').join(',');
  const rowIds = rows.map((r) => r.id);
  const results = await db.batch([
    [
      `UPDATE transactions SET reimbursed_at = ? WHERE ledger_id = ? AND deleted_at IS NULL AND reimbursed_at IS NULL AND is_reimbursable = 1 AND type IN ('expense','fee') AND id IN (${inList})`,
      [stamp, ledgerId, ...rowIds],
    ],
    [
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
        user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ledgerId,
        'reimburse',
        total,
        'CNY',
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
        nowStr(),
      ],
    ],
    ...balanceDeltaStmts([[reimburseTxn, 1]]),
  ]);
  const txnId = Number(results[1]?.meta?.last_row_id || 0);
  if (Number(results[0]?.meta?.changes || 0) !== rows.length || !txnId) {
    try {
      await db.batch([
        [`UPDATE transactions SET reimbursed_at = NULL WHERE ledger_id = ? AND reimbursed_at = ? AND id IN (${inList})`, [ledgerId, stamp, ...rowIds]],
        ['UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowStr(), nowStr(), txnId]],
        ...balanceDeltaStmts([[reimburseTxn, -1]]),
      ]);
    } catch (e) {
      console.error('markReimbursed compensation failed', txnId, e);
    }
    throw new Error('部分记录已被删除或报销，请刷新后重试');
  }
  try {
    await db.run(
      `UPDATE transactions SET related_id = ? WHERE ledger_id = ? AND reimbursed_at = ? AND id IN (${inList})`,
      txnId,
      ledgerId,
      stamp,
      ...rowIds,
    );
  } catch (e) {
    console.error('markReimbursed related_id backfill failed', txnId, e);
  }
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
  if (replace) await db.run('DELETE FROM transaction_tags WHERE transaction_id = ?', txnId);
  if (!names.length) return;
  for (const name of names) {
    let tag = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    if (!tag) {
      await db.run('INSERT OR IGNORE INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, name, colorFromName(name));
      tag = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    }
    if (tag) {
      await db.run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', txnId, tag.id);
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
      ['DELETE FROM splits WHERE transaction_id = ?', [txnId]],
      ['UPDATE transactions SET group_id = NULL WHERE id = ?', [txnId]],
    ]);
    return null;
  }
  const gid = groupId || `sp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const stmts: BatchStatement[] = [['DELETE FROM splits WHERE group_id = ?', [gid]]];
  const now = nowStr();
  for (const s of splits) {
    const share = Math.round(Number(s.share_cents) || 0);
    if (share <= 0) throw new Error('分账金额必须大于 0');
    stmts.push([
      `INSERT INTO splits (group_id, transaction_id, ledger_id, user_id, member_name, share_cents, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [gid, txnId, ledgerId, s.user_id || null, String(s.member_name || '成员').slice(0, 30), share, now],
    ]);
  }
  stmts.push(['UPDATE transactions SET group_id = ? WHERE id = ?', [gid, txnId]]);
  await db.batch(stmts);
  return gid;
}

export async function splitsOf(db: Db, txnId: number) {
  return db.all('SELECT * FROM splits WHERE transaction_id = ? ORDER BY id', txnId);
}

export async function syncDebts(db: Db, ledgerId: number): Promise<void> {
  const [rows, repayRows, existingAuto] = await Promise.all([
    db.all<TxnRow>(
      `SELECT type, merchant, amount_base_cents, account_id, txn_date FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('lend','borrow')`,
      ledgerId,
    ),
    db.all<TxnRow>(
      `SELECT type, merchant, amount_base_cents FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('repay_receive','repay_pay')`,
      ledgerId,
    ),
    db.all<{ direction: string; counterparty: string; due_date: string | null }>(
      "SELECT direction, counterparty, due_date FROM debts WHERE ledger_id = ? AND note = '系统自动汇总' AND due_date IS NOT NULL",
      ledgerId,
    ),
  ]);
  const dueMap = new Map(existingAuto.map((r) => [`${r.direction}|${r.counterparty}`, r.due_date]));
  const map = new Map<
    string,
    { direction: string; counterparty: string; principal: number; account_id: number | null; earliest: string }
  >();
  for (const t of rows) {
    const key = `${t.type}|${t.merchant || '未指定'}`;
    const cur = map.get(key) || {
      direction: t.type === 'lend' ? 'receivable' : 'payable',
      counterparty: t.merchant || '未指定',
      principal: 0,
      account_id: t.account_id,
      earliest: t.txn_date,
    };
    cur.principal += Number(t.amount_base_cents);
    if (t.txn_date < cur.earliest) cur.earliest = t.txn_date;
    map.set(key, cur);
  }
  const repay = new Map<string, number>();
  for (const t of repayRows) {
    const key = `${t.type === 'repay_receive' ? 'lend' : 'borrow'}|${t.merchant || '未指定'}`;
    repay.set(key, (repay.get(key) || 0) + Number(t.amount_base_cents));
  }
  const stmts: BatchStatement[] = [["DELETE FROM debts WHERE ledger_id = ? AND note = '系统自动汇总'", [ledgerId]]];
  const now = nowStr();
  for (const [, v] of map) {
    const key = `${v.direction}|${v.counterparty}`;
    const paid = repay.get(`${v.direction === 'receivable' ? 'lend' : 'borrow'}|${v.counterparty}`) || 0;
    const balance = Math.max(0, v.principal - paid);
    stmts.push([
      `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, account_id, due_date, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        ledgerId,
        v.direction,
        v.counterparty,
        v.principal,
        balance,
        v.account_id,
        dueMap.get(key) ?? null,
        balance <= 0 ? 'closed' : 'open',
        '系统自动汇总',
        now,
      ],
    ]);
  }
  await db.batch(stmts);
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
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts.filter((x) => x.include_in_net)) {
    const b = Number(a.balance_cents);
    if (b >= 0) assets += b;
    else liabilities += Math.abs(b);
  }
  const net = accounts.filter((a) => a.include_in_net).reduce((s, a) => s + Number(a.balance_cents), 0);
  return { accounts, assets, liabilities, net };
}

export async function netWorthTrend(db: Db, ledgerId: number, months = 6) {
  const list = lastMonths(months, todayStr());
  const [allTxns, accounts] = await Promise.all([
    db.all<{ txn_date: string; type: string; amount_base_cents: number; account_id: number | null; to_account_id: number | null }>(
      `SELECT txn_date, type, amount_base_cents, account_id, to_account_id FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY txn_date`,
      ledgerId,
    ),
    db.all<Pick<AccountRow, 'id' | 'initial_cents' | 'include_in_net' | 'created_at' | 'balance_cents'>>(
      'SELECT id, initial_cents, include_in_net, created_at, balance_cents FROM accounts WHERE ledger_id = ? AND is_archived = 0',
      ledgerId,
    ),
  ]);
  const included = new Map(accounts.filter((a) => a.include_in_net).map((a) => [Number(a.id), a]));
  const sortedAccts = [...included.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const out: Array<{ month: string; value: number }> = [];
  let cum = 0;
  let idx = 0;
  let aidx = 0;
  for (const m of list) {
    const end = monthEnd(m);
    while (aidx < sortedAccts.length && String(sortedAccts[aidx].created_at).slice(0, 10) <= end) {
      cum += Number(sortedAccts[aidx].initial_cents);
      aidx++;
    }
    while (idx < allTxns.length && allTxns[idx].txn_date <= end) {
      for (const e of txnEffects(allTxns[idx])) if (included.has(e.accountId)) cum += e.delta;
      idx++;
    }
    out.push({ month: m, value: cum });
  }
  if (out.length) {
    out[out.length - 1].value = [...included.values()].reduce((s, a) => s + Number(a.balance_cents), 0);
  }
  return out;
}
