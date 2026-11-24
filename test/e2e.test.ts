import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { makeDb, todayStr } from '../src/db.js';
import { app } from '../src/index.js';
import { getAiConfig } from '../src/lib/ai.js';
import { checkCreditAccounts, checkSessionCards, repairReimbursedLinks, runScheduled } from '../src/lib/scheduler.js';
import { iterateAllForExport } from '../src/lib/txn.js';
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
      sqlite.exec('BEGIN');
      try {
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
        throw err;
      }
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
  let cookieHeader = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: cookieHeader } })).text();
  let csrf = extractCsrf(homeHtml);

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
  let cookieHeader = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: cookieHeader } })).text();
  let csrf = extractCsrf(homeHtml);

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

  // 恢复后全端旧会话强制失效，需重新登录
  const staleAfterRestore = await req('/', { redirect: 'manual', headers: { Cookie: cookieHeader } });
  assert.equal(staleAfterRestore.status, 302);
  const reloginRes = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'alice', password: 'password123' }),
  });
  assert.equal(reloginRes.status, 302);
  cookieHeader = extractSidCookie(reloginRes);
  csrf = extractCsrf(await (await req('/', { headers: { Cookie: cookieHeader } })).text());

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

test('Phase 2（P1 部署前必做）：附件闭环、分页筛选与通知跳转、报表下钻、分类/规划编辑与账本/管理加固', async () => {
  const { sqlite, env, r2Store } = setupEnv();
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
      site_name: 'P1验收账本',
    }),
  });
  assert.equal(setupRes.status, 302);
  let cookieHeader = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: cookieHeader } })).text();
  let csrf = extractCsrf(homeHtml);
  assert.ok(homeHtml.includes('href="/attachments"'), '侧栏应包含 /attachments 入口');

  const pngBuf = Buffer.from(PNG_1X1_DATA_URL.split(',')[1], 'base64');

  // ---- Item 1：交易编辑页附件查看 / JSON 与 multipart 补传 / 6 张上限 / 单删同步删 R2 ----
  const createTxn = await req('/transactions', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'expense',
      amount: '88.00',
      account_id: 1,
      category_id: 1,
      txn_date: '2026-11-23',
      merchant: '附件测试商户',
      note: '测试票据',
    }),
  });
  assert.equal(createTxn.status, 200);
  const { id: txnId } = (await createTxn.json()) as { id: number };

  const editBefore = await (await req(`/transactions/${txnId}/edit`, { headers: { Cookie: cookieHeader } })).text();
  assert.ok(editBefore.includes('凭证与附件'));
  assert.ok(editBefore.includes('0 / 6'));

  // JSON 补传 2 张
  const upJsonRes = await req(`/transactions/${txnId}/attachments`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      images: [
        { dataUrl: PNG_1X1_DATA_URL, name: 'r1.png' },
        { dataUrl: PNG_1X1_DATA_URL, name: 'r2.png' },
      ],
    }),
  });
  assert.equal(upJsonRes.status, 200);
  const upJson = (await upJsonRes.json()) as { ok: boolean; attachments: Array<{ id: number; rel: string }>; total: number };
  assert.equal(upJson.total, 2);
  assert.equal(r2Store.size, 2);

  // multipart/form-data 补传 1 张
  const mpForm = new FormData();
  mpForm.append('_csrf', csrf);
  mpForm.append('files', new File([pngBuf], 'r3.png', { type: 'image/png' }));
  const upMpRes = await req(`/transactions/${txnId}/attachments`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader },
    body: mpForm,
  });
  assert.equal(upMpRes.status, 302);
  assert.equal(upMpRes.headers.get('location'), `/transactions/${txnId}/edit`);
  assert.equal(r2Store.size, 3);

  // 超出 6 张上限应被拒绝且不落盘
  const overRes = await req(`/transactions/${txnId}/attachments`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: [PNG_1X1_DATA_URL, PNG_1X1_DATA_URL, PNG_1X1_DATA_URL, PNG_1X1_DATA_URL] }),
  });
  assert.equal(overRes.status, 400);
  assert.equal(r2Store.size, 3);

  const editMid = await (await req(`/transactions/${txnId}/edit`, { headers: { Cookie: cookieHeader } })).text();
  assert.ok(editMid.includes('3 / 6'));
  assert.ok(editMid.includes(upJson.attachments[0].rel.replace(/^uploads\//, '/uploads/')));

  // 单删 1 张并校验同步删 R2 且回跳编辑页
  const delAttRes = await req(`/attachments/${upJson.attachments[0].id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, back: `/transactions/${txnId}/edit` }),
  });
  assert.equal(delAttRes.status, 302);
  assert.equal(delAttRes.headers.get('location'), `/transactions/${txnId}/edit`);
  assert.equal(r2Store.size, 2);
  assert.equal(r2Store.has(upJson.attachments[0].rel), false);

  const attListHtml = await (await req('/attachments', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(attListHtml.includes(`href="/transactions/${txnId}/edit"`), '附件页应链接到关联流水编辑页');

  // ---- Item 2：/transactions 分页保留筛选、/search 补分页、/notifications 点击与跨账本跳转 ----
  const subCatFood = sqlite.prepare("SELECT id, parent_id FROM categories WHERE parent_id IS NOT NULL AND kind = 'expense' ORDER BY id LIMIT 2").all() as Array<{ id: number; parent_id: number }>;
  const parentCat = sqlite.prepare('SELECT name FROM categories WHERE id = ?').get(subCatFood[0].parent_id) as { name: string };
  for (let i = 0; i < 45; i++) {
    sqlite
      .prepare(
        `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, merchant, created_at, updated_at)
         VALUES (1, 'expense', 1000, 'CNY', 1, 1000, 1, ?, 1, '2026-11-22', '分页测试备注', '分页测试商户', '2026-11-22 10:00:00', '2026-11-22 10:00:00')`,
      )
      .run(i % 2 === 0 ? subCatFood[0].id : subCatFood[1].id);
  }
  const txPageHtml = await (
    await req(`/transactions?kind=expense&category_id=${subCatFood[0].id}&q=${encodeURIComponent('分页测试')}`, {
      headers: { Cookie: cookieHeader },
    })
  ).text();
  // 23 条（45 中偶数条）<= 40，改为不过滤 category_id 触发 45 条分页（> 40）
  const txPagedAllHtml = await (
    await req(`/transactions?kind=expense&q=${encodeURIComponent('分页测试')}`, { headers: { Cookie: cookieHeader } })
  ).text();
  assert.ok(txPagedAllHtml.includes('page=2'), '/transactions 超 40 条应渲染分页');
  assert.ok(txPagedAllHtml.includes('kind=expense') && txPagedAllHtml.includes('q=%E5%88%86%E9%A1%B5%E6%B5%8B%E8%AF%95'), '分页链接应完整保留 kind 与 q');
  assert.ok(txPageHtml.includes('清空筛选'));

  const searchHtml = await (
    await req(`/search?q=${encodeURIComponent('分页测试')}&type=expense`, { headers: { Cookie: cookieHeader } })
  ).text();
  assert.ok(searchHtml.includes('page=2'), '/search 超 30 条应渲染分页');
  assert.ok(searchHtml.includes('type=expense') && searchHtml.includes('q=%E5%88%86%E9%A1%B5%E6%B5%8B%E8%AF%95'));
  const searchP2 = await req(`/search?q=${encodeURIComponent('分页测试')}&type=expense&page=2`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(searchP2.status, 200);
  assert.ok((await searchP2.text()).includes('分页测试商户'));

  // 通知点击跳转：先创建第 2 个账本，并插入跨账本合法通知与危险伪协议通知
  const createL2 = await req('/ledgers', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: '第二账本', kind: 'family', currency: 'CNY' }),
  });
  assert.equal(createL2.status, 302);
  const l2Row = sqlite.prepare("SELECT id FROM ledgers WHERE name = '第二账本'").get() as { id: number };
  // 切回账本 1
  const swBack = await req('/ledgers/switch', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ledger_id: '1' }),
  });
  cookieHeader = extractSidCookie(swBack) || cookieHeader;

  sqlite
    .prepare("INSERT INTO notifications (user_id, ledger_id, kind, title, body, link, created_at) VALUES (1, ?, 'warn', '跨账本预算预警', '查看账本二', '/budgets', '2026-11-23 12:00:00')")
    .run(l2Row.id);
  const nValid = sqlite.prepare("SELECT id FROM notifications WHERE title = '跨账本预算预警'").get() as { id: number };
  sqlite
    .prepare("INSERT INTO notifications (user_id, ledger_id, kind, title, body, link, created_at) VALUES (1, 1, 'info', '伪协议通知', '测试拦截', 'javascript:alert(1)', '2026-11-23 12:00:00')")
    .run();
  const nBad = sqlite.prepare("SELECT id FROM notifications WHERE title = '伪协议通知'").get() as { id: number };

  const notifHtml = await (await req('/notifications', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(notifHtml.includes(`/notifications/${nValid.id}/open`));
  assert.ok(!notifHtml.includes(`/notifications/${nBad.id}/open`), '非法外链/伪协议不应生成跳转入口');

  const openValid = await req(`/notifications/${nValid.id}/open`, { redirect: 'manual', headers: { Cookie: cookieHeader } });
  assert.equal(openValid.status, 302);
  assert.equal(openValid.headers.get('location'), '/budgets');
  const switchedCookie = extractSidCookie(openValid);
  assert.ok(switchedCookie, '打开其他账本通知应重签 Cookie 切换账本');
  const budgetsOnL2 = await (await req('/budgets', { headers: { Cookie: switchedCookie } })).text();
  assert.ok(budgetsOnL2.includes('第二账本'));

  const openBad = await req(`/notifications/${nBad.id}/open`, { redirect: 'manual', headers: { Cookie: switchedCookie } });
  assert.equal(openBad.status, 302);
  assert.equal(openBad.headers.get('location'), '/notifications');

  // 切回账本 1
  const sw1 = await req('/ledgers/switch', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: switchedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ledger_id: '1' }),
  });
  cookieHeader = extractSidCookie(sw1) || switchedCookie;

  // ---- Item 3：/reports 渲染二级分类下钻明细与未分类 ----
  sqlite
    .prepare(
      `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, created_at, updated_at)
       VALUES (1, 'expense', 2500, 'CNY', 1, 2500, 1, NULL, 1, '2026-11-23', '无分类支出', '2026-11-23 12:00:00', '2026-11-23 12:00:00')`,
    )
    .run();
  const reportsAllHtml = await (await req('/reports?month=2026-11', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(reportsAllHtml.includes('二级分类下钻明细'));
  assert.ok(reportsAllHtml.includes('未分类'));
  assert.ok(reportsAllHtml.includes(`category_id=${subCatFood[0].id}`));

  const reportsDrillHtml = await (
    await req(`/reports?month=2026-11&cat=${encodeURIComponent(parentCat.name)}`, { headers: { Cookie: cookieHeader } })
  ).text();
  assert.ok(reportsDrillHtml.includes('查看全部分类'));
  assert.ok(!reportsDrillHtml.includes('<td>🏷️ <b>未分类</b></td>'), '选定大类后不应包含其他大类或未分类');

  const reportsUncatHtml = await (
    await req(`/reports?month=2026-11&cat=${encodeURIComponent('未分类')}`, { headers: { Cookie: cookieHeader } })
  ).text();
  assert.ok(reportsUncatHtml.includes('未分类'));

  // ---- Item 4：二级分类新建/删除、周期/借贷/目标编辑、订阅删除与历史扣费 ----
  // 4.1 分类：新建自定义一级与二级，拦截三级，删子后再删父
  await req('/categories', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, kind: 'expense', name: '养宠测试', icon: '🐾' }),
  });
  const petRoot = sqlite.prepare("SELECT id FROM categories WHERE name = '养宠测试' AND ledger_id = 1").get() as { id: number };
  await req('/categories', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, kind: 'expense', parent_id: String(petRoot.id), name: '宠物零食', icon: '🦴' }),
  });
  const petSub = sqlite.prepare("SELECT id FROM categories WHERE name = '宠物零食' AND parent_id = ?").get(petRoot.id) as { id: number };
  assert.ok(petSub.id > 0);
  // 禁止三级嵌套
  await req('/categories', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, kind: 'expense', parent_id: String(petSub.id), name: '三级禁止' }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM categories WHERE name = '三级禁止'").get(), undefined);
  // 有子分类时禁删一级分类
  await req(`/categories/${petRoot.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.ok(sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(petRoot.id));
  // 删二级再删一级
  await req(`/categories/${petSub.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(petSub.id), undefined);
  await req(`/categories/${petRoot.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(sqlite.prepare('SELECT id FROM categories WHERE id = ?').get(petRoot.id), undefined);

  // 4.2 周期账单编辑
  await req('/recurring', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      name: '旧房租',
      frequency: 'monthly',
      interval_n: '1',
      next_run_at: '2026-12-01',
      item_type: 'expense',
      item_amount: '3000.00',
      item_account_id: '1',
      auto_post: '1',
    }),
  });
  const recRow = sqlite.prepare("SELECT id FROM recurring_rules WHERE name = '旧房租'").get() as { id: number };
  assert.equal((await req(`/recurring/${recRow.id}/edit`, { headers: { Cookie: cookieHeader } })).status, 200);
  await req(`/recurring/${recRow.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      name: '新房租水电',
      frequency: 'monthly',
      interval_n: '1',
      next_run_at: '2026-12-05',
      item_type: 'expense',
      item_amount: '3200.00',
      item_account_id: '1',
      auto_post: '1',
      is_active: '1',
    }),
  });
  const recUpdated = sqlite.prepare('SELECT name, payload FROM recurring_rules WHERE id = ?').get(recRow.id) as { name: string; payload: string };
  assert.equal(recUpdated.name, '新房租水电');
  assert.ok(recUpdated.payload.includes('320000'));

  // 4.3 借贷编辑（手工台账 + 自动汇总保留到期日）
  await req('/debts', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      direction: 'receivable',
      counterparty: '手工张三',
      amount: '500.00',
      due_date: '2026-12-10',
      note: '旧借款',
    }),
  });
  const manualDebt = sqlite.prepare("SELECT id FROM debts WHERE counterparty = '手工张三'").get() as { id: number };
  assert.equal((await req(`/debts/${manualDebt.id}/edit`, { headers: { Cookie: cookieHeader } })).status, 200);
  await req(`/debts/${manualDebt.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      direction: 'receivable',
      counterparty: '手工张三已清',
      principal: '500.00',
      balance: '0',
      due_date: '2026-12-12',
      status: 'open',
      note: '已结清备注',
    }),
  });
  const manualAfter = sqlite.prepare('SELECT counterparty, balance_cents, status FROM debts WHERE id = ?').get(manualDebt.id) as { counterparty: string; balance_cents: number; status: string };
  assert.equal(manualAfter.counterparty, '手工张三已清');
  assert.equal(manualAfter.balance_cents, 0);
  assert.equal(manualAfter.status, 'closed');

  // 联动流水借贷带上 due_date，再编辑 due_date 后再记一笔借出，验证 due_date 不丢失
  await req('/debts', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      direction: 'receivable',
      counterparty: '自动李四',
      amount: '200.00',
      account_id: '1',
      due_date: '2026-12-15',
      create_txn: '1',
    }),
  });
  const autoDebt1 = sqlite
    .prepare("SELECT id, due_date FROM debts WHERE counterparty = '自动李四' AND note = '系统自动汇总'")
    .get() as { id: number; due_date: string | null };
  assert.equal(autoDebt1.due_date, '2026-12-15');
  await req(`/debts/${autoDebt1.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, due_date: '2026-12-20' }),
  });
  await req('/transactions', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'lend', amount: '100.00', account_id: 1, merchant: '自动李四', txn_date: '2026-11-23' }),
  });
  const autoDebt2 = sqlite
    .prepare("SELECT principal_cents, due_date FROM debts WHERE counterparty = '自动李四' AND note = '系统自动汇总'")
    .get() as { principal_cents: number; due_date: string | null };
  assert.equal(autoDebt2.principal_cents, 30000);
  assert.equal(autoDebt2.due_date, '2026-12-20', 'syncDebts 重算应保留已设 due_date');

  // 4.4 储蓄目标编辑
  await req('/goals', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: '旅行基金', target: '2000.00', saved_amount: '500.00' }),
  });
  const goalRow = sqlite.prepare("SELECT id FROM goals WHERE name = '旅行基金'").get() as { id: number };
  assert.equal((await req(`/goals/${goalRow.id}/edit`, { headers: { Cookie: cookieHeader } })).status, 200);
  await req(`/goals/${goalRow.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: '日本旅行基金', icon: '✈️', target: '2000.00', saved_amount: '2000.00' }),
  });
  const goalAfter = sqlite.prepare('SELECT name, status FROM goals WHERE id = ?').get(goalRow.id) as { name: string; status: string };
  assert.equal(goalAfter.name, '日本旅行基金');
  assert.equal(goalAfter.status, 'completed');

  // 4.5 订阅删除按钮、历史扣费记录与删订阅留流水
  const subToday = todayStr();
  await req('/subscriptions', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      name: 'CloudStorage',
      amount: '21.00',
      cycle: 'monthly',
      account_id: '1',
      next_charge_at: subToday,
      status: 'active',
    }),
  });
  const subRow = sqlite.prepare("SELECT id FROM subscriptions WHERE name = 'CloudStorage'").get() as { id: number };
  await req(`/subscriptions/${subRow.id}/charge`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, next_charge_at: subToday }),
  });
  const subTxn = sqlite
    .prepare('SELECT id FROM transactions WHERE subscription_id = ? AND deleted_at IS NULL')
    .get(subRow.id) as { id: number };
  assert.ok(subTxn.id > 0);
  const subsListHtml = await (await req('/subscriptions', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(subsListHtml.includes(`/subscriptions/${subRow.id}/delete`));
  const subEditHtml = await (await req(`/subscriptions/${subRow.id}/edit`, { headers: { Cookie: cookieHeader } })).text();
  assert.ok(subEditHtml.includes('历史扣费记录'));
  assert.ok(subEditHtml.includes(`/transactions/${subTxn.id}/edit`));

  await req(`/subscriptions/${subRow.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(sqlite.prepare('SELECT id FROM subscriptions WHERE id = ?').get(subRow.id), undefined);
  assert.ok(sqlite.prepare('SELECT id FROM transactions WHERE id = ? AND deleted_at IS NULL').get(subTxn.id), '删除订阅应保留历史扣费流水');

  // ---- Item 5：账本改名与级联删除、/admin 重置密码、全库 JSON 恢复加固 ----
  // 5.1 为第二账本填充子表数据、R2 附件、失败导入报告与绑定令牌
  const swL2 = await req('/ledgers/switch', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ledger_id: String(l2Row.id) }),
  });
  const l2Cookie = extractSidCookie(swL2) || cookieHeader;
  const l2Acc = sqlite.prepare('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1').get(l2Row.id) as { id: number };
  const l2TxnRes = await req('/transactions', {
    method: 'POST',
    headers: { Cookie: l2Cookie, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'expense',
      amount: '99.00',
      account_id: l2Acc.id,
      tags: '清账标签',
      splits: [{ member_name: 'Alice', share_cents: 9900 }],
    }),
  });
  const { id: l2TxnId } = (await l2TxnRes.json()) as { id: number };
  const l2AttRes = await req(`/transactions/${l2TxnId}/attachments`, {
    method: 'POST',
    headers: { Cookie: l2Cookie, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: PNG_1X1_DATA_URL, name: 'l2.png' }),
  });
  const l2Att = ((await l2AttRes.json()) as { attachments: Array<{ rel: string }> }).attachments[0];
  await env.ATTACHMENTS.put(`imports/failures-777.json`, '[]');
  sqlite
    .prepare("INSERT INTO import_jobs (id, ledger_id, user_id, source, total, imported, skipped, failed, status, created_at) VALUES (777, ?, 1, 'csv', 15, 0, 0, 15, 'done', '2026-11-23 12:00:00')")
    .run(l2Row.id);
  const l2TokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: l2Cookie, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'L2Token' }),
  });
  const { token: l2ApiToken } = (await l2TokRes.json()) as { token: string };

  // 改名第二账本
  assert.equal((await req(`/ledgers/${l2Row.id}/edit`, { headers: { Cookie: l2Cookie } })).status, 200);
  await req(`/ledgers/${l2Row.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: l2Cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, name: '改名后账本', icon: '🏠', kind: 'family' }),
  });
  assert.equal((sqlite.prepare('SELECT name FROM ledgers WHERE id = ?').get(l2Row.id) as { name: string }).name, '改名后账本');

  // 名称不匹配时拦截删除
  const delWrong = await req(`/ledgers/${l2Row.id}/delete`, {
    method: 'POST',
    headers: { Cookie: l2Cookie, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_name: '写错的名字' }),
  });
  assert.equal(delWrong.status, 400);
  assert.ok(sqlite.prepare('SELECT id FROM ledgers WHERE id = ?').get(l2Row.id));

  // 名称匹配时级联删除全子表 + R2 + 吊销令牌并切回账本 1
  const delRight = await req(`/ledgers/${l2Row.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: l2Cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, confirm_name: '改名后账本' }),
  });
  assert.equal(delRight.status, 302);
  cookieHeader = extractSidCookie(delRight) || cookieHeader;
  assert.equal(sqlite.prepare('SELECT id FROM ledgers WHERE id = ?').get(l2Row.id), undefined);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?').get(l2Row.id) as { c: number }).c, 0);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM splits WHERE ledger_id = ?').get(l2Row.id) as { c: number }).c, 0);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM transaction_tags WHERE transaction_id = ?').get(l2TxnId) as { c: number }).c, 0);
  assert.equal(r2Store.has(l2Att.rel), false, '删账本应同步删 R2 附件');
  assert.equal(r2Store.has('imports/failures-777.json'), false, '删账本应同步删 R2 失败报告');
  const pingRevoked = await req('/api/open/ping', { headers: { Authorization: `Bearer ${l2ApiToken}` } });
  assert.equal(pingRevoked.status, 401, '绑定被删账本的 API 令牌应自动吊销');

  // 5.2 /admin 重置密码（no-store 一次性结果页 + 旧会话/令牌即时失效）
  await req('/admin/users', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'bob', display_name: 'Bob', password: 'oldpass123' }),
  });
  const bobUser = sqlite.prepare('SELECT id FROM users WHERE username = ?').get('bob') as { id: number };
  const bobLogin = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'bob', password: 'oldpass123' }),
  });
  const bobCookie = extractSidCookie(bobLogin);
  const adminHtml = await (await req('/admin', { headers: { Cookie: cookieHeader } })).text();
  assert.ok(adminHtml.includes('重置密码'));

  const resetRes = await req(`/admin/users/${bobUser.id}`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, action: 'reset_password', password: 'newpass999' }),
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.headers.get('cache-control'), 'no-store');
  const resetHtml = await resetRes.text();
  assert.ok(resetHtml.includes('newpass999'));
  assert.equal((resetRes.headers.get('set-cookie') || '').includes('newpass999'), false, '新密码不得写入 Set-Cookie');

  // Bob 旧 Cookie 失效，新密码可登录
  assert.equal((await req('/', { redirect: 'manual', headers: { Cookie: bobCookie } })).status, 302);
  const bobRelogin = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'bob', password: 'newpass999' }),
  });
  assert.equal(bobRelogin.status, 302);

  // 5.3 /backup/restore 坏包零污染拒绝 + 合法包原子恢复与强制重登
  const validDump = (await (await req('/export/json', { headers: { Cookie: cookieHeader } })).json()) as {
    app: string;
    version: number;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  const txnCountBefore = (sqlite.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;

  // 缺少必填字段的坏备份应被前置拦截，不清空现有数据
  const badBackup = structuredClone(validDump);
  delete badBackup.tables.categories[0].name;
  const badRestoreRes = await req('/backup/restore', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: badBackup }),
  });
  assert.equal(badRestoreRes.status, 400);
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c,
    txnCountBefore,
    '失败的备份恢复不得影响现有库记录',
  );

  // 合法恢复成功且全端旧 Cookie 失效
  const goodRestoreRes = await req('/backup/restore', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'x-csrf-token': csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: validDump }),
  });
  assert.equal(goodRestoreRes.status, 200);
  assert.equal((await req('/', { redirect: 'manual', headers: { Cookie: cookieHeader } })).status, 302);
  const finalLogin = await req('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'alice', password: 'password123' }),
  });
  assert.equal(finalLogin.status, 302);
  cookieHeader = extractSidCookie(finalLogin);
  csrf = extractCsrf(await (await req('/', { headers: { Cookie: cookieHeader } })).text());

  // 5.4 允许删除最后一个账本并安全进入零账本引导态
  const delLast = await req('/ledgers/1/delete', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, confirm_name: 'Alice的账本' }),
  });
  assert.equal(delLast.status, 302);
  const lastCookie = extractSidCookie(delLast) || cookieHeader;
  const zeroLedgerHome = await req('/', { headers: { Cookie: lastCookie } });
  assert.equal(zeroLedgerHome.status, 200);
  assert.ok((await zeroLedgerHome.text()).includes('还没有账本'));
});

test('未配置 SESSION_SECRET 时返回 503 友好配置引导页且阻止半初始化', async () => {
  for (const badSecret of ['', 'short-secret']) {
    const { sqlite, env } = setupEnv();
    env.SESSION_SECRET = badSecret;
    const req = (p: string, init: RequestInit = {}) =>
      app.fetch(new Request(`http://localhost${p}`, init), env);

    const homeRes = await req('/');
    assert.equal(homeRes.status, 503);
    const homeHtml = await homeRes.text();
    assert.ok(homeHtml.includes('SESSION_SECRET'));
    assert.ok(homeHtml.includes('Variables and Secrets'));

    const setupGetRes = await req('/setup');
    assert.equal(setupGetRes.status, 503);
    assert.ok((await setupGetRes.text()).includes('SESSION_SECRET'));

    const setupPostRes = await req('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
      body: new URLSearchParams({
        username: 'alice',
        display_name: 'Alice',
        password: 'password123',
        password2: 'password123',
        site_name: '测试账簿',
      }),
    });
    assert.equal(setupPostRes.status, 503);
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c, 0);

    const jsonRes = await req('/', { headers: { Accept: 'application/json' } });
    assert.equal(jsonRes.status, 503);
    const jsonBody = (await jsonRes.json()) as { ok: boolean; error: string };
    assert.equal(jsonBody.ok, false);
    assert.ok(jsonBody.error.includes('SESSION_SECRET'));

    const healthRes = await req('/healthz');
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { ok: boolean };
    assert.equal(healthBody.ok, true);
  }
});

test('OpenAPI 全资源 CRUD、业务动作与权限/跨账本隔离回归', async () => {
  const { sqlite, env } = setupEnv();
  const req = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${p}`, init), env);
  const api = (p: string, token: string, method = 'GET', body?: unknown) =>
    req(`/api/open${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  // 1. 初始化管理员 alice（账本 1）并创建令牌
  const setupRes = await req('/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'alice',
      display_name: 'Alice',
      password: 'password123',
      password2: 'password123',
      site_name: 'OpenAPI 回归',
    }),
  });
  assert.equal(setupRes.status, 302);
  const aliceCookie = extractSidCookie(setupRes);
  const aliceCsrf = extractCsrf(await (await req('/', { headers: { Cookie: aliceCookie } })).text());

  const aliceTokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AliceL1' }),
  });
  const { token: aliceToken } = (await aliceTokRes.json()) as { token: string };

  // 2. 邀请 bob 作为账本 1 的只读成员（viewer），再让 bob 自建账本 2（alice 无权访问）
  await req('/members/invite', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, role: 'viewer', days: '7' }),
  });
  const invRow = sqlite.prepare('SELECT code FROM ledger_invites ORDER BY id DESC LIMIT 1').get() as { code: string };
  const bobJoinRes = await req(`/join/${invRow.code}/register`, {
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
  const bobL1Cookie = extractSidCookie(bobJoinRes);
  const bobL1Csrf = extractCsrf(await (await req('/', { headers: { Cookie: bobL1Cookie } })).text());
  const viewerTokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: bobL1Cookie, 'x-csrf-token': bobL1Csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'BobViewerL1' }),
  });
  const { token: viewerToken } = (await viewerTokRes.json()) as { token: string };

  const bobNewLedger = await req('/ledgers', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: bobL1Cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: bobL1Csrf, name: 'Bob私账', kind: 'personal', currency: 'CNY' }),
  });
  const bobL2Cookie = extractSidCookie(bobNewLedger);
  const bobL2Csrf = extractCsrf(await (await req('/', { headers: { Cookie: bobL2Cookie } })).text());
  const bobL2TokRes = await req('/settings/api-tokens', {
    method: 'POST',
    headers: { Cookie: bobL2Cookie, 'x-csrf-token': bobL2Csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'BobOwnerL2' }),
  });
  const { token: bobL2Token } = (await bobL2TokRes.json()) as { token: string };

  // 3. 只读角色（viewer）读 200、全写 403
  for (const getPath of [
    '/accounts',
    '/accounts/1',
    '/session-cards',
    '/categories',
    '/categories/1',
    '/tags',
    '/budgets',
    '/recurring',
    '/subscriptions',
    '/debts',
    '/loans',
    '/goals',
  ]) {
    assert.equal((await api(getPath, viewerToken, 'GET')).status, 200, `viewer GET ${getPath} 应返回 200`);
  }
  for (const [m, p] of [
    ['POST', '/accounts'],
    ['PATCH', '/accounts/1'],
    ['POST', '/accounts/1/archive'],
    ['POST', '/accounts/1/adjust'],
    ['DELETE', '/accounts/1'],
    ['POST', '/session-cards'],
    ['PATCH', '/session-cards/1'],
    ['POST', '/session-cards/1/archive'],
    ['DELETE', '/session-cards/1'],
    ['POST', '/categories'],
    ['PATCH', '/categories/1'],
    ['DELETE', '/categories/1'],
    ['POST', '/tags'],
    ['PATCH', '/tags/1'],
    ['DELETE', '/tags/1'],
    ['POST', '/budgets'],
    ['PATCH', '/budgets/1'],
    ['DELETE', '/budgets/1'],
    ['POST', '/recurring'],
    ['PATCH', '/recurring/1'],
    ['POST', '/recurring/1/run'],
    ['DELETE', '/recurring/1'],
    ['POST', '/subscriptions'],
    ['PATCH', '/subscriptions/1'],
    ['POST', '/subscriptions/1/charge'],
    ['POST', '/subscriptions/1/skip'],
    ['DELETE', '/subscriptions/1'],
    ['POST', '/debts'],
    ['PATCH', '/debts/1'],
    ['POST', '/debts/1/settle'],
    ['DELETE', '/debts/1'],
    ['POST', '/loans'],
    ['PATCH', '/loans/1'],
    ['POST', '/loans/1/settle'],
    ['DELETE', '/loans/1'],
    ['POST', '/goals'],
    ['PATCH', '/goals/1'],
    ['POST', '/goals/1/deposit'],
    ['DELETE', '/goals/1'],
  ] as const) {
    assert.equal((await api(p, viewerToken, m, {})).status, 403, `viewer ${m} ${p} 应返回 403`);
  }

  // 4. Accounts CRUD + 归档 + 余额校准 + 删除校验
  const acc1Get = await api('/accounts/1', aliceToken);
  assert.equal(acc1Get.status, 200);
  assert.equal(((await acc1Get.json()) as { account: { group: string } }).account.group, 'funds');

  const accCreate = await api('/accounts', aliceToken, 'POST', { name: '招商储蓄卡', type: 'debit', balance: '100.00' });
  assert.equal(accCreate.status, 201);
  const accId = ((await accCreate.json()) as { id: number }).id;

  const adjZero = (await (await api(`/accounts/${accId}/adjust`, aliceToken, 'POST', { actual_balance_cents: 10000 })).json()) as {
    ok: boolean;
    adjusted: boolean;
    diff_cents: number;
    transaction: unknown;
  };
  assert.equal(adjZero.adjusted, false);
  assert.equal(adjZero.diff_cents, 0);
  assert.equal(adjZero.transaction, null);

  const adjUp = (await (await api(`/accounts/${accId}/adjust`, aliceToken, 'POST', { actual_balance: '150.50' })).json()) as {
    ok: boolean;
    adjusted: boolean;
    diff_cents: number;
    account: { balance_cents: number };
    transaction: { id: number; type: string };
  };
  assert.equal(adjUp.adjusted, true);
  assert.equal(adjUp.diff_cents, 5050);
  assert.equal(adjUp.account.balance_cents, 15050);
  assert.equal(adjUp.transaction.type, 'adjust');

  const accPatchArch = (await (await api(`/accounts/${accId}`, aliceToken, 'PATCH', { is_archived: true })).json()) as {
    account: { is_archived: number };
  };
  assert.equal(accPatchArch.account.is_archived, 1);
  const accActiveList = (await (await api('/accounts', aliceToken)).json()) as { accounts: Array<{ id: number }> };
  assert.equal(accActiveList.accounts.some((a) => a.id === accId), false);
  const accAllList = (await (await api('/accounts?include_archived=1', aliceToken)).json()) as { accounts: Array<{ id: number }> };
  assert.equal(accAllList.accounts.some((a) => a.id === accId), true);

  assert.equal((await api(`/accounts/${accId}/adjust`, aliceToken, 'POST', { actual_balance: '200' })).status, 400);
  const accUnarch = (await (await api(`/accounts/${accId}/archive`, aliceToken, 'POST')).json()) as {
    account: { is_archived: number };
  };
  assert.equal(accUnarch.account.is_archived, 0);

  assert.equal((await api(`/accounts/${accId}`, aliceToken, 'DELETE')).status, 400, '有流水账户禁删');
  assert.equal((await api(`/transactions/${adjUp.transaction.id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/accounts/${accId}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/accounts/${accId}`, aliceToken)).status, 404);

  // 5. Session Cards PATCH / archive / DELETE（保留购卡流水）
  const scRes = await api('/session-cards', aliceToken, 'POST', {
    name: '理发次卡',
    total_sessions: 5,
    total_cost: '250.00',
    record_expense: true,
    account_id: 1,
  });
  assert.equal(scRes.status, 201);
  const scJson = (await scRes.json()) as { id: number; card: { purchase_txn_id: number } };
  const scPatch = (await (
    await api(`/session-cards/${scJson.id}`, aliceToken, 'PATCH', {
      name: '理发VIP卡',
      note: '周末可用',
      total_cost_cents: 30000,
      is_archived: true,
    })
  ).json()) as { card: { name: string; total_cost_cents: number; is_archived: number } };
  assert.equal(scPatch.card.name, '理发VIP卡');
  assert.equal(scPatch.card.total_cost_cents, 30000);
  assert.equal(scPatch.card.is_archived, 1);

  const scArchToggle = (await (await api(`/session-cards/${scJson.id}/archive`, aliceToken, 'POST')).json()) as {
    card: { is_archived: number };
  };
  assert.equal(scArchToggle.card.is_archived, 0);
  assert.equal((await api(`/session-cards/${scJson.id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/transactions/${scJson.card.purchase_txn_id}`, aliceToken)).status, 200, '删卡保留购卡流水');

  // 6. Categories CRUD
  const catRootRes = await api('/categories', aliceToken, 'POST', { name: '养宠', kind: 'expense', icon: '🐾' });
  assert.equal(catRootRes.status, 201);
  const catRootId = ((await catRootRes.json()) as { id: number }).id;

  const catSubRes = await api('/categories', aliceToken, 'POST', { name: '猫粮', parent_id: catRootId });
  assert.equal(catSubRes.status, 201);
  const catSubJson = (await catSubRes.json()) as { id: number; category: { kind: string; path: string } };
  assert.equal(catSubJson.category.kind, 'expense');
  assert.equal(catSubJson.category.path, '养宠/猫粮');

  assert.equal((await api('/categories', aliceToken, 'POST', { name: '三级', parent_id: catSubJson.id })).status, 400);
  assert.equal((await api(`/categories/${catSubJson.id}`, aliceToken)).status, 200);
  const catPatch = (await (
    await api(`/categories/${catSubJson.id}`, aliceToken, 'PATCH', { name: '主食猫粮', icon: '🐟' })
  ).json()) as { category: { path: string; icon: string } };
  assert.equal(catPatch.category.path, '养宠/主食猫粮');
  assert.equal((await api('/categories/1', aliceToken, 'PATCH', { name: '改系统' })).status, 400);
  assert.equal((await api(`/categories/${catRootId}`, aliceToken, 'DELETE')).status, 400);

  const catTxn = (await (
    await api('/transactions', aliceToken, 'POST', { type: 'expense', amount: '50', account_id: 1, category_id: catSubJson.id })
  ).json()) as { id: number };
  assert.equal((await api(`/categories/${catSubJson.id}`, aliceToken, 'DELETE')).status, 400);
  assert.equal((await api(`/transactions/${catTxn.id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/categories/${catSubJson.id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/categories/${catRootId}`, aliceToken, 'DELETE')).status, 200);

  // 7. Tags CRUD
  const tag1Res = await api('/tags', aliceToken, 'POST', { name: '出差', color: '#2563EB' });
  assert.equal(tag1Res.status, 201);
  const tag1Id = ((await tag1Res.json()) as { id: number }).id;
  assert.equal((await api('/tags', aliceToken, 'POST', { name: '出差' })).status, 409);

  await api('/tags', aliceToken, 'POST', { name: '日常' });
  assert.equal((await api(`/tags/${tag1Id}`, aliceToken, 'PATCH', { name: '日常' })).status, 409);
  const tagPatch = (await (
    await api(`/tags/${tag1Id}`, aliceToken, 'PATCH', { name: '商旅', color: '#0F766E' })
  ).json()) as { tag: { name: string; color: string } };
  assert.equal(tagPatch.tag.name, '商旅');

  await api('/transactions', aliceToken, 'POST', { type: 'expense', amount: '20', account_id: 1, tags: '商旅' });
  const tagGet = (await (await api(`/tags/${tag1Id}`, aliceToken)).json()) as { tag: { cnt: number } };
  assert.equal(tagGet.tag.cnt, 1);
  assert.equal((await api(`/tags/${tag1Id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS c FROM transaction_tags WHERE tag_id = ?').get(tag1Id) as { c: number }).c,
    0,
  );

  // 8. Budgets CRUD
  const expCat = sqlite.prepare("SELECT id FROM categories WHERE kind = 'expense' LIMIT 1").get() as { id: number };
  assert.equal(
    (await api('/budgets', aliceToken, 'POST', { name: '坏自定义', period: 'custom', amount: '100' })).status,
    400,
  );
  const budCreate = await api('/budgets', aliceToken, 'POST', {
    name: '月度餐饮预算',
    scope: 'category',
    category_id: expCat.id,
    period: 'monthly',
    amount: '1500.00',
    rollover: true,
    alert_pct: 85,
  });
  assert.equal(budCreate.status, 201);
  const budId = ((await budCreate.json()) as { id: number }).id;
  assert.equal((await api(`/budgets/${budId}`, aliceToken)).status, 200);
  const budPatch = (await (
    await api(`/budgets/${budId}`, aliceToken, 'PATCH', { amount_cents: 200000, is_active: false })
  ).json()) as { budget: { amount_cents: number; is_active: number } };
  assert.equal(budPatch.budget.amount_cents, 200000);
  assert.equal(budPatch.budget.is_active, 0);

  const budDefList = (await (await api('/budgets', aliceToken)).json()) as { budgets: Array<{ id: number }> };
  assert.equal(budDefList.budgets.some((b) => b.id === budId), false);
  const budAllList = (await (await api('/budgets?include_inactive=1', aliceToken)).json()) as { budgets: Array<{ id: number }> };
  assert.equal(budAllList.budgets.some((b) => b.id === budId), true);
  assert.equal((await api(`/budgets/${budId}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/budgets/${budId}`, aliceToken)).status, 404);

  // 9. Recurring CRUD + /run + 409 防重
  const recCreate = await api('/recurring', aliceToken, 'POST', {
    name: '房租物业',
    frequency: 'monthly',
    interval_n: 1,
    next_run_at: todayStr(),
    items: [
      { type: 'expense', amount: '2500.00', account_id: 1, note: '房租' },
      { type: 'expense', amount_cents: 15000, account_id: 1, note: '物业' },
    ],
  });
  assert.equal(recCreate.status, 201);
  const recJson = (await recCreate.json()) as { id: number; recurring: { next_run_at: string; items: unknown[] } };
  assert.equal(recJson.recurring.items.length, 2);

  const recGet = (await (await api(`/recurring/${recJson.id}`, aliceToken)).json()) as {
    recurring: { payload: string; items: unknown[] };
  };
  assert.ok(typeof recGet.recurring.payload === 'string' && recGet.recurring.items.length === 2);
  assert.equal((await api(`/recurring/${recJson.id}`, aliceToken, 'PATCH', { name: '新房租物业' })).status, 200);

  const recPeriod = recJson.recurring.next_run_at;
  const recRun = (await (await api(`/recurring/${recJson.id}/run`, aliceToken, 'POST', {})).json()) as {
    ok: boolean;
    created: number;
    next_run_at: string;
  };
  assert.equal(recRun.created, 2);
  assert.notEqual(recRun.next_run_at, recPeriod);
  assert.equal((await api(`/recurring/${recJson.id}/run`, aliceToken, 'POST', { next_run_at: recPeriod })).status, 409);
  assert.equal((await api(`/recurring/${recJson.id}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/recurring/${recJson.id}`, aliceToken)).status, 404);

  // 10. Subscriptions CRUD + /charge + /skip + DELETE 留流水
  assert.equal(
    (await api('/subscriptions', aliceToken, 'POST', { name: '缺结束日试用', status: 'trial', amount: '30' })).status,
    400,
  );
  const subCreate = await api('/subscriptions', aliceToken, 'POST', {
    name: 'Notion Plus',
    amount: '68.00',
    cycle: 'monthly',
    account_id: 1,
    next_charge_at: todayStr(),
    status: 'active',
  });
  assert.equal(subCreate.status, 201);
  const subId = ((await subCreate.json()) as { id: number }).id;

  const subCancel = (await (await api(`/subscriptions/${subId}`, aliceToken, 'PATCH', { status: 'canceled' })).json()) as {
    subscription: { status: string; canceled_at: string | null };
  };
  assert.equal(subCancel.subscription.status, 'canceled');
  assert.ok(subCancel.subscription.canceled_at);
  assert.equal((await api(`/subscriptions/${subId}/charge`, aliceToken, 'POST', {})).status, 400);

  const subReactivate = (await (
    await api(`/subscriptions/${subId}`, aliceToken, 'PATCH', { status: 'active', next_charge_at: todayStr() })
  ).json()) as { subscription: { status: string; canceled_at: string | null; next_charge_at: string } };
  assert.equal(subReactivate.subscription.status, 'active');
  assert.equal(subReactivate.subscription.canceled_at, null);

  const subPeriod = subReactivate.subscription.next_charge_at;
  const subCharge = (await (await api(`/subscriptions/${subId}/charge`, aliceToken, 'POST', {})).json()) as {
    transaction_id: number;
    next_charge_at: string;
  };
  assert.ok(subCharge.transaction_id > 0);
  assert.equal((await api(`/subscriptions/${subId}/charge`, aliceToken, 'POST', { next_charge_at: subPeriod })).status, 409);

  const subSkip = (await (await api(`/subscriptions/${subId}/skip`, aliceToken, 'POST', {})).json()) as {
    skipped_date: string;
    next_charge_at: string;
  };
  assert.equal(subSkip.skipped_date, subCharge.next_charge_at);
  assert.notEqual(subSkip.next_charge_at, subCharge.next_charge_at);

  const subDetail = (await (await api(`/subscriptions/${subId}`, aliceToken)).json()) as { charges: unknown[] };
  assert.equal(subDetail.charges.length, 1);
  assert.equal((await api(`/subscriptions/${subId}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/transactions/${subCharge.transaction_id}`, aliceToken)).status, 200, '删订阅保留历史扣费流水');

  // 11. Debts & /loans CRUD + /settle + 自动汇总保护
  const debtCreate = await api('/debts', aliceToken, 'POST', {
    direction: 'receivable',
    counterparty: '王五',
    principal: '500.00',
    account_id: 1,
    due_date: '2026-12-31',
  });
  assert.equal(debtCreate.status, 201);
  const debtId = ((await debtCreate.json()) as { id: number }).id;
  assert.equal((await api(`/loans/${debtId}`, aliceToken)).status, 200);
  assert.equal((await api(`/loans/${debtId}`, aliceToken, 'PATCH', { note: '朋友借款', balance_cents: 40000 })).status, 200);

  const settle1 = (await (
    await api(`/debts/${debtId}/settle`, aliceToken, 'POST', { amount: '150.00', account_id: 1 })
  ).json()) as { debt: { balance_cents: number; status: string } };
  assert.equal(settle1.debt.balance_cents, 25000);
  assert.equal(settle1.debt.status, 'open');

  const settle2 = (await (await api(`/loans/${debtId}/settle`, aliceToken, 'POST', { account_id: 1 })).json()) as {
    debt: { balance_cents: number; status: string };
  };
  assert.equal(settle2.debt.balance_cents, 0);
  assert.equal(settle2.debt.status, 'closed');
  assert.equal((await api(`/debts/${debtId}`, aliceToken, 'DELETE')).status, 200);

  const autoDebtCreate = await api('/loans', aliceToken, 'POST', {
    direction: 'payable',
    counterparty: '赵六',
    amount: '800.00',
    account_id: 1,
    create_txn: true,
    due_date: '2026-12-20',
  });
  assert.equal(autoDebtCreate.status, 201);
  const autoDebt = ((await autoDebtCreate.json()) as { id: number; debt: { note: string; due_date: string } }).debt;
  const autoDebtId = (autoDebt as unknown as { id: number }).id;
  assert.equal(autoDebt.note, '系统自动汇总');
  assert.equal(autoDebt.due_date, '2026-12-20');

  assert.equal((await api(`/debts/${autoDebtId}`, aliceToken, 'PATCH', { principal: '100' })).status, 400);
  const autoPatchDue = (await (
    await api(`/debts/${autoDebtId}`, aliceToken, 'PATCH', { due_date: '2026-12-25' })
  ).json()) as { debt: { due_date: string } };
  assert.equal(autoPatchDue.debt.due_date, '2026-12-25');
  assert.equal((await api(`/debts/${autoDebtId}`, aliceToken, 'DELETE')).status, 400);

  const autoSettle = (await (await api(`/loans/${autoDebtId}/settle`, aliceToken, 'POST', { account_id: 1 })).json()) as {
    ok: boolean;
    debt: { balance_cents: number; status: string; note: string };
  };
  assert.equal(autoSettle.ok, true);
  assert.equal(autoSettle.debt.balance_cents, 0);
  assert.equal(autoSettle.debt.status, 'closed');
  assert.equal(autoSettle.debt.note, '系统自动汇总');

  // 12. Goals CRUD + /deposit（存取与达标通知）
  const goalCreate = await api('/goals', aliceToken, 'POST', {
    name: '购车基金',
    target: '1000.00',
    saved_amount: '200.00',
    account_id: 1,
  });
  assert.equal(goalCreate.status, 201);
  const goalId = ((await goalCreate.json()) as { id: number }).id;
  assert.equal((await api(`/goals/${goalId}`, aliceToken)).status, 200);
  assert.equal((await api(`/goals/${goalId}`, aliceToken, 'PATCH', { name: '新能源购车基金', target_cents: 100000 })).status, 200);

  const gWithdraw = (await (await api(`/goals/${goalId}/deposit`, aliceToken, 'POST', { amount: '-50.00' })).json()) as {
    goal: { saved_cents: number };
    transaction_id: number | null;
  };
  assert.equal(gWithdraw.goal.saved_cents, 15000);
  assert.equal(gWithdraw.transaction_id, null);

  const gComplete = (await (
    await api(`/goals/${goalId}/deposit`, aliceToken, 'POST', { amount: '850.00', create_txn: true })
  ).json()) as {
    goal: { saved_cents: number; status: string };
    transaction_id: number;
  };
  assert.equal(gComplete.goal.saved_cents, 100000);
  assert.equal(gComplete.goal.status, 'completed');
  assert.ok(gComplete.transaction_id > 0);
  assert.ok(
    sqlite.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(`goal-done:${goalId}`),
    '储蓄目标达标应推送通知',
  );
  assert.equal((await api(`/goals/${goalId}`, aliceToken, 'DELETE')).status, 200);
  assert.equal((await api(`/goals/${goalId}`, aliceToken)).status, 404);

  // 13. 跨账本隔离（账本 1 令牌读写/删除/引用账本 2 资源均被拦截）
  const l2AccId = ((await (await api('/accounts', bobL2Token, 'POST', { name: 'L2账户', type: 'cash' })).json()) as { id: number }).id;
  const l2ScId = ((await (await api('/session-cards', bobL2Token, 'POST', { name: 'L2卡', total_sessions: 3 })).json()) as { id: number }).id;
  const l2CatId = ((await (await api('/categories', bobL2Token, 'POST', { name: 'L2分类', kind: 'expense' })).json()) as { id: number }).id;
  const l2TagId = ((await (await api('/tags', bobL2Token, 'POST', { name: 'L2标签' })).json()) as { id: number }).id;
  const l2BudId = ((await (await api('/budgets', bobL2Token, 'POST', { name: 'L2预算', amount: '100' })).json()) as { id: number }).id;
  const l2RecId = (
    (await (
      await api('/recurring', bobL2Token, 'POST', {
        name: 'L2周期',
        items: [{ type: 'expense', amount: '10', account_id: l2AccId }],
      })
    ).json()) as { id: number }
  ).id;
  const l2SubId = ((await (await api('/subscriptions', bobL2Token, 'POST', { name: 'L2订阅', amount: '10', account_id: l2AccId })).json()) as { id: number }).id;
  const l2DebtId = ((await (await api('/debts', bobL2Token, 'POST', { counterparty: 'L2某人', principal: '50' })).json()) as { id: number }).id;
  const l2GoalId = ((await (await api('/goals', bobL2Token, 'POST', { name: 'L2目标', target: '100' })).json()) as { id: number }).id;

  for (const path of [
    `/accounts/${l2AccId}`,
    `/session-cards/${l2ScId}`,
    `/categories/${l2CatId}`,
    `/tags/${l2TagId}`,
    `/budgets/${l2BudId}`,
    `/recurring/${l2RecId}`,
    `/subscriptions/${l2SubId}`,
    `/debts/${l2DebtId}`,
    `/loans/${l2DebtId}`,
    `/goals/${l2GoalId}`,
  ]) {
    assert.equal((await api(path, aliceToken, 'GET')).status, 404, `跨账本 GET ${path} 应 404`);
    assert.equal((await api(path, aliceToken, 'PATCH', { name: '越权' })).status, 404, `跨账本 PATCH ${path} 应 404`);
    assert.equal((await api(path, aliceToken, 'DELETE')).status, 404, `跨账本 DELETE ${path} 应 404`);
  }
  assert.equal(
    (await api('/budgets', aliceToken, 'POST', { name: '越权账户', scope: 'account', account_id: l2AccId, amount: '100' })).status,
    400,
  );
  assert.equal(
    (await api('/budgets', aliceToken, 'POST', { name: '越权分类', scope: 'category', category_id: l2CatId, amount: '100' })).status,
    400,
  );
  assert.equal(
    (await api('/subscriptions', aliceToken, 'POST', { name: '越权订阅', amount: '10', account_id: l2AccId })).status,
    400,
  );
  assert.equal(
    (await api('/goals', aliceToken, 'POST', { name: '越权目标', target: '100', account_id: l2AccId })).status,
    400,
  );
});

test('关于页、PWA 图标、防呆/报销/AI 加固、规划边界、CSV TTL/全量导出与 OpenAPI 兼容回归', async () => {
  const { sqlite, env, r2Store } = setupEnv();
  const req = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${p}`, init), env);
  const api = (p: string, token: string, method = 'GET', body?: unknown) =>
    req(`/api/open${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  // 初始化管理员 alice 与只读成员/跨账本用户 bob
  const setupRes = await req('/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({
      username: 'alice',
      display_name: 'Alice',
      password: 'password123',
      password2: 'password123',
      site_name: '全特性回归',
    }),
  });
  assert.equal(setupRes.status, 302);
  const aliceCookie = extractSidCookie(setupRes);
  const homeHtml = await (await req('/', { headers: { Cookie: aliceCookie } })).text();
  const aliceCsrf = extractCsrf(homeHtml);

  const aliceToken = (
    (await (
      await req('/settings/api-tokens', {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'AliceTok' }),
      })
    ).json()) as { token: string }
  ).token;

  await req('/members/invite', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, role: 'viewer', days: '7' }),
  });
  const invCode = (sqlite.prepare('SELECT code FROM ledger_invites ORDER BY id DESC LIMIT 1').get() as { code: string }).code;
  const bobJoinRes = await req(`/join/${invCode}/register`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
    body: new URLSearchParams({ username: 'bob', display_name: 'Bob', password: 'bobpassword', password2: 'bobpassword' }),
  });
  const bobL1Cookie = extractSidCookie(bobJoinRes);
  const bobL1Home = await (await req('/', { headers: { Cookie: bobL1Cookie } })).text();
  const bobL1Csrf = extractCsrf(bobL1Home);

  const bobNewLedger = await req('/ledgers', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: bobL1Cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: bobL1Csrf, name: 'Bob独立账本', kind: 'personal', currency: 'CNY' }),
  });
  const bobL2Cookie = extractSidCookie(bobNewLedger);
  const bobL2Csrf = extractCsrf(await (await req('/', { headers: { Cookie: bobL2Cookie } })).text());
  const bobL2Token = (
    (await (
      await req('/settings/api-tokens', {
        method: 'POST',
        headers: { Cookie: bobL2Cookie, 'x-csrf-token': bobL2Csrf, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'BobL2Tok' }),
      })
    ).json()) as { token: string }
  ).token;

  // 1. /about 页面、移动端导航、viewer 隐藏 AI 助手与真实 PNG 图标
  assert.ok(homeHtml.includes('href="/about"'));
  assert.ok(homeHtml.includes('class="mobile-nav"'));
  assert.ok(homeHtml.includes('id="aiFab"') && homeHtml.includes('/js/assistant.js'));
  assert.ok(homeHtml.includes('今日已记 0 笔'));
  assert.ok(bobL1Home.includes('class="mobile-nav"'));
  assert.equal(bobL1Home.includes('id="aiFab"'), false, '只读成员不得加载 AI 助手浮窗');
  assert.equal(bobL1Home.includes('/js/assistant.js'), false);

  const aboutRes = await req('/about', { headers: { Cookie: aliceCookie } });
  assert.equal(aboutRes.status, 200);
  const aboutHtml = await aboutRes.text();
  assert.ok(aboutHtml.includes('HomeLedger') && aboutHtml.includes('更新记录'));

  for (const iconPath of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png']) {
    const iconRes = await req(iconPath);
    assert.equal(iconRes.status, 200, `${iconPath} 应返回 200`);
    const bytes = new Uint8Array(await iconRes.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${iconPath} 必须为有效 PNG`);
  }
  const manifestRes = await req('/manifest.webmanifest');
  assert.equal(manifestRes.status, 200);
  const manifestText = await manifestRes.text();
  assert.ok(manifestText.includes('/icons/icon-192.png') && manifestText.includes('/icons/icon-512-maskable.png'));

  // 2. 账户删前多表引用检查（Web + OpenAPI）
  const refAccRes = await api('/accounts', aliceToken, 'POST', { name: '引用待删账户', type: 'debit' });
  assert.equal(refAccRes.status, 201);
  const refAcc = ((await refAccRes.json()) as { id: number }).id;

  const refBudRes = await api('/budgets', aliceToken, 'POST', { name: '账户预算', scope: 'account', account_id: refAcc, amount: '500' });
  assert.equal(refBudRes.status, 201);
  const refBudId = ((await refBudRes.json()) as { id: number }).id;
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 400);
  const webDelRes = await req(`/accounts/${refAcc}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf }),
  });
  assert.equal(webDelRes.status, 302);
  assert.ok(sqlite.prepare('SELECT id FROM accounts WHERE id = ?').get(refAcc), '被预算引用时 Web 端也禁止删户');
  await api(`/budgets/${refBudId}`, aliceToken, 'DELETE');

  const refGoalRes = await api('/goals', aliceToken, 'POST', { name: '账户目标', target: '1000', account_id: refAcc });
  assert.equal(refGoalRes.status, 201);
  const refGoalId = ((await refGoalRes.json()) as { id: number }).id;
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 400);
  await api(`/goals/${refGoalId}`, aliceToken, 'DELETE');

  const refDebtRes = await api('/debts', aliceToken, 'POST', { direction: 'receivable', counterparty: '张三', principal: '100', account_id: refAcc });
  assert.equal(refDebtRes.status, 201);
  const refDebtId = ((await refDebtRes.json()) as { id: number }).id;
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 400);
  await api(`/debts/${refDebtId}`, aliceToken, 'DELETE');

  const refSubRes = await api('/subscriptions', aliceToken, 'POST', { name: '账户订阅', amount: '15', account_id: refAcc });
  assert.equal(refSubRes.status, 201);
  const refSubId = ((await refSubRes.json()) as { id: number }).id;
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 400);
  await api(`/subscriptions/${refSubId}`, aliceToken, 'DELETE');

  const refRecRes = await api('/recurring', aliceToken, 'POST', {
    name: '账户周期',
    frequency: 'monthly',
    next_run_at: '2099-01-01',
    items: [{ type: 'expense', amount: '20', account_id: refAcc }],
  });
  assert.equal(refRecRes.status, 201);
  const refRecId = ((await refRecRes.json()) as { id: number }).id;
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 400);
  await api(`/recurring/${refRecId}`, aliceToken, 'DELETE');
  assert.equal((await api(`/accounts/${refAcc}`, aliceToken, 'DELETE')).status, 200);

  // 3. Web 端自定义分类编辑与标签重命名防重
  const customCat = (
    (await (await api('/categories', aliceToken, 'POST', { name: '爱好', kind: 'expense', icon: '🎨' })).json()) as { id: number }
  ).id;
  await req(`/categories/${customCat}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '摄影器材', icon: '📷' }),
  });
  const editedCat = sqlite.prepare('SELECT name, icon FROM categories WHERE id = ?').get(customCat) as { name: string; icon: string };
  assert.deepEqual({ ...editedCat }, { name: '摄影器材', icon: '📷' });

  const sysCatBefore = (sqlite.prepare('SELECT name FROM categories WHERE id = 1').get() as { name: string }).name;
  await req('/categories/1', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '篡改系统' }),
  });
  assert.equal((sqlite.prepare('SELECT name FROM categories WHERE id = 1').get() as { name: string }).name, sysCatBefore);

  const tagA = ((await (await api('/tags', aliceToken, 'POST', { name: '出差' })).json()) as { id: number }).id;
  await api('/tags', aliceToken, 'POST', { name: '日常' });
  await req(`/tags/${tagA}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '日常' }),
  });
  assert.equal((sqlite.prepare('SELECT name FROM tags WHERE id = ?').get(tagA) as { name: string }).name, '出差', '重名标签不得覆盖');
  await req(`/tags/${tagA}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '商旅' }),
  });
  assert.equal((sqlite.prepare('SELECT name FROM tags WHERE id = ?').get(tagA) as { name: string }).name, '商旅');

  // 4. 单笔报销与孤儿已报销标记修复
  const reimbOrigId = (
    (await (
      await api('/transactions', aliceToken, 'POST', {
        type: 'expense',
        amount: '88',
        account_id: 1,
        is_reimbursable: true,
        tags: '商旅',
        note: '单笔报销测试',
      })
    ).json()) as { id: number }
  ).id;
  const reimbRes = await req(`/transactions/${reimbOrigId}/reimburse`, {
    method: 'POST',
    headers: {
      Cookie: aliceCookie,
      'x-csrf-token': aliceCsrf,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ account_id: 1 }),
  });
  assert.equal(reimbRes.status, 200);
  const reimbJson = (await reimbRes.json()) as { count: number; total: number };
  assert.equal(reimbJson.count, 1);
  assert.equal(reimbJson.total, 8800);
  const afterReimb = sqlite.prepare('SELECT reimbursed_at, related_id FROM transactions WHERE id = ?').get(reimbOrigId) as {
    reimbursed_at: string | null;
    related_id: number | null;
  };
  assert.ok(afterReimb.reimbursed_at && afterReimb.related_id);

  // 软删关联的报销入账流水以制造孤儿状态，验证 repairReimbursedLinks 可修复
  sqlite.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').run('2026-11-24 00:00:00', afterReimb.related_id);
  const repaired = await repairReimbursedLinks(makeDb(env));
  assert.equal(repaired, 1);
  const afterRepair = sqlite.prepare('SELECT reimbursed_at, related_id FROM transactions WHERE id = ?').get(reimbOrigId) as {
    reimbursed_at: string | null;
    related_id: number | null;
  };
  assert.deepEqual({ ...afterRepair }, { reimbursed_at: null, related_id: null });

  // 5. AI 解析/聊天 4000 字拦截、零条目不留孤儿图、待确认存图与自然键去重
  const longText = '买'.repeat(4001);
  assert.equal(
    (
      await req('/ai/analyze', {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: longText }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req('/api/ai/chat', {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: longText }),
      })
    ).status,
    400,
  );
  assert.equal((await api('/ai/bill', aliceToken, 'POST', { text: longText })).status, 400);

  const zeroAnalyze = await req('/ai/analyze', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '无金额纯闲聊', images: [PNG_1X1_DATA_URL] }),
  });
  assert.equal(zeroAnalyze.status, 200);
  const zeroJson = (await zeroAnalyze.json()) as { items: unknown[]; images: unknown[] };
  assert.equal(zeroJson.items.length, 0);
  assert.equal(zeroJson.images.length, 0);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS c FROM attachments').get() as { c: number }).c, 0, '零条目不得落盘图片');

  const okAnalyze = await req('/ai/analyze', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '午饭 35 元', images: [{ dataUrl: PNG_1X1_DATA_URL, name: 'meal.png' }] }),
  });
  assert.equal(okAnalyze.status, 200);
  const analyzeData = (await okAnalyze.json()) as {
    autoSave: boolean;
    items: Array<{ draft_id: string } & Record<string, unknown>>;
    images: Array<{ id: number }>;
  };
  assert.equal(typeof analyzeData.autoSave, 'boolean');
  assert.equal(analyzeData.items.length, 1);
  assert.equal(analyzeData.images.length, 1);
  const attBeforeConfirm = sqlite.prepare('SELECT ai_status, txn_id FROM attachments WHERE id = ?').get(analyzeData.images[0].id) as {
    ai_status: string;
    txn_id: number | null;
  };
  assert.equal(attBeforeConfirm.ai_status, 'pending');
  assert.equal(attBeforeConfirm.txn_id, null);

  const confirmRes = await req('/ai/confirm', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: analyzeData.items,
      image_ids: analyzeData.images.map((x) => x.id),
      source: 'ai_screenshot',
    }),
  });
  assert.equal(confirmRes.status, 200);
  const attAfterConfirm = sqlite.prepare('SELECT ai_status, txn_id FROM attachments WHERE id = ?').get(analyzeData.images[0].id) as {
    ai_status: string;
    txn_id: number | null;
  };
  assert.equal(attAfterConfirm.ai_status, 'linked');
  assert.ok(attAfterConfirm.txn_id);

  const chat1 = await req('/api/ai/chat', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '打车 48 元' }),
  });
  assert.equal(chat1.status, 200);
  assert.equal(((await chat1.json()) as { created: number }).created, 1);
  const chat2 = await req('/api/ai/chat', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '打车 48 元' }),
  });
  assert.equal(chat2.status, 200);
  const chat2Json = (await chat2.json()) as { created: number; duplicates: number };
  assert.equal(chat2Json.created, 0);
  assert.equal(chat2Json.duplicates, 1, '重复自然键聊天记账应命中去重');

  // 6. 搜索筛选与报表星期分布 / 自定义区间
  const searchRes = await req(`/search?member_id=1&tag_id=${tagA}&source=openapi&min=10&max=500`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal(searchRes.status, 200);
  const searchHtml = await searchRes.text();
  assert.ok(searchHtml.includes('单笔报销测试'));

  const repHtml = await (
    await req('/reports?preset=custom&from=2026-01-01&to=2026-12-31', { headers: { Cookie: aliceCookie } })
  ).text();
  assert.ok(repHtml.includes('2026-01-01 ~ 2026-12-31'));
  assert.ok(repHtml.includes('星期分布（支出）'));

  // 7. 规划细节：预算自定义日校验与编辑字段、试用期订阅阻断扣费、目标存入校验归档账户
  await req('/budgets', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: aliceCsrf,
      name: '倒挂预算',
      period: 'custom',
      start_date: '2026-06-10',
      end_date: '2026-06-01',
      amount: '100',
    }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM budgets WHERE name = '倒挂预算'").get(), undefined);

  const budId = ((await (await api('/budgets', aliceToken, 'POST', { name: '编辑字段预算', amount: '300' })).json()) as { id: number }).id;
  await req(`/budgets/${budId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: aliceCsrf,
      name: '编辑字段预算',
      period: 'custom',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      amount: '500',
      trigger_type: 'income',
      currency: 'USD',
      is_active: '1',
    }),
  });
  const budRow = sqlite.prepare('SELECT trigger_type, currency FROM budgets WHERE id = ?').get(budId) as {
    trigger_type: string;
    currency: string;
  };
  assert.deepEqual({ ...budRow }, { trigger_type: 'income', currency: 'USD' });

  const trialSubId = (
    (await (
      await api('/subscriptions', aliceToken, 'POST', {
        name: '试用流媒体',
        amount: '28',
        account_id: 1,
        status: 'trial',
        trial_ends_on: '2099-12-31',
      })
    ).json()) as { id: number }
  ).id;
  assert.equal((await api(`/subscriptions/${trialSubId}/charge`, aliceToken, 'POST')).status, 400, '试用期未结束前 API 禁止提前扣费');
  await req(`/subscriptions/${trialSubId}/charge`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf }),
  });
  assert.equal(
    (sqlite.prepare('SELECT COUNT(*) AS c FROM transactions WHERE subscription_id = ?').get(trialSubId) as { c: number }).c,
    0,
    '试用期未结束前 Web 端也禁止提前扣费',
  );

  const archAccRes = await api('/accounts', aliceToken, 'POST', { name: '已归档卡', type: 'debit' });
  assert.equal(archAccRes.status, 201);
  const archAccId = ((await archAccRes.json()) as { id: number }).id;
  await api(`/accounts/${archAccId}/archive`, aliceToken, 'POST');
  const goalId = (
    (await (await api('/goals', aliceToken, 'POST', { name: '旅游基金', target: '2000', account_id: 1 })).json()) as { id: number }
  ).id;
  await req(`/goals/${goalId}/deposit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, amount: '100', create_txn: 'on', account_id: String(archAccId) }),
  });
  assert.equal(
    (sqlite.prepare('SELECT saved_cents FROM goals WHERE id = ?').get(goalId) as { saved_cents: number }).saved_cents,
    0,
    '选中归档账户存入不得修改 goal saved_cents',
  );

  // 8. CSV 导入预览字段与 2 小时 TTL 校验 + >200 行全量导出
  const csvSample = [
    '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号',
    '2026-11-24 12:00:00,餐饮美食,便利店,便当,支出,25.00,,支付成功,ORD-TTL-1',
    '2026-11-24 13:00:00,投资理财,基金,转入,不计收支,100.00,现金,支付成功,ORD-TTL-2',
    'bad-date,餐饮美食,食堂,早餐,支出,10.00,现金,支付成功,ORD-TTL-3',
  ].join('\n');
  const csvDataUrl = `data:text/csv;base64,${Buffer.from(csvSample, 'utf8').toString('base64')}`;
  const prevRes = await req('/api/import/preview', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'ttl.csv', dataUrl: csvDataUrl }),
  });
  assert.equal(prevRes.status, 200);
  const prevJson = (await prevRes.json()) as {
    token: string;
    skipped: number;
    skippedDates: number;
    neutralCount: number;
    neutralSample: unknown[];
    sample: Array<{ guess_account_missing?: boolean }>;
  };
  assert.equal(prevJson.skipped, 1);
  assert.equal(prevJson.skippedDates, 1);
  assert.equal(prevJson.neutralCount, 1);
  assert.equal(prevJson.neutralSample.length, 1);
  assert.equal(prevJson.sample[0].guess_account_missing, true);

  const previewKey = `imports/preview-${prevJson.token}.json`;
  const storedPreview = r2Store.get(previewKey);
  assert.ok(storedPreview);
  const expiredPayload = JSON.parse(new TextDecoder().decode(storedPreview.data)) as Record<string, unknown>;
  expiredPayload.created_at = Date.now() - 3 * 3600 * 1000;
  storedPreview.data = new TextEncoder().encode(JSON.stringify(expiredPayload));

  const expiredCommit = await req('/api/import/commit', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: prevJson.token }),
  });
  assert.equal(expiredCommit.status, 400);
  assert.equal(r2Store.has(previewKey), false, '过期的预览对象应在拒接后同步从 R2 删除');

  // 插入超过 200 笔流水验证全量导出无截断
  const insBulk = sqlite.prepare(
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, txn_date, note, status, source, user_id, created_at, updated_at)
     VALUES (1, 'expense', 100, 'CNY', 1, 100, 1, '2026-11-01', ?, 'cleared', 'manual', 1, '2026-11-01 00:00:00', '2026-11-01 00:00:00')`,
  );
  for (let i = 0; i < 215; i++) insBulk.run(`批量导出测试-${i}`);

  const exportCsvText = await (await req('/export/csv', { headers: { Cookie: aliceCookie } })).text();
  const csvLines = exportCsvText.trim().split('\n');
  assert.ok(csvLines.length >= 216, `Web CSV 导出应包含全部流水（当前 ${csvLines.length - 1} 行）`);

  const openExportJson = (await (await api('/export', aliceToken)).json()) as {
    total: number;
    transactions: unknown[];
  };
  assert.ok(openExportJson.total >= 215 && openExportJson.transactions.length >= 215);

  // 9. OpenAPI 兼容别名、中文字段、扩展总览/报表与全库导出权限控制
  const payRuleId = (
    (await (
      await api('/recurring', aliceToken, 'POST', {
        name: '房租月付',
        frequency: 'monthly',
        next_run_at: '2026-11-24',
        items: [{ type: 'expense', amount: '2500', account_id: 1 }],
      })
    ).json()) as { id: number }
  ).id;
  const payRecRes = await api(`/recurring/${payRuleId}/pay`, aliceToken, 'POST', { kind: 'bill' });
  assert.equal(payRecRes.status, 200);
  assert.equal(((await payRecRes.json()) as { kind: string }).kind, 'recurring');

  const activeSubId = (
    (await (
      await api('/subscriptions', aliceToken, 'POST', { name: '云盘', amount: '12', account_id: 1, status: 'active' })
    ).json()) as { id: number }
  ).id;
  const paySubRes = await api(`/recurring/${activeSubId}/pay`, aliceToken, 'POST', { kind: 'subscription' });
  assert.equal(paySubRes.status, 200);
  assert.equal(((await paySubRes.json()) as { kind: string }).kind, 'subscription');

  const cnTxnRes = await api('/transactions', aliceToken, 'POST', {
    type: '支出',
    date: '2026-11-24',
    amount: '33.50',
    category: '餐饮美食',
    account: '招行自动建卡',
    note: '中文别名记账',
  });
  assert.equal(cnTxnRes.status, 201);
  const cnTxnJson = (await cnTxnRes.json()) as {
    transaction: { type: string; txn_date: string; amount_cents: number };
    created_accounts?: string[];
  };
  assert.equal(cnTxnJson.transaction.type, 'expense');
  assert.equal(cnTxnJson.transaction.txn_date, '2026-11-24');
  assert.equal(cnTxnJson.transaction.amount_cents, 3350);
  assert.deepEqual(cnTxnJson.created_accounts, ['招行自动建卡']);

  const ovJson = (await (await api('/overview', aliceToken)).json()) as Record<string, unknown> & {
    subscriptions: Record<string, unknown>;
  };
  for (const key of [
    'previous',
    'trend',
    'expense_categories',
    'income_categories',
    'accounts',
    'budgets',
    'debts',
    'goals',
    'upcoming_recurring',
    'pending_reimburse',
  ]) {
    assert.ok(key in ovJson, `/overview 缺少 ${key}`);
  }
  assert.ok('annual_cents' in ovJson.subscriptions);

  const openRepJson = (
    await (await api('/reports?preset=custom&from=2026-01-01&to=2026-12-31', aliceToken)).json()
  ) as Record<string, unknown>;
  for (const key of ['range', 'kind', 'subcategories', 'daily', 'weekday_expense', 'expense_stats']) {
    assert.ok(key in openRepJson, `/reports 缺少 ${key}`);
  }

  assert.equal((await api('/export?scope=full', bobL2Token)).status, 403, '非站点管理员禁止导出全库备份');
  const fullExpRes = await api('/export?scope=full', aliceToken);
  assert.equal(fullExpRes.status, 200);
  assert.equal(fullExpRes.headers.get('cache-control'), 'no-store');
  const fullExpJson = (await fullExpRes.json()) as { app: string; tables: Record<string, unknown[]> };
  assert.equal(fullExpJson.app, 'homeledger');
  assert.ok(Array.isArray(fullExpJson.tables.users) && Array.isArray(fullExpJson.tables.transactions));

  // 当月收入分类 TOP 与未来周期账单首页展示
  const incCatRow = sqlite.prepare("SELECT id FROM categories WHERE kind = 'income' LIMIT 1").get() as { id: number };
  assert.equal(
    (
      await api('/transactions', aliceToken, 'POST', {
        type: '收入',
        date: todayStr(),
        amount: '800',
        account_id: 1,
        category_id: incCatRow.id,
        note: '首页收入分类验证',
      })
    ).status,
    201,
  );
  const popHomeHtml = await (await req('/', { headers: { Cookie: aliceCookie } })).text();
  assert.ok(popHomeHtml.includes('本月收入分类 TOP') && popHomeHtml.includes('今日已记'));

  // 10. Codex 审查 P1/P2 修复专项回归
  // 10.1 repairReimbursedLinks 不重置 related_id IS NULL 的历史合法标记
  const nullLinkTxnId = (
    (await (
      await api('/transactions', aliceToken, 'POST', {
        type: 'expense',
        amount: '42',
        account_id: 1,
        is_reimbursable: true,
        note: '无关联ID历史已报销',
      })
    ).json()) as { id: number }
  ).id;
  sqlite.prepare("UPDATE transactions SET reimbursed_at = '2026-11-24 00:00:00', related_id = NULL WHERE id = ?").run(nullLinkTxnId);
  assert.equal(await repairReimbursedLinks(makeDb(env)), 0);
  const stillReimbursed = sqlite.prepare('SELECT reimbursed_at FROM transactions WHERE id = ?').get(nullLinkTxnId) as {
    reimbursed_at: string | null;
  };
  assert.ok(stillReimbursed.reimbursed_at, 'related_id IS NULL 不得被误清报销标记');

  // 10.2 储蓄目标并发存入乐观锁与失败增量回滚
  const raceGoalId = (
    (await (await api('/goals', aliceToken, 'POST', { name: '并发测试目标', target: '1000', account_id: 1 })).json()) as { id: number }
  ).id;
  const [depA, depB] = await Promise.all([
    api(`/goals/${raceGoalId}/deposit`, aliceToken, 'POST', { amount: '10' }),
    api(`/goals/${raceGoalId}/deposit`, aliceToken, 'POST', { amount: '20' }),
  ]);
  const depStatuses = [depA.status, depB.status].sort();
  assert.ok(
    (depStatuses[0] === 200 && depStatuses[1] === 409) || (depStatuses[0] === 200 && depStatuses[1] === 200),
  );
  const savedAfterRace = (sqlite.prepare('SELECT saved_cents FROM goals WHERE id = ?').get(raceGoalId) as { saved_cents: number })
    .saved_cents;
  const expectedAfterRace =
    (depA.status === 200 ? 1000 : 0) + (depB.status === 200 ? 2000 : 0);
  assert.equal(savedAfterRace, expectedAfterRace, '并发存入不可丢失更新');
  const failDep = await api(`/goals/${raceGoalId}/deposit`, aliceToken, 'POST', {
    amount: '50',
    create_txn: true,
    account_id: 999999,
  });
  assert.equal(failDep.status, 400);
  assert.equal(
    (sqlite.prepare('SELECT saved_cents FROM goals WHERE id = ?').get(raceGoalId) as { saved_cents: number }).saved_cents,
    expectedAfterRace,
  );

  // 10.3 AI 调用模型前图片校验、同日同额多杯保留、外币保留与部分失败关联
  assert.equal(
    (
      await req('/ai/analyze', {
        method: 'POST',
        headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: ['https://evil.test/x.png'] }),
      })
    ).status,
    400,
    '非 dataUrl 图片应在调用模型前被拦截',
  );
  assert.equal((await api('/ai/bill', aliceToken, 'POST', { images: ['https://evil.test/x.png'] })).status, 400);

  const dupCoffees = await req('/ai/confirm', {
    method: 'POST',
    headers: { Cookie: aliceCookie, 'x-csrf-token': aliceCsrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'ai_text',
      items: [
        { draft_id: 'coffee-a', type: 'expense', amount_cents: 3200, currency: 'CNY', account_id: 1, txn_date: todayStr(), merchant: '瑞幸', note: '美式1' },
        { draft_id: 'coffee-b', type: 'expense', amount_cents: 3200, currency: 'CNY', account_id: 1, txn_date: todayStr(), merchant: '瑞幸', note: '美式2' },
        { draft_id: 'usd-bill', type: 'expense', amount_cents: 1000, currency: 'USD', account_id: 1, txn_date: todayStr(), merchant: 'AppStore', note: '外币保留' },
      ],
    }),
  });
  assert.equal(dupCoffees.status, 200);
  const dupCoffeesJson = (await dupCoffees.json()) as { created: number; duplicates: number; ids: number[] };
  assert.equal(dupCoffeesJson.created, 3, '同日等额多笔与外币草稿均应入库');
  assert.equal(dupCoffeesJson.duplicates, 0);
  const usdTxn = sqlite.prepare('SELECT currency, amount_cents, amount_base_cents FROM transactions WHERE id = ?').get(
    dupCoffeesJson.ids[2],
  ) as { currency: string; amount_cents: number; amount_base_cents: number };
  assert.equal(usdTxn.currency, 'USD');
  assert.equal(usdTxn.amount_cents, 1000);
  assert.ok(usdTxn.amount_base_cents > 1000);

  // 模拟多笔 AI 返回部分成功（1 笔 USD 成功，1 笔 ZZZ 无汇率失败）仍关联凭证图且不丢凭证
  const origFetch = globalThis.fetch;
  sqlite.prepare("UPDATE settings SET value = 'true' WHERE key = 'ai.enabled'").run();
  sqlite.prepare("UPDATE settings SET value = 'http://127.0.0.1:18999/v1' WHERE key = 'ai.base_url'").run();
  sqlite.prepare("UPDATE settings SET value = 'mock-model' WHERE key = 'ai.model'").run();
  sqlite.prepare("UPDATE settings SET value = 'true' WHERE key = 'ai.vision'").run();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { type: 'expense', amount: 12, currency: 'CNY', merchant: '部分成功项', acct: '现金' },
                { type: 'expense', amount: 15, currency: 'ZZZ', merchant: '无汇率失败项', acct: '现金' },
              ]),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  try {
    const partRes = await api('/ai/bill', aliceToken, 'POST', {
      text: '两笔混币测试',
      images: [{ dataUrl: PNG_1X1_DATA_URL, name: 'part.png' }],
    });
    assert.equal(partRes.status, 200);
    const partJson = (await partRes.json()) as {
      created: number;
      errors?: string[];
      images: Array<{ id: number }>;
    };
    assert.equal(partJson.created, 1);
    assert.equal(partJson.errors?.length, 1);
    assert.equal(partJson.images.length, 1);
    const linkedAtt = sqlite.prepare('SELECT ai_status, txn_id FROM attachments WHERE id = ?').get(partJson.images[0].id) as {
      ai_status: string;
      txn_id: number | null;
    };
    assert.equal(linkedAtt.ai_status, 'linked');
    assert.ok(linkedAtt.txn_id);
  } finally {
    globalThis.fetch = origFetch;
    sqlite.prepare("UPDATE settings SET value = 'false' WHERE key = 'ai.enabled'").run();
  }

  // 10.4 /recurring/:id/pay 同 ID 歧义返回 409
  sqlite
    .prepare(
      `INSERT INTO recurring_rules (id, ledger_id, name, payload, frequency, interval_n, day_of_month, next_run_at, auto_post, is_active, created_by_user_id, created_at)
       VALUES (?, 1, '同ID冲突规则', ?, 'monthly', 1, 24, '2026-11-24', 0, 1, 1, '2026-11-24 00:00:00')`,
    )
    .run(activeSubId, JSON.stringify({ items: [{ type: 'expense', amount_cents: 1000, account_id: 1 }] }));
  assert.equal((await api(`/recurring/${activeSubId}/pay`, aliceToken, 'POST')).status, 409);

  // 10.5 Web 规划写入跨账本 IDOR 校验
  const bobL2AccId = (
    (await (await api('/accounts', bobL2Token, 'POST', { name: 'Bob秘密卡', type: 'debit' })).json()) as { id: number }
  ).id;
  const bobL2CatId = (
    (await (await api('/categories', bobL2Token, 'POST', { name: 'Bob私密分类', kind: 'expense' })).json()) as { id: number }
  ).id;
  await req('/budgets', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '越权Web账户预算', scope: 'account', account_id: String(bobL2AccId), amount: '100' }),
  });
  await req('/budgets', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '越权Web分类预算', scope: 'category', category_id: String(bobL2CatId), amount: '100' }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM budgets WHERE name LIKE '越权Web%'").get(), undefined);

  await req('/recurring', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: aliceCsrf,
      name: '越权Web周期',
      item_type: 'expense',
      item_amount: '50',
      item_account_id: String(bobL2AccId),
      item_category_id: String(bobL2CatId),
    }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM recurring_rules WHERE name = '越权Web周期'").get(), undefined);

  await req('/subscriptions', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '越权Web订阅', amount: '20', account_id: String(bobL2AccId) }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM subscriptions WHERE name = '越权Web订阅'").get(), undefined);

  await req('/goals', {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: aliceCsrf, name: '越权Web目标', target: '200', account_id: String(bobL2AccId) }),
  });
  assert.equal(sqlite.prepare("SELECT id FROM goals WHERE name = '越权Web目标'").get(), undefined);

  // 10.6 汇率字段标记 data-no-money-format & 单笔编辑页一键报销按钮
  const newTxnHtml = await (await req('/transactions/new', { headers: { Cookie: aliceCookie } })).text();
  assert.ok(newTxnHtml.includes('name="rate"') && newTxnHtml.includes('data-no-money-format'));

  const editReimbHtml = await (await req(`/transactions/${reimbOrigId}/edit`, { headers: { Cookie: aliceCookie } })).text();
  assert.ok(editReimbHtml.includes(`action="/transactions/${reimbOrigId}/reimburse"`));

  // 10.7 预算外币折算本位币 & 无效币种拒绝
  const usdOverview = (await (await api('/overview', aliceToken)).json()) as {
    budgets: Array<{ id: number; effective_cents: number }>;
  };
  const usdBudgetItem = usdOverview.budgets.find((x) => x.id === budId);
  assert.ok(usdBudgetItem && usdBudgetItem.effective_cents > 50000, 'USD 预算必须折算为本位币后再计算额度');
  assert.equal((await api('/budgets', aliceToken, 'POST', { name: '坏币种预算', amount: '100', currency: 'ZZZ' })).status, 400);

  // 10.8 OpenAPI 自动建户：失败零残留与超长名截断复用
  assert.equal(
    (await api('/transactions', aliceToken, 'POST', { type: '支出', amount: '0', account: '零金额禁止建户' })).status,
    400,
  );
  assert.equal(sqlite.prepare("SELECT id FROM accounts WHERE name = '零金额禁止建户'").get(), undefined);
  assert.equal(
    (await api('/transactions', aliceToken, 'POST', { type: 'transfer', amount: '50', account: '缺转入禁止建户' })).status,
    400,
  );
  assert.equal(sqlite.prepare("SELECT id FROM accounts WHERE name = '缺转入禁止建户'").get(), undefined);

  const longAccName = '超长账户名称用于验证截断后不会在第二次记账时重复建户超过三十字符';
  const long1 = await api('/transactions', aliceToken, 'POST', { type: '支出', amount: '10', account: longAccName });
  assert.equal(long1.status, 201);
  const long1Json = (await long1.json()) as { created_accounts?: string[] };
  assert.equal(long1Json.created_accounts?.length, 1);
  const long2 = await api('/transactions', aliceToken, 'POST', { type: '支出', amount: '11', account: longAccName });
  assert.equal(long2.status, 201);
  const long2Json = (await long2.json()) as { created_accounts?: string[] };
  assert.equal(long2Json.created_accounts, undefined, '截断同名账户应复用而非重复创建');

  // 10.9 键集游标 iterateAllForExport 精确无重复无漏行
  const dbRowsCount = (
    sqlite.prepare('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = 1 AND deleted_at IS NULL').get() as { c: number }
  ).c;
  const cursorIds: number[] = [];
  for await (const chunk of iterateAllForExport(makeDb(env), 1, 50)) {
    for (const row of chunk) cursorIds.push(Number(row.id));
  }
  assert.equal(cursorIds.length, dbRowsCount);
  assert.equal(new Set(cursorIds).size, dbRowsCount);
});
