import { accountAmounts, balanceDeltaStmts, nowStr, todayStr } from '../db.js';
import type { AccountRow, BatchStatement, Db, Env, SessionCardRow } from '../types.js';
import { nextMonthlyDay } from './accounts.js';
import { deleteKeysFromR2 } from './attachments.js';
import { ledgerWriterIds, notify } from './auth.js';
import { decorateCard } from './session-cards.js';
import * as subs from './subscriptions.js';
import { resolveRate } from './txn.js';
import { pad, toBase } from './util.js';

export function tzRefDate(): Date {
  return new Date(`${todayStr()}T00:00:00Z`);
}

export interface RecurringRuleRow {
  id: number;
  ledger_id: number;
  name: string;
  payload: string;
  frequency: string;
  interval_n: number;
  day_of_month: number | null;
  weekday: number | null;
  next_run_at: string;
  last_run_at: string | null;
  auto_post: number;
  is_active: number;
  created_by_user_id: number | null;
}

export function advanceDate(
  dateStr: string,
  rule: { frequency?: string; interval_n?: number; day_of_month?: number | null },
): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const n = Math.max(1, Number(rule.interval_n) || 1);
  switch (rule.frequency) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7 * n);
      break;
    case 'yearly': {
      const anchorDay = Number(rule.day_of_month) || d.getUTCDate();
      const year = d.getUTCFullYear() + n;
      const month = d.getUTCMonth() + 1;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return `${year}-${pad(month)}-${pad(Math.min(anchorDay, last))}`;
    }
    case 'monthly':
    default: {
      const anchorDay = Number(rule.day_of_month) || d.getUTCDate();
      const monthIdx = d.getUTCMonth() + n;
      const year = d.getUTCFullYear() + Math.floor(monthIdx / 12);
      const month = (monthIdx % 12) + 1;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return `${year}-${pad(month)}-${pad(Math.min(anchorDay, last))}`;
    }
  }
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

interface RuleItemPayload {
  type?: string;
  amount_cents?: number;
  currency?: string;
  account_id?: number | null;
  to_account_id?: number | null;
  category_id?: number | null;
  note?: string;
  merchant?: string;
}

function ruleItems(rule: RecurringRuleRow): { items: RuleItemPayload[]; userId?: number } {
  const payload = JSON.parse(rule.payload) as RuleItemPayload[] | { items?: RuleItemPayload[]; user_id?: number };
  if (Array.isArray(payload)) return { items: payload };
  if (Array.isArray(payload.items)) return { items: payload.items, userId: payload.user_id };
  return { items: [payload as RuleItemPayload], userId: (payload as { user_id?: number }).user_id };
}

export async function recurringPostStmts(db: Db, rule: RecurringRuleRow, dateStr: string) {
  const { items, userId } = ruleItems(rule);
  const stmts: BatchStatement[] = [];
  let created = 0;
  const now = nowStr();
  for (const p of items) {
    const amount = Math.abs(Number(p.amount_cents) || 0);
    if (!amount) continue;
    const currency = p.currency || 'CNY';
    const rate = await resolveRate(db, currency);
    const base = toBase(amount, rate);
    const effect = {
      type: p.type || 'expense',
      amount_base_cents: base,
      account_id: p.account_id || null,
      to_account_id: p.to_account_id || null,
    };
    const pTxn = { ...effect, ...await accountAmounts(db, rule.ledger_id, { ...effect, currency, amount_cents: amount }) };
    stmts.push([
      `INSERT INTO transactions
       (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
        user_id, txn_date, note, merchant, status, source, created_at, updated_at, account_amount_cents, to_account_amount_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rule.ledger_id,
        p.type || 'expense',
        amount,
        currency,
        rate,
        base,
        p.account_id || null,
        p.to_account_id || null,
        p.category_id || null,
        userId || rule.created_by_user_id || 1,
        dateStr,
        p.note || rule.name,
        p.merchant || null,
        'cleared',
        'recurring',
        now,
        now,
        pTxn.account_amount_cents,
        pTxn.to_account_amount_cents,
      ],
    ]);
    stmts.push(...balanceDeltaStmts([[pTxn, 1]]));
    created++;
  }
  return { stmts, created };
}

export async function ruleBadAccount(db: Db, rule: RecurringRuleRow): Promise<string | null> {
  let items: RuleItemPayload[];
  try {
    items = ruleItems(rule).items;
  } catch {
    return null;
  }
  const ids: number[] = [];
  for (const p of items) {
    if (!Math.abs(Number(p.amount_cents) || 0)) continue;
    if (p.account_id == null || String(p.account_id) === '') return '存在未指定账户的明细';
    ids.push(Number(p.account_id));
  }
  for (const id of [...new Set(ids)]) {
    if (!(await subs.accountUsable(db, id, rule.ledger_id))) return `账户不存在或已归档（id=${id}）`;
  }
  return null;
}

export async function runDueRecurring(db: Db, today = todayStr()): Promise<number> {
  const rules = await db.all<RecurringRuleRow>(
    'SELECT * FROM recurring_rules WHERE is_active = 1 AND next_run_at <= ?',
    today,
  );
  let created = 0;
  for (const rule of rules) {
    try {
      try {
        JSON.parse(rule.payload);
      } catch {
        const key = `recurring-badpayload:${rule.id}:${today}`;
        for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
          await notify(db, uid, {
            kind: 'danger',
            ledgerId: rule.ledger_id,
            title: `周期账单损坏：${rule.name}`,
            body: '规则数据解析失败，已跳过本次执行，请检查后重新保存',
            link: '/recurring',
            dedupeKey: key,
          });
        }
        continue;
      }

      let stmts: BatchStatement[];
      let count: number;
      try {
        ({ stmts, created: count } = await recurringPostStmts(db, rule, rule.next_run_at));
      } catch (e) {
        const key = `recurring-error:${rule.id}:${today}`;
        const msg = e instanceof Error ? e.message : '执行失败';
        for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
          await notify(db, uid, {
            kind: 'danger',
            ledgerId: rule.ledger_id,
            title: `周期账单执行失败：${rule.name}`,
            body: `计划日期 ${rule.next_run_at}，${msg}，本期未记账，下轮重试`,
            link: '/recurring',
            dedupeKey: key,
          });
        }
        continue;
      }

      if (!rule.auto_post) {
        const key = `recurring:${rule.id}:${rule.next_run_at}:${today}`;
        for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
          await notify(db, uid, {
            kind: 'recurring',
            ledgerId: rule.ledger_id,
            title: `周期账单待确认：${rule.name}`,
            body: `计划日期 ${rule.next_run_at}`,
            link: '/recurring',
            dedupeKey: key,
          });
        }
        await db.run('UPDATE recurring_rules SET last_run_at = ? WHERE id = ?', nowStr(), rule.id);
        continue;
      }

      const next = advanceDate(rule.next_run_at, rule);
      const claim = await db.run(
        'UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
        next,
        rule.id,
        rule.next_run_at,
      );
      if (claim.changes !== 1) continue;

      let bad: string | null;
      try {
        bad = await ruleBadAccount(db, rule);
      } catch (e) {
        const rb = await db
          .run(
            'UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
            rule.next_run_at,
            rule.id,
            next,
          )
          .catch(() => null);
        if (!rb || rb.changes !== 1) {
          const key = `recurring-rollback-fail:${rule.id}:${rule.next_run_at}`;
          for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
            await notify(db, uid, {
              kind: 'danger',
              ledgerId: rule.ledger_id,
              title: `周期账单异常：${rule.name}`,
              body: `计划日期 ${rule.next_run_at}，账户校验失败且抢占回滚失败，该期可能被跳过，请检查规则与流水`,
              link: '/recurring',
              dedupeKey: key,
            });
          }
        }
        console.error('[scheduler] ruleBadAccount failed:', rule.id, e);
        continue;
      }

      if (bad) {
        const key = `recurring-noaccount:${rule.id}:${rule.next_run_at}`;
        for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
          await notify(db, uid, {
            kind: 'warn',
            ledgerId: rule.ledger_id,
            title: `周期账单跳过：${rule.name}`,
            body: `计划日期 ${rule.next_run_at}，${bad}，本期已跳过，请检查规则设置`,
            link: '/recurring',
            dedupeKey: key,
          });
        }
        continue;
      }

      try {
        stmts.push(['UPDATE recurring_rules SET last_run_at = ? WHERE id = ?', [nowStr(), rule.id]]);
        await db.batch(stmts);
      } catch (e) {
        await db
          .run(
            'UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
            rule.next_run_at,
            rule.id,
            next,
          )
          .catch(() => {});
        console.error('[scheduler] 周期账单入账失败，已回滚抢占:', rule.id, e);
        continue;
      }

      created += count;
      if (count === 0) {
        const key = `recurring-zero:${rule.id}:${rule.next_run_at}`;
        for (const uid of await ledgerWriterIds(db, rule.ledger_id)) {
          await notify(db, uid, {
            kind: 'warn',
            ledgerId: rule.ledger_id,
            title: `周期账单本期金额为 0：${rule.name}`,
            body: `计划日期 ${rule.next_run_at} 的全部明细金额为 0，未生成流水，下次执行日已顺延`,
            link: '/recurring',
            dedupeKey: key,
          });
        }
      }
    } catch (e) {
      console.error('[scheduler] 周期账单规则失败:', rule.id, e);
    }
  }
  return created;
}

export interface BudgetRow {
  id: number;
  ledger_id: number;
  name: string;
  scope: string;
  category_id: number | null;
  account_id: number | null;
  period: string;
  amount_cents: number;
  currency: string;
  trigger_type: string;
  rollover: number;
  alert_pct: number;
  start_date: string | null;
  end_date: string | null;
  is_active: number;
}

export function budgetPeriodRange(b: Pick<BudgetRow, 'period' | 'start_date' | 'end_date'>, ref = tzRefDate()) {
  const month = `${ref.getUTCFullYear()}-${pad(ref.getUTCMonth() + 1)}`;
  switch (b.period) {
    case 'yearly':
      return {
        start: `${ref.getUTCFullYear()}-01-01`,
        end: `${ref.getUTCFullYear()}-12-31`,
        label: `${ref.getUTCFullYear()}年`,
        key: String(ref.getUTCFullYear()),
      };
    case 'weekly': {
      const wd = (ref.getUTCDay() + 6) % 7;
      const s = new Date(ref.getTime() - wd * 86400000);
      const e = new Date(s.getTime() + 6 * 86400000);
      const f = (x: Date) => `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
      const monday = f(s);
      return { start: f(s), end: f(e), label: `${monday} 当周`, key: monday };
    }
    case 'custom':
      return {
        start: b.start_date || `${month}-01`,
        end: b.end_date || `${month}-31`,
        label: '自定义周期',
        key: `${b.start_date}_${b.end_date}`,
      };
    case 'monthly':
    default: {
      const last = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).getUTCDate();
      return { start: `${month}-01`, end: `${month}-${pad(last)}`, label: month, key: month };
    }
  }
}

export async function budgetUsedInRange(db: Db, b: BudgetRow, start: string, end: string): Promise<number> {
  const params: unknown[] = [b.ledger_id, start, end];
  const typeCond =
    b.trigger_type === 'income'
      ? "AND type IN ('income')"
      : "AND type IN ('expense','lend','repay_pay','fee','invest_buy')";
  let sql = `SELECT COALESCE(SUM(amount_base_cents),0) AS s FROM transactions
             WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? ${typeCond}`;
  if (b.scope === 'category' && b.category_id) {
    sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))';
    params.push(b.category_id, b.category_id);
  }
  if (b.scope === 'account' && b.account_id) {
    sql += ' AND account_id = ?';
    params.push(b.account_id);
  }
  const row = await db.get<{ s: number }>(sql, ...params);
  return Number(row?.s || 0);
}

export function budgetPrevRange(b: Pick<BudgetRow, 'period' | 'start_date' | 'end_date'>, ref: Date) {
  const f = (x: Date) => `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  switch (b.period) {
    case 'yearly': {
      const y = ref.getUTCFullYear() - 1;
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    }
    case 'weekly': {
      const wd = (ref.getUTCDay() + 6) % 7;
      const s = new Date(ref.getTime() - (wd + 7) * 86400000);
      const e = new Date(s.getTime() + 6 * 86400000);
      return { start: f(s), end: f(e) };
    }
    case 'custom': {
      if (!b.start_date || !b.end_date) return null;
      const s = new Date(`${b.start_date}T00:00:00Z`);
      const e = new Date(`${b.end_date}T00:00:00Z`);
      const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
      if (!(days > 0)) return null;
      return {
        start: f(new Date(s.getTime() - days * 86400000)),
        end: f(new Date(s.getTime() - 86400000)),
      };
    }
    case 'monthly':
    default: {
      const idx = ref.getUTCMonth() - 1;
      const y = ref.getUTCFullYear() + Math.floor(idx / 12);
      const m = ((idx % 12) + 12) % 12 + 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` };
    }
  }
}

export async function budgetAmountInBaseCents(
  db: Db,
  b: Pick<BudgetRow, 'amount_cents' | 'currency'>,
): Promise<number> {
  const raw = Number(b.amount_cents) || 0;
  if (!raw) return 0;
  try {
    const rate = await resolveRate(db, b.currency || 'CNY');
    return toBase(raw, rate);
  } catch (e) {
    console.warn('[budget] missing rate for budget currency:', b.currency, e);
    return raw;
  }
}

export async function effectiveBudget(db: Db, b: BudgetRow, ref: Date) {
  const amount = await budgetAmountInBaseCents(db, b);
  if (!b.rollover || b.trigger_type === 'income') return { amount, rollover: 0 };
  const prev = budgetPrevRange(b, ref);
  if (!prev) return { amount, rollover: 0 };
  const prevUsed = await budgetUsedInRange(db, b, prev.start, prev.end);
  const rollover = Math.max(0, amount - prevUsed);
  return { amount: amount + rollover, rollover };
}

export async function checkBudgets(db: Db): Promise<number> {
  const budgets = await db.all<BudgetRow>('SELECT * FROM budgets WHERE is_active = 1');
  const ref = tzRefDate();
  let alerted = 0;
  for (const b of budgets) {
    if (b.period === 'custom' && (!b.start_date || !b.end_date)) continue;
    const range = budgetPeriodRange(b, ref);
    const used = await budgetUsedInRange(db, b, range.start, range.end);
    const { amount, rollover } = await effectiveBudget(db, b, ref);
    if (amount <= 0) continue;
    const ratio = (used / amount) * 100;
    const alertAt = Number(b.alert_pct) || 80;
    let level: 'over' | 'warn' | null = null;
    if (ratio >= 100) level = 'over';
    else if (ratio >= alertAt) level = 'warn';
    if (!level) continue;
    const dedupeKey = `budget:${b.id}:${range.key}:${level}`;
    const title = level === 'over' ? `预算超支：${b.name}` : `预算预警：${b.name}`;
    const body = `已用 ${(used / 100).toFixed(2)} / ${(amount / 100).toFixed(2)}（${ratio.toFixed(0)}%）${rollover ? `，含上期结转 ${(rollover / 100).toFixed(2)}` : ''}`;
    let sent = false;
    for (const uid of await ledgerWriterIds(db, b.ledger_id)) {
      if (await notify(db, uid, { kind: level === 'over' ? 'danger' : 'warn', ledgerId: b.ledger_id, title, body, link: '/budgets', dedupeKey })) {
        sent = true;
      }
    }
    if (sent) alerted++;
  }
  return alerted;
}

export async function checkDebts(db: Db): Promise<number> {
  const today = todayStr();
  const soon = await db.all<{
    id: number;
    ledger_id: number;
    direction: string;
    counterparty: string;
    balance_cents: number;
    due_date: string;
  }>("SELECT * FROM debts WHERE status = 'open' AND due_date IS NOT NULL AND due_date <= date(?, '+3 day')", today);
  let n = 0;
  for (const d of soon) {
    const dedupeKey = `debt:${d.id}:${d.due_date}:${today.slice(0, 7)}`;
    const overdue = d.due_date < today;
    const who = d.direction === 'receivable' ? `应收 ${d.counterparty}` : `应付 ${d.counterparty}`;
    let sent = false;
    for (const uid of await ledgerWriterIds(db, d.ledger_id)) {
      if (
        await notify(db, uid, {
          kind: overdue ? 'danger' : 'warn',
          ledgerId: d.ledger_id,
          title: `${overdue ? '已逾期' : '即将到期'}：${who}`,
          body: `金额 ${(d.balance_cents / 100).toFixed(2)}，到期日 ${d.due_date}`,
          link: '/debts',
          dedupeKey,
        })
      ) {
        sent = true;
      }
    }
    if (sent) n++;
  }
  return n;
}

export async function checkGoals(db: Db): Promise<number> {
  const today = todayStr();
  const done = await db.all<{ id: number; ledger_id: number; name: string; saved_cents: number; target_cents: number }>(
    "SELECT * FROM goals WHERE status = 'active' AND target_cents > 0 AND saved_cents >= target_cents",
  );
  for (const g of done) {
    await db.run("UPDATE goals SET status = 'completed' WHERE id = ?", g.id);
    const key = `goal-done:${g.id}`;
    for (const uid of await ledgerWriterIds(db, g.ledger_id)) {
      await notify(db, uid, {
        kind: 'success',
        ledgerId: g.ledger_id,
        title: `储蓄目标达成：${g.name}`,
        body: `已存 ${(Number(g.saved_cents) / 100).toFixed(2)}，目标 ${(Number(g.target_cents) / 100).toFixed(2)}`,
        link: '/goals',
        dedupeKey: key,
      });
    }
  }
  const goals = await db.all<{
    id: number;
    ledger_id: number;
    name: string;
    saved_cents: number;
    target_cents: number;
    target_date: string;
  }>("SELECT * FROM goals WHERE status = 'active' AND target_date IS NOT NULL AND target_date <= date(?, '+7 day')", today);
  let n = 0;
  for (const g of goals) {
    const dedupeKey = `goal:${g.id}:${g.target_date}:${today.slice(0, 7)}`;
    const left = Math.max(0, Number(g.target_cents) - Number(g.saved_cents));
    let sent = false;
    for (const uid of await ledgerWriterIds(db, g.ledger_id)) {
      if (
        await notify(db, uid, {
          kind: 'info',
          ledgerId: g.ledger_id,
          title: `储蓄目标临近：${g.name}`,
          body: `还差 ${(left / 100).toFixed(2)}，目标日 ${g.target_date}`,
          link: '/goals',
          dedupeKey,
        })
      ) {
        sent = true;
      }
    }
    if (sent) n++;
  }
  return n;
}

export async function checkCreditAccounts(db: Db, today = todayStr()): Promise<number> {
  const rows = await db.all<
    Pick<AccountRow, 'id' | 'ledger_id' | 'name' | 'balance_cents' | 'due_day'>
  >('SELECT id, ledger_id, name, balance_cents, due_day FROM accounts WHERE is_archived = 0 AND due_day BETWEEN 1 AND 31 AND balance_cents < 0');
  let n = 0;
  for (const acc of rows) {
    const due = nextMonthlyDay(acc.due_day, today);
    if (!due || due.daysUntil > 3) continue;
    const debt = Math.abs(Number(acc.balance_cents));
    const dedupeKey = `credit-due:${acc.id}:${due.cycleKey}`;
    const title = due.daysUntil === 0 ? `今日还款日：${acc.name}` : `即将到还款日：${acc.name}`;
    const body = `当前待还 ${(debt / 100).toFixed(2)}，还款日 ${due.date}${due.daysUntil === 0 ? '（今日到期）' : `（还有 ${due.daysUntil} 天）`}`;
    let sent = false;
    for (const uid of await ledgerWriterIds(db, acc.ledger_id)) {
      if (
        await notify(db, uid, {
          kind: due.daysUntil === 0 ? 'danger' : 'warn',
          ledgerId: acc.ledger_id,
          title,
          body,
          link: `/accounts/${acc.id}`,
          dedupeKey,
        })
      ) {
        sent = true;
      }
    }
    if (sent) n++;
  }
  return n;
}

export async function checkSessionCards(db: Db, today = todayStr()): Promise<number> {
  const rows = await db.all<SessionCardRow>(
    'SELECT * FROM session_cards WHERE is_archived = 0 AND remaining_sessions > 0',
  );
  let n = 0;
  for (const raw of rows) {
    const c = decorateCard(raw, today);
    const alerts: Array<{ kind: 'danger' | 'warn' | 'info'; title: string; body: string; dedupeKey: string }> = [];
    if (c.isExpiringSoon && c.expires_at) {
      alerts.push({
        kind: c.daysUntilExpiry === 0 ? 'danger' : 'warn',
        title: c.daysUntilExpiry === 0 ? `次卡今日到期：${c.name}` : `次卡即将到期：${c.name}`,
        body: `剩余 ${c.remaining_sessions}/${c.total_sessions} 次，有效期至 ${c.expires_at}`,
        dedupeKey: `sc-expiring:${c.id}:${c.expires_at}`,
      });
    } else if (c.isExpired && c.expires_at) {
      alerts.push({
        kind: 'danger',
        title: `次卡已过期仍有余次：${c.name}`,
        body: `剩余 ${c.remaining_sessions}/${c.total_sessions} 次，已于 ${c.expires_at} 到期`,
        dedupeKey: `sc-expired:${c.id}:${c.expires_at}`,
      });
    }
    if (c.isLowSessions) {
      alerts.push({
        kind: 'warn',
        title: `次卡余次不足：${c.name}`,
        body: `当前仅剩 ${c.remaining_sessions}/${c.total_sessions} 次${c.expires_at ? `，有效期至 ${c.expires_at}` : ''}`,
        dedupeKey: `sc-low:${c.id}:${c.total_sessions}`,
      });
    }
    if (!alerts.length) continue;
    const writers = await ledgerWriterIds(db, c.ledger_id);
    for (const a of alerts) {
      let sent = false;
      for (const uid of writers) {
        if (
          await notify(db, uid, {
            kind: a.kind,
            ledgerId: c.ledger_id,
            title: a.title,
            body: a.body,
            link: `/session-cards/${c.id}`,
            dedupeKey: a.dedupeKey,
          })
        ) {
          sent = true;
        }
      }
      if (sent) n++;
    }
  }
  return n;
}

export async function runSubscriptions(db: Db, today = todayStr()) {
  const r = await subs.runDue(db, today);
  const reminded = await subs.checkReminders(db, today);
  return { charged: r.charged, renewed: r.renewed, notified: r.notified + reminded };
}

/** 修复因关联报销入账流水缺失导致的孤儿已报销标记（纯 DB，不扫 R2；仅重置有明确 dangling related_id 的记录） */
export async function repairReimbursedLinks(db: Db): Promise<number> {
  const res = await db.run(
    `UPDATE transactions
     SET reimbursed_at = NULL, related_id = NULL
     WHERE reimbursed_at IS NOT NULL
       AND deleted_at IS NULL
       AND related_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM transactions r
         WHERE r.id = transactions.related_id
           AND r.ledger_id = transactions.ledger_id
           AND r.type = 'reimburse'
           AND r.deleted_at IS NULL
       )`,
  );
  return Number(res.changes || 0);
}

/** 轻量 DB 清理（不在定时任务中执行任何 R2.list() 全量扫描） */
async function cleanup(db: Db, env?: Pick<Env, 'ATTACHMENTS'>) {
  try {
    const today = todayStr();
    await db.batch([
      ['DELETE FROM ledger_invites WHERE expires_at IS NOT NULL AND expires_at < ?', [today]],
      ["DELETE FROM notifications WHERE is_read = 1 AND created_at < date(?, '-90 day')", [today]],
    ]);
    await repairReimbursedLinks(db);
    const pending = await db.all<{ id: number; rel_path: string }>(
      "SELECT id, rel_path FROM attachments WHERE ai_status = 'pending' AND created_at < date(?, '-7 day')",
      today,
    );
    if (pending.length) {
      await deleteKeysFromR2(env, pending.map((r) => r.rel_path));
      await db.run(
        `DELETE FROM attachments WHERE id IN (${pending.map(() => '?').join(',')})`,
        ...pending.map((r) => r.id),
      );
    }
  } catch (e) {
    console.error('[scheduler] cleanup failed:', e);
  }
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const all: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    all.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all;
}

/** 管理员手动清理孤儿 R2 对象（仅手动触发，不进 4 小时 Cron） */
export async function cleanupOrphanR2(db: Db, env: Pick<Env, 'ATTACHMENTS'>) {
  let deletedImports = 0;
  let deletedUploads = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const imports = await listAllObjects(env.ATTACHMENTS, 'imports/');
  const staleImports = imports.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
  for (let i = 0; i < staleImports.length; i += 1000) {
    await env.ATTACHMENTS.delete(staleImports.slice(i, i + 1000));
  }
  deletedImports = staleImports.length;

  const [listed, rows, avatarRows] = await Promise.all([
    listAllObjects(env.ATTACHMENTS, 'uploads/'),
    db.all<{ rel_path: string }>('SELECT rel_path FROM attachments'),
    db.all<{ avatar_path: string }>('SELECT avatar_path FROM users WHERE avatar_path IS NOT NULL'),
  ]);
  const known = new Set(rows.map((r) => r.rel_path));
  for (const uRow of avatarRows) {
    const clean = String(uRow.avatar_path || '').replace(/^uploads\/avatars\//, '');
    if (clean && !clean.includes('..')) known.add(`uploads/avatars/${clean}`);
  }
  const orphans = listed
    .filter((o) => !known.has(o.key) && o.uploaded.getTime() < cutoff)
    .map((o) => o.key);
  for (let i = 0; i < orphans.length; i += 1000) {
    await env.ATTACHMENTS.delete(orphans.slice(i, i + 1000));
  }
  deletedUploads = orphans.length;
  return { deletedImports, deletedUploads };
}

export async function runScheduled(db: Db, env?: Pick<Env, 'ATTACHMENTS'>) {
  const r = {
    recurring: 0,
    budgets: 0,
    debts: 0,
    goals: 0,
    creditAccounts: 0,
    sessionCards: 0,
    subscriptions: { charged: 0, renewed: 0, notified: 0 },
  };
  try {
    r.recurring = await runDueRecurring(db);
  } catch (e) {
    console.error('[scheduler] 周期账单失败:', e);
  }
  try {
    r.subscriptions = await runSubscriptions(db);
  } catch (e) {
    console.error('[scheduler] 订阅扣费失败:', e);
  }
  try {
    r.budgets = await checkBudgets(db);
  } catch (e) {
    console.error('[scheduler] 预算检查失败:', e);
  }
  try {
    r.debts = await checkDebts(db);
  } catch (e) {
    console.error('[scheduler] 借贷检查失败:', e);
  }
  try {
    r.goals = await checkGoals(db);
  } catch (e) {
    console.error('[scheduler] 目标检查失败:', e);
  }
  try {
    r.creditAccounts = await checkCreditAccounts(db);
  } catch (e) {
    console.error('[scheduler] 信用账户还款提醒失败:', e);
  }
  try {
    r.sessionCards = await checkSessionCards(db);
  } catch (e) {
    console.error('[scheduler] 次卡提醒失败:', e);
  }
  await cleanup(db, env);
  return r;
}

export const runDaily = runScheduled;
