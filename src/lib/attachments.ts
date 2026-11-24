import { nowStr, todayStr } from '../db.js';
import type { Db, Env } from '../types.js';
import { uid } from './util.js';

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 6;

export const webUrl = (rel: string): string => `/uploads/${String(rel).replace(/^uploads\//, '')}`;

function checkMagicBytes(mime: string, buf: Buffer): void {
  const bytes = buf.subarray(0, 12);
  const startsWith = (arr: number[]) => arr.every((b, i) => bytes[i] === b);
  const textAt = (off: number, len: number) => buf.subarray(off, off + len).toString('latin1');
  switch (mime) {
    case 'image/png':
      if (!startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        throw new Error('图片内容与声明的 PNG 格式不符');
      }
      break;
    case 'image/jpeg':
    case 'image/jpg':
      if (!startsWith([0xff, 0xd8, 0xff])) throw new Error('图片内容与声明的 JPEG 格式不符');
      break;
    case 'image/gif':
      if (!(textAt(0, 6) === 'GIF87a' || textAt(0, 6) === 'GIF89a')) {
        throw new Error('图片内容与声明的 GIF 格式不符');
      }
      break;
    case 'image/webp':
      if (!(textAt(0, 4) === 'RIFF' && textAt(8, 4) === 'WEBP')) {
        throw new Error('图片内容与声明的 WebP 格式不符');
      }
      break;
    case 'image/bmp':
      if (textAt(0, 2) !== 'BM') throw new Error('图片内容与声明的 BMP 格式不符');
      break;
    default:
      break;
  }
}

export function validateImageBuffer(mimeInput: string, buf: Buffer): { mime: string; ext: string } {
  const mime = String(mimeInput || '').toLowerCase().split(';')[0].trim();
  if (!Object.prototype.hasOwnProperty.call(MIME_EXT, mime)) {
    throw new Error(`不支持的图片类型：${mime || '未知'}`);
  }
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('单张图片请小于 8MB');
  const ext = MIME_EXT[mime];
  const canonicalMime = EXT_MIME[ext];
  checkMagicBytes(canonicalMime, buf);
  return { mime: canonicalMime, ext };
}

export function inferImageMime(mimeInput: string | null | undefined, fileName?: string | null): string {
  const clean = String(mimeInput || '').toLowerCase().split(';')[0].trim();
  if (clean && clean !== 'application/octet-stream') return clean;
  const m = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : '';
  return (ext && EXT_MIME[ext]) || clean;
}

export function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || '').trim());
  if (!m) throw new Error('图片格式无法识别（需要 data:image/...;base64,xxx）');
  const buf = Buffer.from(m[2], 'base64');
  const { mime } = validateImageBuffer(m[1], buf);
  return { mime, buf };
}

export interface AttachmentRow {
  id: number;
  ledger_id: number;
  txn_id: number | null;
  user_id: number;
  kind: string;
  file_name: string;
  rel_path: string;
  mime: string | null;
  size: number | null;
  ai_status: string;
  created_at: string;
  url?: string;
}

export async function saveBufferImage(
  db: Db,
  env: Pick<Env, 'ATTACHMENTS'>,
  {
    buf,
    mime: mimeInput,
    ledgerId,
    userId,
    txnId = null,
    name,
    kind = 'screenshot',
    aiStatus = 'pending',
  }: {
    buf: Buffer;
    mime: string;
    ledgerId: number;
    userId: number;
    txnId?: number | null;
    name?: string;
    kind?: string;
    aiStatus?: string;
  },
) {
  const { mime, ext } = validateImageBuffer(mimeInput, buf);
  const ym = todayStr().slice(0, 4) + todayStr().slice(5, 7);
  const fileName = `${Date.now()}_${uid(8)}.${ext}`;
  const key = `uploads/${ym}/${fileName}`;
  await env.ATTACHMENTS.put(key, buf, { httpMetadata: { contentType: mime } });
  const info = await db.run(
    `INSERT INTO attachments (ledger_id, txn_id, user_id, kind, file_name, rel_path, mime, size, ai_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    Number(ledgerId),
    txnId != null ? Number(txnId) : null,
    Number(userId),
    kind,
    name || fileName,
    key,
    mime,
    buf.length,
    aiStatus,
    nowStr(),
  );
  return {
    id: Number(info.lastInsertRowid),
    rel: key,
    url: webUrl(key),
    size: buf.length,
    mime,
    file_name: name || fileName,
    txn_id: txnId != null ? Number(txnId) : null,
  };
}

export async function saveDataUrlImage(
  db: Db,
  env: Pick<Env, 'ATTACHMENTS'>,
  {
    dataUrl,
    ledgerId,
    userId,
    txnId = null,
    name,
    kind = 'screenshot',
    aiStatus = 'pending',
  }: {
    dataUrl: string;
    ledgerId: number;
    userId: number;
    txnId?: number | null;
    name?: string;
    kind?: string;
    aiStatus?: string;
  },
) {
  const { mime, buf } = parseDataUrl(dataUrl);
  return saveBufferImage(db, env, { buf, mime, ledgerId, userId, txnId, name, kind, aiStatus });
}

export async function linkImagesToTxns(
  db: Db,
  {
    ledgerId,
    imageIds = [],
    txnIds = [],
    aiStatus = 'linked',
  }: { ledgerId: number; imageIds?: number[]; txnIds?: number[]; aiStatus?: string },
) {
  const ids = imageIds.map(Number).filter(Boolean);
  const txns = txnIds.map(Number).filter(Boolean);
  if (!ids.length || !txns.length) return [];
  const pairs: Array<{ image_id: number; txn_id: number }> = [];
  for (let i = 0; i < ids.length; i++) {
    const target = txns.length === ids.length ? txns[i] : txns[0];
    const res = await db.run(
      'UPDATE attachments SET txn_id = ?, ai_status = ? WHERE id = ? AND ledger_id = ? AND txn_id IS NULL',
      target,
      aiStatus,
      ids[i],
      Number(ledgerId),
    );
    if (res.changes === 1) pairs.push({ image_id: ids[i], txn_id: target });
  }
  return pairs;
}

export async function listByTxnIds(db: Db, txnIds: number[] = []): Promise<Map<number, AttachmentRow[]>> {
  const ids = txnIds.map(Number).filter(Boolean);
  const map = new Map<number, AttachmentRow[]>();
  if (!ids.length) return map;
  const rows = await db.all<AttachmentRow>(
    `SELECT id, ledger_id, txn_id, user_id, kind, file_name, rel_path, mime, size, ai_status, created_at
     FROM attachments WHERE txn_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ...ids,
  );
  for (const r of rows) {
    r.url = webUrl(r.rel_path);
    const k = Number(r.txn_id);
    const list = map.get(k) || [];
    list.push(r);
    map.set(k, list);
  }
  return map;
}

export async function listByTxn(db: Db, txnId: number): Promise<AttachmentRow[]> {
  const rows = await db.all<AttachmentRow>(
    `SELECT id, ledger_id, txn_id, user_id, kind, file_name, rel_path, mime, size, ai_status, created_at
     FROM attachments WHERE txn_id = ? ORDER BY id`,
    Number(txnId),
  );
  return rows.map((r) => ({ ...r, url: webUrl(r.rel_path) }));
}

export async function countByTxnIds(db: Db, txnIds: number[] = []): Promise<Map<number, number>> {
  const ids = txnIds.map(Number).filter(Boolean);
  const map = new Map<number, number>();
  if (!ids.length) return map;
  const rows = await db.all<{ txn_id: number; c: number }>(
    `SELECT txn_id, COUNT(*) AS c FROM attachments
     WHERE txn_id IN (${ids.map(() => '?').join(',')}) GROUP BY txn_id`,
    ...ids,
  );
  for (const r of rows) map.set(Number(r.txn_id), Number(r.c));
  return map;
}

export async function attachCounts<T extends { id?: number; attachment_count?: number }>(
  db: Db,
  items: T[] = [],
): Promise<T[]> {
  const ids = items.map((t) => Number(t?.id)).filter(Boolean);
  const counts = await countByTxnIds(db, ids);
  for (const t of items) {
    if (t && t.id != null) t.attachment_count = counts.get(Number(t.id)) || 0;
  }
  return items;
}

export async function getById(db: Db, ledgerId: number, id: number): Promise<AttachmentRow | null> {
  const row = await db.get<AttachmentRow>(
    'SELECT * FROM attachments WHERE id = ? AND ledger_id = ?',
    Number(id),
    Number(ledgerId),
  );
  if (row) row.url = webUrl(row.rel_path);
  return row || null;
}

export async function resolveObject(env: Pick<Env, 'ATTACHMENTS'>, ledgerId: number, db: Db, id: number) {
  const row = await getById(db, ledgerId, id);
  if (!row) return null;
  const key = String(row.rel_path);
  if (!key.startsWith('uploads/') || key.includes('..')) return null;
  const obj = await env.ATTACHMENTS.get(key);
  if (!obj) return null;
  return { obj, row };
}

export async function deleteKeysFromR2(env: Pick<Env, 'ATTACHMENTS'> | undefined, keys: string[]): Promise<void> {
  if (!env?.ATTACHMENTS) return;
  const valid = keys.filter(
    (k) => k && (k.startsWith('uploads/') || k.startsWith('imports/')) && !k.includes('..') && !k.includes('\\'),
  );
  for (let i = 0; i < valid.length; i += 1000) {
    try {
      await env.ATTACHMENTS.delete(valid.slice(i, i + 1000));
    } catch {
      /* ignore missing R2 keys */
    }
  }
}

export async function removeById(
  db: Db,
  env: Pick<Env, 'ATTACHMENTS'>,
  ledgerId: number,
  id: number,
): Promise<boolean> {
  const row = await db.get<AttachmentRow>(
    'SELECT * FROM attachments WHERE id = ? AND ledger_id = ?',
    Number(id),
    Number(ledgerId),
  );
  if (!row) return false;
  await deleteKeysFromR2(env, [String(row.rel_path)]);
  await db.run('DELETE FROM attachments WHERE id = ?', row.id);
  return true;
}

export async function saveAvatar(
  env: Pick<Env, 'ATTACHMENTS'>,
  userId: number,
  { mime, buf, ext }: { mime: string; buf: Buffer; ext: string },
): Promise<string> {
  const name = `user-${Number(userId)}.${ext}`;
  const key = `uploads/avatars/${name}`;
  await env.ATTACHMENTS.put(key, buf, { httpMetadata: { contentType: mime } });
  return name;
}

export async function removeAvatar(env: Pick<Env, 'ATTACHMENTS'>, avatarPath: string | null | undefined): Promise<void> {
  if (!avatarPath) return;
  const clean = String(avatarPath).replace(/^uploads\/avatars\//, '');
  if (!clean || clean.includes('..')) return;
  await deleteKeysFromR2(env, [`uploads/avatars/${clean}`]);
}
