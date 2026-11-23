import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeDb } from '../src/db.js';
import { app } from '../src/index.js';
import { runScheduled } from '../src/lib/scheduler.js';
import type { Env } from '../src/types.js';

type SQLInputValue = null | number | bigint | string | Uint8Array;
interface SqliteStatement {
  all(...params: SQLInputValue[]): unknown[];
  get(...params: SQLInputValue[]): unknown;
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };

function normParam(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  return String(v);
}

function createSqliteD1(sqlite: SqliteDatabase): D1Database {
  const mkStmt = (sql: string, bound: SQLInputValue[] = []) => ({
    bind(...params: unknown[]) {
      return mkStmt(sql, params.map(normParam));
    },
    async all<T = Record<string, unknown>>() {
      const results = sqlite.prepare(sql).all(...bound) as T[];
      return { results, success: true, meta: { duration: 0, changes: 0, last_row_id: 0 } };
    },
    async first<T = Record<string, unknown>>(col?: string) {
      const row = sqlite.prepare(sql).get(...bound) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (col ? row[col] : row) as T;
    },
    async run() {
      const info = sqlite.prepare(sql).run(...bound);
      return {
        results: [],
        success: true,
        meta: {
          duration: 0,
          changes: Number(info.changes),
          last_row_id: Number(info.lastInsertRowid),
        },
      };
    },
    async raw() {
      return [];
    },
  });

  return {
    prepare(sql: string) {
      return mkStmt(sql);
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    withSession() {
      return this;
    },
  } as unknown as D1Database;
}

function createMemoryR2() {
  const store = new Map<string, { data: Uint8Array; httpMetadata?: R2HTTPMetadata; uploaded: Date }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: R2PutOptions) {
      const data =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? new Uint8Array(value)
            : new Uint8Array(value);
      const meta =
        opts?.httpMetadata instanceof Headers
          ? { contentType: opts.httpMetadata.get('content-type') || undefined }
          : opts?.httpMetadata;
      store.set(key, { data, httpMetadata: meta, uploaded: new Date() });
      return { key, size: data.byteLength } as R2Object;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      const bytes = entry.data;
      return {
        key,
        size: bytes.byteLength,
        httpMetadata: entry.httpMetadata,
        uploaded: entry.uploaded,
        body: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(bytes);
            ctrl.close();
          },
        }),
        async text() {
          return new TextDecoder().decode(bytes);
        },
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async list(opts?: R2ListOptions) {
      const prefix = opts?.prefix || '';
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.data.byteLength, uploaded: v.uploaded }) as R2Object);
      return { objects, truncated: false, delimitedPrefixes: [] } as R2Objects;
    },
  } as unknown as R2Bucket;
  return { bucket, store };
}

function setupEnv() {
  const sqlite = new DatabaseSync(':memory:');
  const root = process.cwd();
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0002_seed.sql'), 'utf8'));

  const DB = createSqliteD1(sqlite);
  const { bucket: ATTACHMENTS, store: r2Store } = createMemoryR2();
  const ASSETS = {
    async fetch(req: Request) {
      const p = new URL(req.url).pathname;
      const disk = path.join(root, 'public', p.replace(/^\/+/, ''));
      if (fs.existsSync(disk) && fs.statSync(disk).isFile()) {
        return new Response(fs.readFileSync(disk));
      }
      return new Response('Not Found', { status: 404 });
    },
  } as unknown as Fetcher;

  const env: Env = {
    DB,
    ATTACHMENTS,
    ASSETS,
    SESSION_SECRET: 'e2e-test-session-secret-with-32-bytes',
    COOKIE_SECURE: 'false',
    SITE_NAME: '家账簿测试',
    TZ: 'Asia/Shanghai',
  };
  return { sqlite, env, r2Store };
}

function extractSidCookie(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [res.headers.get('set-cookie') || ''];
  for (const h of list) {
    const m = /hl\.sid=([^;]+)/.exec(h);
    if (m && m[1]) return `hl.sid=${m[1]}`;
  }
  return '';
}

function extractCsrf(html: string): string {
  const m = /<meta name="csrf" content="([^"]+)"/.exec(html);
  return m ? m[1] : '';
}

const PNG_1X1_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('HomeLedger 端到端全链路测试（极简 D1 + 无状态 Cookie + 离线规则 + OpenAPI + Cron）', async () => {
  const { sqlite, env, r2Store } = setupEnv();
  const req = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${p}`, init), env);

  // 1. Schema 与种子数据符合 D1 红线
  const forbidden = ['sessions', 'rate_limits', 'login_attempts', 'audit_logs', 'notification_dedup'];
  for (const tbl of forbidden) {
    const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    assert.equal(exists, undefined, `禁止存在表 ${tbl}`);
  }
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c, 209);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM exchange_rates').get() as { c: number }).c, 10);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c, 10);

  // 2. 健康检查与安全头
  const health = await req('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(health.headers.get('content-security-policy')?.includes("script-src 'self' 'nonce-"));

  // 3. 首次启动自动引导至 /setup
  const rRoot = await req('/', { redirect: 'manual' });
  assert.equal(rRoot.status, 302);
  assert.ok(rRoot.headers.get('location')?.startsWith('/login'));
  const rLogin = await req('/login', { redirect: 'manual' });
  assert.equal(rLogin.status, 302);
  assert.equal(rLogin.headers.get('location'), '/setup');
  assert.equal((await req('/setup')).status, 200);

  // 4. 提交 /setup 初始化管理员、默认账本及 5 个默认账户
  const setupRes = await req('/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'alice',
      display_name: 'Alice',
      password: 'password123',
      password2: 'password123',
      site_name: '我们的家账簿',
    }),
  });
  assert.equal(setupRes.status, 302);
  let cookieHeader = extractSidCookie(setupRes);
  assert.ok(cookieHeader.startsWith('hl.sid='));

  // 5. 获取首页并校验 CSRF + Stitch 设计界面 + 全部 20+ 核心路由 200
  const homeRes = await req('/', { headers: { Cookie: cookieHeader } });
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.ok(homeHtml.includes('我们的家账簿'));
  let csrf = extractCsrf(homeHtml);
  assert.ok(csrf.length >= 16);

  const pages = [
    '/transactions',
    '/transactions/new',
    '/calendar',
    '/search',
    '/notifications',
    '/accounts',
    '/categories',
    '/tags',
    '/budgets',
    '/recurring',
    '/goals',
    '/debts',
    '/subscriptions',
    '/ai',
    '/attachments',
    '/reports',
    '/settings',
    '/ledgers',
    '/members',
    '/import',
    '/export',
    '/admin',
  ];
  for (const p of pages) {
    const res = await req(p, { headers: { Cookie: cookieHeader } });
    assert.equal(res.status, 200, `${p} 应返回 200`);
  }

  // 6. Web CSRF 防护拒绝无令牌提交
  const csrfReject = await req('/transactions', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'expense', amount: '10', account_id: 1 }),
  });
  assert.equal(csrfReject.status, 403);

  // 7. 正常创建一笔支出并校验账户余额联动 + /reports 离线 SVG 渲染
  const createTxnRes = await req('/transactions', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrf,
      type: 'expense',
      amount: '42.50',
      account_id: '1',
      merchant: '全家便利店',
      note: '早餐',
    }),
  });
  assert.equal(createTxnRes.status, 302);
  const acc1 = sqlite.prepare('SELECT balance_cents FROM accounts WHERE id = 1').get() as { balance_cents: number };
  assert.equal(acc1.balance_cents, -4250);

  const reportHtml = await (await req('/reports', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(reportHtml.includes('<svg'), '报表页应渲染离线 SVG 图表');
  assert.ok(reportHtml.includes('42.50'));

  // 8. AI 截图 + 文本离线规则解析 -> 确认入库 -> 附件鉴权读取 -> 删流水同步删 R2
  const analyzeRes = await req('/ai/analyze', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: '午饭 35 元 支付宝',
      images: [{ dataUrl: PNG_1X1_DATA_URL, name: 'receipt.png' }],
    }),
  });
  assert.equal(analyzeRes.status, 200);
  const analyzed = (await analyzeRes.json()) as {
    ok: boolean;
    engine: string;
    items: Array<{ amount_cents: number; draft_id: string; category_id: number | null; account_id: number | null; txn_date: string }>;
    images: Array<{ id: number; rel: string; url: string }>;
  };
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.engine, 'rule');
  assert.equal(analyzed.items[0].amount_cents, 3500);
  assert.equal(analyzed.images.length, 1);
  assert.ok(r2Store.has(analyzed.images[0].rel), 'R2 应持久化账单截图');

  const confirmRes = await req('/ai/confirm', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: analyzed.items,
      image_ids: [analyzed.images[0].id],
      source: 'ai_screenshot',
    }),
  });
  const confirmed = (await confirmRes.json()) as { ok: boolean; created: number; ids: number[] };
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.created, 1);

  const uploadRes = await req(analyzed.images[0].url, { headers: { Cookie: cookieHeader } });
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.headers.get('content-security-policy'), 'sandbox');

  const delRes = await req(`/transactions/${confirmed.ids[0]}/delete`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(delRes.status, 200);
  assert.equal(r2Store.has(analyzed.images[0].rel), false, '删除流水应同步清理 R2 原图');

  // 9. OpenAPI 鉴权 + 记账 + 只读零写校验，以及修改密码后 token_version 吊销全端会话与 API 令牌
  const unauthApi = await req('/api/open/ping');
  assert.equal(unauthApi.status, 401);

  const tokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'TestBot' }),
  });
  assert.equal(tokRes.status, 200);
  assert.equal(tokRes.headers.get('cache-control'), 'no-store');
  const tokData = (await tokRes.json()) as { token: string };
  assert.ok(tokData.token.startsWith('hl_'));

  const pingRes = await req('/api/open/ping', { headers: { Authorization: `Bearer ${tokData.token}` } });
  assert.equal(pingRes.status, 200);

  const openPost = await req('/api/open/transactions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokData.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'income', amount: '100.00', account_id: 2, note: '奖金' }),
  });
  assert.equal(openPost.status, 201);

  const openRecent = await req('/api/open/transactions/recent', {
    headers: { Authorization: `Bearer ${tokData.token}` },
  });
  const recentJson = (await openRecent.json()) as { items: Array<{ note: string }> };
  assert.ok(recentJson.items.some((x) => x.note === '奖金'));

  // 修改密码触发 token_version + 1 与 API Token 吊销
  const oldCookie = cookieHeader;
  const pwdRes = await req('/settings/password', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: oldCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      current_password: 'password123',
      password: 'newpassword123',
      password2: 'newpassword123',
    }),
  });
  assert.equal(pwdRes.status, 302);
  assert.equal((await req('/', { redirect: 'manual', headers: { Cookie: oldCookie } })).status, 302);
  assert.equal((await req('/api/open/ping', { headers: { Authorization: `Bearer ${tokData.token}` } })).status, 401);

  // 新密码登录恢复并执行定时任务
  const reLogin = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'alice', password: 'newpassword123' }),
  });
  assert.equal(reLogin.status, 302);
  cookieHeader = extractSidCookie(reLogin);
  csrf = extractCsrf(await (await req('/', { headers: { Cookie: cookieHeader } })).text());
  assert.ok(csrf.length >= 16);

  const schedRes = await runScheduled(makeDb(env), env);
  assert.equal(typeof schedRes.recurring, 'number');
});
