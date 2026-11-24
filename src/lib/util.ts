import { todayStr } from '../db.js';

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  HKD: 'HK$',
  JPY: '¥',
  GBP: '£',
  KRW: '₩',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
  TWD: 'NT$',
};

export function currencySymbol(code?: string | null): string {
  return (code && CURRENCY_SYMBOL[code]) || (code ? `${code} ` : '¥');
}

export function fmtAmount(cents: number | string | null | undefined, decimals = 2): string {
  const n = Number(cents || 0) / 100;
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (neg ? '-' : '') + s;
}

export function money(cents: number | string | null | undefined, code = 'CNY'): string {
  return currencySymbol(code) + fmtAmount(cents);
}

export function signedMoney(cents: number | string | null | undefined, code = 'CNY'): string {
  const n = Number(cents || 0);
  return (n > 0 ? '+' : n < 0 ? '-' : '') + currencySymbol(code) + fmtAmount(Math.abs(n));
}

export function compactMoney(cents: number | string | null | undefined, code = 'CNY'): string {
  const n = Math.abs(Number(cents || 0)) / 100;
  const s = currencySymbol(code);
  const sign = Number(cents) < 0 ? '-' : '';
  if (n >= 100000000) return `${sign}${s}${(n / 100000000).toFixed(2)}亿`;
  if (n >= 10000) return `${sign}${s}${(n / 10000).toFixed(2)}万`;
  return `${sign}${s}${n.toFixed(2)}`;
}

export function parseAmountToCents(input: unknown): number {
  if (input === null || input === undefined) return 0;
  const s = String(input).trim().replace(/[¥$€£,\s元块圆]/g, '');
  if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(s)) return 0;
  const neg = s.startsWith('-');
  const [ip, fp = ''] = (neg ? s.slice(1) : s).split('.');
  let cents = Number(ip) * 100 + Number((fp + '00').slice(0, 2));
  if (fp.length > 2 && Number(fp[2]) >= 5) cents += 1;
  return neg ? -cents : cents;
}

export const pad = (n: number | string): string => String(n).padStart(2, '0');

export function fmtDate(d: unknown): string {
  if (!d) return '';
  return String(d).slice(0, 10);
}

export function fmtDateTime(d: unknown): string {
  return d ? String(d).slice(0, 16) : '';
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${fmtDate(dateStr)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function relDate(dateStr: string, today?: string | Date): string {
  const d = fmtDate(dateStr);
  const t =
    typeof today === 'string' && today
      ? fmtDate(today)
      : today instanceof Date
        ? `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`
        : todayStr();
  if (d === t) return '今天';
  if (d === addDays(t, -1)) return '昨天';
  if (d === addDays(t, -2)) return '前天';
  const [yy, mm, dd] = d.split('-');
  if (yy === t.slice(0, 4)) return `${Number(mm)}月${Number(dd)}日`;
  return `${yy}年${Number(mm)}月${Number(dd)}日`;
}

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function weekdayOf(dateStr: string): string {
  const d = new Date(`${fmtDate(dateStr)}T00:00:00Z`);
  return WEEKDAYS[d.getUTCDay()];
}

export function addMonths(monthStr: string, n: number): string {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const monthOf = (dateStr: string): string => fmtDate(dateStr).slice(0, 7);
export function monthStart(monthStr: string): string {
  return `${monthStr}-01`;
}
export function daysInMonth(monthStr: string): number {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function monthEnd(monthStr: string): string {
  return `${monthStr}-${pad(daysInMonth(monthStr))}`;
}
export function monthLabel(monthStr: string): string {
  const [y, m] = monthStr.split('-');
  return `${y}年${Number(m)}月`;
}
export function monthShort(monthStr: string): string {
  return `${Number(monthStr.split('-')[1])}月`;
}

export function lastMonths(n: number, ref: Date | string = todayStr()): string[] {
  const base =
    typeof ref === 'string'
      ? ref.slice(0, 7)
      : `${ref.getUTCFullYear()}-${pad(ref.getUTCMonth() + 1)}`;
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(base, -i));
  return out;
}

export function monthDays(monthStr: string): string[] {
  const total = daysInMonth(monthStr);
  const out: string[] = [];
  for (let i = 1; i <= total; i++) out.push(`${monthStr}-${pad(i)}`);
  return out;
}

export function firstWeekday(monthStr: string): number {
  const d = new Date(`${monthStr}-01T00:00:00Z`);
  return d.getUTCDay();
}

export const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 1000) / 10 : 0);
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(s: unknown, n = 24): string {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export const PALETTE = [
  '#4f7cff',
  '#13c2c2',
  '#52c41a',
  '#fa8c16',
  '#eb2f96',
  '#722ed1',
  '#fa541c',
  '#1677ff',
  '#a0d911',
  '#f5222d',
];

export function colorFor(str: unknown): string {
  if (!str) return PALETTE[0];
  const s = String(str);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 99991;
  return PALETTE[h % PALETTE.length];
}

export function initials(name: unknown): string {
  if (!name) return '?';
  const s = String(name).trim();
  if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-2);
  return s.slice(0, 2).toUpperCase();
}

export function uid(len = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export function toBase(amountCents: number, rate: number): number {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new Error('汇率无效');
  const scaled = Math.round(r * 1e6);
  return Math.round((amountCents * scaled) / 1e6);
}

export function barPct(used: number, total: number): number {
  return clamp(pct(used, total), 0, 100);
}

export function avatarUrl(u: { avatar_path?: string | null; avatar_ver?: number | null } | null | undefined): string | null {
  if (!u || !u.avatar_path) return null;
  const p = String(u.avatar_path).replace(/^uploads\/avatars\//, '');
  return `/uploads/avatars/${encodeURIComponent(p)}?v=${Number(u.avatar_ver) || 0}`;
}

/** 仅放行站内相对路径，拦截外链与伪协议（如 javascript:、//evil.com、含制表符/控制字符绕过） */
export function safeInternalPath(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\x00-\x1f\x7f]/.test(s)) {
    return fallback;
  }
  try {
    const base = 'https://homeledger.local';
    const parsed = new URL(s, base);
    if (parsed.origin !== base) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
