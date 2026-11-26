import type { BatchStatement } from '../types.js';
import { accountAmounts, balanceDeltaStmts, nowStr, todayStr } from '../db.js';
import type { Db } from '../types.js';
import { ledgerWriterIds, notify } from './auth.js';
import { resolveRate } from './txn.js';
import { pad, toBase } from './util.js';

export const CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};

export const CYCLE_LABEL: Record<string, string> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季',
  half_yearly: '每半年',
  yearly: '每年',
};

export const CYCLE_UNIT: Record<string, string> = {
  weekly: '周',
  monthly: '月',
  quarterly: '季',
  half_yearly: '半年',
  yearly: '年',
};

export const STATUS_LABEL: Record<string, string> = {
  trial: '试用中',
  active: '生效中',
  paused: '已暂停',
  canceled: '已取消',
};

const STATUS_KIND: Record<string, string> = {
  trial: 'primary',
  active: 'income',
  paused: 'warn',
  canceled: '',
};

const MAX_CATCHUP = 6;

export interface SubscriptionRow {
  id: number;
  ledger_id: number;
  name: string;
  icon: string;
  plan: string | null;
  vendor_url: string | null;
  amount_cents: number;
  currency: string;
  cycle: string;
  cycle_n: number;
  anchor_month: number | null;
  anchor_day: number | null;
  account_id: number | null;
  category_id: number | null;
  auto_renew: number;
  trial_ends_on: string | null;
  next_charge_at: string;
  last_charge_at: string | null;
  reminder_days: number;
  charge_count: number;
  status: string;
  note: string | null;
  created_by_user_id: number | null;
  canceled_at: string | null;
  created_at: string;
  account_name?: string | null;
  category_name?: string | null;
  category_icon?: string | null;
}

export const cycleOf = (v?: string | null): string => (v && (CYCLE_MONTHS[v] || v === 'weekly') ? v : 'monthly');

export const cycleLabel = (cycle?: string | null, n = 1): string => {
  const c = cycleOf(cycle);
  const times = Math.max(1, Number(n) || 1);
  if (times === 1) return CYCLE_LABEL[c];
  return `每 ${times} ${CYCLE_UNIT[c]}`;
};

export const statusLabel = (s: string): string => STATUS_LABEL[s] || '生效中';

export function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function advance(
  dateStr: string,
  sub: { cycle?: string; cycle_n?: number; anchor_day?: number | null } = {},
): string {
  const cycle = cycleOf(sub.cycle);
  const n = Math.max(1, Number(sub.cycle_n) || 1);
  const base = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return String(dateStr).slice(0, 10);

  if (cycle === 'weekly') {
    base.setUTCDate(base.getUTCDate() + 7 * n);
    return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
  }
  const months = CYCLE_MONTHS[cycle] * n;
  const anchorDay = Number(sub.anchor_day) || base.getUTCDate();
  const year = base.getUTCFullYear();
  const monthIdx = base.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIdx / 12);
  const targetMonth = (monthIdx % 12) + 1;
  const day = Math.min(anchorDay, lastDayOf(targetYear, targetMonth));
  return `${targetYear}-${pad(targetMonth)}-${pad(day)}`;
}

export function firstChargeDate({
  cycle,
  cycle_n,
  anchor_month,
  anchor_day,
  startFrom = todayStr(),
}: {
  cycle?: string;
  cycle_n?: number;
  anchor_month?: number | null;
  anchor_day?: number | null;
  startFrom?: string;
}): string {
  const c = cycleOf(cycle);
  const from = String(startFrom).slice(0, 10);
  const startDay = Number(from.slice(8, 10));
  const day = Math.max(1, Math.min(31, Number(anchor_day) || startDay));
  if (c === 'weekly') return from;

  const step = CYCLE_MONTHS[c] * Math.max(1, Number(cycle_n) || 1);
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  if (c === 'yearly' && Number(anchor_month)) month = Math.max(1, Math.min(12, Number(anchor_month)));

  const build = (y: number, m: number) => `${y}-${pad(m)}-${pad(Math.min(day, lastDayOf(y, m)))}`;
  let date = build(year, month);
  if (date < from) {
    const idx = month - 1 + step;
    year += Math.floor(idx / 12);
    month = (idx % 12) + 1;
    date = build(year, month);
  }
  return date;
}

export function daysUntil(dateStr: string): number | null {
  const t = new Date(`${todayStr()}T00:00:00Z`);
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

export function annualCents(sub: { amount_cents: number; cycle?: string; cycle_n?: number }): number {
  const amount = Math.abs(Number(sub.amount_cents) || 0);
  const c = cycleOf(sub.cycle);
  const n = Math.max(1, Number(sub.cycle_n) || 1);
  if (c === 'weekly') return Math.round((amount * 52) / n);
  return Math.round((amount * 12) / (CYCLE_MONTHS[c] * n));
}

export function monthlyCents(sub: { amount_cents: number; cycle?: string; cycle_n?: number }): number {
  return Math.round(annualCents(sub) / 12);
}

export function decorate(sub: SubscriptionRow, extras: Record<string, unknown> = {}) {
  const left = daysUntil(sub.next_charge_at);
  const monthEq = monthlyCents(sub);
  const trialLeft = sub.trial_ends_on ? daysUntil(sub.trial_ends_on) : null;
  return {
    ...sub,
    cycleLabel: cycleLabel(sub.cycle, sub.cycle_n),
    statusLabel: statusLabel(sub.status),
    statusKind: STATUS_KIND[sub.status] || 'info',
    monthly_cents: monthEq,
    annual_cents: annualCents(sub),
    daysLeft: left,
    dueLabel: left === null ? '—' : left < 0 ? `已逾期 ${-left} 天` : left === 0 ? '今天扣费' : `${left} 天后`,
    trialLeft,
    trialDue: trialLeft !== null && trialLeft >= 0 && trialLeft <= 7,
    ...extras,
  };
}

export async function overview(db: Db, ledgerId: number) {
  const month = todayStr().slice(0, 7);
  const [rows, chargedRow, ledgerRow] = await Promise.all([
    db.all<SubscriptionRow>(
      `SELECT s.*, a.name AS account_name, c.name AS category_name, c.icon AS category_icon
       FROM subscriptions s
       LEFT JOIN accounts a ON a.id = s.account_id AND a.ledger_id = s.ledger_id
       LEFT JOIN categories c ON c.id = s.category_id AND (c.ledger_id IS NULL OR c.ledger_id = s.ledger_id)
       WHERE s.ledger_id = ?
       ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                s.next_charge_at, s.id`,
      Number(ledgerId),
    ),
    db.get<{ s: number }>(
      `SELECT COALESCE(SUM(amount_base_cents),0) AS s FROM transactions
       WHERE ledger_id = ? AND subscription_id IS NOT NULL AND deleted_at IS NULL
       AND substr(txn_date, 1, 7) = ?`,
      Number(ledgerId),
      month,
    ),
    db.get<{ currency: string }>('SELECT currency FROM ledgers WHERE id = ?', Number(ledgerId)),
  ]);

  const baseCurrency = String(ledgerRow?.currency || 'CNY').toUpperCase();
  const items = rows.map((r) => decorate(r, { charge_count: Number(r.charge_count) || 0 }));
  const live = items.filter((s) => s.status === 'active' || s.status === 'trial');
  const dueThisMonthItems = live.filter((s) => String(s.next_charge_at).slice(0, 7) === month);
  let thisMonthPending = 0;
  for (const s of dueThisMonthItems) {
    const rate = await resolveRate(db, s.currency || baseCurrency, baseCurrency);
    thisMonthPending += toBase(Math.abs(Number(s.amount_cents) || 0), rate);
  }
  const upcoming =
    live.filter((s) => s.daysLeft !== null && s.daysLeft <= 7).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0] ||
    null;

  return {
    items,
    live,
    active: items.filter((s) => s.status === 'active'),
    trials: items.filter((s) => s.status === 'trial'),
    paused: items.filter((s) => s.status === 'paused'),
    canceled: items.filter((s) => s.status === 'canceled'),
    monthlyTotal: live.reduce((sum, s) => sum + Number(s.monthly_cents), 0),
    annualTotal: live.reduce((sum, s) => sum + Number(s.annual_cents), 0),
    annualPaidCount: live.filter((s) => s.cycle === 'yearly' || s.cycle === 'half_yearly').length,
    dueThisMonth: dueThisMonthItems.length,
    thisMonthPending,
    thisMonthCharged: Number(chargedRow?.s || 0),
    upcoming,
  };
}

export async function chargesOf(db: Db, ledgerId: number, subId: number, limit = 12) {
  return db.all<{ id: number; amount_base_cents: number; txn_date: string; note: string | null; status: string }>(
    `SELECT id, amount_base_cents, txn_date, note, status FROM transactions
     WHERE ledger_id = ? AND subscription_id = ? AND deleted_at IS NULL
     ORDER BY txn_date DESC, id DESC LIMIT ?`,
    Number(ledgerId),
    Number(subId),
    Number(limit),
  );
}

export async function accountUsable(db: Db, accountId: number | null | undefined, ledgerId: number | null | undefined): Promise<boolean> {
  if (!accountId || ledgerId == null) return false;
  const row = await db.get<{ id: number }>(
    'SELECT id FROM accounts WHERE id = ? AND ledger_id = ? AND is_archived = 0',
    Number(accountId),
    Number(ledgerId),
  );
  return !!row;
}

export async function charge(db: Db, sub: SubscriptionRow, userId: number | null, period = sub.next_charge_at) {
  const amount = Math.abs(Number(sub.amount_cents) || 0);
  const next = advance(period, sub);
  const guard = `EXISTS (
    SELECT 1 FROM subscriptions s JOIN ledgers l ON l.id = s.ledger_id WHERE s.id = ?
      AND s.next_charge_at = ? AND s.status = ? AND s.account_id IS ? AND s.amount_cents = ?
      AND s.auto_renew = ? AND s.currency = ? AND s.category_id IS ? AND s.trial_ends_on IS ?
      AND s.cycle = ? AND s.cycle_n = ? AND s.anchor_day IS ? AND l.is_archived = 0
  )`;
  const params = [sub.id, period, sub.status, sub.account_id, sub.amount_cents, sub.auto_renew,
    sub.currency, sub.category_id, sub.trial_ends_on, sub.cycle, sub.cycle_n, sub.anchor_day];
  const stamp = nowStr();
  const statements: BatchStatement[] = [];
  if (amount) {
    if (!(await accountUsable(db, sub.account_id, sub.ledger_id))) {
      throw new Error('扣费账户不存在或已归档，请先在订阅设置里更换账户');
    }
    const label = sub.plan ? `${sub.name}（${sub.plan}）` : sub.name;
    const currency = sub.currency || 'CNY';
    const rate = await resolveRate(db, currency);
    const baseCents = toBase(amount, rate);
    const effect = { type: 'expense', amount_base_cents: baseCents, account_id: sub.account_id || null };
    const chargeTxn = { ...effect, ...await accountAmounts(db, sub.ledger_id, { ...effect, currency, amount_cents: amount }) };
    statements.push([
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id,
        user_id, txn_date, note, merchant, status, source, subscription_id, created_at, updated_at, account_amount_cents, scheduled_period)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
      [sub.ledger_id, 'expense', amount, currency, rate, baseCents, sub.account_id, sub.category_id,
        userId || sub.created_by_user_id || 1, period, `订阅扣费 · ${label}`, sub.name, 'cleared', 'subscription',
        sub.id, stamp, stamp, chargeTxn.account_amount_cents, period, ...params],
    ]);
    for (const [sql, args] of balanceDeltaStmts([[chargeTxn, 1]])) statements.push([`${sql} AND ${guard}`, [...(args ?? []), ...params]]);
  }
  statements.push([
    `UPDATE subscriptions SET next_charge_at = ?, last_charge_at = CASE WHEN ? THEN ? ELSE last_charge_at END,
      charge_count = charge_count + ? WHERE id = ? AND ${guard}`,
    [next, Number(Boolean(amount)), period, Number(Boolean(amount)), sub.id, ...params],
  ]);
  const results = await db.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) return null;
  return { transactionId: amount ? Number(results[0].meta.last_row_id) : null, next };
}

export async function runDue(db: Db, today = todayStr()) {
  const month = today.slice(0, 7);
  const noEndTrials = await db.all<SubscriptionRow>(
    "SELECT s.* FROM subscriptions s JOIN ledgers l ON l.id = s.ledger_id WHERE l.is_archived = 0 AND status = 'trial' AND trial_ends_on IS NULL",
  );
  for (const t of noEndTrials) {
    const key = `subtrial-noend:${t.id}:${month}`;
    for (const uid of await ledgerWriterIds(db, t.ledger_id)) {
      await notify(db, uid, {
        kind: 'warn',
        ledgerId: t.ledger_id,
        title: `试用订阅缺结束日：${t.name}`,
        body: '试用订阅未填试用结束日，已暂停自动扣费，请编辑补填结束日后再恢复',
        link: '/subscriptions',
        dedupeKey: key,
      });
    }
  }

  const expiredTrials = await db.all<SubscriptionRow>(
    "SELECT s.* FROM subscriptions s JOIN ledgers l ON l.id = s.ledger_id WHERE l.is_archived = 0 AND status = 'trial' AND trial_ends_on IS NOT NULL AND trial_ends_on <= ?",
    today,
  );
  for (const t of expiredTrials) {
    const toStatus = t.auto_renew ? 'active' : 'paused';
    const updated = await db.run(`UPDATE subscriptions SET status = ? WHERE id = ? AND status = 'trial'
      AND trial_ends_on = ? AND auto_renew = ?
      AND EXISTS (SELECT 1 FROM ledgers WHERE id = subscriptions.ledger_id AND is_archived = 0)`,
      toStatus, t.id, t.trial_ends_on, t.auto_renew);
    if (updated.changes !== 1) continue;
    const key = `subtrial-end:${t.id}:${t.trial_ends_on}`;
    for (const uid of await ledgerWriterIds(db, t.ledger_id)) {
      await notify(db, uid, {
        kind: t.auto_renew ? 'info' : 'warn',
        ledgerId: t.ledger_id,
        title: t.auto_renew ? `试用已结束，开始扣费：${t.name}` : `试用已结束：${t.name}`,
        body: t.auto_renew
          ? `试用于 ${t.trial_ends_on} 结束，已开启自动续费，将按 ${(t.amount_cents / 100).toFixed(2)} ${cycleLabel(t.cycle, t.cycle_n)}扣费`
          : `试用于 ${t.trial_ends_on} 结束，未开启自动续费，订阅已暂停`,
        link: '/subscriptions',
        dedupeKey: key,
      });
    }
  }

  const due = await db.all<SubscriptionRow>(
    "SELECT s.* FROM subscriptions s JOIN ledgers l ON l.id = s.ledger_id WHERE l.is_archived = 0 AND status IN ('active','trial') AND next_charge_at <= ? ORDER BY next_charge_at, id",
    today,
  );
  const stat = { charged: 0, renewed: 0, notified: 0 };
  for (const sub of due) {
    if (sub.status === 'trial' && !sub.trial_ends_on) continue;
    if (sub.status === 'trial' && sub.trial_ends_on && sub.trial_ends_on > today) continue;
    if (!sub.auto_renew) {
      const key = `sub-hold:${sub.id}:${sub.next_charge_at}:${month}`;
      for (const uid of await ledgerWriterIds(db, sub.ledger_id)) {
        if (
          await notify(db, uid, {
            kind: 'warn',
            ledgerId: sub.ledger_id,
            title: `订阅到期待确认：${sub.name}`,
            body: `计划扣费 ${sub.next_charge_at}，金额 ${(sub.amount_cents / 100).toFixed(2)}`,
            link: '/subscriptions',
            dedupeKey: key,
          })
        ) {
          stat.notified++;
        }
      }
      continue;
    }

    let cursor = sub.next_charge_at;
    let renewed = false;
    for (let count = 0; cursor <= today && count < MAX_CATCHUP; count++) {
      try {
        if (!(await accountUsable(db, sub.account_id, sub.ledger_id))) {
          const next = advance(cursor, sub);
          const skipped = await db.run(`UPDATE subscriptions SET next_charge_at = ?
            WHERE id = ? AND next_charge_at = ? AND status = ? AND auto_renew = 1 AND account_id IS ?
              AND EXISTS (SELECT 1 FROM ledgers WHERE id = subscriptions.ledger_id AND is_archived = 0)`,
            next, sub.id, cursor, sub.status, sub.account_id);
          if (skipped.changes !== 1) break;
          for (const uid of await ledgerWriterIds(db, sub.ledger_id)) {
            await notify(db, uid, {
              kind: 'warn', ledgerId: sub.ledger_id, title: `订阅扣费跳过：${sub.name}`,
              body: `计划扣费 ${cursor}，扣费账户不存在或已归档，本期已跳过，请检查订阅设置`,
              link: '/subscriptions', dedupeKey: `sub-noaccount:${sub.id}:${cursor}`,
            });
          }
          cursor = next;
          continue;
        }
        const result = await charge(db, sub, sub.created_by_user_id, cursor);
        if (!result) break;
        if (result.transactionId) stat.charged++;
        if (sub.trial_ends_on && result.next > sub.trial_ends_on) renewed = true;
        cursor = result.next;
      } catch (error) {
        console.error('[subscriptions] 扣费失败，本期保留:', sub.id, error);
        break;
      }
    }
    if (renewed) stat.renewed++;

  }
  return stat;
}

export async function checkReminders(db: Db, today = todayStr()): Promise<number> {
  const items = await db.all<SubscriptionRow>("SELECT s.* FROM subscriptions s JOIN ledgers l ON l.id = s.ledger_id WHERE l.is_archived = 0 AND status IN ('active','trial')");
  let n = 0;
  for (const sub of items) {
    const days = daysUntil(sub.next_charge_at);
    const ahead = Math.max(0, Number(sub.reminder_days) || 0);
    const pastDueNoRenew = !sub.auto_renew && sub.next_charge_at && sub.next_charge_at <= today;
    if (days !== null && days >= 0 && days <= ahead && !pastDueNoRenew) {
      const key = `sub:${sub.id}:${sub.next_charge_at}`;
      for (const uid of await ledgerWriterIds(db, sub.ledger_id)) {
        if (
          await notify(db, uid, {
            kind: 'info',
            ledgerId: sub.ledger_id,
            title: `订阅即将扣费：${sub.name}`,
            body: `${days === 0 ? '今天' : `${days} 天后`}（${sub.next_charge_at}）将扣 ${(sub.amount_cents / 100).toFixed(2)}`,
            link: '/subscriptions',
            dedupeKey: key,
          })
        ) {
          n++;
        }
      }
    }
    if (sub.trial_ends_on) {
      const tDays = daysUntil(sub.trial_ends_on);
      if (tDays !== null && tDays >= 0 && tDays <= 3) {
        const key = `subtrial:${sub.id}:${sub.trial_ends_on}`;
        for (const uid of await ledgerWriterIds(db, sub.ledger_id)) {
          if (
            await notify(db, uid, {
              kind: 'warn',
              ledgerId: sub.ledger_id,
              title: `试用即将结束：${sub.name}`,
              body: `${tDays === 0 ? '今天' : `${tDays} 天后`}结束试用，之后将按 ${(sub.amount_cents / 100).toFixed(2)} ${cycleLabel(sub.cycle, sub.cycle_n)}扣费，不想续就先去取消`,
              link: '/subscriptions',
              dedupeKey: key,
            })
          ) {
            n++;
          }
        }
      }
    }
  }
  return n;
}
