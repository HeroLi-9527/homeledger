import {
  ACCOUNT_GROUPS,
  ACCOUNT_TYPE_MAP,
  accountGroupOf,
  isCreditGroupType,
  todayStr,
  type AccountGroupKey,
} from '../db.js';
import type { AccountRow, Db } from '../types.js';
import { addMonths, daysInMonth, esc, fmtAmount, pad, parseAmountToCents } from './util.js';

export interface NextMonthlyDay {
  date: string;
  daysUntil: number;
  cycleKey: string;
}

export interface CreditMetrics {
  debtCents: number;
  overflowCents: number;
  limitCents: number | null;
  availableCents: number | null;
  usagePct: number;
  nextBill: NextMonthlyDay | null;
  nextDue: NextMonthlyDay | null;
}

export interface GroupedAccountsSummary {
  active: AccountRow[];
  archived: AccountRow[];
  groups: Record<AccountGroupKey, AccountRow[]>;
  fundsTotalCents: number;
  prepaidTotalCents: number;
  creditDebtCents: number;
  creditLimitCents: number;
  creditAvailableCents: number;
}

function utcDayMs(dateStr: string): number {
  return Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
}

export function nextMonthlyDay(dayOfMonth: number | null | undefined, today = todayStr()): NextMonthlyDay | null {
  const day = Number(dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? String(today).slice(0, 10) : todayStr();
  const curMonth = ref.slice(0, 7);
  const curMax = daysInMonth(curMonth);
  let targetDate = `${curMonth}-${pad(Math.min(day, curMax))}`;
  if (targetDate < ref) {
    const nextMonth = addMonths(curMonth, 1);
    const nextMax = daysInMonth(nextMonth);
    targetDate = `${nextMonth}-${pad(Math.min(day, nextMax))}`;
  }
  const daysUntil = Math.round((utcDayMs(targetDate) - utcDayMs(ref)) / 86400000);
  return { date: targetDate, daysUntil, cycleKey: targetDate };
}

export function creditMetrics(
  acc: Pick<AccountRow, 'balance_cents' | 'credit_limit' | 'bill_day' | 'due_day'>,
  today = todayStr(),
): CreditMetrics {
  const balance = Number(acc.balance_cents || 0);
  const debtCents = Math.max(0, -balance);
  const overflowCents = Math.max(0, balance);
  const rawLimit = acc.credit_limit;
  const limitCents = rawLimit !== null && rawLimit !== undefined && Number(rawLimit) >= 0 ? Number(rawLimit) : null;
  const availableCents = limitCents !== null ? Math.max(0, limitCents + balance) : null;
  const usagePct = limitCents !== null && limitCents > 0 ? Math.round((debtCents / limitCents) * 1000) / 10 : 0;
  return {
    debtCents,
    overflowCents,
    limitCents,
    availableCents,
    usagePct,
    nextBill: nextMonthlyDay(acc.bill_day, today),
    nextDue: nextMonthlyDay(acc.due_day, today),
  };
}

export function groupAccountsSummary(accounts: AccountRow[], rates?: ReadonlyMap<string, number>): GroupedAccountsSummary {
  const baseValue = (a: AccountRow, cents: number) =>
    Math.round(cents * (rates ? rates.get(a.currency.toUpperCase()) ?? 0 : 1));
  const active = accounts.filter((a) => !a.is_archived);
  const archived = accounts.filter((a) => Boolean(a.is_archived));
  const groups: Record<AccountGroupKey, AccountRow[]> = {
    funds: [],
    prepaid: [],
    credit: [],
  };
  for (const a of active) {
    groups[accountGroupOf(a.type)].push(a);
  }
  const fundsTotalCents = groups.funds.reduce((s, a) => s + baseValue(a, Number(a.balance_cents || 0)), 0);
  const prepaidTotalCents = groups.prepaid.reduce((s, a) => s + baseValue(a, Number(a.balance_cents || 0)), 0);
  const creditDebtCents = groups.credit.reduce((s, a) => s + baseValue(a, Math.max(0, -Number(a.balance_cents || 0))), 0);
  const creditLimitCents = groups.credit.reduce(
    (s, a) => s + (a.credit_limit != null && Number(a.credit_limit) > 0 ? baseValue(a, Number(a.credit_limit)) : 0),
    0,
  );
  const creditAvailableCents = groups.credit.reduce((s, a) => s + baseValue(a, creditMetrics(a).availableCents ?? 0), 0);
  return {
    active,
    archived,
    groups,
    fundsTotalCents,
    prepaidTotalCents,
    creditDebtCents,
    creditLimitCents,
    creditAvailableCents,
  };
}

export function accountOptionsHtml(
  accounts: AccountRow[],
  opts: {
    selectedId?: number | string | null;
    emptyLabel?: string;
    showBalance?: boolean;
    excludeId?: number | null;
  } = {},
): string {
  const sel = opts.selectedId !== undefined && opts.selectedId !== null && opts.selectedId !== '' ? Number(opts.selectedId) : null;
  const ex = opts.excludeId != null ? Number(opts.excludeId) : null;
  const buckets = new Map<AccountGroupKey, AccountRow[]>(ACCOUNT_GROUPS.map((g) => [g.key, []]));
  for (const a of accounts) {
    if (ex !== null && Number(a.id) === ex) continue;
    buckets.get(accountGroupOf(a.type))?.push(a);
  }
  const parts: string[] = [];
  if (opts.emptyLabel !== undefined) {
    parts.push(`<option value="">${esc(opts.emptyLabel)}</option>`);
  }
  for (const g of ACCOUNT_GROUPS) {
    const list = buckets.get(g.key) || [];
    if (!list.length) continue;
    const options = list
      .map((a) => {
        const b = Number(a.balance_cents || 0);
        const balStr = opts.showBalance
          ? isCreditGroupType(a.type) && b < 0
            ? `（待还 ${esc(a.currency)} ${fmtAmount(Math.abs(b))}）`
            : `（${esc(a.currency)} ${fmtAmount(b)}）`
          : '';
        return `<option value="${a.id}" ${sel === Number(a.id) ? 'selected' : ''}>${esc(a.icon || '💳')} ${esc(a.name)}${balStr}</option>`;
      })
      .join('');
    parts.push(`<optgroup label="${esc(g.icon)} ${esc(g.label)}">${options}</optgroup>`);
  }
  return parts.join('');
}

function parseOptionalDay(raw: unknown, label: string, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    throw new Error(`${label}须为 1 至 31 之间的整数`);
  }
  return n;
}

function parseBoolFlag(v: unknown): number {
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'off' || v === null) return 0;
  return 1;
}

function parseOptionalCreditLimit(
  body: Record<string, unknown>,
  apiMode: boolean,
  fallback: number | null,
): number | null {
  if (apiMode) {
    if (body.credit_limit_cents !== undefined) {
      if (body.credit_limit_cents === null || String(body.credit_limit_cents).trim() === '') return null;
      const cents = Math.round(Number(body.credit_limit_cents));
      if (!Number.isFinite(cents) || cents < 0) throw new Error('信用额度不能为负数');
      return cents;
    }
    if (body.credit_limit_yuan !== undefined) {
      const raw = String(body.credit_limit_yuan ?? '').trim();
      if (!raw) return null;
      const cents = parseAmountToCents(raw);
      if (cents < 0) throw new Error('信用额度不能为负数');
      return cents;
    }
    if (body.credit_limit !== undefined) {
      if (body.credit_limit === null || String(body.credit_limit).trim() === '') return null;
      const cents = Math.round(Number(body.credit_limit));
      if (!Number.isFinite(cents) || cents < 0) throw new Error('信用额度不能为负数');
      return cents;
    }
    return fallback;
  }

  if (body.credit_limit === undefined) return fallback;
  const raw = String(body.credit_limit ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[¥$€£,\s元块圆]/g, '');
  if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(cleaned)) throw new Error('信用额度格式不正确');
  const cents = parseAmountToCents(raw);
  if (cents < 0) throw new Error('信用额度不能为负数');
  return cents;
}

export interface NormalizedAccountWrite {
  name: string;
  type: string;
  icon: string;
  currency: string;
  include_in_net: number;
  sort_order: number;
  institution: string | null;
  card_no: string | null;
  note: string | null;
  credit_limit: number | null;
  bill_day: number | null;
  due_day: number | null;
  initial_cents?: number;
  balance_cents?: number;
}

export function normalizeAccountWrite(
  body: Record<string, unknown>,
  opts: { mode: 'create' | 'edit'; existing?: AccountRow; apiMode?: boolean },
): NormalizedAccountWrite {
  const apiMode = Boolean(opts.apiMode);
  const ex = opts.existing;

  const rawName = body.name !== undefined ? String(body.name || '').trim() : ex?.name || '';
  const name = rawName.slice(0, 30);
  if (!name) throw new Error('请填写账户名称');

  const rawType = body.type !== undefined ? String(body.type || '').trim() : ex?.type || 'cash';
  const typeMeta = ACCOUNT_TYPE_MAP[rawType];
  if (!typeMeta) throw new Error('不支持的账户类型');
  const type = typeMeta.key;

  const iconRaw = body.icon !== undefined ? String(body.icon || '').trim() : ex?.icon || typeMeta.icon;
  const icon = (iconRaw || typeMeta.icon || '💳').slice(0, 16);

  const curRaw = body.currency !== undefined ? String(body.currency || '').trim().toUpperCase() : ex?.currency || 'CNY';
  const currency = (curRaw || 'CNY').slice(0, 8);
  if (ex && currency !== ex.currency && (ex.initial_cents || ex.balance_cents || ex.credit_limit)) {
    throw new Error('已有余额或额度的账户不能更换币种');
  }

  let includeInNet: number;
  if (body.include_in_net !== undefined) {
    includeInNet = parseBoolFlag(body.include_in_net);
  } else if (body._include_in_net_present) {
    includeInNet = 0;
  } else {
    includeInNet = opts.mode === 'edit' && ex ? Number(ex.include_in_net) : 1;
  }

  const sortOrder =
    body.sort_order !== undefined && String(body.sort_order).trim() !== ''
      ? Math.round(Number(body.sort_order) || 0)
      : (ex?.sort_order ?? 0);

  const optText = (val: unknown, max: number, prev: string | null | undefined): string | null => {
    if (val === undefined) return prev ?? null;
    const s = String(val ?? '').trim();
    return s ? s.slice(0, max) : null;
  };

  const institution = optText(body.institution, 40, ex?.institution);
  const cardNo = optText(body.card_no, 16, ex?.card_no);
  const note = optText(body.note, 200, ex?.note);

  const isCredit = isCreditGroupType(type);
  const creditLimit = isCredit ? parseOptionalCreditLimit(body, apiMode, ex?.credit_limit ?? null) : null;
  const billDay = isCredit ? parseOptionalDay(body.bill_day, '账单日', ex?.bill_day ?? null) : null;
  const dueDay = isCredit ? parseOptionalDay(body.due_day, '还款日', ex?.due_day ?? null) : null;

  const out: NormalizedAccountWrite = {
    name,
    type,
    icon,
    currency,
    include_in_net: includeInNet,
    sort_order: sortOrder,
    institution,
    card_no: cardNo,
    note,
    credit_limit: creditLimit,
    bill_day: billDay,
    due_day: dueDay,
  };

  if (opts.mode === 'create') {
    let opening = 0;
    if (apiMode) {
      if (body.debt_cents !== undefined && body.debt_cents !== null && String(body.debt_cents).trim() !== '') {
        opening = -Math.abs(Math.round(Number(body.debt_cents) || 0));
      } else if (body.debt !== undefined && body.debt !== null && String(body.debt).trim() !== '') {
        opening = -Math.abs(parseAmountToCents(body.debt));
      } else if (body.initial_cents != null) {
        opening = Math.round(Number(body.initial_cents) || 0);
      } else {
        opening = parseAmountToCents(body.balance);
      }
    } else {
      const parsed = parseAmountToCents(body.balance);
      opening = isCredit ? -Math.abs(parsed) : parsed;
    }
    out.initial_cents = opening;
    out.balance_cents = opening;
  }

  return out;
}

export interface AccountReferenceCounts {
  transactions: number;
  subscriptions: number;
  recurring_rules: number;
  budgets: number;
  goals: number;
  debts: number;
  total: number;
}

export async function findAccountReferences(
  db: Db,
  ledgerId: number,
  accountId: number,
): Promise<AccountReferenceCounts> {
  const aid = Number(accountId);
  const lid = Number(ledgerId);
  const [txnRow, subRow, recRows, budRow, goalRow, debtRow] = await Promise.all([
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND (account_id = ? OR to_account_id = ?)',
      lid,
      aid,
      aid,
    ),
    db.get<{ c: number }>('SELECT COUNT(*) AS c FROM subscriptions WHERE ledger_id = ? AND account_id = ?', lid, aid),
    db.all<{ payload: string }>('SELECT payload FROM recurring_rules WHERE ledger_id = ?', lid),
    db.get<{ c: number }>('SELECT COUNT(*) AS c FROM budgets WHERE ledger_id = ? AND account_id = ?', lid, aid),
    db.get<{ c: number }>('SELECT COUNT(*) AS c FROM goals WHERE ledger_id = ? AND account_id = ?', lid, aid),
    db.get<{ c: number }>('SELECT COUNT(*) AS c FROM debts WHERE ledger_id = ? AND account_id = ?', lid, aid),
  ]);

  let recurringCount = 0;
  for (const r of recRows) {
    let matched = false;
    try {
      const parsed = JSON.parse(r.payload || '{}') as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
          ? (parsed as { items: unknown[] }).items
          : parsed && typeof parsed === 'object'
            ? [parsed]
            : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const rec = it as Record<string, unknown>;
        if (
          aid > 0 &&
          ((rec.account_id != null && Number(rec.account_id) === aid) ||
            (rec.to_account_id != null && Number(rec.to_account_id) === aid))
        ) {
          matched = true;
          break;
        }
      }
    } catch {
      // 忽略损坏 JSON（不采用正则猜测），统一按有效周期规则对象校验
    }
    if (matched) recurringCount++;
  }

  const transactions = Number(txnRow?.c || 0);
  const subscriptions = Number(subRow?.c || 0);
  const budgets = Number(budRow?.c || 0);
  const goals = Number(goalRow?.c || 0);
  const debts = Number(debtRow?.c || 0);
  return {
    transactions,
    subscriptions,
    recurring_rules: recurringCount,
    budgets,
    goals,
    debts,
    total: transactions + subscriptions + recurringCount + budgets + goals + debts,
  };
}

export function formatAccountRefError(refs: AccountReferenceCounts): string {
  const parts: string[] = [];
  if (refs.transactions > 0) parts.push(`未删除记账 ${refs.transactions} 笔`);
  if (refs.subscriptions > 0) parts.push(`订阅 ${refs.subscriptions} 个`);
  if (refs.recurring_rules > 0) parts.push(`周期账单 ${refs.recurring_rules} 个`);
  if (refs.budgets > 0) parts.push(`预算 ${refs.budgets} 个`);
  if (refs.goals > 0) parts.push(`储蓄目标 ${refs.goals} 个`);
  if (refs.debts > 0) parts.push(`借贷记录 ${refs.debts} 笔`);
  return parts.length ? `该账户仍被引用（${parts.join('、')}），无法删除` : '该账户无法删除';
}

export async function deleteAccountIfUnreferenced(
  db: Db,
  ledgerId: number,
  accountId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const refs = await findAccountReferences(db, ledgerId, accountId);
  if (refs.total > 0) {
    return { ok: false, error: formatAccountRefError(refs) };
  }
  const res = await db.run(
    `DELETE FROM accounts
     WHERE id = ? AND ledger_id = ?
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = accounts.ledger_id AND (t.account_id = accounts.id OR t.to_account_id = accounts.id))
       AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.ledger_id = accounts.ledger_id AND s.account_id = accounts.id)
       AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.ledger_id = accounts.ledger_id AND b.account_id = accounts.id)
       AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.ledger_id = accounts.ledger_id AND g.account_id = accounts.id)
       AND NOT EXISTS (SELECT 1 FROM debts d WHERE d.ledger_id = accounts.ledger_id AND d.account_id = accounts.id)`,
    accountId,
    ledgerId,
  );
  if (Number(res.changes || 0) === 1) return { ok: true };
  const after = await findAccountReferences(db, ledgerId, accountId);
  if (after.total > 0) return { ok: false, error: formatAccountRefError(after) };
  return { ok: false, error: '账户不存在或已被删除' };
}
