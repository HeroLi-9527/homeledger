import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeDb } from '../src/db.js';
import { app } from '../src/index.js';
import { getAiConfig } from '../src/lib/ai.js';
import { checkCreditAccounts, checkSessionCards, runScheduled } from '../src/lib/scheduler.js';
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
  const migDir = path.join(root, 'migrations');
  const migFiles = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migFiles) {
    sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }

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

test('P0 回归：AI 配置保存、默认账户兜底、CSV 导入预览、邀请注册与无账本防护', async () => {
  const { sqlite, env } = setupEnv();
  const db = makeDb(env);
  const req = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${p}`, init), env);

  // 初始化管理员 alice（默认开启 site.allow_register = 'false'）
  const setupRes = await req('/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'alice',
      display_name: 'Alice',
      password: 'password123',
      password2: 'password123',
      site_name: '家庭账本',
    }),
  });
  assert.equal(setupRes.status, 302);
  const cookieHeader = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: cookieHeader } })).text();
  const csrf = extractCsrf(homeHtml);

  // 1. AI 配置真值保存与回读
  const aiSaveOn = await req('/settings/ai', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      base_url: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      api_key: 'sk-test-secret-key',
      enabled: '1',
      'ai.vision': '1',
      auto_save: '1',
    }),
  });
  assert.equal(aiSaveOn.status, 302);
  const cfgOn = await getAiConfig(db);
  assert.equal(cfgOn.enabled, true);
  assert.equal(cfgOn.vision, true);
  assert.equal(cfgOn.autoSave, true);
  assert.equal(cfgOn.model, 'gpt-4o-mini');

  const aiSaveOff = await req('/settings/ai', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      base_url: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
    }),
  });
  assert.equal(aiSaveOff.status, 302);
  const cfgOff = await getAiConfig(db);
  assert.equal(cfgOff.enabled, false);
  assert.equal(cfgOff.vision, false);
  assert.equal(cfgOff.autoSave, false);

  // 2. 浮动 AI 助手 (/api/ai/chat) 与 OpenAPI (/api/open/ai/bill) category_path + 默认账户兜底
  const chatRes = await req('/api/ai/chat', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: '午饭 35 元', images: [] }),
  });
  assert.equal(chatRes.status, 200);
  const chatJson = (await chatRes.json()) as {
    ok: boolean;
    created: number;
    items: Array<{ category_path: string; account_id: number | null; amount_cents: number }>;
  };
  assert.equal(chatJson.ok, true);
  assert.equal(chatJson.created, 1);
  assert.equal(chatJson.items[0].category_path, '餐饮/午餐');
  assert.equal(chatJson.items[0].account_id, 1);

  const tokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Bot' }),
  });
  const { token: apiToken } = (await tokRes.json()) as { token: string };

  const openAiRes = await req('/api/open/ai/bill', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '打车 28 元' }),
  });
  assert.equal(openAiRes.status, 200);
  const openAiJson = (await openAiRes.json()) as {
    ok: boolean;
    created: number;
    items: Array<{ category_path: string; account_id: number | null }>;
  };
  assert.equal(openAiJson.ok, true);
  assert.equal(openAiJson.created, 1);
  assert.equal(openAiJson.items[0].category_path, '交通/打车');
  assert.equal(openAiJson.items[0].account_id, 1);

  const acc1AfterAi = sqlite.prepare('SELECT balance_cents FROM accounts WHERE id = 1').get() as { balance_cents: number };
  assert.equal(acc1AfterAi.balance_cents, -6300);

  // 3. CSV 导入预览 guess_category / guess_account 与无账户列默认账户提交
  const csvContent = [
    '交易时间,交易分类,交易对方,商品说明,收/支,金额(元),收/付款方式,当前状态,交易订单号',
    '2026-11-20 12:00:00,餐饮美食,瑞幸咖啡,拿铁咖啡,支出,18.00,支付宝,支付成功,ORD20261120001',
    '2026-11-20 18:00:00,日用百货,路边小店,买水,支出,5.00,,支付成功,ORD20261120002',
  ].join('\n');
  const csvDataUrl = `data:text/csv;base64,${Buffer.from(csvContent, 'utf8').toString('base64')}`;

  const previewRes = await req('/api/import/preview', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dataUrl: csvDataUrl, fileName: 'alipay.csv' }),
  });
  assert.equal(previewRes.status, 200);
  const previewJson = (await previewRes.json()) as {
    ok: boolean;
    token: string;
    count: number;
    sample: Array<{ guess_category: string | null; guess_account: string | null }>;
  };
  assert.equal(previewJson.ok, true);
  assert.equal(previewJson.count, 2);
  assert.equal(previewJson.sample[0].guess_category, '餐饮美食');
  assert.equal(previewJson.sample[0].guess_account, '支付宝');
  assert.equal(previewJson.sample[1].guess_category, '日用百货');

  const commitRes = await req('/api/import/commit', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: previewJson.token, auto_create_account: true }),
  });
  assert.equal(commitRes.status, 200);
  const commitJson = (await commitRes.json()) as { ok: boolean; imported: number; failed: number };
  assert.equal(commitJson.ok, true);
  assert.equal(commitJson.imported, 2);
  assert.equal(commitJson.failed, 0);

  // 4. 关闭自助注册下的邀请注册闭环与管理员建号
  const regClosedHtml = await (await req('/register')).text();
  assert.ok(regClosedHtml.includes('本站未开放自助注册'));

  const inviteRes = await req('/members/invite', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, role: 'member', days: '7' }),
  });
  assert.equal(inviteRes.status, 302);
  const invRow = sqlite.prepare('SELECT code FROM ledger_invites ORDER BY id DESC LIMIT 1').get() as { code: string };
  assert.ok(invRow?.code);

  const joinGet = await req(`/join/${invRow.code}`);
  assert.equal(joinGet.status, 200);
  const joinHtml = await joinGet.text();
  assert.ok(joinHtml.includes(`/join/${invRow.code}/register`));

  const joinReg = await req(`/join/${invRow.code}/register`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'bob',
      display_name: 'Bob',
      password: 'bobpassword',
      password2: 'bobpassword',
    }),
  });
  assert.equal(joinReg.status, 302);
  const bobCookie = extractSidCookie(joinReg);
  assert.ok(bobCookie.startsWith('hl.sid='));
  const bobHome = await req('/', { headers: { Cookie: bobCookie } });
  assert.equal(bobHome.status, 200);
  assert.ok((await bobHome.text()).includes('Alice的账本'));

  // 同一邀请码不可重复注册
  assert.equal((await req(`/join/${invRow.code}`)).status, 410);
  const reusePost = await req(`/join/${invRow.code}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'bob2',
      display_name: 'Bob2',
      password: 'bobpassword',
      password2: 'bobpassword',
    }),
  });
  assert.equal(reusePost.status, 410);

  // 管理员直接在后台新建用户 charlie
  const adminCreateUser = await req('/admin/users', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      username: 'charlie',
      display_name: 'Charlie',
      password: 'charlie123',
    }),
  });
  assert.equal(adminCreateUser.status, 302);

  const charlieLogin = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'charlie', password: 'charlie123' }),
  });
  assert.equal(charlieLogin.status, 302);
  const charlieCookie = extractSidCookie(charlieLogin);
  const charlieHome = await (await req('/', { headers: { Cookie: charlieCookie } })).text();
  assert.ok(charlieHome.includes('Charlie的账本'));
  const charlieCsrf = extractCsrf(charlieHome);

  // 5. 归档用户唯一账本后，无活跃账本访问各页面不触发 500
  const charlieLedger = sqlite
    .prepare("SELECT id FROM ledgers WHERE name = 'Charlie的账本' ORDER BY id DESC LIMIT 1")
    .get() as { id: number };
  const archiveRes = await req(`/ledgers/${charlieLedger.id}/archive`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: charlieCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: charlieCsrf }),
  });
  assert.equal(archiveRes.status, 302);

  const noLedgerHome = await req('/', { headers: { Cookie: charlieCookie } });
  assert.equal(noLedgerHome.status, 200);
  assert.ok((await noLedgerHome.text()).includes('还没有账本'));

  for (const p of [
    '/transactions/deleted',
    '/accounts/1',
    '/session-cards/1',
    '/categories',
    '/tags',
    '/budgets',
    '/recurring',
    '/debts',
    '/goals',
    '/subscriptions',
    '/members',
    '/export',
  ]) {
    const res = await req(p, { redirect: 'manual', headers: { Cookie: charlieCookie } });
    assert.equal(res.status, 302, `${p} 无账本时应安全重定向至 /`);
    assert.equal(res.headers.get('location'), '/');
  }
});

test('Phase 1：账户三层分层、账户编辑、信用额度提醒与次卡全生命周期', async () => {
  const { sqlite, env } = setupEnv();
  const db = makeDb(env);
  const req = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${p}`, init), env);

  // 初始化管理员与账本
  const setupRes = await req('/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'alice',
      display_name: 'Alice',
      password: 'password123',
      password2: 'password123',
      site_name: '家用账本',
    }),
  });
  assert.equal(setupRes.status, 302);
  const cookieHeader = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: cookieHeader } })).text();
  const csrf = extractCsrf(homeHtml);

  // 1. 新建花呗（信用账户）：正数录入当前待还 320.50 -> 后台自动转为 -32050
  const createCreditRes = await req('/accounts', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      _include_in_net_present: '1',
      include_in_net: '1',
      name: '花呗',
      type: 'credit',
      icon: '🟦',
      balance: '320.50',
      currency: 'CNY',
      institution: '支付宝',
      card_no: '9527',
      credit_limit: '10000',
      bill_day: '1',
      due_day: '10',
      note: '日常花呗消费',
    }),
  });
  assert.equal(createCreditRes.status, 302);
  const huabei = sqlite
    .prepare("SELECT * FROM accounts WHERE name = '花呗' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  assert.equal(huabei.type, 'credit');
  assert.equal(huabei.initial_cents, -32050);
  assert.equal(huabei.balance_cents, -32050);
  assert.equal(huabei.credit_limit, 1000000);
  assert.equal(huabei.bill_day, 1);
  assert.equal(huabei.due_day, 10);
  assert.equal(huabei.institution, '支付宝');
  assert.equal(huabei.card_no, '9527');

  // 新建充值账户（储值卡）
  const createPrepaidRes = await req('/accounts', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      _include_in_net_present: '1',
      include_in_net: '1',
      name: '山姆储值卡',
      type: 'prepaid',
      icon: '🎫',
      balance: '500.00',
      currency: 'CNY',
    }),
  });
  assert.equal(createPrepaidRes.status, 302);

  // 验证 /accounts 三层分组展示、去还款链接与详情编辑不改动初始/当前余额
  const accountsHtml = await (await req('/accounts', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(accountsHtml.includes('资金账户'));
  assert.ok(accountsHtml.includes('充值账户与次卡'));
  assert.ok(accountsHtml.includes('信用账户'));
  assert.ok(accountsHtml.includes('待还 320.50'));
  assert.ok(accountsHtml.includes(`/transactions/new?type=transfer&to_account_id=${huabei.id}&amount=320.50`));

  // 验证「去还款」预填转账页不会默认把 account_id 设为目标信用账户且包含 <optgroup>
  const repayNewHtml = await (
    await req(`/transactions/new?type=transfer&to_account_id=${huabei.id}&amount=320.50`, {
      headers: { Cookie: cookieHeader },
    })
  ).text();
  assert.ok(repayNewHtml.includes('<optgroup label="💰 资金账户">'));
  assert.ok(repayNewHtml.includes('<optgroup label="💳 信用账户">'));
  assert.ok(!repayNewHtml.includes(`name="account_id"` + `>` + `<option value="${huabei.id}" selected`));

  // 编辑花呗元数据与额度（保持余额不变）
  const editAccRes = await req(`/accounts/${huabei.id}/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      _include_in_net_present: '1',
      include_in_net: '1',
      name: '蚂蚁花呗',
      type: 'credit',
      icon: '🟦',
      currency: 'CNY',
      institution: '支付宝官方',
      card_no: '6688',
      credit_limit: '15000',
      bill_day: '2',
      due_day: '10',
      note: '提额后备注',
    }),
  });
  assert.equal(editAccRes.status, 302);
  const huabeiEdited = sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(huabei.id)) as Record<string, unknown>;
  assert.equal(huabeiEdited.name, '蚂蚁花呗');
  assert.equal(huabeiEdited.credit_limit, 1500000);
  assert.equal(huabeiEdited.initial_cents, -32050);
  assert.equal(huabeiEdited.balance_cents, -32050);

  // 2. CSV 导入自动识别「京东白条」为 credit 类型
  const csvContent = [
    '交易时间,交易分类,交易对方,商品说明,收/支,金额(元),收/付款方式,当前状态,交易订单号',
    '2026-11-20 12:00:00,日用百货,京东自营,纸巾,支出,59.90,京东白条,支付成功,ORD_BT_001',
  ].join('\n');
  const prevRes = await req('/api/import/preview', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dataUrl: `data:text/csv;base64,${Buffer.from(csvContent, 'utf8').toString('base64')}`,
      fileName: 'jd.csv',
    }),
  });
  const prevJson = (await prevRes.json()) as { token: string };
  await req('/api/import/commit', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: prevJson.token, auto_create_account: true }),
  });
  const baitiao = sqlite
    .prepare("SELECT type, balance_cents FROM accounts WHERE name = '京东白条'")
    .get() as { type: string; balance_cents: number };
  assert.equal(baitiao.type, 'credit');
  assert.equal(baitiao.balance_cents, -5990);

  // 3. 次卡生命周期：开卡联动支出 vs 存量卡补录、核销防超扣、撤销、续费、删除不删流水
  const acc1Before = sqlite.prepare('SELECT balance_cents FROM accounts WHERE id = 1').get() as { balance_cents: number };
  const scCreateRes = await req('/session-cards', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      name: '洗车精洗次卡',
      icon: '🚿',
      merchant: '途虎养车',
      total_sessions: '10',
      total_cost: '500.00',
      purchase_date: '2026-11-01',
      expires_at: '2026-11-28',
      record_expense: '1',
      account_id: '1',
    }),
  });
  assert.equal(scCreateRes.status, 302);
  const acc1AfterCard = sqlite.prepare('SELECT balance_cents FROM accounts WHERE id = 1').get() as { balance_cents: number };
  assert.equal(acc1AfterCard.balance_cents, acc1Before.balance_cents - 50000);

  const washCard = sqlite
    .prepare("SELECT * FROM session_cards WHERE name = '洗车精洗次卡' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; remaining_sessions: number; total_sessions: number; purchase_txn_id: number };
  assert.equal(washCard.remaining_sessions, 10);
  assert.ok(washCard.purchase_txn_id > 0);

  // 补录存量老卡（不勾选 record_expense，剩余次数 < 总次数）
  await req('/session-cards', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      name: '健身私教老卡',
      total_sessions: '20',
      remaining_sessions: '2',
      total_cost: '4000.00',
      purchase_date: '2026-06-01',
      expires_at: '2026-11-20',
    }),
  });
  const acc1AfterOldCard = sqlite.prepare('SELECT balance_cents FROM accounts WHERE id = 1').get() as { balance_cents: number };
  assert.equal(acc1AfterOldCard.balance_cents, acc1AfterCard.balance_cents, '补录存量老卡不应扣减资金账户');

  // 核销 8 次 -> 剩 2 次；再尝试超扣 3 次 -> 400 拒绝且无孤儿核销日志
  const use8 = await req(`/session-cards/${washCard.id}/use`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ count: 8, used_at: '2026-11-22', note: '朋友同行' }),
  });
  assert.equal(use8.status, 200);
  const use8Json = (await use8.json()) as { ok: boolean; logId: number; card: { remaining_sessions: number } };
  assert.equal(use8Json.card.remaining_sessions, 2);

  const overUse = await req(`/session-cards/${washCard.id}/use`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ count: 3 }),
  });
  assert.equal(overUse.status, 400);
  const negLogsCount = (
    sqlite
      .prepare('SELECT COUNT(*) AS c FROM session_card_logs WHERE card_id = ? AND delta < 0')
      .get(washCard.id) as { c: number }
  ).c;
  assert.equal(negLogsCount, 1, '并发/超扣拒绝不得写入孤儿日志');

  // 撤销刚才 8 次核销 -> 回补到 10 次
  const undoRes = await req(`/session-cards/${washCard.id}/logs/${use8Json.logId}/undo`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(undoRes.status, 302);
  const washAfterUndo = sqlite.prepare('SELECT remaining_sessions FROM session_cards WHERE id = ?').get(washCard.id) as {
    remaining_sessions: number;
  };
  assert.equal(washAfterUndo.remaining_sessions, 10);

  // 同卡续费加次（+5次，200元，联动账户1支出）
  const topupRes = await req(`/session-cards/${washCard.id}/topup`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      add_sessions: '5',
      add_cost: '200.00',
      expires_at: '2026-12-31',
      record_expense: '1',
      account_id: '1',
    }),
  });
  assert.equal(topupRes.status, 302);
  const washAfterTopup = sqlite
    .prepare('SELECT total_sessions, remaining_sessions, total_cost_cents FROM session_cards WHERE id = ?')
    .get(washCard.id) as { total_sessions: number; remaining_sessions: number; total_cost_cents: number };
  assert.equal(washAfterTopup.total_sessions, 15);
  assert.equal(washAfterTopup.remaining_sessions, 15);
  assert.equal(washAfterTopup.total_cost_cents, 70000);

  // 4. OpenAPI 账户分层、编辑与次卡接口
  const tokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phase1Bot' }),
  });
  const { token: apiToken } = (await tokRes.json()) as { token: string };

  const openAccGet = await req('/api/open/accounts', { headers: { Authorization: `Bearer ${apiToken}` } });
  const openAccJson = (await openAccGet.json()) as {
    ok: boolean;
    accounts: Array<{ id: number; group: string; credit: { debtCents: number } | null }>;
    groups: { credit_debt_cents: number; prepaid_total_cents: number };
  };
  assert.equal(openAccJson.ok, true);
  assert.equal(openAccJson.groups.prepaid_total_cents, 50000);
  assert.ok(openAccJson.groups.credit_debt_cents >= 32050 + 5990);

  const openPatchAcc = await req(`/api/open/accounts/${huabei.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'API修改备注', credit_limit_cents: 1800000 }),
  });
  assert.equal(openPatchAcc.status, 200);
  const openPatchJson = (await openPatchAcc.json()) as { account: { credit_limit: number; note: string } };
  assert.equal(openPatchJson.account.credit_limit, 1800000);
  assert.equal(openPatchJson.account.note, 'API修改备注');

  const openUseCard = await req(`/api/open/session-cards/${washCard.id}/use`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 2, note: '快捷指令核销' }),
  });
  assert.equal(openUseCard.status, 200);
  const openUseJson = (await openUseCard.json()) as { card: { remaining_sessions: number } };
  assert.equal(openUseJson.card.remaining_sessions, 13);

  const openCreateCard = await req('/api/open/session-cards', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '咖啡周卡', total_sessions: 7, total_cost_cents: 9900 }),
  });
  assert.equal(openCreateCard.status, 201);
  const openListCards = await req('/api/open/session-cards', {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const openListJson = (await openListCards.json()) as { ok: boolean; active_count: number; cards: Array<{ name: string }> };
  assert.equal(openListJson.ok, true);
  assert.ok(openListJson.cards.some((c) => c.name === '咖啡周卡'));

  const detailCardRes = await req(`/session-cards/${washCard.id}`, { headers: { Cookie: cookieHeader } });
  assert.equal(detailCardRes.status, 200);
  const detailCardHtml = await detailCardRes.text();
  assert.ok(detailCardHtml.includes('快捷指令核销'));

  // 5. Cron 提醒：信用还款日前 3 天提醒 + 次卡临期/过期/余次不足提醒（及幂等去重）
  const creditAlerts1 = await checkCreditAccounts(db, '2026-11-08');
  assert.equal(creditAlerts1, 1);
  const creditAlerts2 = await checkCreditAccounts(db, '2026-11-08');
  assert.equal(creditAlerts2, 0, '同周期还款日提醒应幂等去重');

  const scAlerts1 = await checkSessionCards(db, '2026-11-23');
  assert.equal(scAlerts1, 2, '健身老卡应触发已过期仍有余次 + 余次不足 2 条提醒');
  const scAlerts2 = await checkSessionCards(db, '2026-11-23');
  assert.equal(scAlerts2, 0, '次卡提醒应幂等去重');

  // 6. JSON 全库备份与恢复包含 session_cards 与 session_card_logs
  const exportRes = await req('/export/json', { headers: { Cookie: cookieHeader } });
  assert.equal(exportRes.status, 200);
  const dumpJson = (await exportRes.json()) as {
    tables: { session_cards?: unknown[]; session_card_logs?: unknown[] };
  };
  assert.ok((dumpJson.tables.session_cards?.length || 0) >= 2);
  assert.ok((dumpJson.tables.session_card_logs?.length || 0) >= 3);

  const restoreRes = await req('/backup/restore', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'x-csrf-token': csrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ backup: dumpJson }),
  });
  assert.equal(restoreRes.status, 200);
  const restoreJson = (await restoreRes.json()) as { ok: boolean; restored: { session_cards: number } };
  assert.equal(restoreJson.ok, true);
  assert.ok(restoreJson.restored.session_cards >= 2);

  // 7. 删除次卡仅删台账与日志，保留已记账的购卡支出流水
  const delCardRes = await req(`/session-cards/${washCard.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(delCardRes.status, 302);
  const purchaseTxnStillExists = sqlite
    .prepare('SELECT id, deleted_at FROM transactions WHERE id = ?')
    .get(washCard.purchase_txn_id) as { id: number; deleted_at: string | null };
  assert.equal(purchaseTxnStillExists.id, washCard.purchase_txn_id);
  assert.equal(purchaseTxnStillExists.deleted_at, null);

  // 8. 首页总览与次卡详情页面可正常渲染
  const homeAfter = await req('/', { headers: { Cookie: cookieHeader } });
  assert.equal(homeAfter.status, 200);
  const homeAfterHtml = await homeAfter.text();
  assert.ok(homeAfterHtml.includes('账户分层与余额'));
  assert.ok(homeAfterHtml.includes('有效次卡'));
});
