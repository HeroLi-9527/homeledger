import type { Context } from 'hono';
import { allSettings } from '../db.js';
import { canManage, canWrite, csrfCheck } from '../lib/auth.js';
import type { Db, Env, FlashMessage, HonoEnv } from '../types.js';

type AppCtx = Context<HonoEnv>;

export function dbOf(c: AppCtx): Db {
  return c.get('db');
}

export function envOf(c: AppCtx): Env {
  return c.env;
}

export function hasValidSessionSecret(env: Env): boolean {
  return String(env.SESSION_SECRET || '').length >= 16;
}

export function getSessionSecret(env: Env): string {
  if (!hasValidSessionSecret(env)) {
    throw new Error('SESSION_SECRET 未配置或长度不足 16 位');
  }
  return String(env.SESSION_SECRET);
}

export async function bodyOf(c: AppCtx): Promise<Record<string, unknown>> {
  const cached = c.get('body');
  if (cached && typeof cached === 'object') return cached;
  const ct = c.req.header('content-type') || '';
  let out: Record<string, unknown> = {};
  try {
    if (ct.includes('application/json')) {
      out = ((await c.req.json()) as Record<string, unknown>) || {};
    } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const fd = await c.req.formData();
      const o: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (o[k] === undefined) o[k] = v;
        else if (Array.isArray(o[k])) (o[k] as unknown[]).push(v);
        else o[k] = [o[k], v];
      }
      out = o;
    }
  } catch {
    out = {};
  }
  c.set('body', out);
  return out;
}

export function wantsJson(c: AppCtx): boolean {
  return (c.req.header('accept') || '').includes('application/json');
}

export function cookie(c: AppCtx, name: string): string | null {
  const h = c.req.header('cookie') || '';
  const m = h.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setFlash(c: AppCtx, type: FlashMessage['type'], message: string): void {
  const secure = String(c.env.COOKIE_SECURE ?? '').toLowerCase() !== 'false';
  const val = encodeURIComponent(JSON.stringify({ type, message }));
  c.header('Set-Cookie', `hl.flash=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60${secure ? '; Secure' : ''}`, {
    append: true,
  });
}

export function takeFlash(c: AppCtx): FlashMessage | null {
  const cached = c.get('flash');
  if (cached !== undefined) return cached;
  const raw = cookie(c, 'hl.flash');
  if (!raw) {
    c.set('flash', null);
    return null;
  }
  const secure = String(c.env.COOKIE_SECURE ?? '').toLowerCase() !== 'false';
  c.header('Set-Cookie', `hl.flash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`, {
    append: true,
  });
  try {
    const parsed = JSON.parse(raw) as FlashMessage;
    c.set('flash', parsed);
    return parsed;
  } catch {
    c.set('flash', null);
    return null;
  }
}

function isSameOriginRequest(c: AppCtx): boolean {
  let own: string;
  try {
    own = new URL(c.req.url).origin;
  } catch {
    return false;
  }
  const origin = c.req.header('origin');
  if (origin) return origin === own;
  const referer = c.req.header('referer');
  if (referer) {
    try {
      return new URL(referer).origin === own;
    } catch {
      return false;
    }
  }
  return true;
}

export function checkCsrf(c: AppCtx, body: Record<string, unknown>): boolean {
  const m = c.req.method;
  if (['GET', 'HEAD', 'OPTIONS'].includes(m)) return true;
  const sess = c.get('sess');
  if (sess) {
    const presented = String(body._csrf || body.csrf || c.req.header('x-csrf-token') || '');
    return csrfCheck(sess.csrf, presented);
  }
  return isSameOriginRequest(c);
}

export function csrfFail(c: AppCtx): Response {
  if (wantsJson(c)) return c.json({ ok: false, error: 'CSRF 校验失败，请刷新页面重试' }, 403);
  return c.html('<h1>会话已过期</h1><p>安全令牌校验失败，请返回上一页刷新后重试。</p>', 403);
}

export function toPublicError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (!msg) return '服务器开小差了，请稍后重试';
  if (
    /^D1_(ERROR|TYPE_ERROR)/.test(msg) ||
    /no such (table|column|function)|UNIQUE constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|near ".+": syntax error|datatype mismatch|attempt to write a readonly database/i.test(
      msg,
    )
  ) {
    console.error('[api-error]', msg);
    return '服务器开小差了，请稍后重试';
  }
  return msg;
}

export function requireLogin(c: AppCtx): Response | null {
  const ctx = c.get('ctx');
  if (!ctx?.user) {
    if (wantsJson(c)) return c.json({ ok: false, error: '未登录', redirect: '/login' }, 401);
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  }
  return null;
}

export function requireLedger(c: AppCtx): Response | null {
  const r = requireLogin(c);
  if (r) return r;
  const ctx = c.get('ctx');
  if (!ctx?.ledger) {
    if (wantsJson(c)) return c.json({ ok: false, error: '当前没有可用账本，请先创建一个账本' }, 400);
    if (c.req.method === 'GET') return c.redirect('/');
    return c.html('<h1>没有账本</h1><p>请先创建一个账本</p>', 400);
  }
  return null;
}

export function archivedLedgerResponse(c: AppCtx): Response {
  const message = '账本已归档，只能查阅和导出';
  return wantsJson(c)
    ? c.json({ ok: false, error: message }, 403)
    : c.html(`<h1>归档账本只读</h1><p>${message}</p>`, 403);
}

export function requireWrite(c: AppCtx): Response | null {
  const r = requireLedger(c);
  if (r) return r;
  if (c.get('ctx').ledger?.is_archived) return archivedLedgerResponse(c);
  if (!canWrite(c.get('ctx').ledger?.role)) {
    if (wantsJson(c)) return c.json({ ok: false, error: '只读权限，无法修改' }, 403);
    return c.html('<h1>只读权限</h1><p>你在该账本中只有只读权限，无法进行此操作</p>', 403);
  }
  return null;
}

export function requireManage(c: AppCtx): Response | null {
  const r = requireLedger(c);
  if (r) return r;
  if (c.get('ctx').ledger?.is_archived) return archivedLedgerResponse(c);
  if (!canManage(c.get('ctx').ledger?.role)) {
    return c.html('<h1>权限不足</h1><p>需要账本管理员及以上权限</p>', 403);
  }
  return null;
}

export function requireAdmin(c: AppCtx): Response | null {
  const r = requireLogin(c);
  if (r) return r;
  if (!c.get('ctx')?.isAdmin) {
    if (wantsJson(c)) return c.json({ ok: false, error: '仅管理员可访问' }, 403);
    return c.html('<h1>无权限</h1><p>仅管理员可访问该页面</p>', 403);
  }
  return null;
}

export async function siteMeta(c: AppCtx): Promise<{ siteName: string; baseCurrency: string; allowRegister: boolean }> {
  const all = await allSettings(dbOf(c));
  return {
    siteName: all['site.name'] || c.env.SITE_NAME || '家账簿',
    baseCurrency: all['site.currency'] || 'CNY',
    allowRegister: all['site.allow_register'] === 'true',
  };
}
