import type { Context } from 'hono';
import { Hono } from 'hono';
import { accountGroupOf, isCreditGroupType, nowStr, todayStr } from '../db.js';
import { creditMetrics, groupAccountsSummary, normalizeAccountWrite } from '../lib/accounts.js';
import { analyzeBill } from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import * as sc from '../lib/session-cards.js';
import { overview as subsOverview } from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { AccountRow, CategoryRow, HonoEnv, Role } from '../types.js';
import { dbOf, envOf, toPublicError } from './helpers.js';
import {
  parseAmountField,
  parseBoolFlag,
  parseOptionalDate,
  parseOptionalRefId,
  parsePositiveIntId,
  readJsonObject,
  requireWriteApi,
} from './openapi-helpers.js';
import { registerPlanningOpenApi } from './openapi-planning.js';

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
  const db = dbOf(c);
  const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
  const [accounts, ov] = await Promise.all([
    includeArchived
      ? db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? ORDER BY is_archived, sort_order, id', oa.ledgerId)
      : fd.accounts(db, oa.ledgerId),
    txn.accountOverview(db, oa.ledgerId),
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

openapiRoutes.get('/accounts/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const acc = await dbOf(c).get<AccountRow>(
    'SELECT * FROM accounts WHERE id = ? AND ledger_id = ?',
    id,
    oa.ledgerId,
  );
  if (!acc) return c.json({ ok: false, error: '账户不存在' }, 404);
  return c.json({ ok: true, account: enrichAccount(acc) });
});

openapiRoutes.post('/accounts', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
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
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  try {
    const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
    const body = await readJsonObject(c);
    const data = normalizeAccountWrite(body, { mode: 'edit', existing, apiMode: true });
    const isArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : Number(existing.is_archived);
    await db.run(
      `UPDATE accounts
       SET name = ?, type = ?, icon = ?, currency = ?, include_in_net = ?, is_archived = ?, sort_order = ?,
           institution = ?, card_no = ?, note = ?, credit_limit = ?, bill_day = ?, due_day = ?
       WHERE id = ? AND ledger_id = ?`,
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.include_in_net,
      isArchived,
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

openapiRoutes.post('/accounts/:id/archive', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
  try {
    const body = await readJsonObject(c, { optional: true });
    const nextArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : existing.is_archived
          ? 0
          : 1;
    await db.run('UPDATE accounts SET is_archived = ? WHERE id = ? AND ledger_id = ?', nextArchived, id, oa.ledgerId);
    const updated = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, account: updated ? enrichAccount(updated) : null });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/accounts/:id/adjust', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const acc = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!acc) return c.json({ ok: false, error: '账户不存在' }, 404);
  if (acc.is_archived) {
    return c.json({ ok: false, error: '已归档账户不可校准余额，请先取消归档' }, 400);
  }
  try {
    const body = await readJsonObject(c);
    const target = parseAmountField(
      body,
      ['actual_balance_cents', 'balance_cents'],
      ['actual_balance', 'balance'],
      { allowZero: true, allowNegative: true, label: '目标余额' },
    );
    if (target === undefined) {
      return c.json({ ok: false, error: '请填写目标余额' }, 400);
    }
    const adjustDate = parseOptionalDate(body.adjust_date ?? body.txn_date, todayStr(), '校准日期') || todayStr();
    const diff = target - Number(acc.balance_cents);
    if (diff === 0) {
      return c.json({ ok: true, adjusted: false, diff_cents: 0, account: enrichAccount(acc), transaction: null });
    }
    const claim = await db.run(
      'UPDATE accounts SET balance_cents = ? WHERE id = ? AND ledger_id = ? AND balance_cents = ?',
      target,
      id,
      oa.ledgerId,
      Number(acc.balance_cents),
    );
    if (claim.changes !== 1) {
      return c.json({ ok: false, error: '账户余额已变动，请重试' }, 409);
    }
    let txnId: number;
    try {
      const note =
        body.note != null && String(body.note).trim()
          ? String(body.note).trim().slice(0, 300)
          : `余额校准：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(target)}`;
      txnId = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
        type: 'adjust',
        amount_cents: diff,
        currency: acc.currency || 'CNY',
        rate: 1,
        account_id: id,
        txn_date: adjustDate,
        note,
        source: 'openapi',
        skipBalanceDelta: true,
      });
    } catch (e) {
      await db
        .run(
          'UPDATE accounts SET balance_cents = ? WHERE id = ? AND ledger_id = ? AND balance_cents = ?',
          Number(acc.balance_cents),
          id,
          oa.ledgerId,
          target,
        )
        .catch(() => {});
      throw e;
    }
    const [updated, createdTxn] = await Promise.all([
      db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId),
      txn.getTransaction(db, txnId, oa.ledgerId),
    ]);
    return c.json({
      ok: true,
      adjusted: true,
      diff_cents: diff,
      account: updated ? enrichAccount(updated) : null,
      transaction: createdTxn || null,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.delete('/accounts/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
  const used = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND (account_id = ? OR to_account_id = ?) AND deleted_at IS NULL',
        oa.ledgerId,
        id,
        id,
      )
    )?.c || 0,
  );
  if (used > 0) {
    return c.json({ ok: false, error: `该账户还有 ${used} 笔未删除记账，无法删除` }, 400);
  }
  await db.run('DELETE FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  return c.json({ ok: true });
});

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

async function handleSessionCardUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const existing = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '次卡不存在' }, 404);
  try {
    const body = await readJsonObject(c);
    const totalCostCents = parseAmountField(body, ['total_cost_cents'], ['total_cost'], {
      allowZero: true,
      label: '购卡金额',
    });
    const expiresAt =
      body.expires_at !== undefined
        ? parseOptionalDate(body.expires_at, existing.expires_at, '有效期')
        : undefined;
    await sc.updateSessionCard(db, id, oa.ledgerId, {
      name: body.name !== undefined ? String(body.name || '') : existing.name,
      icon: body.icon !== undefined ? String(body.icon || '') : existing.icon,
      merchant: body.merchant !== undefined ? (body.merchant == null ? null : String(body.merchant)) : undefined,
      total_cost_cents: totalCostCents,
      expires_at: expiresAt,
      note: body.note !== undefined ? (body.note == null ? null : String(body.note)) : undefined,
    });
    if (body.is_archived !== undefined) {
      const nextArchived = parseBoolFlag(body.is_archived, Number(existing.is_archived));
      await db.run(
        'UPDATE session_cards SET is_archived = ?, updated_at = ? WHERE id = ? AND ledger_id = ?',
        nextArchived,
        nowStr(),
        id,
        oa.ledgerId,
      );
    }
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/session-cards/:id', handleSessionCardUpdate);
openapiRoutes.patch('/session-cards/:id', handleSessionCardUpdate);

openapiRoutes.post('/session-cards/:id/archive', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const existing = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '次卡不存在' }, 404);
  try {
    const body = await readJsonObject(c, { optional: true });
    const nextArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : existing.is_archived
          ? 0
          : 1;
    await db.run(
      'UPDATE session_cards SET is_archived = ?, updated_at = ? WHERE id = ? AND ledger_id = ?',
      nextArchived,
      nowStr(),
      id,
      oa.ledgerId,
    );
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.delete('/session-cards/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const deleted = await sc.deleteSessionCard(dbOf(c), id, oa.ledgerId);
  if (!deleted) return c.json({ ok: false, error: '次卡不存在' }, 404);
  return c.json({ ok: true });
});

async function getCategoryWithPath(db: ReturnType<typeof dbOf>, id: number, ledgerId: number) {
  const cat = await db.get<CategoryRow>(
    `SELECT c.*, p.name AS parent_name
     FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.id = ? AND (c.ledger_id IS NULL OR c.ledger_id = ?)`,
    id,
    ledgerId,
  );
  if (!cat) return undefined;
  return { ...cat, path: cat.parent_name ? `${cat.parent_name}/${cat.name}` : cat.name };
}

openapiRoutes.get('/categories', async (c) => {
  const oa = c.get('openAuth')!;
  const kind = c.req.query('kind');
  const k = kind === 'expense' || kind === 'income' ? kind : null;
  const categories = await fd.flatCategories(dbOf(c), oa.ledgerId, k);
  return c.json({ ok: true, categories });
});

openapiRoutes.get('/categories/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const category = await getCategoryWithPath(dbOf(c), id, oa.ledgerId);
  if (!category) return c.json({ ok: false, error: '分类不存在' }, 404);
  return c.json({ ok: true, category });
});

openapiRoutes.post('/categories', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return c.json({ ok: false, error: '请填写分类名称' }, 400);

    let parentId = parseOptionalRefId(body.parent_id, null, '父分类 ID');
    let kind: 'expense' | 'income' = 'expense';
    let color = body.color ? String(body.color).trim().slice(0, 20) || '#8c8c8c' : '#8c8c8c';

    if (parentId !== null) {
      const parent = await db.get<CategoryRow>(
        'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
        parentId,
        oa.ledgerId,
      );
      if (!parent) return c.json({ ok: false, error: '所属一级分类不存在' }, 400);
      if (parent.parent_id != null) {
        return c.json({ ok: false, error: '仅支持二级分类，不能在二级分类下继续新建子分类' }, 400);
      }
      kind = parent.kind;
      if (body.kind !== undefined && String(body.kind) !== parent.kind) {
        return c.json({ ok: false, error: '二级分类类型必须与一级分类一致' }, 400);
      }
      if (!body.color) color = parent.color || color;
      parentId = Number(parent.id);
    } else {
      if (body.kind !== undefined && body.kind !== 'expense' && body.kind !== 'income') {
        return c.json({ ok: false, error: '分类类型仅支持 expense 或 income' }, 400);
      }
      kind = body.kind === 'income' ? 'income' : 'expense';
    }

    const icon = String(body.icon || '🏷️').trim().slice(0, 8) || '🏷️';
    const sortOrder =
      body.sort_order !== undefined && String(body.sort_order).trim() !== ''
        ? Math.round(Number(body.sort_order) || 0)
        : 0;

    const ins = await db.run(
      'INSERT INTO categories (ledger_id, parent_id, kind, name, icon, color, is_system, is_archived, sort_order) VALUES (?,?,?,?,?,?,0,0,?)',
      oa.ledgerId,
      parentId,
      kind,
      name,
      icon,
      color,
      sortOrder,
    );
    const id = Number(ins.lastInsertRowid);
    const category = await getCategoryWithPath(db, id, oa.ledgerId);
    return c.json({ ok: true, id, category }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleCategoryUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const existing = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '分类不存在' }, 404);
  if (existing.is_system || Number(existing.ledger_id) !== oa.ledgerId) {
    return c.json({ ok: false, error: '内置系统分类不可修改' }, 400);
  }
  try {
    const body = await readJsonObject(c);
    if (body.kind !== undefined && String(body.kind) !== existing.kind) {
      return c.json({ ok: false, error: '分类创建后不允许修改收支类型（kind）' }, 400);
    }
    if (body.parent_id !== undefined) {
      const reqParentId = parseOptionalRefId(body.parent_id, null, '父分类 ID');
      const curParentId = existing.parent_id != null ? Number(existing.parent_id) : null;
      if ((reqParentId ?? null) !== curParentId) {
        return c.json({ ok: false, error: '分类创建后不允许调整父级关系（parent_id）' }, 400);
      }
    }
    const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 20);
    if (!name) return c.json({ ok: false, error: '分类名称不能为空' }, 400);
    const icon = body.icon !== undefined ? String(body.icon || '').trim().slice(0, 8) || '🏷️' : existing.icon;
    const color =
      body.color !== undefined ? String(body.color || '').trim().slice(0, 20) || existing.color : existing.color;
    const sortOrder =
      body.sort_order !== undefined && String(body.sort_order).trim() !== ''
        ? Math.round(Number(body.sort_order) || 0)
        : Number(existing.sort_order);
    const isArchived = parseBoolFlag(body.is_archived, Number(existing.is_archived));

    await db.run(
      'UPDATE categories SET name = ?, icon = ?, color = ?, sort_order = ?, is_archived = ? WHERE id = ? AND ledger_id = ? AND is_system = 0',
      name,
      icon,
      color,
      sortOrder,
      isArchived,
      id,
      oa.ledgerId,
    );
    const category = await getCategoryWithPath(db, id, oa.ledgerId);
    return c.json({ ok: true, id, category });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/categories/:id', handleCategoryUpdate);
openapiRoutes.patch('/categories/:id', handleCategoryUpdate);

openapiRoutes.delete('/categories/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const existing = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '分类不存在' }, 404);
  if (existing.is_system || Number(existing.ledger_id) !== oa.ledgerId) {
    return c.json({ ok: false, error: '仅可删除当前账本的自定义分类' }, 400);
  }
  const childCnt = Number(
    (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND ledger_id = ?', id, oa.ledgerId))
      ?.c || 0,
  );
  if (childCnt > 0) {
    return c.json({ ok: false, error: `该分类下还有 ${childCnt} 个子分类，请先删除子分类` }, 400);
  }
  const used = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND category_id = ? AND deleted_at IS NULL',
        oa.ledgerId,
        id,
      )
    )?.c || 0,
  );
  if (used > 0) {
    return c.json({ ok: false, error: `该分类下还有 ${used} 笔记账，无法删除` }, 400);
  }
  await db.run('DELETE FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0', id, oa.ledgerId);
  return c.json({ ok: true });
});

const TAG_SELECT =
  'SELECT t.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt FROM tags t WHERE t.id = ? AND t.ledger_id = ?';

openapiRoutes.get('/tags', async (c) => {
  const oa = c.get('openAuth')!;
  return c.json({ ok: true, tags: await fd.tags(dbOf(c), oa.ledgerId) });
});

openapiRoutes.get('/tags/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const tag = await dbOf(c).get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
  if (!tag) return c.json({ ok: false, error: '标签不存在' }, 404);
  return c.json({ ok: true, tag });
});

openapiRoutes.post('/tags', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return c.json({ ok: false, error: '请填写标签名称' }, 400);
    const dup = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', oa.ledgerId, name);
    if (dup) return c.json({ ok: false, error: '标签名称已存在' }, 409);
    const color = body.color ? String(body.color).trim().slice(0, 20) || '#0F766E' : '#0F766E';
    const ins = await db.run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', oa.ledgerId, name, color);
    const id = Number(ins.lastInsertRowid);
    const tag = await db.get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
    return c.json({ ok: true, id, tag }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleTagUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const existing = await db.get<{ id: number; ledger_id: number; name: string; color: string }>(
    'SELECT * FROM tags WHERE id = ? AND ledger_id = ?',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '标签不存在' }, 404);
  try {
    const body = await readJsonObject(c);
    const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 20);
    if (!name) return c.json({ ok: false, error: '标签名称不能为空' }, 400);
    if (name !== existing.name) {
      const dup = await db.get<{ id: number }>(
        'SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND id != ?',
        oa.ledgerId,
        name,
        id,
      );
      if (dup) return c.json({ ok: false, error: '标签名称已存在' }, 409);
    }
    const color =
      body.color !== undefined ? String(body.color || '').trim().slice(0, 20) || existing.color : existing.color;
    await db.run('UPDATE tags SET name = ?, color = ? WHERE id = ? AND ledger_id = ?', name, color, id, oa.ledgerId);
    const tag = await db.get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
    return c.json({ ok: true, id, tag });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/tags/:id', handleTagUpdate);
openapiRoutes.patch('/tags/:id', handleTagUpdate);

openapiRoutes.delete('/tags/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const existing = await db.get<{ id: number }>('SELECT id FROM tags WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '标签不存在' }, 404);
  await db.batch([
    ['DELETE FROM transaction_tags WHERE tag_id = ?', [id]],
    ['DELETE FROM tags WHERE id = ? AND ledger_id = ?', [id, oa.ledgerId]],
  ]);
  return c.json({ ok: true });
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

registerPlanningOpenApi(openapiRoutes);

openapiRoutes.get('/export', async (c) => {
  const oa = c.get('openAuth')!;
  const res = await txn.listTransactions(dbOf(c), oa.ledgerId, { page: 1, pageSize: 50000 });
  return c.json({ ok: true, ledger_id: oa.ledgerId, total: res.total, transactions: res.rows });
});
