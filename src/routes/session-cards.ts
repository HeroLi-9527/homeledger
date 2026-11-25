import { canWrite } from '../lib/auth.js';
import { Hono } from 'hono';
import * as fd from '../lib/formdata.js';
import * as sc from '../lib/session-cards.js';
import type { HonoEnv } from '../types.js';
import { sessionCardDetailPage } from '../views/accounts.js';
import { layout } from '../views/layout.js';
import { bodyOf, dbOf, requireLedger, requireWrite, setFlash, siteMeta, takeFlash, toPublicError, wantsJson } from './helpers.js';

export const sessionCardsRoutes = new Hono<HonoEnv>();

sessionCardsRoutes.post('/session-cards', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const isJson = body._json === '1' || wantsJson(c);
  const back = String(body.back || '/accounts#session-cards');

  try {
    const costCents = sc.parseCardCostCents(body, 'total_cost_cents', 'total_cost');
    const totalSessions = Number(body.total_sessions);
    const remainingRaw = body.remaining_sessions;
    const remainingSessions =
      remainingRaw !== undefined && remainingRaw !== null && String(remainingRaw).trim() !== ''
        ? Number(remainingRaw)
        : null;
    const id = await sc.createSessionCard(db, Number(ctx.ledger!.id), ctx.user!.id, {
      name: String(body.name || ''),
      icon: body.icon ? String(body.icon) : '🎟️',
      merchant: body.merchant ? String(body.merchant) : null,
      total_sessions: totalSessions,
      remaining_sessions: remainingSessions,
      total_cost_cents: costCents,
      currency: body.currency ? String(body.currency) : 'CNY',
      purchase_date: body.purchase_date ? String(body.purchase_date) : undefined,
      expires_at: body.expires_at ? String(body.expires_at) : null,
      note: body.note ? String(body.note) : null,
      record_expense: Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false'),
      account_id: body.account_id ? Number(body.account_id) : null,
      category_id: body.category_id ? Number(body.category_id) : null,
    });
    if (isJson) return c.json({ ok: true, id });
    setFlash(c, 'success', '次卡已创建');
    return c.redirect(back);
  } catch (e) {
    const msg = toPublicError(e);
    if (isJson) return c.json({ ok: false, error: msg }, 400);
    setFlash(c, 'error', msg);
    return c.redirect(back);
  }
});

sessionCardsRoutes.get('/session-cards/:id', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const ledgerId = Number(ctx.ledger!.id);
  const id = Number(c.req.param('id'));

  const [card, logs, accounts, expenseCats] = await Promise.all([
    sc.getSessionCard(db, id, ledgerId),
    sc.listCardLogs(db, id, ledgerId),
    fd.accounts(db, ledgerId),
    fd.flatCategories(db, ledgerId, 'expense'),
  ]);

  if (!card) {
    return c.html(
      layout({
        title: '次卡不存在',
        activeNav: 'accounts',
        ctx,
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: '<div class="card">次卡不存在。<a class="btn btn-sm mt12" href="/accounts#session-cards">返回账户管理</a></div>',
      }),
      404,
    );
  }

  return c.html(
    layout({
      title: card.name,
      activeNav: 'accounts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: sessionCardDetailPage({ writable: canWrite(ctx.ledger?.role), card, logs, accounts, expenseCats, csrf: c.get('csrf') || '' }),
    }),
  );
});

sessionCardsRoutes.post('/session-cards/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  try {
    const totalCostCents = sc.parseCardCostCents(body, 'total_cost_cents', 'total_cost');
    await sc.updateSessionCard(db, id, ledgerId, {
      name: String(body.name || ''),
      icon: body.icon ? String(body.icon) : '🎟️',
      merchant: body.merchant !== undefined ? String(body.merchant) : undefined,
      total_cost_cents: totalCostCents,
      expires_at: body.expires_at !== undefined ? String(body.expires_at) : undefined,
      note: body.note !== undefined ? String(body.note) : undefined,
    });
    setFlash(c, 'success', '次卡信息已更新');
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect(`/session-cards/${id}`);
});

sessionCardsRoutes.post('/session-cards/:id/use', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const isJson = body._json === '1' || wantsJson(c);
  const back = String(body.back || `/session-cards/${id}`);

  try {
    const count = body.count !== undefined && body.count !== '' ? Number(body.count) : 1;
    const res = await sc.useSessionCard(db, id, ledgerId, ctx.user!.id, {
      count,
      used_at: body.used_at ? String(body.used_at) : undefined,
      note: body.note ? String(body.note) : null,
    });
    if (isJson) return c.json({ ok: true, ...res });
    setFlash(c, 'success', `已核销 ${count} 次，当前剩余 ${res.card.remaining_sessions} 次`);
    return c.redirect(back);
  } catch (e) {
    const msg = toPublicError(e);
    if (isJson) return c.json({ ok: false, error: msg }, 400);
    setFlash(c, 'error', msg);
    return c.redirect(back);
  }
});

sessionCardsRoutes.post('/session-cards/:id/topup', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  try {
    const addCostCents = sc.parseCardCostCents(body, 'add_cost_cents', 'add_cost');
    const card = await sc.topUpSessionCard(db, id, ledgerId, ctx.user!.id, {
      add_sessions: Number(body.add_sessions),
      add_cost_cents: addCostCents,
      topup_date: body.topup_date ? String(body.topup_date) : undefined,
      expires_at: body.expires_at !== undefined ? String(body.expires_at) : undefined,
      note: body.note ? String(body.note) : null,
      record_expense: Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false'),
      account_id: body.account_id ? Number(body.account_id) : null,
      category_id: body.category_id ? Number(body.category_id) : null,
    });
    setFlash(c, 'success', `续费加次成功，当前剩余 ${card.remaining_sessions}/${card.total_sessions} 次`);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect(`/session-cards/${id}`);
});

sessionCardsRoutes.post('/session-cards/:id/logs/:logId/undo', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const logId = Number(c.req.param('logId'));
  try {
    const res = await sc.undoSessionCardLog(db, id, logId, ledgerId);
    setFlash(c, 'success', `已撤销核销，回补 ${res.restored} 次`);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect(`/session-cards/${id}`);
});

sessionCardsRoutes.post('/session-cards/:id/archive', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  await sc.toggleArchiveSessionCard(db, id, ledgerId);
  return c.redirect(String(body.back || '/accounts#session-cards'));
});

sessionCardsRoutes.post('/session-cards/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const deleted = await sc.deleteSessionCard(db, id, ledgerId);
  setFlash(c, deleted ? 'success' : 'error', deleted ? '次卡已删除（已产生的购卡支出流水不受影响）' : '次卡不存在');
  return c.redirect('/accounts#session-cards');
});
