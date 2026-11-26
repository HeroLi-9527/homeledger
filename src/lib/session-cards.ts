import { nowStr, todayStr } from '../db.js';
import type { BatchStatement, Db, SessionCardLogRow, SessionCardRow } from '../types.js';
import * as txn from './txn.js';
import { parseAmountToCents } from './util.js';

export type SessionCardStatus = 'archived' | 'exhausted' | 'expired' | 'active';

export interface DecoratedSessionCard extends SessionCardRow {
  usedSessions: number;
  unitCostCents: number;
  daysUntilExpiry: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
  isExhausted: boolean;
  isLowSessions: boolean;
  status: SessionCardStatus;
}

export interface CreateSessionCardInput {
  name: string;
  icon?: string;
  merchant?: string | null;
  total_sessions: number;
  remaining_sessions?: number | null;
  total_cost_cents: number;
  currency?: string;
  purchase_date?: string;
  expires_at?: string | null;
  note?: string | null;
  record_expense?: boolean;
  account_id?: number | string | null;
  category_id?: number | string | null;
}

export interface UpdateSessionCardInput {
  name: string;
  icon?: string;
  merchant?: string | null;
  total_cost_cents?: number;
  expires_at?: string | null;
  note?: string | null;
  is_archived?: number;
}

export interface TopUpSessionCardInput {
  add_sessions: number;
  add_cost_cents: number;
  topup_date?: string;
  expires_at?: string | null;
  note?: string | null;
  record_expense?: boolean;
  account_id?: number | string | null;
  category_id?: number | string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcDayMs(dateStr: string): number {
  return Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
}

function validOptionalDate(raw: string | null | undefined, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!DATE_RE.test(s)) throw new Error(`${label}格式不正确`);
  return s;
}

export function decorateCard(card: SessionCardRow, today = todayStr()): DecoratedSessionCard {
  const total = Math.max(0, Number(card.total_sessions || 0));
  const remaining = Math.max(0, Number(card.remaining_sessions || 0));
  const cost = Math.max(0, Number(card.total_cost_cents || 0));
  const usedSessions = Math.max(0, total - remaining);
  const unitCostCents = total > 0 ? Math.round(cost / total) : 0;
  const expiresAt = card.expires_at && DATE_RE.test(String(card.expires_at).slice(0, 10)) ? String(card.expires_at).slice(0, 10) : null;
  const daysUntilExpiry =
    expiresAt !== null ? Math.round((utcDayMs(expiresAt) - utcDayMs(today)) / 86400000) : null;
  const isExpired = daysUntilExpiry !== null && daysUntilExpiry < 0;
  const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry <= 7;
  const isExhausted = remaining <= 0;
  const isLowSessions = remaining > 0 && total > 2 && remaining <= 2;
  const status: SessionCardStatus = card.is_archived
    ? 'archived'
    : isExhausted
      ? 'exhausted'
      : isExpired
        ? 'expired'
        : 'active';

  return {
    ...card,
    expires_at: expiresAt,
    usedSessions,
    unitCostCents,
    daysUntilExpiry,
    isExpired,
    isExpiringSoon,
    isExhausted,
    isLowSessions,
    status,
  };
}

export async function listSessionCards(db: Db, ledgerId: number, today = todayStr()) {
  const rows = await db.all<SessionCardRow>(
    `SELECT * FROM session_cards
     WHERE ledger_id = ?
     ORDER BY is_archived ASC, (remaining_sessions <= 0) ASC,
              CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, id DESC`,
    ledgerId,
  );
  const all = rows.map((r) => decorateCard(r, today));
  const active = all.filter((c) => !c.is_archived && c.remaining_sessions > 0);
  const archivedOrExhausted = all.filter((c) => c.is_archived || c.remaining_sessions <= 0);
  const totalRemaining = active.reduce((s, c) => s + Number(c.remaining_sessions || 0), 0);
  return {
    all,
    active,
    archivedOrExhausted,
    activeCount: active.length,
    totalRemaining,
  };
}

export async function getSessionCard(
  db: Db,
  id: number,
  ledgerId: number,
  today = todayStr(),
): Promise<DecoratedSessionCard | undefined> {
  const row = await db.get<SessionCardRow>('SELECT * FROM session_cards WHERE id = ? AND ledger_id = ?', id, ledgerId);
  return row ? decorateCard(row, today) : undefined;
}

export async function listCardLogs(db: Db, cardId: number, ledgerId: number): Promise<SessionCardLogRow[]> {
  return db.all<SessionCardLogRow>(
    `SELECT l.*, u.display_name AS member_name
     FROM session_card_logs l
     LEFT JOIN users u ON u.id = l.user_id
     WHERE l.card_id = ? AND l.ledger_id = ?
     ORDER BY l.used_at DESC, l.id DESC`,
    cardId,
    ledgerId,
  );
}

export function parseCardCostCents(body: Record<string, unknown>, centsKey = 'total_cost_cents', yuanKey = 'total_cost'): number {
  if (body[centsKey] !== undefined && body[centsKey] !== null && String(body[centsKey]).trim() !== '') {
    const n = Math.round(Number(body[centsKey]));
    if (!Number.isFinite(n) || n < 0) throw new Error('金额不能为负数');
    return n;
  }
  const raw = String(body[yuanKey] ?? '').trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[¥$€£,\s元块圆]/g, '');
  if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(cleaned)) throw new Error('金额格式不正确');
  const cents = parseAmountToCents(raw);
  if (cents < 0) throw new Error('金额不能为负数');
  return cents;
}

export async function createSessionCard(
  db: Db,
  ledgerId: number,
  userId: number,
  input: CreateSessionCardInput,
): Promise<number> {
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) throw new Error('请填写次卡名称');
  const total = Number(input.total_sessions);
  if (!Number.isInteger(total) || total < 1 || total > 9999) {
    throw new Error('总次数须为 1 至 9999 的整数');
  }
  const remaining =
    input.remaining_sessions !== undefined && input.remaining_sessions !== null && String(input.remaining_sessions) !== ''
      ? Number(input.remaining_sessions)
      : total;
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > total) {
    throw new Error('剩余次数须在 0 至总次数之间');
  }
  const cost = Math.round(Number(input.total_cost_cents || 0));
  if (!Number.isFinite(cost) || cost < 0) throw new Error('购卡金额不能为负数');

  const icon = (String(input.icon || '🎟️').trim() || '🎟️').slice(0, 16);
  const merchant = input.merchant ? String(input.merchant).trim().slice(0, 60) || null : null;
  const currency = (String(input.currency || 'CNY').trim().toUpperCase() || 'CNY').slice(0, 8);
  const purchaseDate = validOptionalDate(input.purchase_date, '购卡日期') || todayStr();
  const expiresAt = validOptionalDate(input.expires_at, '有效期');
  const note = input.note ? String(input.note).trim().slice(0, 200) || null : null;

  const linked = Boolean(input.record_expense && cost > 0);
  const expense = linked ? await txn.prepareTransactionWrites(db, ledgerId, userId, {
    type: 'expense', amount_cents: cost, currency, account_id: input.account_id || null,
    category_id: input.category_id || null, txn_date: purchaseDate, merchant: merchant || name,
    note: `购买次卡：${name}（${total}次）`, source: 'manual',
  }) : [];
  const stamp = nowStr();
  const initNote = remaining < total
    ? `补录存量卡（共 ${total} 次，当前余 ${remaining} 次）` : `开卡建账（共 ${total} 次）`;
  const result = await db.batch([
    ...expense,
    [`INSERT INTO session_cards
      (ledger_id, name, icon, merchant, total_sessions, remaining_sessions, total_cost_cents, currency,
       purchase_date, expires_at, purchase_txn_id, is_archived, note, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,${linked ? 'last_insert_rowid()' : 'NULL'},0,?,?,? WHERE ${txn.activeLedgerGuard}`,
      [ledgerId, name, icon, merchant, total, remaining, cost, currency, purchaseDate, expiresAt, note, stamp, stamp, ledgerId]],
    [`INSERT INTO session_card_logs (card_id, ledger_id, user_id, delta, used_at, note, txn_id, created_at)
      SELECT c.id, c.ledger_id, ?, ?, ?, ?, c.purchase_txn_id, ? FROM session_cards c
      WHERE c.id = last_insert_rowid() AND c.ledger_id = ? AND ${txn.activeLedgerGuard}`,
      [userId, remaining, purchaseDate, initNote, stamp, ledgerId, ledgerId]],
  ]);
  if (result[expense.length]?.meta.changes !== 1) throw new Error('账本已归档，只能查阅和导出');
  return Number(result[expense.length].meta.last_row_id);
}

export async function updateSessionCard(
  db: Db,
  id: number,
  ledgerId: number,
  input: UpdateSessionCardInput,
): Promise<DecoratedSessionCard> {
  const existing = await db.get<SessionCardRow>('SELECT * FROM session_cards WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!existing) throw new Error('次卡不存在');

  const name = String(input.name ?? existing.name).trim().slice(0, 40);
  if (!name) throw new Error('请填写次卡名称');
  const icon = (String(input.icon ?? existing.icon).trim() || '🎟️').slice(0, 16);
  const merchant =
    input.merchant !== undefined ? String(input.merchant || '').trim().slice(0, 60) || null : existing.merchant;
  const expiresAt =
    input.expires_at !== undefined ? validOptionalDate(input.expires_at, '有效期') : existing.expires_at;
  const note = input.note !== undefined ? String(input.note || '').trim().slice(0, 200) || null : existing.note;
  const cost =
    input.total_cost_cents !== undefined ? Math.round(Number(input.total_cost_cents)) : Number(existing.total_cost_cents);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('购卡金额不能为负数');

  const result = await db.run(
    `UPDATE session_cards
     SET name = ?, icon = ?, merchant = ?, total_cost_cents = ?, expires_at = ?, note = ?,
         is_archived = COALESCE(?, is_archived), updated_at = ?
     WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
    name,
    icon,
    merchant,
    cost,
    expiresAt,
    note,
    input.is_archived ?? null,
    nowStr(),
    id,
    ledgerId,
    ledgerId,
  );
  if (!result.changes) throw new Error('次卡不存在或账本已归档');
  return (await getSessionCard(db, id, ledgerId))!;
}

export async function useSessionCard(
  db: Db,
  id: number,
  ledgerId: number,
  userId: number,
  opts: { count?: number; used_at?: string; note?: string | null } = {},
) {
  const count = opts.count !== undefined ? Number(opts.count) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 9999) {
    throw new Error('核销次数须为 1 至 9999 的整数');
  }
  const usedAt = validOptionalDate(opts.used_at, '核销日期') || todayStr();
  const note = opts.note ? String(opts.note).trim().slice(0, 200) || null : null;
  const stamp = nowStr();

  const available = `id = ? AND ledger_id = ? AND is_archived = 0 AND remaining_sessions >= ? AND ${txn.activeLedgerGuard}`;
  const params = [id, ledgerId, count, ledgerId];
  const [log, update] = await db.batch([
    [`INSERT INTO session_card_logs (card_id, ledger_id, user_id, delta, used_at, note, created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM session_cards WHERE ${available})`,
      [id, ledgerId, userId, -count, usedAt, note, stamp, ...params]],
    [`UPDATE session_cards SET remaining_sessions = remaining_sessions - ?, updated_at = ? WHERE ${available}`,
      [count, stamp, ...params]],
  ]);
  if (update.meta.changes !== 1) {
    const existing = await getSessionCard(db, id, ledgerId);
    if (!existing) throw new Error('次卡不存在');
    if (existing.is_archived) throw new Error('次卡已归档，请先恢复后再核销');
    if (existing.remaining_sessions < count) throw new Error(`剩余次数不足（当前剩余 ${existing.remaining_sessions} 次）`);
    throw new Error('账本已归档，只能查阅和导出');
  }
  return { card: (await getSessionCard(db, id, ledgerId))!, logId: Number(log.meta.last_row_id) };
}

export async function topUpSessionCard(
  db: Db,
  id: number,
  ledgerId: number,
  userId: number,
  input: TopUpSessionCardInput,
) {
  const existing = await db.get<SessionCardRow>('SELECT * FROM session_cards WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!existing) throw new Error('次卡不存在');

  const addSessions = Number(input.add_sessions);
  if (!Number.isInteger(addSessions) || addSessions < 1 || addSessions > 9999) {
    throw new Error('续费次数须为 1 至 9999 的整数');
  }
  const addCost = Math.round(Number(input.add_cost_cents || 0));
  if (!Number.isFinite(addCost) || addCost < 0) throw new Error('续费金额不能为负数');
  const topupDate = validOptionalDate(input.topup_date, '续费日期') || todayStr();
  const nextExpiry = validOptionalDate(input.expires_at, '新有效期');
  const note = input.note ? String(input.note).trim().slice(0, 200) : `续费加次 +${addSessions} 次`;
  const linked = Boolean(input.record_expense && addCost > 0);
  const cardGuard: BatchStatement = ['EXISTS (SELECT 1 FROM session_cards WHERE id = ? AND ledger_id = ?)', [id, ledgerId]];
  const expense = linked ? await txn.prepareTransactionWrites(db, ledgerId, userId, {
    type: 'expense', amount_cents: addCost, currency: existing.currency || 'CNY', account_id: input.account_id || null,
    category_id: input.category_id || null, txn_date: topupDate, merchant: existing.merchant || existing.name,
    note: `次卡续费：${existing.name}（+${addSessions}次）`, source: 'manual',
  }, cardGuard) : [];

  const stamp = nowStr();
  const results = await db.batch([
    ...expense,
    [`INSERT INTO session_card_logs (card_id, ledger_id, user_id, delta, used_at, note, txn_id, created_at)
      SELECT ?,?,?,?,?,?,${linked ? 'last_insert_rowid()' : 'NULL'},? WHERE ${cardGuard[0]} AND ${txn.activeLedgerGuard}`,
      [id, ledgerId, userId, addSessions, topupDate, note, stamp, id, ledgerId, ledgerId]],
    [`UPDATE session_cards SET total_sessions = total_sessions + ?, remaining_sessions = remaining_sessions + ?,
        total_cost_cents = total_cost_cents + ?, expires_at = COALESCE(?, expires_at), is_archived = 0, updated_at = ?
      WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
      [addSessions, addSessions, addCost, nextExpiry, stamp, id, ledgerId, ledgerId]],
  ]);
  if (results.at(-1)?.meta.changes !== 1) throw new Error('次卡不存在或账本已归档');
  return (await getSessionCard(db, id, ledgerId))!;
}

export async function undoSessionCardLog(db: Db, cardId: number, logId: number, ledgerId: number) {
  const log = await db.get<SessionCardLogRow>(
    'SELECT * FROM session_card_logs WHERE id = ? AND card_id = ? AND ledger_id = ?',
    logId,
    cardId,
    ledgerId,
  );
  if (!log) throw new Error('核销记录不存在');
  if (Number(log.delta) >= 0) throw new Error('仅支持撤销核销（扣减次数）记录');

  const original = `id = ? AND card_id = ? AND ledger_id = ? AND delta < 0 AND ${txn.activeLedgerGuard}`;
  const args = [logId, cardId, ledgerId, ledgerId];
  const restoreCount = Math.abs(Number(log.delta));
  const [, del] = await db.batch([
    [`UPDATE session_cards SET remaining_sessions = MIN(total_sessions, remaining_sessions + ?),
       is_archived = 0, updated_at = ? WHERE id = ? AND ledger_id = ?
       AND EXISTS (SELECT 1 FROM session_card_logs WHERE ${original})`,
      [restoreCount, nowStr(), cardId, ledgerId, ...args]],
    [`DELETE FROM session_card_logs WHERE ${original}`, args],
  ]);
  if (del.meta.changes !== 1) throw new Error('核销记录已被撤销或账本已归档');
  return { card: (await getSessionCard(db, cardId, ledgerId))!, restored: restoreCount };
}

export async function toggleArchiveSessionCard(db: Db, id: number, ledgerId: number, archived?: number): Promise<boolean> {
  const result = await db.run(
    `UPDATE session_cards SET is_archived = COALESCE(?, 1 - is_archived), updated_at = ?
     WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
    archived ?? null, nowStr(), id, ledgerId, ledgerId,
  );
  return result.changes === 1;
}

export async function deleteSessionCard(db: Db, id: number, ledgerId: number): Promise<boolean> {
  const [, deleted] = await db.batch([
    [`DELETE FROM session_card_logs WHERE card_id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, [id, ledgerId, ledgerId]],
    [`DELETE FROM session_cards WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, [id, ledgerId, ledgerId]],
  ]);
  return deleted.meta.changes === 1;
}
