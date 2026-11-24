import { Hono } from 'hono';
import { makeDb } from './db.js';
import * as auth from './lib/auth.js';
import { runScheduled } from './lib/scheduler.js';
import { esc, uid } from './lib/util.js';
import { accountsRoutes } from './routes/accounts.js';
import { adminRoutes } from './routes/admin.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import {
  bodyOf,
  checkCsrf,
  cookie,
  csrfFail,
  getSessionSecret,
  hasValidSessionSecret,
  requireLogin,
  toPublicError,
  wantsJson,
} from './routes/helpers.js';
import { openapiRoutes } from './routes/openapi.js';
import { planningRoutes } from './routes/planning.js';
import { reportsRoutes } from './routes/reports.js';
import { sessionCardsRoutes } from './routes/session-cards.js';
import { subscriptionsRoutes } from './routes/subscriptions.js';
import { txnRoutes } from './routes/transactions.js';
import type { Env, HonoEnv } from './types.js';
import { blank, layout } from './views/layout.js';

export const app = new Hono<HonoEnv>();

const STATIC_ASSETS_PREFIX = /^\/(css|js)\//;
const STATIC_ASSET_EXACT = new Set(['/manifest.webmanifest', '/sw.js', '/favicon.ico']);
const UPLOAD_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
};

function applySecurityHeaders(res: Response, nonce: string, cacheNoStore = false): void {
  res.headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
  );
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (cacheNoStore) res.headers.set('Cache-Control', 'no-store');
}

app.use('*', async (c, next) => {
  const path = c.req.path;
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && c.env.ASSETS) {
    if (STATIC_ASSETS_PREFIX.test(path) || STATIC_ASSET_EXACT.has(path)) {
      const assetRes = await c.env.ASSETS.fetch(c.req.raw);
      if (assetRes.status !== 404) return assetRes;
    }
  }

  const nonce = uid(16);
  c.set('cspNonce', nonce);
  c.set('db', makeDb(c.env));
  c.set('flash', undefined);

  await next();

  if (!c.res.headers.has('Content-Security-Policy')) {
    const noStore = path === '/settings/api-tokens' || path === '/export/json';
    applySecurityHeaders(c.res, nonce, noStore);
  }
});

app.get('/healthz', (c) => c.json({ ok: true, app: 'homeledger', time: new Date().toISOString() }));

// OpenAPI 在 CSRF 与 Cookie 会话中间件之前挂载，使用纯只读 Bearer 鉴权
app.route('/api/open', openapiRoutes);

// 浏览器无状态 Cookie 会话鉴权
app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/open')) {
    await next();
    return;
  }
  if (!hasValidSessionSecret(c.env)) {
    if (wantsJson(c) || c.req.path.startsWith('/api/')) {
      return c.json({ ok: false, error: 'SESSION_SECRET 未配置或长度不足 16 位' }, 503);
    }
    return c.html(
      blank({
        title: '缺少必要配置',
        siteName: c.env.SITE_NAME || '家账簿',
        cspNonce: c.get('cspNonce') || '',
        body: `
          <h1 style="font-size:18px;margin-bottom:6px">缺少必要配置：SESSION_SECRET</h1>
          <p class="muted small mb16"><code>SESSION_SECRET</code> 未配置或长度不足 16 位（建议 32 位以上随机字符串），系统已暂停初始化与登录以保障会话安全。</p>
          <div class="flash warn" style="margin-bottom:14px">
            <span><strong>Cloudflare 控制台配置步骤</strong>：进入 <strong>Workers &amp; Pages</strong> → 当前 Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong> → <strong>Add</strong> → 类型选择 <strong>Secret</strong> → 名称填 <code>SESSION_SECRET</code>，值填入 ≥ 16 位随机串 → 保存并部署。</span>
          </div>
          <p class="small muted"><strong>CLI / 本地开发</strong>：运行 <code>openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET</code>（本地开发请在 <code>.dev.vars</code> 中配置）。</p>
          <a class="btn btn-primary btn-block mt12" href="/">已配置，刷新重试</a>
        `,
      }),
      503,
    );
  }
  const db = c.get('db');
  const rawSid = cookie(c, 'hl.sid');
  let sess = rawSid ? await auth.verifySession(rawSid, getSessionSecret(c.env)) : null;
  const ctx = await auth.loadContext(db, sess);

  if (rawSid && !ctx.user) {
    c.header('Set-Cookie', auth.clearSessionCookie(c.env), { append: true });
    sess = null;
  } else if (sess && ctx.user && auth.needsRefresh(sess)) {
    const refreshed = auth.createSessionPayload(sess.uid, sess.lid, sess.tv, sess.csrf);
    const token = await auth.signSession(refreshed, getSessionSecret(c.env));
    c.header('Set-Cookie', auth.sessionCookie(token, c.env), { append: true });
    sess = refreshed;
  }

  c.set('sess', ctx.user ? sess : null);
  c.set('ctx', ctx);
  c.set('csrf', ctx.user && sess ? sess.csrf : '');
  await next();
});

// Web CSRF 校验（排除 OpenAPI）
app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/open')) {
    await next();
    return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const body = await bodyOf(c);
    if (!checkCsrf(c, body)) return csrfFail(c);
  }
  await next();
});

// 受保护 R2 附件与头像读取（严格鉴权 + 扩展名白名单 + sandbox CSP）
app.get('/uploads/*', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const key = c.req.path.replace(/^\/+/, '');
  if (!key.startsWith('uploads/') || key.includes('..') || key.includes('\\')) {
    return c.text('Not Found', 404);
  }
  const extMatch = /\.([a-z0-9]+)$/i.exec(key);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const mime = UPLOAD_CONTENT_TYPE[ext];
  if (!mime) return c.text('Forbidden', 403);

  const db = c.get('db');
  const ctx = c.get('ctx');
  if (!key.startsWith('uploads/avatars/')) {
    const att = await db.get<{ ledger_id: number }>('SELECT ledger_id FROM attachments WHERE rel_path = ?', key);
    if (!att) return c.text('Not Found', 404);
    const member = await auth.membership(db, ctx.user!.id, Number(att.ledger_id));
    if (!member) return c.text('Forbidden', 403);
  }

  if (!c.env.ATTACHMENTS) return c.text('Storage Not Configured', 404);
  const obj = await c.env.ATTACHMENTS.get(key);
  if (!obj) return c.text('Not Found', 404);

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || mime);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('Cache-Control', 'private, max-age=86400');
  return new Response(obj.body, { headers });
});

app.route('/', authRoutes);
app.route('/', dashboardRoutes);
app.route('/', txnRoutes);
app.route('/', accountsRoutes);
app.route('/', sessionCardsRoutes);
app.route('/', planningRoutes);
app.route('/', subscriptionsRoutes);
app.route('/', aiRoutes);
app.route('/', reportsRoutes);
app.route('/', adminRoutes);

app.notFound((c) => {
  if (wantsJson(c) || c.req.path.startsWith('/api/')) {
    return c.json({ ok: false, error: '接口不存在' }, 404);
  }
  const ctx = c.get('ctx');
  if (ctx?.user) {
    return c.html(
      layout({
        title: '页面不存在',
        ctx,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce') || '',
        body: '<div class="card"><h2>404 页面不存在</h2><p class="muted mt8">你要访问的页面已移动或不存在。</p><a class="btn btn-primary mt12" href="/">返回总览</a></div>',
      }),
      404,
    );
  }
  return c.html(
    blank({
      title: '页面不存在',
      cspNonce: c.get('cspNonce') || '',
      body: '<h2>404 页面不存在</h2><p class="muted mt8">请检查访问路径是否正确。</p><a class="btn btn-primary mt12" href="/">返回首页</a>',
    }),
    404,
  );
});

app.onError((err, c) => {
  console.error('[worker-error]', err);
  const msg = toPublicError(err);
  if (wantsJson(c) || c.req.path.startsWith('/api/')) {
    return c.json({ ok: false, error: msg }, 500);
  }
  return c.html(
    blank({
      title: '请求处理失败',
      cspNonce: c.get('cspNonce') || '',
      body: `<h2>请求处理失败</h2><p class="muted mt8">${esc(msg)}</p><a class="btn btn-primary mt12" href="/">返回首页</a>`,
    }),
    500,
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const db = makeDb(env);
    ctx.waitUntil(runScheduled(db, env).catch((e) => console.error('scheduled runScheduled failed', e)));
  },
};
