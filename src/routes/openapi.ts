import type { Context } from 'hono';
import { Hono } from 'hono';
import { accountGroupOf, isCreditGroupType, nowStr, todayStr } from '../db.js';
import { creditMetrics, groupAccountsSummary, normalizeAccountWrite } from '../lib/accounts.js';
import { analyzeBill } from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import { budgetPeriodRange, budgetUsedInRange, effectiveBudget, tzRefDate, type BudgetRow } from '../lib/scheduler.js';
import * as sc from '../lib/session-cards.js';
import { decorate as decorateSub, overview as subsOverview, type SubscriptionRow } from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { AccountRow, HonoEnv, Role } from '../types.js';
import { dbOf, envOf, toPublicError } from './helpers.js';

export const openapiRoutes = new Hono<HonoEnv>();

function extractBearer(c: Context<HonoEnv>): string | null {
  const authz = c.req.header('authorization') || '';
  if (/^Bearer\s+/i.test(authz)) return authz.replace(/^Bearer\s+/i, '').trim();
  const key = c.req.header('x-api-key');
  return key ? key.trim() : null;
}

openapiRoutes.use('*', async (c, next) => {
  const raw = extractBearer(c);
  if (!raw) return c.json({ ok: false, error: '缺少 Bearer Token' }, 401);

  const db = dbOf(c);
  const hash = await auth.sha256Hex(raw);
  // 按 D1 红线约定：Bearer 鉴权保持纯只读，严禁更新 api_tokens.last_used_at
  const row = await db.get<{
    token_id: number;
    user_id: number;
    ledger_id: number | null;
    token_name: string;
    expires_at: string | null;
    username: string;
    display_name: string;
    status: string;
    is_admin: number;
  }>(
    `SELECT t.id AS token_id, t.user_id, t.ledger_id, t.name AS token_name, t.expires_at,
            u.username, u.display_name, u.status, u.is_admin
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    hash,
  );

  if (!row || row.status !== 'active') {
    return c.json({ ok: false, error: '无效或已吊销的 API 令牌' }, 401);
  }
  if (row.expires_at && row.expires_at < nowStr()) {
    return c.json({ ok: false, error: 'API 令牌已过期' }, 401);
  }

  const requestedLedger = Number(c.req.query('ledger_id') || c.req.header('x-ledger-id') || row.ledger_id || 0);
  let member = requestedLedger ? await auth.membership(db, row.user_id, requestedLedger) : null;
  if (!member && !requestedLedger) {
    member = await db.get<{ id: number; ledger_id: number; user_id: number; role: Role; nickname: string | null }>(
      `SELECT m.* FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
       WHERE m.user_id = ? AND l.is_archived = 0 ORDER BY m.id LIMIT 1`,
      row.user_id,
    );
  }
  if (!member) {
    return c.json({ ok: false, error: '无权访问目标账本' }, 403);
  }

  c.set('openAuth', {
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    ledgerId: Number(member.ledger_id),
    role: member.role as NonNullable<HonoEnv['Variables']['openAuth']>['role'],
    tokenId: Number(row.token_id),
    tokenName: row.token_name,
  });

  await next();
});

function requireWriteApi(c: Context<HonoEnv>): Response | null {
  const oa = c.get('openAuth');
  if (!oa || !auth.canWrite(oa.role)) {
    return c.json({ ok: false, error: '当前令牌成员角色为只读，禁止写入' }, 403);
  }
  return null;
}

openapiRoutes.get('/ping', (c) => {
  const oa = c.get('openAuth')!;
  return c.json({
    ok: true,
    user: { id: oa.userId, username: oa.username, display_name: oa.displayName, is_admin: oa.isAdmin },
    ledger_id: oa.ledgerId,
    role: oa.role,
    token: { id: oa.tokenId, name: oa.tokenName },
    time: nowStr(),
  });
});

openapiRoutes.get('/transactions/recent', async (c) => {
  const oa = c.get('openAuth')!;
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') || 15)));
  const res = await txn.listTransactions(dbOf(c), oa.ledgerId, { page: 1, pageSize: limit });
  return c.json({ ok: true, ledger_id: oa.ledgerId, items: res.rows, total: res.total });
});

openapiRoutes.get('/transactions', async (c) => {
  const oa = c.get('openAuth')!;
  const q = c.req.query();
  const res = await txn.listTransactions(dbOf(c), oa.ledgerId, {
    type: q.type || undefined,
    kind: q.kind === 'expense' || q.kind === 'income' ? q.kind : undefined,
    month: q.month || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    keyword: q.q || undefined,
    categoryId: q.category_id ? Number(q.category_id) : undefined,
    accountId: q.account_id ? Number(q.account_id) : undefined,
    page: Math.max(1, Number(q.page || 1)),
    pageSize: Math.max(1, Math.min(200, Number(q.page_size || 40))),
  });
  return c.json({ ok: true, ledger_id: oa.ledgerId, ...res });
});

openapiRoutes.get('/transactions/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const row = await txn.getTransaction(dbOf(c), Number(c.req.param('id')), oa.ledgerId);
  if (!row) return c.json({ ok: false, error: '记录不存在' }, 404);
  return c.json({ ok: true, transaction: row });
});

openapiRoutes.post('/transactions', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const amountCents =
      body.amount_cents != null ? Math.round(Number(body.amount_cents)) : u.parseAmountToCents(body.amount);
    const id = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
      type: String(body.type || 'expense'),
      amount_cents: amountCents,
      currency: String(body.currency || 'CNY'),
      rate: (body.rate as string | number | null) ?? null,
      account_id: (body.account_id as string | number | null) ?? null,
      to_account_id: (body.to_account_id as string | number | null) ?? null,
      category_id: (body.category_id as string | number | null) ?? null,
      txn_date: String(body.txn_date || todayStr()),
      note: body.note != null ? String(body.note) : null,
      merchant: body.merchant != null ? String(body.merchant) : null,
      status: String(body.status || 'cleared'),
      is_reimbursable: body.is_reimbursable ? 1 : 0,
      tags: String(body.tags || ''),
      source: String(body.source || 'openapi').slice(0, 30),
    });
    const created = await txn.getTransaction(db, id, oa.ledgerId);
    return c.json({ ok: true, id, transaction: created }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleApiTxnUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const existing = await txn.getTransaction(db, id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '记录不存在' }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    const amountCents =
      body.amount_cents != null
        ? Math.round(Number(body.amount_cents))
        : body.amount != null
          ? u.parseAmountToCents(body.amount)
          : existing.amount_cents;
    await txn.updateTransaction(db, id, oa.ledgerId, oa.userId, {
      type: body.type !== undefined ? String(body.type) : existing.type,
      amount_cents: amountCents,
      currency: body.currency !== undefined ? String(body.currency) : existing.currency,
      rate: body.rate !== undefined ? (body.rate as string | number | null) : existing.rate,
      account_id: body.account_id !== undefined ? (body.account_id as string | number | null) : existing.account_id,
      to_account_id:
        body.to_account_id !== undefined ? (body.to_account_id as string | number | null) : existing.to_account_id,
      category_id:
        body.category_id !== undefined ? (body.category_id as string | number | null) : existing.category_id,
      txn_date: body.txn_date !== undefined ? String(body.txn_date) : existing.txn_date,
      note: body.note !== undefined ? (body.note == null ? null : String(body.note)) : existing.note,
      merchant: body.merchant !== undefined ? (body.merchant == null ? null : String(body.merchant)) : existing.merchant,
      status: body.status !== undefined ? String(body.status) : existing.status,
      is_reimbursable:
        body.is_reimbursable !== undefined ? (body.is_reimbursable ? 1 : 0) : existing.is_reimbursable,
      updated_at: body.updated_at ? String(body.updated_at) : existing.updated_at,
    });
    const updated = await txn.getTransaction(db, id, oa.ledgerId);
    return c.json({ ok: true, id, transaction: updated });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/transactions/:id', handleApiTxnUpdate);
openapiRoutes.patch('/transactions/:id', handleApiTxnUpdate);

openapiRoutes.delete('/transactions/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  try {
    const ok = await txn.softDelete(dbOf(c), Number(c.req.param('id')), oa.ledgerId, { env: envOf(c) });
    if (!ok) return c.json({ ok: false, error: '记录不存在' }, 404);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/ai/bill', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const env = envOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, attach.MAX_IMAGES) : [];
    const text = String(body.text || '').trim();
    if (!rawImages.length && !text) {
      return c.json({ ok: false, error: '请提供 text 或 images' }, 400);
    }

    const savedImages: Array<Awaited<ReturnType<typeof attach.saveDataUrlImage>>> = [];
    const analyzeImages: Array<{ dataUrl: string }> = [];
    for (const img of rawImages) {
      const dataUrl = typeof img === 'string' ? img : String((img as { dataUrl?: string })?.dataUrl || '');
      if (!dataUrl) continue;
      analyzeImages.push({ dataUrl });
      savedImages.push(
        await attach.saveDataUrlImage(db, env, {
          dataUrl,
          ledgerId: oa.ledgerId,
          userId: oa.userId,
          kind: 'screenshot',
          aiStatus: 'analyzed',
        }),
      );
    }

    const res = await analyzeBill(db, {
      images: analyzeImages,
      text,
      ledgerId: oa.ledgerId,
      defaultAccountId: body.account_id ? Number(body.account_id) : null,
    });
    const autoSave = body.auto_save !== false;
    const createdIds: number[] = [];

    if (autoSave && res.items.length) {
      for (const it of res.items) {
        if (!(it.amount_cents > 0)) continue;
        const id = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
          type: it.type,
          amount_cents: it.amount_cents,
          currency: it.currency || 'CNY',
          account_id: it.account_id,
          category_id: it.category_id,
          txn_date: it.txn_date,
          note: it.note,
          merchant: it.merchant,
          source: String(body.source || (rawImages.length ? 'ai_screenshot' : 'openapi')).slice(0, 30),
        });
        createdIds.push(id);
      }
      if (createdIds.length && savedImages.length) {
        await attach.linkImagesToTxns(db, {
          ledgerId: oa.ledgerId,
          imageIds: savedImages.map((s) => s.id),
          txnIds: createdIds,
          aiStatus: 'linked',
        });
      }
    }

    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      items: res.items,
      created: createdIds.length,
      ids: createdIds,
      warnings: res.warnings,
      images: savedImages,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.get('/attachments/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const found = await attach.resolveObject(envOf(c), oa.ledgerId, dbOf(c), Number(c.req.param('id')));
  if (!found) return c.json({ ok: false, error: '附件不存在' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', found.row.mime || 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  return new Response(found.obj.body, { headers });
});

function enrichAccount(a: AccountRow) {
  return {
    ...a,
    group: accountGroupOf(a.type),
    credit: isCreditGroupType(a.type) ? creditMetrics(a) : null,
  };
}

openapiRoutes.get('/accounts', async (c) => {
  const oa = c.get('openAuth')!;
  const [accounts, ov] = await Promise.all([
    fd.accounts(dbOf(c), oa.ledgerId),
    txn.accountOverview(dbOf(c), oa.ledgerId),
  ]);
  const summary = groupAccountsSummary(accounts);
  return c.json({
    ok: true,
    accounts: accounts.map(enrichAccount),
    assets: ov.assets,
    liabilities: ov.liabilities,
    net: ov.net,
    groups: {
      funds_total_cents: summary.fundsTotalCents,
      prepaid_total_cents: summary.prepaidTotalCents,
      credit_debt_cents: summary.creditDebtCents,
      credit_limit_cents: summary.creditLimitCents,
      credit_available_cents: summary.creditAvailableCents,
    },
  });
});

openapiRoutes.post('/accounts', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const data = normalizeAccountWrite(body, { mode: 'create', apiMode: true });
    const res = await db.run(
      `INSERT INTO accounts
       (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day, due_day,
        institution, card_no, note, include_in_net, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      oa.ledgerId,
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.initial_cents ?? 0,
      data.balance_cents ?? 0,
      data.credit_limit,
      data.bill_day,
      data.due_day,
      data.institution,
      data.card_no,
      data.note,
      data.include_in_net,
      data.sort_order,
      nowStr(),
    );
    const created = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', res.lastInsertRowid, oa.ledgerId);
    return c.json({ ok: true, id: res.lastInsertRowid, account: created ? enrichAccount(created) : null }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleApiAccountUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    const data = normalizeAccountWrite(body, { mode: 'edit', existing, apiMode: true });
    await db.run(
      `UPDATE accounts
       SET name = ?, type = ?, icon = ?, currency = ?, include_in_net = ?, sort_order = ?,
           institution = ?, card_no = ?, note = ?, credit_limit = ?, bill_day = ?, due_day = ?
       WHERE id = ? AND ledger_id = ?`,
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.include_in_net,
      data.sort_order,
      data.institution,
      data.card_no,
      data.note,
      data.credit_limit,
      data.bill_day,
      data.due_day,
      id,
      oa.ledgerId,
    );
    const updated = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, account: updated ? enrichAccount(updated) : null });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/accounts/:id', handleApiAccountUpdate);
openapiRoutes.patch('/accounts/:id', handleApiAccountUpdate);

openapiRoutes.get('/session-cards', async (c) => {
  const oa = c.get('openAuth')!;
  const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
  const res = await sc.listSessionCards(dbOf(c), oa.ledgerId);
  return c.json({
    ok: true,
    active_count: res.activeCount,
    total_remaining: res.totalRemaining,
    cards: includeArchived ? res.all : res.active,
  });
});

openapiRoutes.get('/session-cards/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const card = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!card) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const logs = await sc.listCardLogs(db, id, oa.ledgerId);
  return c.json({ ok: true, card, logs });
});

openapiRoutes.post('/session-cards', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const totalCostCents = sc.parseCardCostCents(body, 'total_cost_cents', 'total_cost');
    const recordExpense =
      body.record_expense !== undefined
        ? Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false')
        : Boolean(body.account_id);
    const id = await sc.createSessionCard(db, oa.ledgerId, oa.userId, {
      name: String(body.name || ''),
      icon: body.icon ? String(body.icon) : '🎟️',
      merchant: body.merchant != null ? String(body.merchant) : null,
      total_sessions: Number(body.total_sessions),
      remaining_sessions: body.remaining_sessions != null ? Number(body.remaining_sessions) : null,
      total_cost_cents: totalCostCents,
      currency: body.currency ? String(body.currency) : 'CNY',
      purchase_date: body.purchase_date ? String(body.purchase_date) : undefined,
      expires_at: body.expires_at != null ? String(body.expires_at) : null,
      note: body.note != null ? String(body.note) : null,
      record_expense: recordExpense,
      account_id: body.account_id != null ? Number(body.account_id) : null,
      category_id: body.category_id != null ? Number(body.category_id) : null,
    });
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/use', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const count = body.count != null ? Number(body.count) : 1;
    const res = await sc.useSessionCard(db, id, oa.ledgerId, oa.userId, {
      count,
      used_at: body.used_at ? String(body.used_at) : undefined,
      note: body.note != null ? String(body.note) : null,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/topup', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const addCostCents = sc.parseCardCostCents(body, 'add_cost_cents', 'add_cost');
    const recordExpense =
      body.record_expense !== undefined
        ? Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false')
        : Boolean(body.account_id);
    const card = await sc.topUpSessionCard(db, id, oa.ledgerId, oa.userId, {
      add_sessions: Number(body.add_sessions),
      add_cost_cents: addCostCents,
      topup_date: body.topup_date ? String(body.topup_date) : undefined,
      expires_at: body.expires_at !== undefined ? (body.expires_at == null ? null : String(body.expires_at)) : undefined,
      note: body.note != null ? String(body.note) : null,
      record_expense: recordExpense,
      account_id: body.account_id != null ? Number(body.account_id) : null,
      category_id: body.category_id != null ? Number(body.category_id) : null,
    });
    return c.json({ ok: true, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/logs/:logId/undo', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const res = await sc.undoSessionCardLog(db, Number(c.req.param('id')), Number(c.req.param('logId')), oa.ledgerId);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.get('/categories', async (c) => {
  const oa = c.get('openAuth')!;
  const kind = c.req.query('kind');
  const k = kind === 'expense' || kind === 'income' ? kind : null;
  const categories = await fd.flatCategories(dbOf(c), oa.ledgerId, k);
  return c.json({ ok: true, categories });
});

openapiRoutes.get('/tags', async (c) => {
  const oa = c.get('openAuth')!;
  return c.json({ ok: true, tags: await fd.tags(dbOf(c), oa.ledgerId) });
});

openapiRoutes.get('/summary', async (c) => {
  const oa = c.get('openAuth')!;
  const month = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || ''))
    ? String(c.req.query('month'))
    : todayStr().slice(0, 7);
  const start = String(c.req.query('from') || `${month}-01`);
  const end = String(c.req.query('to') || u.monthEnd(month));
  const [summary, overview] = await Promise.all([
    txn.summary(dbOf(c), oa.ledgerId, start, end),
    txn.accountOverview(dbOf(c), oa.ledgerId),
  ]);
  return c.json({
    ok: true,
    start,
    end,
    summary,
    overview: { net: overview.net, assets: overview.assets, liabilities: overview.liabilities },
  });
});

openapiRoutes.get('/overview', async (c) => {
  const oa = c.get('openAuth')!;
  const month = todayStr().slice(0, 7);
  const db = dbOf(c);
  const [summary, overview, recent, subs] = await Promise.all([
    txn.summary(db, oa.ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.accountOverview(db, oa.ledgerId),
    txn.listTransactions(db, oa.ledgerId, { page: 1, pageSize: 10 }),
    subsOverview(db, oa.ledgerId),
  ]);
  return c.json({
    ok: true,
    month,
    summary,
    overview: { net: overview.net, assets: overview.assets, liabilities: overview.liabilities },
    recent: recent.rows,
    subscriptions: { active_count: subs.active.length, monthly_cents: subs.monthlyTotal },
  });
});

openapiRoutes.get('/reports', async (c) => {
  const oa = c.get('openAuth')!;
  const month = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || ''))
    ? String(c.req.query('month'))
    : todayStr().slice(0, 7);
  const start = `${month}-01`;
  const end = u.monthEnd(month);
  const db = dbOf(c);
  const [summary, expense_categories, income_categories, trend, members, net_worth] = await Promise.all([
    txn.summary(db, oa.ledgerId, start, end),
    txn.categoryBreakdown(db, oa.ledgerId, start, end, 'expense'),
    txn.categoryBreakdown(db, oa.ledgerId, start, end, 'income'),
    txn.monthlyTrend(db, oa.ledgerId, 6),
    txn.memberBreakdown(db, oa.ledgerId, start, end),
    txn.netWorthTrend(db, oa.ledgerId, 6),
  ]);
  return c.json({ ok: true, month, summary, expense_categories, income_categories, trend, members, net_worth });
});

openapiRoutes.get('/budgets', async (c) => {
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const ref = tzRefDate();
  const rows = await db.all<BudgetRow>('SELECT * FROM budgets WHERE ledger_id = ? AND is_active = 1 ORDER BY id', oa.ledgerId);
  const budgets = await Promise.all(
    rows.map(async (b) => {
      const range = budgetPeriodRange(b, ref);
      const used = await budgetUsedInRange(db, b, range.start, range.end);
      const eff = await effectiveBudget(db, b, ref);
      return { ...b, range, used_cents: used, effective_cents: eff.amount, rollover_cents: eff.rollover };
    }),
  );
  return c.json({ ok: true, budgets });
});

openapiRoutes.get('/subscriptions', async (c) => {
  const oa = c.get('openAuth')!;
  const rows = await dbOf(c).all<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE ledger_id = ? ORDER BY id DESC',
    oa.ledgerId,
  );
  return c.json({ ok: true, subscriptions: rows.map((s) => decorateSub(s)) });
});

openapiRoutes.get('/recurring', async (c) => {
  const oa = c.get('openAuth')!;
  const rules = await dbOf(c).all('SELECT * FROM recurring_rules WHERE ledger_id = ? ORDER BY id DESC', oa.ledgerId);
  return c.json({ ok: true, recurring: rules });
});

async function listDebts(c: Context<HonoEnv>) {
  const oa = c.get('openAuth')!;
  const debts = await dbOf(c).all('SELECT * FROM debts WHERE ledger_id = ? ORDER BY status, id DESC', oa.ledgerId);
  return c.json({ ok: true, debts });
}

openapiRoutes.get('/debts', listDebts);
openapiRoutes.get('/loans', listDebts);

openapiRoutes.get('/goals', async (c) => {
  const oa = c.get('openAuth')!;
  const goals = await dbOf(c).all('SELECT * FROM goals WHERE ledger_id = ? ORDER BY id DESC', oa.ledgerId);
  return c.json({ ok: true, goals });
});

openapiRoutes.get('/export', async (c) => {
  const oa = c.get('openAuth')!;
  const res = await txn.listTransactions(dbOf(c), oa.ledgerId, { page: 1, pageSize: 50000 });
  return c.json({ ok: true, ledger_id: oa.ledgerId, total: res.total, transactions: res.rows });
});
