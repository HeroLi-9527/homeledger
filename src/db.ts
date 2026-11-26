import {
  ACCOUNT_GROUPS,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_MAP,
  TXN_TYPES,
  TXN_TYPE_MAP,
  PRIMARY_TXN_TYPES,
  accountGroupOf,
  isCreditGroupType,
  type AccountGroupKey,
} from './constants.js';
import type { BatchStatement, Db, Env, Role } from './types.js';

export {
  ACCOUNT_GROUPS,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_MAP,
  TXN_TYPES,
  TXN_TYPE_MAP,
  PRIMARY_TXN_TYPES,
  accountGroupOf,
  isCreditGroupType,
  type AccountGroupKey,
};

let TZ = 'Asia/Shanghai';
export function setTimezone(tz: string): void {
  if (typeof tz === 'string' && tz) TZ = tz;
}
export function getTimezone(): string {
  return TZ;
}

export function nowStr(d = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export const todayStr = (): string => nowStr().slice(0, 10);
export const B = (v: unknown): number => (v ? 1 : 0);
export const N = <T>(v: T | undefined | null | ''): T | null => (v === undefined || v === null || v === '' ? null : v);

export function makeDb(env: Pick<Env, 'DB' | 'TZ'>): Db {
  if (env.TZ) setTimezone(env.TZ);
  const d1 = env.DB;
  return {
    d1,
    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      const { results } = await d1.prepare(sql).bind(...params).all<T>();
      return results || [];
    },
    async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? undefined;
    },
    async run(sql: string, ...params: unknown[]) {
      const r = await d1.prepare(sql).bind(...params).run();
      return {
        changes: Number(r.meta?.changes || 0),
        lastInsertRowid: Number(r.meta?.last_row_id || 0),
      };
    },
    async batch(statements: BatchStatement[]) {
      return d1.batch(statements.map(([sql, params]) => d1.prepare(sql).bind(...(params || []))));
    },
  };
}

export async function getSetting(db: Db, key: string, def: string | null = null): Promise<string | null> {
  const r = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value ?? ''),
  );
}

export async function allSettings(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    out[r.key] = r.value;
  }
  return out;
}

export async function createDefaultAccounts(db: Db, ledgerId: number, currency = 'CNY'): Promise<void> {
  const presets: Array<[string, string, string]> = [
    ['现金', 'cash', '💵'],
    ['支付宝', 'virtual', '📱'],
    ['微信钱包', 'virtual', '💬'],
    ['银行卡', 'debit', '🏦'],
    ['信用卡', 'credit', '💳'],
  ];
  const now = nowStr();
  await db.batch(
    presets.map(([name, type, icon], i) => [
      `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, created_at)
       VALUES (?,?,?,?,?,0,0,?,?)`,
      [ledgerId, name, type, icon, currency, i, now],
    ]),
  );
}

export async function addLedgerMember(
  db: Db,
  ledgerId: number,
  userId: number,
  role: Role = 'member',
  nickname: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO ledger_members (ledger_id, user_id, role, nickname, joined_at) VALUES (?,?,?,?,?)
     ON CONFLICT(ledger_id, user_id) DO UPDATE SET role = excluded.role`,
    ledgerId,
    userId,
    role,
    nickname,
    nowStr(),
  );
}

export async function createDefaultLedger(db: Db, userId: number, displayName: string): Promise<number> {
  const currency = (await getSetting(db, 'site.currency', 'CNY')) || 'CNY';
  const info = await db.run(
    `INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    `${displayName}的账本`,
    'personal',
    currency,
    '📒',
    '#4f7cff',
    userId,
    '注册时自动创建',
    nowStr(),
  );
  const id = info.lastInsertRowid;
  await addLedgerMember(db, id, userId, 'owner');
  await createDefaultAccounts(db, id, currency);
  return id;
}

export async function baseExchangeRates(db: Db) {
  const code = String(await getSetting(db, 'site.currency', 'CNY')).toUpperCase();
  const rows = await db.all<{ base: string; rate: number }>(
    'SELECT base, rate FROM exchange_rates WHERE quote = ? AND rate > 0', code,
  );
  return { code, rates: new Map([...rows.map((r) => [r.base, Number(r.rate)] as const), [code, 1]]) };
}

export interface TxnEffectInput {
  type: string;
  amount_base_cents: number;
  account_id: number | null;
  to_account_id?: number | null;
  account_amount_cents?: number | null;
  to_account_amount_cents?: number | null;
}

export function accountCentsFromBase(cents: number, currency: string, base: string, rate: number | undefined): number {
  if (currency === base) return cents;
  if (rate === undefined || !(rate > 0)) throw new Error(`缺少 ${currency} 兑 ${base} 汇率，请填写账户原币金额`);
  const original = Math.round(cents / rate);
  if (!original) throw new Error('折算后的账户原币金额小于最小单位，请填写实际金额');
  return original;
}

export async function accountAmounts(
  db: Db,
  ledgerId: number,
  t: TxnEffectInput & { amount_cents: number; currency: string },
): Promise<{ account_amount_cents: number | null; to_account_amount_cents: number | null }> {
  const twoSided = ['transfer', 'invest_buy', 'invest_sell'].includes(t.type);
  const ids = [t.account_id, twoSided ? t.to_account_id : null].filter((id): id is number => id != null);
  if (!ids.length) return { account_amount_cents: null, to_account_amount_cents: null };
  const accounts = await db.all<{ id: number; currency: string }>(
    `SELECT id, currency FROM accounts WHERE ledger_id = ? AND id IN (${ids.map(() => '?').join(',')})`, ledgerId, ...ids,
  );
  let basePromise: Promise<string | null> | undefined;
  const amountFor = async (id: number | null | undefined, actual: number | null | undefined) => {
    if (!id || actual === null) return null;
    const account = accounts.find((a) => Number(a.id) === id);
    if (!account) throw new Error('账户不属于当前账本或已删除');
    if (actual != null) {
      if (!Number.isSafeInteger(actual) || (t.type === 'adjust' ? Math.sign(actual) !== Math.sign(t.amount_cents) : actual <= 0)) {
        throw new Error('账户原币金额无效');
      }
      return actual;
    }
    const code = account.currency.toUpperCase();
    if (code === t.currency.toUpperCase()) return t.amount_cents;
    const base = String(await (basePromise ??= getSetting(db, 'site.currency', 'CNY'))).toUpperCase();
    if (code === base) return t.amount_base_cents;
    const row = await db.get<{ rate: number }>('SELECT rate FROM exchange_rates WHERE base = ? AND quote = ?', code, base);
    return accountCentsFromBase(t.amount_base_cents, code, base, row?.rate);
  };
  const [account_amount_cents, to_account_amount_cents] = await Promise.all([
    amountFor(t.account_id, t.account_amount_cents),
    amountFor(twoSided ? t.to_account_id : null, t.to_account_amount_cents),
  ]);
  return { account_amount_cents, to_account_amount_cents };
}

export interface BalanceEffect {
  accountId: number;
  delta: number;
}

export function txnEffects(t: TxnEffectInput): BalanceEffect[] {
  const a = Number(t.account_amount_cents === undefined ? t.amount_base_cents : t.account_amount_cents) || 0;
  const b = Number(t.to_account_amount_cents === undefined ? t.amount_base_cents : t.to_account_amount_cents) || 0;
  const out: BalanceEffect[] = [];
  const push = (id: number | null | undefined, d: number) => {
    if (id) out.push({ accountId: Number(id), delta: d });
  };
  switch (t.type) {
    case 'expense':
    case 'lend':
    case 'repay_pay':
    case 'fee':
      push(t.account_id, -a);
      break;
    case 'income':
    case 'borrow':
    case 'repay_receive':
    case 'reimburse':
    case 'refund':
    case 'interest':
      push(t.account_id, a);
      break;
    case 'transfer':
    case 'invest_buy':
      push(t.account_id, -a);
      push(t.to_account_id, b);
      break;
    case 'invest_sell':
      if (t.to_account_id) push(t.to_account_id, -b);
      else push(t.account_id, -a);
      push(t.account_id, a);
      break;
    case 'adjust':
      push(t.account_id, a);
      break;
    default:
      push(t.account_id, -a);
  }
  return out;
}

export function balanceDeltaStmts(signed: Array<[TxnEffectInput, number]>): BatchStatement[] {
  const net = new Map<number, number>();
  for (const [t, s] of signed) {
    for (const e of txnEffects(t)) {
      net.set(e.accountId, (net.get(e.accountId) || 0) + s * e.delta);
    }
  }
  return [...net.entries()]
    .filter(([, d]) => d !== 0)
    .map(([accountId, d]) => ['UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [d, accountId]]);
}

export const backfillLegacyAccountAmounts: BatchStatement = [`WITH base AS (SELECT UPPER(COALESCE((SELECT value FROM settings WHERE key = 'site.currency'), 'CNY')) AS code)
UPDATE transactions AS t
SET account_amount_cents = (
      SELECT CASE
        WHEN UPPER(a.currency) = UPPER(t.currency) THEN t.amount_cents
        WHEN UPPER(a.currency) = base.code THEN t.amount_base_cents
      END
      FROM accounts a, base WHERE a.id = t.account_id AND a.ledger_id = t.ledger_id
    ),
    to_account_amount_cents = (
      SELECT CASE
        WHEN UPPER(a.currency) = UPPER(t.currency) THEN t.amount_cents
        WHEN UPPER(a.currency) = base.code THEN t.amount_base_cents
      END
      FROM accounts a, base WHERE a.id = t.to_account_id AND a.ledger_id = t.ledger_id
    )`];

export const accountBalanceCtes = `sides AS (
  SELECT account_id AS id, CASE
    WHEN type = 'invest_sell' AND to_account_id IS NULL THEN 0
    WHEN type IN ('income','borrow','repay_receive','reimburse','refund','interest','invest_sell','adjust')
      THEN account_amount_cents ELSE -account_amount_cents END AS delta
  FROM balance_txns WHERE account_id IS NOT NULL
  UNION ALL
  SELECT to_account_id, CASE WHEN type = 'invest_sell' THEN -to_account_amount_cents ELSE to_account_amount_cents END
  FROM balance_txns WHERE to_account_id IS NOT NULL AND type IN ('transfer','invest_buy','invest_sell')
), totals AS (SELECT id, SUM(delta) AS delta FROM sides GROUP BY id)`;

export const recomputeAccountBalances: BatchStatement = [`WITH balance_txns AS (
  SELECT * FROM transactions WHERE deleted_at IS NULL
), ${accountBalanceCtes}
UPDATE accounts SET balance_cents = initial_cents + COALESCE((SELECT delta FROM totals WHERE id = accounts.id), 0)`];
