import { nowStr } from '../db.js';
import type { AppContext, Db, Env, LedgerRow, Role, SessionPayload, UserRow } from '../types.js';
import { uid } from './util.js';

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};
const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

const PBKDF2_ITER = 100_000;
const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
export const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8Bytes(s: string): Uint8Array<ArrayBuffer> {
  const src = enc.encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(s: string): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return a;
}

function randomHex(nBytes: number): string {
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return hex(a);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomHex(16);
  const key = await crypto.subtle.importKey('raw', utf8Bytes(String(plain)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(salt), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${hex(bits)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = String(stored).split('$');
    if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false;
    const [, iter, salt, hash] = parts;
    const iterations = Number(iter);
    if (!Number.isFinite(iterations) || iterations < 1 || !salt || !hash) return false;
    const key = await crypto.subtle.importKey('raw', utf8Bytes(String(plain)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: unhex(salt), iterations, hash: 'SHA-256' },
      key,
      256,
    );
    return timingSafeEqual(new Uint8Array(bits), unhex(hash));
  } catch {
    return false;
  }
}

export const DUMMY_PASSWORD_HASH = `pbkdf2$${PBKDF2_ITER}$${'00'.repeat(16)}$${'00'.repeat(32)}`;

// ---- 无状态 HMAC-SHA256 签名 Cookie（零 D1 读写） ----

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET 未配置或长度不足 16 位');
  }
  return crypto.subtle.importKey('raw', utf8Bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function createSessionPayload(
  userId: number,
  ledgerId: number | null,
  tokenVersion: number,
  csrf = uid(32),
  now = Date.now(),
): SessionPayload {
  return {
    uid: Number(userId),
    lid: ledgerId == null ? null : Number(ledgerId),
    tv: Number(tokenVersion) || 1,
    csrf,
    exp: now + SESSION_MS,
  };
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const body = b64urlEncode(utf8Bytes(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifySession(
  token: string | null | undefined,
  secret: string | undefined,
  now = Date.now(),
): Promise<SessionPayload | null> {
  if (!token || !secret || secret.length < 16) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!body || !sigPart) return null;
  try {
    const key = await importHmacKey(secret);
    const sigBytes = b64urlDecode(sigPart);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, utf8Bytes(body));
    if (!valid) return null;
    const parsed = JSON.parse(dec.decode(b64urlDecode(body))) as SessionPayload;
    if (!parsed || typeof parsed.uid !== 'number' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function needsRefresh(payload: SessionPayload, now = Date.now()): boolean {
  return payload.exp - now < REFRESH_THRESHOLD_MS;
}

export function sessionCookie(
  token: string,
  env: Pick<Env, 'COOKIE_SECURE'>,
  maxAgeSec = SESSION_DAYS * 24 * 3600,
): string {
  const secure = String(env.COOKIE_SECURE ?? '').toLowerCase() !== 'false';
  return `hl.sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export const clearSessionCookie = (env: Pick<Env, 'COOKIE_SECURE'>): string => sessionCookie('', env, 0);

export function csrfCheck(expectedToken: string, bodyToken?: string | null, headerToken?: string | null): boolean {
  const got = bodyToken || headerToken || '';
  return !!got && !!expectedToken && got === expectedToken;
}

// ---- 权限与上下文 ----

export const canWrite = (role?: string | null): boolean => (ROLE_RANK[role as Role] || 0) >= ROLE_RANK.member;
export const canWriteLedger = (ledger?: LedgerRow | null): boolean => !!ledger && !ledger.is_archived && canWrite(ledger.role);
export const canManage = (role?: string | null): boolean => (ROLE_RANK[role as Role] || 0) >= ROLE_RANK.admin;

export async function membership(db: Db, userId: number, ledgerId: number) {
  if (!userId || !ledgerId) return null;
  return db.get<{ id: number; ledger_id: number; user_id: number; role: Role; nickname: string | null }>(
    'SELECT * FROM ledger_members WHERE user_id = ? AND ledger_id = ?',
    Number(userId),
    Number(ledgerId),
  );
}

export async function loadContext(db: Db, sess: SessionPayload | null): Promise<AppContext> {
  if (!sess?.uid) return { user: null, ledgers: [], ledger: null, isAdmin: false, unreadCount: 0 };
  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', sess.uid);
  if (!user || user.status !== 'active' || Number(user.token_version) !== Number(sess.tv)) {
    return { user: null, ledgers: [], ledger: null, isAdmin: false, unreadCount: 0 };
  }
  const [ledgers, unread] = await Promise.all([
    db.all<LedgerRow>(
      `SELECT l.*, lm.role FROM ledgers l JOIN ledger_members lm ON lm.ledger_id = l.id
       WHERE lm.user_id = ? ORDER BY l.is_archived, l.sort_order, l.id`,
      user.id,
    ),
    db.get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', user.id),
  ]);
  const ledgerId = sess.lid || ledgers[0]?.id || null;
  const ledger = ledgers.find((l) => l.id === Number(ledgerId)) || ledgers[0] || null;
  return { user, ledgers, ledger, isAdmin: !!user.is_admin, unreadCount: Number(unread?.c || 0) };
}

// ---- 通知（单表 INSERT OR IGNORE 去重，零额外表与预查） ----

export interface NotifyOptions {
  kind?: string;
  ledgerId?: number | null;
  title: string;
  body?: string;
  link?: string;
  dedupeKey?: string | null;
}

export async function notify(db: Db, userId: number, opts: NotifyOptions): Promise<boolean> {
  const r = await db.run(
    `INSERT OR IGNORE INTO notifications (user_id, ledger_id, kind, title, body, link, dedupe_key, created_at)
     SELECT ?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM ledgers WHERE id = ? AND is_archived = 0)`,
    Number(userId),
    opts.ledgerId ?? null,
    opts.kind || 'info',
    opts.title,
    opts.body || '',
    opts.link || '',
    opts.dedupeKey ?? null,
    nowStr(),
    opts.ledgerId ?? null,
    opts.ledgerId ?? null,
  );
  return r.changes === 1;
}

export async function sha256Hex(plain: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(plain));
  return hex(digest);
}

export async function ledgerWriterIds(db: Db, ledgerId: number): Promise<number[]> {
  const rows = await db.all<{ user_id: number }>(
    "SELECT user_id FROM ledger_members WHERE ledger_id = ? AND role IN ('owner','admin','member')",
    ledgerId,
  );
  return rows.map((r) => Number(r.user_id));
}
