import type { Context, Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { ledgerWriterIds, notify } from '../lib/auth.js';
import {
  advanceDate,
  budgetAmountInBaseCents,
  budgetPeriodRange,
  budgetUsedInRange,
  effectiveBudget,
  postRecurringPeriod,
  ruleBadAccount,
  tzRefDate,
  type BudgetRow,
  type RecurringRuleRow,
} from '../lib/scheduler.js';
import * as subs from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import type { Db, HonoEnv, OpenAuth } from '../types.js';
import {
  assertAccountInLedger,
  assertCategoryInLedger,
  parseAmountField,
  parseBoolFlag,
  parseOptionalDate,
  parseOptionalIntRange,
  parseOptionalRefId,
  parsePositiveIntId,
  readJsonObject,
  requireWriteApi,
} from './openapi-helpers.js';
import { dbOf, toPublicError } from './helpers.js';

const AUTO_DEBT_NOTE = '系统自动汇总';
const BUDGET_SCOPES = ['overall', 'category', 'account'] as const;
const BUDGET_PERIODS = ['monthly', 'weekly', 'yearly', 'custom'] as const;
const RECURRING_FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
const SUB_CYCLES = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly'] as const;
const SUB_CREATE_STATUSES = ['active', 'trial', 'paused'] as const;
const SUB_ALL_STATUSES = ['active', 'trial', 'paused', 'canceled'] as const;
const DEBT_PROTECTED_KEYS = [
  'direction',
  'counterparty',
  'principal',
  'principal_cents',
  'amount',
  'amount_cents',
  'balance',
  'balance_cents',
  'account_id',
  'status',
  'note',
  'currency',
] as const;

interface RecurringItem {
  type: 'expense' | 'income';
  amount_cents: number;
  currency: string;
  account_id: number | null;
  category_id: number | null;
  note: string;
  merchant: string | null;
}

interface DebtRow {
  id: number;
  ledger_id: number;
  direction: string;
  counterparty: string;
  principal_cents: number;
  balance_cents: number;
  opening_cents: number;
  currency: string;
  account_id: number | null;
  due_date: string | null;
  status: string;
  note: string | null;
  created_at: string;
}

interface GoalRow {
  id: number;
  ledger_id: number;
  name: string;
  icon: string;
  target_cents: number;
  saved_cents: number;
  account_id: number | null;
  target_date: string | null;
  status: string;
  note: string | null;
  created_at: string;
}

/* ============================ Budgets ============================ */

async function enrichBudget(db: Db, b: BudgetRow, ref = tzRefDate()) {
  const isUnset = b.period === 'custom' && (!b.start_date || !b.end_date);
  if (isUnset) {
    return {
      ...b,
      range: { start: b.start_date || '', end: b.end_date || '', label: '周期未设置', key: '' },
      used_cents: null as number | null,
      effective_cents: await budgetAmountInBaseCents(db, b),
      rollover_cents: 0,
    };
  }
  const range = budgetPeriodRange(b, ref);
  const [used, eff] = await Promise.all([
    budgetUsedInRange(db, b, range.start, range.end),
    effectiveBudget(db, b, ref),
  ]);
  return {
    ...b,
    range,
    used_cents: used,
    effective_cents: eff.amount,
    rollover_cents: eff.rollover,
  };
}

async function normalizeBudgetWrite(
  db: Db,
  ledgerId: number,
  body: Record<string, unknown>,
  existing?: BudgetRow,
) {
  const name = (body.name !== undefined ? String(body.name || '').trim() : existing?.name || '').slice(0, 30);
  if (!name) throw new Error('请填写预算名称');

  const amountCents =
    parseAmountField(body, ['amount_cents'], ['amount'], { label: '预算金额' }) ?? existing?.amount_cents;
  if (!amountCents || amountCents <= 0) throw new Error('请填写有效预算金额');

  const scope = body.scope !== undefined ? String(body.scope) : existing?.scope || 'overall';
  if (!(BUDGET_SCOPES as readonly string[]).includes(scope)) {
    throw new Error('无效的预算范围（scope）');
  }

  const triggerType =
    body.trigger_type !== undefined ? String(body.trigger_type) : existing?.trigger_type || 'expense';
  if (triggerType !== 'expense' && triggerType !== 'income') {
    throw new Error('无效的预算收支类型（trigger_type）');
  }

  const period = body.period !== undefined ? String(body.period) : existing?.period || 'monthly';
  if (!(BUDGET_PERIODS as readonly string[]).includes(period)) {
    throw new Error('无效的预算周期（period）');
  }

  const rawCategoryId = parseOptionalRefId(body.category_id, existing?.category_id ?? null, '分类 ID');
  const rawAccountId = parseOptionalRefId(body.account_id, existing?.account_id ?? null, '账户 ID');

  let categoryId: number | null = null;
  let accountId: number | null = null;
  if (scope === 'category') {
    if (!rawCategoryId) throw new Error('按分类预算必须提供 category_id');
    await assertCategoryInLedger(db, ledgerId, rawCategoryId, triggerType as 'expense' | 'income', {
      allowArchived: existing ? rawCategoryId === existing.category_id : false,
    });
    categoryId = rawCategoryId;
  } else if (scope === 'account') {
    if (!rawAccountId) throw new Error('按账户预算必须提供 account_id');
    await assertAccountInLedger(db, ledgerId, rawAccountId, {
      allowArchived: existing ? rawAccountId === existing.account_id : false,
    });
    accountId = rawAccountId;
  }

  const rawStart = parseOptionalDate(body.start_date, existing?.start_date ?? null, '开始日期');
  const rawEnd = parseOptionalDate(body.end_date, existing?.end_date ?? null, '结束日期');
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (period === 'custom') {
    if (!rawStart || !rawEnd) throw new Error('自定义周期必须填写 start_date 与 end_date');
    if (rawStart > rawEnd) throw new Error('开始日期不能晚于结束日期');
    startDate = rawStart;
    endDate = rawEnd;
  }

  const currency =
    body.currency !== undefined
      ? String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'CNY'
      : existing?.currency || 'CNY';
  await txn.resolveRate(db, currency);
  const rollover = parseBoolFlag(body.rollover, existing?.rollover ?? 0);
  const alertPct =
    parseOptionalIntRange(body.alert_pct, existing?.alert_pct ?? 80, 1, 100, '预警阈值 alert_pct') ?? 80;
  const isActive = parseBoolFlag(body.is_active, existing?.is_active ?? 1);

  return {
    name,
    scope,
    category_id: categoryId,
    account_id: accountId,
    period,
    amount_cents: amountCents,
    currency,
    trigger_type: triggerType,
    rollover,
    alert_pct: alertPct,
    start_date: startDate,
    end_date: endDate,
    is_active: isActive,
  };
}

/* ============================ Recurring ============================ */

function parseRecurringPayload(raw: string): { items: unknown[]; user_id?: number } {
  try {
    const p = JSON.parse(raw || '{}') as unknown[] | { items?: unknown[]; user_id?: number };
    if (Array.isArray(p)) return { items: p };
    if (p && typeof p === 'object' && Array.isArray(p.items)) return { items: p.items, user_id: p.user_id };
    if (p && typeof p === 'object' && 'amount_cents' in p) return { items: [p], user_id: p.user_id };
    return { items: [] };
  } catch {
    return { items: [] };
  }
}

function decorateRecurring(rule: RecurringRuleRow) {
  const { items } = parseRecurringPayload(rule.payload);
  return { ...rule, items };
}

async function normalizeRecurringItems(
  db: Db,
  ledgerId: number,
  rawItems: unknown,
  fallbackNote: string,
  allowExistingAccountIds = new Set<number>(),
  allowExistingCategoryIds = new Set<number>(),
): Promise<RecurringItem[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('周期账单明细 items 不能为空数组');
  }
  const items: RecurringItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`第 ${i + 1} 条周期明细格式无效`);
    }
    const it = raw as Record<string, unknown>;
    const type = it.type !== undefined ? String(it.type) : 'expense';
    if (type !== 'expense' && type !== 'income') {
      throw new Error('周期账单明细 type 仅支持 expense 或 income');
    }
    const amountCents = parseAmountField(it, ['amount_cents'], ['amount'], {
      label: `第 ${i + 1} 条明细金额`,
    });
    if (!amountCents) throw new Error(`第 ${i + 1} 条周期明细必须填写有效金额`);

    const currency = it.currency ? String(it.currency).trim().toUpperCase().slice(0, 8) || 'CNY' : 'CNY';
    const accountId = parseOptionalRefId(it.account_id, null, `第 ${i + 1} 条明细账户 ID`);
    if (accountId !== null) {
      await assertAccountInLedger(db, ledgerId, accountId, {
        allowArchived: allowExistingAccountIds.has(accountId),
      });
    }
    const categoryId = parseOptionalRefId(it.category_id, null, `第 ${i + 1} 条明细分类 ID`);
    if (categoryId !== null) {
      await assertCategoryInLedger(db, ledgerId, categoryId, type, {
        allowArchived: allowExistingCategoryIds.has(categoryId),
      });
    }
    const note = it.note != null && String(it.note).trim() ? String(it.note).trim().slice(0, 300) : fallbackNote;
    const merchant = it.merchant != null && String(it.merchant).trim() ? String(it.merchant).trim().slice(0, 60) : null;

    items.push({
      type,
      amount_cents: amountCents,
      currency,
      account_id: accountId,
      category_id: categoryId,
      note,
      merchant,
    });
  }
  return items;
}

/* ============================ Subscriptions ============================ */

const SUB_SELECT = `SELECT s.*, a.name AS account_name, c.name AS category_name, c.icon AS category_icon
  FROM subscriptions s
  LEFT JOIN accounts a ON a.id = s.account_id AND a.ledger_id = s.ledger_id
  LEFT JOIN categories c ON c.id = s.category_id AND (c.ledger_id IS NULL OR c.ledger_id = s.ledger_id)`;

async function getDecoratedSub(db: Db, id: number, ledgerId: number) {
  const row = await db.get<subs.SubscriptionRow>(`${SUB_SELECT} WHERE s.id = ? AND s.ledger_id = ?`, id, ledgerId);
  return row ? subs.decorate(row) : undefined;
}

async function normalizeSubscriptionWrite(
  db: Db,
  ledgerId: number,
  body: Record<string, unknown>,
  existing?: subs.SubscriptionRow,
) {
  const name = (body.name !== undefined ? String(body.name || '').trim() : existing?.name || '').slice(0, 40);
  if (!name) throw new Error('请填写订阅名称');

  const amountCents =
    parseAmountField(body, ['amount_cents'], ['amount'], { label: '订阅金额' }) ?? existing?.amount_cents;
  if (!amountCents || amountCents <= 0) throw new Error('请填写有效订阅金额');

  const cycle = body.cycle !== undefined ? String(body.cycle) : existing?.cycle || 'monthly';
  if (!(SUB_CYCLES as readonly string[]).includes(cycle)) {
    throw new Error('无效的订阅周期（cycle）');
  }

  const cycleN = parseOptionalIntRange(body.cycle_n, existing?.cycle_n ?? 1, 1, 12, '每 N 个周期（cycle_n）') ?? 1;
  const anchorMonth = parseOptionalIntRange(
    body.anchor_month,
    existing?.anchor_month ?? null,
    1,
    12,
    '锚点月份（anchor_month）',
  );
  const trialEndsOn = parseOptionalDate(body.trial_ends_on, existing?.trial_ends_on ?? null, '试用结束日');

  const allowedStatuses: readonly string[] = existing ? SUB_ALL_STATUSES : SUB_CREATE_STATUSES;
  const status = body.status !== undefined ? String(body.status) : existing?.status || 'active';
  if (!allowedStatuses.includes(status)) {
    throw new Error(`无效的订阅状态（status）：${status}`);
  }
  if (status === 'trial' && !trialEndsOn) {
    throw new Error('试用中必须填写 trial_ends_on（试用结束日）');
  }

  const accountId = parseOptionalRefId(body.account_id, existing?.account_id ?? null, '扣费账户 ID');
  if (accountId !== null) {
    await assertAccountInLedger(db, ledgerId, accountId, {
      allowArchived: existing ? accountId === existing.account_id : false,
    });
  }
  const categoryId = parseOptionalRefId(body.category_id, existing?.category_id ?? null, '分类 ID');
  if (categoryId !== null) {
    await assertCategoryInLedger(db, ledgerId, categoryId, 'expense', {
      allowArchived: existing ? categoryId === existing.category_id : false,
    });
  }

  const today = todayStr();
  let next: string;
  if (existing) {
    if (body.next_charge_at !== undefined) {
      const parsedNext = parseOptionalDate(body.next_charge_at, null, '下次扣费日');
      if (!parsedNext) throw new Error('下次扣费日不能为空');
      next = parsedNext;
    } else {
      next = existing.next_charge_at;
      if ((existing.status === 'canceled' || existing.status === 'paused') && (status === 'active' || status === 'trial') && next < today) {
        const effDay =
          parseOptionalIntRange(body.anchor_day, existing.anchor_day ?? null, 1, 31, '扣费日（anchor_day）') ??
          Number(next.slice(8, 10));
        next = subs.firstChargeDate({
          cycle,
          cycle_n: cycleN,
          anchor_month: anchorMonth,
          anchor_day: effDay,
          startFrom: today,
        });
      }
    }
  } else {
    next = parseOptionalDate(body.next_charge_at, null, '下次扣费日') || trialEndsOn || today;
  }

  const anchorDay =
    parseOptionalIntRange(body.anchor_day, existing?.anchor_day ?? null, 1, 31, '扣费日（anchor_day）') ??
    Number(next.slice(8, 10));

  if (status === 'trial' && trialEndsOn && next < trialEndsOn) {
    next = trialEndsOn;
  }
  if (!existing || (body.next_charge_at !== undefined && next !== existing.next_charge_at)) {
    let guard = 0;
    while (next < today && guard++ < 500) {
      next = subs.advance(next, { cycle, cycle_n: cycleN, anchor_day: anchorDay });
    }
  }

  const optText = (val: unknown, max: number, prev: string | null | undefined): string | null => {
    if (val === undefined) return prev ?? null;
    if (val === null) return null;
    const s = String(val).trim();
    return s ? s.slice(0, max) : null;
  };

  const canceledAt =
    status === 'canceled'
      ? existing?.status === 'canceled'
        ? existing.canceled_at
        : nowStr()
      : null;

  return {
    name,
    icon: body.icon !== undefined ? String(body.icon || '').trim().slice(0, 8) || '🧾' : existing?.icon || '🧾',
    plan: optText(body.plan, 40, existing?.plan),
    vendor_url: optText(body.vendor_url, 200, existing?.vendor_url),
    amount_cents: amountCents,
    currency:
      body.currency !== undefined
        ? String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'CNY'
        : existing?.currency || 'CNY',
    cycle,
    cycle_n: cycleN,
    anchor_month: anchorMonth,
    anchor_day: anchorDay,
    account_id: accountId,
    category_id: categoryId,
    auto_renew: subs.parseAutoRenewFlag(body.auto_renew, existing?.auto_renew ?? 1),
    trial_ends_on: trialEndsOn,
    next_charge_at: next,
    reminder_days:
      parseOptionalIntRange(body.reminder_days, existing?.reminder_days ?? 3, 0, 60, '提前提醒天数（reminder_days）') ??
      3,
    status,
    note: optText(body.note, 200, existing?.note),
    canceled_at: canceledAt,
  };
}

/* ============================ Debts & Loans ============================ */

async function handleListDebts(c: Context<HonoEnv>) {
  const oa = c.get('openAuth')!;
  const status = c.req.query('status');
  const direction = c.req.query('direction');
  const where = ['ledger_id = ?'];
  const params: unknown[] = [oa.ledgerId];
  if (status === 'open' || status === 'closed') {
    where.push('status = ?');
    params.push(status);
  }
  if (direction === 'receivable' || direction === 'payable') {
    where.push('direction = ?');
    params.push(direction);
  }
  const debts = await dbOf(c).all<DebtRow>(
    `SELECT * FROM debts WHERE ${where.join(' AND ')} ORDER BY status, id DESC`,
    ...params,
  );
  return c.json({ ok: true, debts });
}

async function handleGetDebt(c: Context<HonoEnv>) {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '借贷记录不存在' }, 404);
  const debt = await dbOf(c).get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!debt) return c.json({ ok: false, error: '借贷记录不存在' }, 404);
  return c.json({ ok: true, debt });
}

async function handleCreateDebt(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const direction = body.direction !== undefined ? String(body.direction) : 'receivable';
    if (direction !== 'receivable' && direction !== 'payable') {
      return c.json({ ok: false, error: '无效的借贷方向（direction 仅支持 receivable 或 payable）' }, 400);
    }
    const counterparty = String(body.counterparty || '').trim().slice(0, 30);
    if (!counterparty) return c.json({ ok: false, error: '请填写对方姓名（counterparty）' }, 400);

    const principal = parseAmountField(body, ['principal_cents', 'amount_cents'], ['principal', 'amount'], {
      label: '借贷金额',
    });
    if (!principal) return c.json({ ok: false, error: '请填写有效借贷金额' }, 400);

    const dueDate = parseOptionalDate(body.due_date, null, '到期日');
    const currency = String(body.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
    const accountId = parseOptionalRefId(body.account_id, null, '账户 ID');
    if (accountId !== null) {
      await assertAccountInLedger(db, oa.ledgerId, accountId);
    }
    const createTxn = parseBoolFlag(body.create_txn, 0) === 1;

    if (createTxn) {
      if (!accountId) return c.json({ ok: false, error: '生成流水必须指定有效的 account_id' }, 400);
      const txnDate = parseOptionalDate(body.txn_date ?? body.date, todayStr(), '交易日期') || todayStr();
      const note =
        body.note != null && String(body.note).trim()
          ? String(body.note).trim().slice(0, 200)
          : direction === 'receivable'
            ? '借出'
            : '借入';
      const txnId = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
        type: direction === 'receivable' ? 'lend' : 'borrow',
        amount_cents: principal,
        currency,
        account_id: accountId,
        txn_date: txnDate,
        merchant: counterparty,
        note,
        source: 'openapi',
      });
      if (dueDate) {
        await db.run(
          `UPDATE debts SET due_date = ? WHERE ledger_id = ? AND direction = ? AND counterparty = ? AND opening_cents = 0 AND note = ? AND ${txn.activeLedgerGuard}`,
          dueDate,
          oa.ledgerId,
          direction,
          counterparty,
          AUTO_DEBT_NOTE,
          oa.ledgerId,
        );
      }
      const debt = await db.get<DebtRow>(
        'SELECT * FROM debts WHERE ledger_id = ? AND direction = ? AND counterparty = ? AND opening_cents = 0 AND note = ? ORDER BY id DESC LIMIT 1',
        oa.ledgerId,
        direction,
        counterparty,
        AUTO_DEBT_NOTE,
      );
      return c.json({ ok: true, id: debt ? Number(debt.id) : null, transaction_id: txnId, debt: debt || null }, 201);
    }

    const rawNote = body.note != null ? String(body.note).trim().slice(0, 200) || null : null;
    if (rawNote === AUTO_DEBT_NOTE) {
      return c.json({ ok: false, error: '备注不能使用系统保留关键字「系统自动汇总」' }, 400);
    }
    const balance =
      parseAmountField(body, ['balance_cents'], ['balance'], { allowZero: true, label: '待还/待收余额' }) ??
      principal;
    if (body.status !== undefined && body.status !== 'open' && body.status !== 'closed') {
      return c.json({ ok: false, error: '无效的借贷状态（status）' }, 400);
    }
    const status = balance === 0 || body.status === 'closed' ? 'closed' : 'open';

    const ins = await db.run(
      `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, currency, account_id, due_date, status, note, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
      oa.ledgerId,
      direction,
      counterparty,
      principal,
      balance,
      currency,
      accountId,
      dueDate,
      status,
      rawNote,
      nowStr(),
      oa.ledgerId,
    );
    if (!ins.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
    const id = Number(ins.lastInsertRowid);
    const debt = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, debt }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

async function handleUpdateDebt(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '借贷记录不存在' }, 404);

  const existing = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '借贷记录不存在' }, 404);

  try {
    const body = await readJsonObject(c);
    if (existing.opening_cents > 0 || existing.note === AUTO_DEBT_NOTE) {
      const touchesProtected = DEBT_PROTECTED_KEYS.some((k) => k in body && body[k] !== undefined);
      if (touchesProtected) {
        return c.json({ ok: false, error: '期初或自动汇总借贷仅允许修改 due_date（到期日）' }, 400);
      }
      const dueDate = parseOptionalDate(body.due_date, existing.due_date, '到期日');
      await db.run(`UPDATE debts SET due_date = ? WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, dueDate, id, oa.ledgerId, oa.ledgerId);
      const debt = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, debt });
    }

    const direction = body.direction !== undefined ? String(body.direction) : existing.direction;
    if (direction !== 'receivable' && direction !== 'payable') {
      return c.json({ ok: false, error: '无效的借贷方向（direction）' }, 400);
    }
    const counterparty = (
      body.counterparty !== undefined ? String(body.counterparty || '').trim() : existing.counterparty
    ).slice(0, 30);
    if (!counterparty) return c.json({ ok: false, error: '请填写对方姓名（counterparty）' }, 400);

    const principal =
      parseAmountField(body, ['principal_cents', 'amount_cents'], ['principal', 'amount'], { label: '本金' }) ??
      Number(existing.principal_cents);
    const balance =
      parseAmountField(body, ['balance_cents'], ['balance'], { allowZero: true, label: '待还/待收余额' }) ??
      Number(existing.balance_cents);
    const accountId = parseOptionalRefId(body.account_id, existing.account_id, '账户 ID');
    if (accountId !== null) {
      await assertAccountInLedger(db, oa.ledgerId, accountId, {
        allowArchived: accountId === existing.account_id,
      });
    }
    const dueDate = parseOptionalDate(body.due_date, existing.due_date, '到期日');
    const currency =
      body.currency !== undefined
        ? String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'CNY'
        : existing.currency;
    const note =
      body.note !== undefined
        ? body.note == null || String(body.note).trim() === ''
          ? null
          : String(body.note).trim().slice(0, 200)
        : existing.note;
    if (note === AUTO_DEBT_NOTE) {
      return c.json({ ok: false, error: '备注不能使用系统保留关键字「系统自动汇总」' }, 400);
    }
    if (body.status !== undefined && body.status !== 'open' && body.status !== 'closed') {
      return c.json({ ok: false, error: '无效的借贷状态（status）' }, 400);
    }
    const status = balance === 0 ? 'closed' : body.status !== undefined ? String(body.status) : existing.status;

    await db.run(
      `UPDATE debts
       SET direction = ?, counterparty = ?, principal_cents = ?,
           manual_balance_cents = manual_balance_cents + ? - balance_cents, balance_cents = ?, currency = ?,
           account_id = ?, due_date = ?, status = ?, note = ?
       WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
      direction,
      counterparty,
      principal,
      balance,
      balance,
      currency,
      accountId,
      dueDate,
      status,
      note,
      id,
      oa.ledgerId,
      oa.ledgerId,
    );
    const debt = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, debt });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

async function handleDeleteDebt(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '借贷记录不存在' }, 404);

  const existing = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '借贷记录不存在' }, 404);
  if (existing.opening_cents > 0 || existing.note === AUTO_DEBT_NOTE) {
    return c.json({ ok: false, error: '期初或自动汇总借贷不能直接删除' }, 400);
  }
  await db.run(`DELETE FROM debts WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
  return c.json({ ok: true });
}

async function handleSettleDebt(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '借贷记录不存在' }, 404);

  const existing = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '借贷记录不存在' }, 404);
  if (existing.status === 'closed' || Number(existing.balance_cents) <= 0) {
    return c.json({ ok: false, error: '该借贷已结清，无需重复结算' }, 400);
  }

  try {
    const body = await readJsonObject(c, { optional: true });
    const inputAmt = parseAmountField(body, ['amount_cents'], ['amount'], { label: '结清金额' });
    const settleAmt = Math.min(inputAmt ?? Number(existing.balance_cents), Number(existing.balance_cents));
    const accountId = parseOptionalRefId(body.account_id, existing.account_id, '账户 ID');
    if (!accountId) return c.json({ ok: false, error: '请指定收款/还款账户 account_id' }, 400);
    await assertAccountInLedger(db, oa.ledgerId, accountId);

    const txnDate = parseOptionalDate(body.txn_date ?? body.date, todayStr(), '交易日期') || todayStr();
    const note =
      body.note != null && String(body.note).trim()
        ? String(body.note).trim().slice(0, 300)
        : `${existing.direction === 'receivable' ? '收回借款 · ' : '偿还借款 · '}${existing.counterparty}`;

    const txnId = await txn.settleDebt(db, oa.ledgerId, oa.userId, existing, {
      amount_cents: settleAmt,
      account_id: accountId,
      txn_date: txnDate,
      note,
      source: 'openapi',
    });
    const debt = existing.opening_cents === 0 && existing.note === AUTO_DEBT_NOTE
      ? await db.get<DebtRow>(
        'SELECT * FROM debts WHERE ledger_id = ? AND direction = ? AND counterparty = ? AND opening_cents = 0 AND note = ? ORDER BY id DESC LIMIT 1',
        oa.ledgerId, existing.direction, existing.counterparty, AUTO_DEBT_NOTE,
      )
      : await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, settled_cents: settleAmt, transaction_id: txnId, debt: debt || null });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

/* ============================ Register Planning Routes ============================ */

export function registerPlanningOpenApi(openapiRoutes: Hono<HonoEnv>): void {
  // ---- Budgets ----
  openapiRoutes.get('/budgets', async (c) => {
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const ref = tzRefDate();
    const includeInactive = c.req.query('include_inactive') === '1' || c.req.query('include_inactive') === 'true';
    const rows = await db.all<BudgetRow>(
      `SELECT * FROM budgets WHERE ledger_id = ?${includeInactive ? '' : ' AND is_active = 1'} ORDER BY id`,
      oa.ledgerId,
    );
    const budgets = await Promise.all(rows.map((b) => enrichBudget(db, b, ref)));
    return c.json({ ok: true, budgets });
  });

  openapiRoutes.get('/budgets/:id', async (c) => {
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '预算不存在' }, 404);
    const row = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!row) return c.json({ ok: false, error: '预算不存在' }, 404);
    return c.json({ ok: true, budget: await enrichBudget(db, row, tzRefDate()) });
  });

  openapiRoutes.post('/budgets', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    try {
      const body = await readJsonObject(c);
      const d = await normalizeBudgetWrite(db, oa.ledgerId, body);
      const res = await db.run(
        `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
          trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
        oa.ledgerId,
        d.name,
        d.scope,
        d.category_id,
        d.account_id,
        d.period,
        d.amount_cents,
        d.currency,
        d.trigger_type,
        d.rollover,
        d.alert_pct,
        d.start_date,
        d.end_date,
        d.is_active,
        nowStr(),
        oa.ledgerId,
      );
      if (!res.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
      const id = Number(res.lastInsertRowid);
      const created = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, budget: created ? await enrichBudget(db, created, tzRefDate()) : null }, 201);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  async function handleBudgetUpdate(c: Context<HonoEnv>) {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '预算不存在' }, 404);
    const existing = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '预算不存在' }, 404);
    try {
      const body = await readJsonObject(c);
      const d = await normalizeBudgetWrite(db, oa.ledgerId, body, existing);
      await db.run(
        `UPDATE budgets
         SET name = ?, scope = ?, category_id = ?, account_id = ?, period = ?, amount_cents = ?, currency = ?,
             trigger_type = ?, rollover = ?, alert_pct = ?, start_date = ?, end_date = ?, is_active = ?
         WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
        d.name,
        d.scope,
        d.category_id,
        d.account_id,
        d.period,
        d.amount_cents,
        d.currency,
        d.trigger_type,
        d.rollover,
        d.alert_pct,
        d.start_date,
        d.end_date,
        d.is_active,
        id,
        oa.ledgerId,
        oa.ledgerId,
      );
      const updated = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, budget: updated ? await enrichBudget(db, updated, tzRefDate()) : null });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  }

  openapiRoutes.put('/budgets/:id', handleBudgetUpdate);
  openapiRoutes.patch('/budgets/:id', handleBudgetUpdate);

  openapiRoutes.delete('/budgets/:id', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '预算不存在' }, 404);
    const res = await dbOf(c).run(`DELETE FROM budgets WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
    if (res.changes !== 1) return c.json({ ok: false, error: '预算不存在' }, 404);
    return c.json({ ok: true });
  });

  // ---- Recurring ----
  openapiRoutes.get('/recurring', async (c) => {
    const oa = c.get('openAuth')!;
    const qActive = c.req.query('is_active');
    let sql = 'SELECT * FROM recurring_rules WHERE ledger_id = ?';
    const params: unknown[] = [oa.ledgerId];
    if (qActive === '1' || qActive === 'true') {
      sql += ' AND is_active = 1';
    } else if (qActive === '0' || qActive === 'false') {
      sql += ' AND is_active = 0';
    }
    sql += ' ORDER BY id DESC';
    const rows = await dbOf(c).all<RecurringRuleRow>(sql, ...params);
    return c.json({ ok: true, recurring: rows.map(decorateRecurring) });
  });

  openapiRoutes.get('/recurring/:id', async (c) => {
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    const row = await dbOf(c).get<RecurringRuleRow>(
      'SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!row) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    return c.json({ ok: true, recurring: decorateRecurring(row) });
  });

  openapiRoutes.post('/recurring', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    try {
      const body = await readJsonObject(c);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return c.json({ ok: false, error: '请填写周期账单名称' }, 400);

      const frequency = body.frequency !== undefined ? String(body.frequency) : 'monthly';
      if (!(RECURRING_FREQS as readonly string[]).includes(frequency)) {
        return c.json({ ok: false, error: '无效的周期频率（frequency）' }, 400);
      }
      const intervalN = parseOptionalIntRange(body.interval_n, 1, 1, 365, '间隔（interval_n）') ?? 1;
      const dayOfMonth = parseOptionalIntRange(body.day_of_month, null, 1, 31, '每月几号（day_of_month）');
      const weekday = parseOptionalIntRange(body.weekday, null, 0, 6, '星期（weekday）');
      const items = await normalizeRecurringItems(db, oa.ledgerId, body.items, name);

      const today = todayStr();
      let next = parseOptionalDate(body.next_run_at, today, '下次执行日') || today;
      let guard = 0;
      while (next < today && guard++ < 400) {
        next = advanceDate(next, { frequency, interval_n: intervalN, day_of_month: dayOfMonth });
      }
      const effDayOfMonth = dayOfMonth ?? Number(next.slice(8, 10));
      const autoPost = parseBoolFlag(body.auto_post, 1);
      const isActive = parseBoolFlag(body.is_active, 1);

      const res = await db.run(
        `INSERT INTO recurring_rules
         (ledger_id, name, payload, frequency, interval_n, day_of_month, weekday, next_run_at, auto_post, is_active, created_by_user_id, created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
        oa.ledgerId,
        name,
        JSON.stringify({ items, user_id: oa.userId }),
        frequency,
        intervalN,
        effDayOfMonth,
        weekday,
        next,
        autoPost,
        isActive,
        oa.userId,
        nowStr(),
        oa.ledgerId,
      );
      if (!res.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
      const id = Number(res.lastInsertRowid);
      const created = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, recurring: created ? decorateRecurring(created) : null }, 201);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  async function handleRecurringUpdate(c: Context<HonoEnv>) {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    const existing = await db.get<RecurringRuleRow>(
      'SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!existing) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    try {
      const body = await readJsonObject(c);
      const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 40);
      if (!name) return c.json({ ok: false, error: '请填写周期账单名称' }, 400);

      const frequency = body.frequency !== undefined ? String(body.frequency) : existing.frequency;
      if (!(RECURRING_FREQS as readonly string[]).includes(frequency)) {
        return c.json({ ok: false, error: '无效的周期频率（frequency）' }, 400);
      }
      const intervalN =
        parseOptionalIntRange(body.interval_n, existing.interval_n || 1, 1, 365, '间隔（interval_n）') ?? 1;
      const dayOfMonth = parseOptionalIntRange(
        body.day_of_month,
        existing.day_of_month,
        1,
        31,
        '每月几号（day_of_month）',
      );
      const weekday = parseOptionalIntRange(body.weekday, existing.weekday, 0, 6, '星期（weekday）');

      const prevParsed = parseRecurringPayload(existing.payload);
      const prevAcctIds = new Set(
        prevParsed.items
          .map((x) => (x && typeof x === 'object' ? Number((x as Record<string, unknown>).account_id) : 0))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
      const prevCatIds = new Set(
        prevParsed.items
          .map((x) => (x && typeof x === 'object' ? Number((x as Record<string, unknown>).category_id) : 0))
          .filter((n) => Number.isInteger(n) && n > 0),
      );

      const items =
        body.items !== undefined
          ? await normalizeRecurringItems(db, oa.ledgerId, body.items, name, prevAcctIds, prevCatIds)
          : prevParsed.items;
      if (!items.length) return c.json({ ok: false, error: '周期账单明细不能为空' }, 400);

      const today = todayStr();
      let next = existing.next_run_at;
      if (body.next_run_at !== undefined) {
        const rawNext = parseOptionalDate(body.next_run_at, null, '下次执行日');
        if (!rawNext) return c.json({ ok: false, error: '下次执行日不能为空' }, 400);
        next = rawNext;
        if (rawNext !== existing.next_run_at) {
          let guard = 0;
          while (next < today && guard++ < 400) {
            next = advanceDate(next, { frequency, interval_n: intervalN, day_of_month: dayOfMonth });
          }
        }
      }

      const effDayOfMonth = dayOfMonth ?? Number(next.slice(8, 10));
      const autoPost = parseBoolFlag(body.auto_post, existing.auto_post);
      const isActive = parseBoolFlag(body.is_active, existing.is_active);
      const payload = JSON.stringify({
        items,
        user_id: prevParsed.user_id || existing.created_by_user_id || oa.userId,
      });

      await db.run(
        `UPDATE recurring_rules
         SET name = ?, payload = ?, frequency = ?, interval_n = ?, day_of_month = ?, weekday = ?, next_run_at = ?, auto_post = ?, is_active = ?
         WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
        name,
        payload,
        frequency,
        intervalN,
        effDayOfMonth,
        weekday,
        next,
        autoPost,
        isActive,
        id,
        oa.ledgerId,
        oa.ledgerId,
      );
      const updated = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, recurring: updated ? decorateRecurring(updated) : null });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  }

  openapiRoutes.put('/recurring/:id', handleRecurringUpdate);
  openapiRoutes.patch('/recurring/:id', handleRecurringUpdate);

  openapiRoutes.delete('/recurring/:id', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    const res = await dbOf(c).run(`DELETE FROM recurring_rules WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
    if (res.changes !== 1) return c.json({ ok: false, error: '周期账单不存在' }, 404);
    return c.json({ ok: true });
  });

  async function executeRecurringRule(
    db: Db,
    oa: OpenAuth,
    rule: RecurringRuleRow,
    body: Record<string, unknown>,
  ): Promise<{ status: 200 | 400 | 409; data: Record<string, unknown> }> {
    const bad = await ruleBadAccount(db, rule);
    if (bad) return { status: 400, data: { ok: false, error: bad } };

    const period = parseOptionalDate(body.next_run_at, rule.next_run_at, '执行期次') || rule.next_run_at;
    const today = todayStr();
    const defaultDate = period < today ? period : today;
    const runDate = parseOptionalDate(body.txn_date ?? body.date, defaultDate, '入账日期') || defaultDate;
    const result = await postRecurringPeriod(db, rule, period, runDate);
    if (!result) {
      return { status: 409, data: { ok: false, error: '该期已执行，请勿重复提交' } };
    }

    const updated = await db.get<RecurringRuleRow>(
      'SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?',
      rule.id,
      oa.ledgerId,
    );
    return {
      status: 200,
      data: {
        ok: true,
        created: result.created,
        next_run_at: result.next,
        recurring: updated ? decorateRecurring(updated) : null,
      },
    };
  }

  async function executeSubscriptionCharge(
    db: Db,
    oa: OpenAuth,
    s: subs.SubscriptionRow,
    body: Record<string, unknown>,
  ): Promise<{ status: 200 | 400 | 409; data: Record<string, unknown> }> {
    if (!['active', 'trial'].includes(s.status)) {
      return { status: 400, data: { ok: false, error: '已暂停或取消的订阅无法扣费' } };
    }
    if (s.status === 'trial' && s.trial_ends_on && s.trial_ends_on > todayStr()) {
      return {
        status: 400,
        data: { ok: false, error: `订阅仍在试用期（到期日 ${s.trial_ends_on}），暂不可手动扣费` },
      };
    }
    if (!(await subs.accountUsable(db, s.account_id, s.ledger_id))) {
      return { status: 400, data: { ok: false, error: '扣费账户不存在或已归档，请先在订阅设置里更换账户' } };
    }
    const period = parseOptionalDate(body.next_charge_at, s.next_charge_at, '扣费日期') || s.next_charge_at;
    const result = await subs.charge(db, s, oa.userId, period);
    if (!result) return { status: 409, data: { ok: false, error: '该期已扣费，请勿重复提交' } };
    const subscription = await getDecoratedSub(db, s.id, oa.ledgerId);
    return {
      status: 200,
      data: {
        ok: true,
        transaction_id: result.transactionId,
        charged_date: period,
        next_charge_at: result.next,
        subscription,
      },
    };
  }

  openapiRoutes.post('/recurring/:id/run', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '周期账单不存在' }, 404);

    const rule = await db.get<RecurringRuleRow>(
      'SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!rule) return c.json({ ok: false, error: '周期账单不存在' }, 404);

    try {
      const body = await readJsonObject(c, { optional: true });
      const res = await executeRecurringRule(db, oa, rule, body);
      return c.json(res.data, res.status);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  openapiRoutes.post('/recurring/:id/pay', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '周期账单或订阅不存在' }, 404);

    try {
      const body = await readJsonObject(c, { optional: true });
      const rawKind = body.kind !== undefined && body.kind !== null ? String(body.kind).trim() : '';
      if (rawKind && !['bill', 'recurring', 'subscription'].includes(rawKind)) {
        return c.json({ ok: false, error: '无效的 kind 参数（仅支持 bill / recurring / subscription）' }, 400);
      }

      if (rawKind === 'subscription') {
        const s = await db.get<subs.SubscriptionRow>(
          'SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?',
          id,
          oa.ledgerId,
        );
        if (!s) return c.json({ ok: false, error: '订阅不存在' }, 404);
        const res = await executeSubscriptionCharge(db, oa, s, body);
        return c.json({ ...res.data, ...(res.status === 200 ? { kind: 'subscription' } : {}) }, res.status);
      }

      if (rawKind === 'bill' || rawKind === 'recurring') {
        const rule = await db.get<RecurringRuleRow>(
          'SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?',
          id,
          oa.ledgerId,
        );
        if (!rule) return c.json({ ok: false, error: '周期账单不存在' }, 404);
        const res = await executeRecurringRule(db, oa, rule, body);
        return c.json({ ...res.data, ...(res.status === 200 ? { kind: 'recurring' } : {}) }, res.status);
      }

      const [rule, sub] = await Promise.all([
        db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, oa.ledgerId),
        db.get<subs.SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?', id, oa.ledgerId),
      ]);
      if (rule && sub) {
        return c.json(
          { ok: false, error: '该 ID 同时命中周期账单与订阅，请显式传入 kind（"recurring" 或 "subscription"）' },
          409,
        );
      }
      if (rule) {
        const res = await executeRecurringRule(db, oa, rule, body);
        return c.json({ ...res.data, ...(res.status === 200 ? { kind: 'recurring' } : {}) }, res.status);
      }
      if (sub) {
        const res = await executeSubscriptionCharge(db, oa, sub, body);
        return c.json({ ...res.data, ...(res.status === 200 ? { kind: 'subscription' } : {}) }, res.status);
      }

      return c.json({ ok: false, error: '周期账单或订阅不存在' }, 404);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  // ---- Subscriptions ----
  openapiRoutes.get('/subscriptions', async (c) => {
    const oa = c.get('openAuth')!;
    const status = c.req.query('status');
    let sql = `${SUB_SELECT} WHERE s.ledger_id = ?`;
    const params: unknown[] = [oa.ledgerId];
    if (status) {
      if (!(SUB_ALL_STATUSES as readonly string[]).includes(status)) {
        return c.json({ ok: false, error: '无效的订阅状态过滤参数（status）' }, 400);
      }
      sql += ' AND s.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY s.id DESC';
    const rows = await dbOf(c).all<subs.SubscriptionRow>(sql, ...params);
    return c.json({ ok: true, subscriptions: rows.map((s) => subs.decorate(s)) });
  });

  openapiRoutes.get('/subscriptions/:id', async (c) => {
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const sub = await getDecoratedSub(db, id, oa.ledgerId);
    if (!sub) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const charges = await subs.chargesOf(db, oa.ledgerId, id, 50);
    return c.json({ ok: true, subscription: sub, charges });
  });

  openapiRoutes.post('/subscriptions', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    try {
      const body = await readJsonObject(c);
      const d = await normalizeSubscriptionWrite(db, oa.ledgerId, body);
      const res = await db.run(
        `INSERT INTO subscriptions (ledger_id, name, icon, plan, vendor_url, amount_cents, currency, cycle, cycle_n,
          anchor_month, anchor_day, account_id, category_id, auto_renew, trial_ends_on, next_charge_at,
          reminder_days, status, note, created_by_user_id, created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
        oa.ledgerId,
        d.name,
        d.icon,
        d.plan,
        d.vendor_url,
        d.amount_cents,
        d.currency,
        d.cycle,
        d.cycle_n,
        d.anchor_month,
        d.anchor_day,
        d.account_id,
        d.category_id,
        d.auto_renew,
        d.trial_ends_on,
        d.next_charge_at,
        d.reminder_days,
        d.status,
        d.note,
        oa.userId,
        nowStr(),
        oa.ledgerId,
      );
      if (!res.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
      const id = Number(res.lastInsertRowid);
      const subscription = await getDecoratedSub(db, id, oa.ledgerId);
      return c.json({ ok: true, id, subscription }, 201);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  async function handleSubscriptionUpdate(c: Context<HonoEnv>) {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const existing = await db.get<subs.SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!existing) return c.json({ ok: false, error: '订阅不存在' }, 404);
    try {
      const body = await readJsonObject(c);
      const d = await normalizeSubscriptionWrite(db, oa.ledgerId, body, existing);
      await db.run(
        `UPDATE subscriptions
         SET name = ?, icon = ?, plan = ?, vendor_url = ?, amount_cents = ?, currency = ?, cycle = ?, cycle_n = ?,
             anchor_month = ?, anchor_day = ?, account_id = ?, category_id = ?, auto_renew = ?, trial_ends_on = ?,
             next_charge_at = ?, reminder_days = ?, status = ?, note = ?, canceled_at = ?
         WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
        d.name,
        d.icon,
        d.plan,
        d.vendor_url,
        d.amount_cents,
        d.currency,
        d.cycle,
        d.cycle_n,
        d.anchor_month,
        d.anchor_day,
        d.account_id,
        d.category_id,
        d.auto_renew,
        d.trial_ends_on,
        d.next_charge_at,
        d.reminder_days,
        d.status,
        d.note,
        d.canceled_at,
        id,
        oa.ledgerId,
        oa.ledgerId,
      );
      const subscription = await getDecoratedSub(db, id, oa.ledgerId);
      return c.json({ ok: true, id, subscription });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  }

  openapiRoutes.put('/subscriptions/:id', handleSubscriptionUpdate);
  openapiRoutes.patch('/subscriptions/:id', handleSubscriptionUpdate);

  openapiRoutes.delete('/subscriptions/:id', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const res = await dbOf(c).run(`DELETE FROM subscriptions WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
    if (res.changes !== 1) return c.json({ ok: false, error: '订阅不存在' }, 404);
    return c.json({ ok: true });
  });

  openapiRoutes.post('/subscriptions/:id/charge', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const s = await db.get<subs.SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!s) return c.json({ ok: false, error: '订阅不存在' }, 404);
    try {
      const body = await readJsonObject(c, { optional: true });
      const res = await executeSubscriptionCharge(db, oa, s, body);
      return c.json(res.data, res.status);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  openapiRoutes.post('/subscriptions/:id/skip', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const s = await db.get<subs.SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = ? AND ledger_id = ?',
      id,
      oa.ledgerId,
    );
    if (!s) return c.json({ ok: false, error: '订阅不存在' }, 404);
    try {
      const body = await readJsonObject(c, { optional: true });
      const period = parseOptionalDate(body.next_charge_at, s.next_charge_at, '跳过日期') || s.next_charge_at;
      const next = subs.advance(period, s);
      const claim = await db.run(
        `UPDATE subscriptions SET next_charge_at = ? WHERE id = ? AND ledger_id = ? AND next_charge_at = ? AND ${txn.activeLedgerGuard}`,
        next,
        s.id,
        oa.ledgerId,
        period,
        oa.ledgerId,
      );
      if (claim.changes !== 1) {
        return c.json({ ok: false, error: '该期已处理或下次扣费日已变更，请刷新后重试' }, 409);
      }
      const subscription = await getDecoratedSub(db, id, oa.ledgerId);
      return c.json({
        ok: true,
        skipped_date: period,
        next_charge_at: next,
        subscription,
      });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  // ---- Debts & Loans ----
  openapiRoutes.get('/debts', handleListDebts);
  openapiRoutes.get('/loans', handleListDebts);
  openapiRoutes.get('/debts/:id', handleGetDebt);
  openapiRoutes.get('/loans/:id', handleGetDebt);
  openapiRoutes.post('/debts', handleCreateDebt);
  openapiRoutes.post('/loans', handleCreateDebt);
  openapiRoutes.put('/debts/:id', handleUpdateDebt);
  openapiRoutes.patch('/debts/:id', handleUpdateDebt);
  openapiRoutes.put('/loans/:id', handleUpdateDebt);
  openapiRoutes.patch('/loans/:id', handleUpdateDebt);
  openapiRoutes.delete('/debts/:id', handleDeleteDebt);
  openapiRoutes.delete('/loans/:id', handleDeleteDebt);
  openapiRoutes.post('/debts/:id/settle', handleSettleDebt);
  openapiRoutes.post('/loans/:id/settle', handleSettleDebt);

  // ---- Goals ----
  openapiRoutes.get('/goals', async (c) => {
    const oa = c.get('openAuth')!;
    const status = c.req.query('status');
    let sql = 'SELECT * FROM goals WHERE ledger_id = ?';
    const params: unknown[] = [oa.ledgerId];
    if (status === 'active' || status === 'completed') {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC';
    const goals = await dbOf(c).all<GoalRow>(sql, ...params);
    return c.json({ ok: true, goals });
  });

  openapiRoutes.get('/goals/:id', async (c) => {
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    const goal = await dbOf(c).get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!goal) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    return c.json({ ok: true, goal });
  });

  openapiRoutes.post('/goals', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    try {
      const body = await readJsonObject(c);
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) return c.json({ ok: false, error: '请填写储蓄目标名称' }, 400);

      const target = parseAmountField(body, ['target_cents', 'amount_cents'], ['target', 'amount'], {
        label: '目标金额',
      });
      if (!target) return c.json({ ok: false, error: '目标金额须大于 0' }, 400);

      const saved =
        parseAmountField(body, ['saved_cents'], ['saved_amount', 'saved'], { allowZero: true, label: '已存金额' }) ?? 0;
      const icon = String(body.icon || '🎯').trim().slice(0, 8) || '🎯';
      const accountId = parseOptionalRefId(body.account_id, null, '关联账户 ID');
      if (accountId !== null) {
        await assertAccountInLedger(db, oa.ledgerId, accountId);
      }
      const targetDate = parseOptionalDate(body.target_date, null, '目标日期');
      const note = body.note != null && String(body.note).trim() ? String(body.note).trim().slice(0, 200) : null;
      const status = saved >= target ? 'completed' : 'active';

      const ins = await db.run(
        `INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at)
         SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
        oa.ledgerId,
        name,
        icon,
        target,
        saved,
        accountId,
        targetDate,
        status,
        note,
        nowStr(),
        oa.ledgerId,
      );
      if (!ins.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
      const id = Number(ins.lastInsertRowid);
      const goal = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, goal }, 201);
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });

  async function handleGoalUpdate(c: Context<HonoEnv>) {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    const existing = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    try {
      const body = await readJsonObject(c);
      const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 30);
      if (!name) return c.json({ ok: false, error: '请填写储蓄目标名称' }, 400);

      const target =
        parseAmountField(body, ['target_cents', 'amount_cents'], ['target', 'amount'], { label: '目标金额' }) ??
        Number(existing.target_cents);
      const saved =
        parseAmountField(body, ['saved_cents'], ['saved_amount', 'saved'], { allowZero: true, label: '已存金额' }) ??
        Number(existing.saved_cents);
      const icon =
        body.icon !== undefined ? String(body.icon || '').trim().slice(0, 8) || '🎯' : existing.icon || '🎯';
      const accountId = parseOptionalRefId(body.account_id, existing.account_id, '关联账户 ID');
      if (accountId !== null) {
        await assertAccountInLedger(db, oa.ledgerId, accountId, {
          allowArchived: accountId === existing.account_id,
        });
      }
      const targetDate = parseOptionalDate(body.target_date, existing.target_date, '目标日期');
      const note =
        body.note !== undefined
          ? body.note == null || String(body.note).trim() === ''
            ? null
            : String(body.note).trim().slice(0, 200)
          : existing.note;
      const status = saved >= target ? 'completed' : 'active';

      await db.run(
        `UPDATE goals
         SET name = ?, icon = ?, target_cents = ?, saved_cents = ?, account_id = ?, target_date = ?, status = ?, note = ?
         WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
        name,
        icon,
        target,
        saved,
        accountId,
        targetDate,
        status,
        note,
        id,
        oa.ledgerId,
        oa.ledgerId,
      );
      const goal = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, id, goal });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  }

  openapiRoutes.put('/goals/:id', handleGoalUpdate);
  openapiRoutes.patch('/goals/:id', handleGoalUpdate);

  openapiRoutes.delete('/goals/:id', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    const res = await dbOf(c).run(`DELETE FROM goals WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
    if (res.changes !== 1) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    return c.json({ ok: true });
  });

  openapiRoutes.post('/goals/:id/deposit', async (c) => {
    const w = requireWriteApi(c);
    if (w) return w;
    const oa = c.get('openAuth')!;
    const db = dbOf(c);
    const id = parsePositiveIntId(c.req.param('id'));
    if (!id) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);
    const g = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!g) return c.json({ ok: false, error: '储蓄目标不存在' }, 404);

    try {
      const body = await readJsonObject(c);
      const rawAmt = parseAmountField(body, ['amount_cents'], ['amount'], {
        allowNegative: true,
        label: '存取金额',
      });
      if (rawAmt === undefined) return c.json({ ok: false, error: '请填写存取金额' }, 400);

      const amt = rawAmt > 0 ? rawAmt : -Math.min(Math.abs(rawAmt), Number(g.saved_cents));
      if (!amt) return c.json({ ok: false, error: '当前已存金额为 0，无法继续取出' }, 400);

      const createTxn = parseBoolFlag(body.create_txn, 0) === 1;
      let accountId: number | null = null;
      if (createTxn) {
        accountId = parseOptionalRefId(body.account_id, g.account_id, '账户 ID');
        if (!accountId) return c.json({ ok: false, error: '生成流水需要指定 account_id' }, 400);
        await assertAccountInLedger(db, oa.ledgerId, accountId);
      }

      const prevSaved = Number(g.saved_cents);
      const saved = Math.max(0, prevSaved + amt);
      const done = Number(g.target_cents) > 0 && saved >= Number(g.target_cents);
      const nextStatus = done ? 'completed' : 'active';
      const claim = await db.run(
        `UPDATE goals SET saved_cents = ?, status = ? WHERE id = ? AND ledger_id = ? AND saved_cents = ? AND ${txn.activeLedgerGuard}`,
        saved,
        nextStatus,
        id,
        oa.ledgerId,
        prevSaved,
        oa.ledgerId,
      );
      if (Number(claim.changes || 0) !== 1) {
        return c.json({ ok: false, error: '储蓄目标刚被并发更新，请重试' }, 409);
      }

      let txnId: number | null = null;
      if (createTxn && accountId) {
        try {
          const txnDate = parseOptionalDate(body.txn_date ?? body.date, todayStr(), '交易日期') || todayStr();
          const note =
            body.note != null && String(body.note).trim()
              ? String(body.note).trim().slice(0, 300)
              : `储蓄目标「${g.name}」${amt > 0 ? '存入' : '取出'}`;
          txnId = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
            type: amt > 0 ? 'expense' : 'income',
            amount_cents: Math.abs(amt),
            account_id: accountId,
            txn_date: txnDate,
            note,
            source: 'openapi',
          });
        } catch (e) {
          await db
            .run(
              `UPDATE goals
               SET saved_cents = MAX(0, saved_cents - ?),
                   status = CASE WHEN target_cents > 0 AND MAX(0, saved_cents - ?) >= target_cents THEN 'completed' ELSE 'active' END
               WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
              amt,
              amt,
              id,
              oa.ledgerId,
              oa.ledgerId,
            )
            .catch(() => {});
          throw e;
        }
      }

      if (done && g.status !== 'completed') {
        const key = `goal-done:${g.id}`;
        for (const uid of await ledgerWriterIds(db, oa.ledgerId)) {
          await notify(db, uid, {
            kind: 'success',
            ledgerId: oa.ledgerId,
            title: `储蓄目标达成：${g.name}`,
            body: `已存 ${(saved / 100).toFixed(2)}，目标 ${(Number(g.target_cents) / 100).toFixed(2)}`,
            link: '/goals',
            dedupeKey: key,
          });
        }
      }

      const goal = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
      return c.json({ ok: true, delta_cents: amt, transaction_id: txnId, goal });
    } catch (e) {
      return c.json({ ok: false, error: toPublicError(e) }, 400);
    }
  });
}
