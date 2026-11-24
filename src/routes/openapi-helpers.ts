import type { Context } from 'hono';
import * as auth from '../lib/auth.js';
import * as u from '../lib/util.js';
import type { AccountRow, CategoryRow, Db, HonoEnv } from '../types.js';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const YUAN_RE = /^-?\d{1,12}(\.\d{0,4})?$/;

export function requireWriteApi(c: Context<HonoEnv>): Response | null {
  const oa = c.get('openAuth');
  if (!oa || !auth.canWrite(oa.role)) {
    return c.json({ ok: false, error: '当前令牌成员角色为只读，禁止写入' }, 403);
  }
  return null;
}

export async function readJsonObject(
  c: Context<HonoEnv>,
  opts: { optional?: boolean } = {},
): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) {
    if (opts.optional) return {};
    throw new Error('请求体必须为有效的 JSON 对象');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('请求体必须为有效的 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须为有效的 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export function parsePositiveIntId(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseBoolFlag(val: unknown, fallback: number): number {
  if (val === undefined) return fallback;
  if (val === false || val === 0 || val === '0' || val === 'false' || val === 'off' || val === null) {
    return 0;
  }
  return 1;
}

export function parseOptionalDate(val: unknown, fallback: string | null, label: string): string | null {
  if (val === undefined) return fallback;
  if (val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (!DAY_RE.test(s)) throw new Error(`${label}格式不正确（应为 YYYY-MM-DD）`);
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== s) {
    throw new Error(`${label}不是有效的日历日期`);
  }
  return s;
}

export function parseOptionalRefId(val: unknown, fallback: number | null, label: string): number | null {
  if (val === undefined) return fallback;
  if (val === null || String(val).trim() === '') return null;
  const s = String(val).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${label}无效`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}无效`);
  return n;
}

export function parseOptionalIntRange(
  val: unknown,
  fallback: number | null,
  min: number,
  max: number,
  label: string,
): number | null {
  if (val === undefined) return fallback;
  if (val === null || String(val).trim() === '') return null;
  const n = Number(String(val).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label}须为 ${min} 至 ${max} 之间的整数`);
  }
  return n;
}

export function parseAmountField(
  body: Record<string, unknown>,
  centsKeys: string[],
  yuanKeys: string[],
  opts: { allowZero?: boolean; allowNegative?: boolean; label: string },
): number | undefined {
  const checkBounds = (cents: number): number => {
    if (!Number.isFinite(cents)) throw new Error(`${opts.label}无效`);
    if (!opts.allowNegative && cents < 0) throw new Error(`${opts.label}不能为负数`);
    if (!opts.allowZero && cents === 0) throw new Error(`${opts.label}不能为 0`);
    return cents;
  };

  for (const k of centsKeys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${opts.label}无效`);
      return checkBounds(Math.round(n));
    }
  }

  for (const k of yuanKeys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      const cleaned = String(v).trim().replace(/[¥$€£,\s元块圆]/g, '');
      if (!YUAN_RE.test(cleaned)) {
        throw new Error(`${opts.label}格式不正确`);
      }
      return checkBounds(u.parseAmountToCents(cleaned));
    }
  }

  return undefined;
}

export async function assertAccountInLedger(
  db: Db,
  ledgerId: number,
  accountId: number,
  opts: { allowArchived?: boolean } = {},
): Promise<AccountRow> {
  const acc = await db.get<AccountRow>(
    'SELECT * FROM accounts WHERE id = ? AND ledger_id = ?',
    accountId,
    ledgerId,
  );
  if (!acc) throw new Error(`账户不存在或不属于当前账本（id=${accountId}）`);
  if (!opts.allowArchived && acc.is_archived) throw new Error(`账户「${acc.name}」已归档`);
  return acc;
}

export async function assertCategoryInLedger(
  db: Db,
  ledgerId: number,
  categoryId: number,
  kind?: 'expense' | 'income',
  opts: { allowArchived?: boolean } = {},
): Promise<CategoryRow> {
  const cat = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    categoryId,
    ledgerId,
  );
  if (!cat) throw new Error(`分类不存在或不属于当前账本（id=${categoryId}）`);
  if (!opts.allowArchived && cat.is_archived) throw new Error(`分类「${cat.name}」已归档`);
  if (kind && cat.kind !== kind) throw new Error('分类类型与当前操作不匹配');
  return cat;
}
