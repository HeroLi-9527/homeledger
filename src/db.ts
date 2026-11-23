import { ACCOUNT_TYPES, ACCOUNT_TYPE_MAP, TXN_TYPES, TXN_TYPE_MAP, PRIMARY_TXN_TYPES } from './constants.js';
import type { BatchStatement, Db, Env, Role } from './types.js';

export { ACCOUNT_TYPES, ACCOUNT_TYPE_MAP, TXN_TYPES, TXN_TYPE_MAP, PRIMARY_TXN_TYPES };

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

export interface TxnEffectInput {
  type: string;
  amount_base_cents: number;
  account_id: number | null;
  to_account_id?: number | null;
}

export interface BalanceEffect {
  accountId: number;
  delta: number;
}

export function txnEffects(t: TxnEffectInput): BalanceEffect[] {
  const a = Number(t.amount_base_cents) || 0;
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
      push(t.to_account_id, a);
      break;
    case 'invest_sell':
      push(t.to_account_id || t.account_id, -a);
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

export async function recalcBalances(db: Db, ledgerId: number): Promise<void> {
  const [accounts, rows] = await Promise.all([
    db.all<{ id: number; initial_cents: number }>('SELECT id, initial_cents FROM accounts WHERE ledger_id = ?', ledgerId),
    db.all<TxnEffectInput>(
      'SELECT type, amount_base_cents, account_id, to_account_id FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL',
      ledgerId,
    ),
  ]);
  const delta = new Map<number, number>();
  for (const t of rows) {
    for (const e of txnEffects(t)) {
      delta.set(e.accountId, (delta.get(e.accountId) || 0) + e.delta);
    }
  }
  const stmts: BatchStatement[] = accounts.map((acc) => {
    const v = Number(acc.initial_cents) + (delta.get(Number(acc.id)) || 0);
    return ['UPDATE accounts SET balance_cents = ? WHERE id = ?', [v, acc.id]];
  });
  if (stmts.length) await db.batch(stmts);
}
