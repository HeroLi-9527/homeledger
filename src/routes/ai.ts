import type { Context } from 'hono';
import { Hono } from 'hono';
import { analyzeBill, getAiConfig } from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as fd from '../lib/formdata.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { aiPage, attachmentsPage } from '../views/ai.js';
import { layout } from '../views/layout.js';
import {
  bodyOf,
  dbOf,
  envOf,
  requireLogin,
  requireWrite,
  setFlash,
  siteMeta,
  takeFlash,
  toPublicError,
  wantsJson,
} from './helpers.js';

export const aiRoutes = new Hono<HonoEnv>();

aiRoutes.get('/ai', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);

  const [cfg, recent, form] = await Promise.all([
    getAiConfig(db),
    db.all<attach.AttachmentRow & { amount_cents?: number | null; txn_date?: string | null; merchant?: string | null }>(
      `SELECT a.*, t.amount_base_cents AS amount_cents, t.txn_date, t.merchant
       FROM attachments a
       LEFT JOIN transactions t ON t.id = a.txn_id AND t.deleted_at IS NULL
       WHERE a.ledger_id = ?
       ORDER BY a.id DESC LIMIT 12`,
      ledgerId,
    ),
    fd.txFormData(db, ledgerId),
  ]);

  const aiForm = {
    categories: [...form.expenseCats, ...form.incomeCats].map((cat) => ({
      id: cat.id,
      name: cat.name,
      path: cat.path,
      kind: cat.kind,
    })),
    accounts: form.accounts.map((acc) => ({ id: acc.id, name: acc.name, icon: acc.icon })),
  };
  const csrf = c.get('csrf') || '';
  const cspNonce = c.get('cspNonce') || '';

  return c.html(
    layout({
      title: 'AI 智能记账',
      activeNav: 'ai',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce,
      flash: takeFlash(c),
      body: aiPage({ cfg, recent, aiForm, csrf, cspNonce }),
    }),
  );
});

async function handleAnalyze(c: Context<HonoEnv>) {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const userId = Number(ctx.user!.id);
  const body = await bodyOf(c);

  const rawImages = Array.isArray(body.images) ? body.images.slice(0, attach.MAX_IMAGES) : [];
  const text = String(body.text || '').trim();
  if (!rawImages.length && !text) {
    return c.json({ ok: false, error: '请上传账单截图或输入消费描述' }, 400);
  }

  const savedImages: Array<Awaited<ReturnType<typeof attach.saveDataUrlImage>>> = [];
  const analyzeImages: Array<{ dataUrl: string }> = [];

  try {
    for (const img of rawImages) {
      const dataUrl = typeof img === 'string' ? img : String((img as { dataUrl?: string })?.dataUrl || '');
      const name = typeof img === 'object' && img ? String((img as { name?: string })?.name || '') : undefined;
      if (!dataUrl) continue;
      analyzeImages.push({ dataUrl });
      const saved = await attach.saveDataUrlImage(db, env, {
        dataUrl,
        ledgerId,
        userId,
        name: name || undefined,
        kind: 'screenshot',
        aiStatus: 'analyzed',
      });
      savedImages.push(saved);
    }

    const res = await analyzeBill(db, { images: analyzeImages, text, ledgerId });
    const items = res.items.map((it) => ({
      ...it,
      draft_id: u.uid(12),
    }));

    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      items,
      warnings: res.warnings,
      images: savedImages,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

aiRoutes.post('/ai/analyze', handleAnalyze);
aiRoutes.post('/api/ai/scan', handleAnalyze);

async function handleConfirm(c: Context<HonoEnv>) {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const userId = Number(ctx.user!.id);
  const body = await bodyOf(c);

  const items = Array.isArray(body.items) ? body.items : [];
  const imageIds = Array.isArray(body.image_ids) ? body.image_ids.map(Number).filter(Boolean) : [];
  const source = String(body.source || (imageIds.length ? 'ai_screenshot' : 'ai_text')).slice(0, 30);

  if (!items.length) {
    return c.json({ ok: false, error: '没有可保存的草稿项' }, 400);
  }

  const createdIds: number[] = [];
  let duplicates = 0;
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = (items[i] || {}) as Record<string, unknown>;
    const amountCents = it.amount_cents != null ? Math.round(Number(it.amount_cents)) : u.parseAmountToCents(it.amount);
    if (!(amountCents > 0)) {
      errors.push(`第 ${i + 1} 笔金额无效`);
      continue;
    }
    const draftId = it.draft_id ? String(it.draft_id).replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (draftId) {
      const existing = await db.get<{ id: number }>(
        'SELECT id FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND ai_json LIKE ?',
        ledgerId,
        `%"draft_id":"${draftId}"%`,
      );
      if (existing) {
        duplicates++;
        continue;
      }
    }
    try {
      const id = await txn.createTransaction(db, ledgerId, userId, {
        type: String(it.type || 'expense'),
        amount_cents: amountCents,
        currency: String(it.currency || 'CNY'),
        account_id: (it.account_id as string | number | null) ?? null,
        to_account_id: (it.to_account_id as string | number | null) ?? null,
        category_id: (it.category_id as string | number | null) ?? null,
        txn_date: String(it.txn_date || ''),
        note: it.note != null ? String(it.note) : null,
        merchant: it.merchant != null ? String(it.merchant) : null,
        source,
        ai_json: JSON.stringify({
          ...(draftId ? { draft_id: draftId } : {}),
          ...(it.confidence != null ? { confidence: it.confidence } : {}),
        }),
      });
      createdIds.push(id);
    } catch (e) {
      errors.push(`第 ${i + 1} 笔（${toPublicError(e)}）`);
    }
  }

  if (createdIds.length && imageIds.length) {
    await attach.linkImagesToTxns(db, {
      ledgerId,
      imageIds,
      txnIds: createdIds,
      aiStatus: 'linked',
    });
  }

  return c.json({
    ok: createdIds.length > 0 || duplicates > 0,
    created: createdIds.length,
    ids: createdIds,
    duplicates,
    errors,
  });
}

aiRoutes.post('/ai/confirm', handleConfirm);
aiRoutes.post('/api/ai/confirm', handleConfirm);

aiRoutes.post('/api/ai/text', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const body = await bodyOf(c);
  const text = String(body.text || '').trim();
  if (!text) return c.json({ ok: false, error: '请输入消费描述' }, 400);

  try {
    const res = await analyzeBill(db, { text, ledgerId });
    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      items: res.items.map((it) => ({ ...it, draft_id: u.uid(12) })),
      warnings: res.warnings,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

aiRoutes.post('/api/ai/chat', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const userId = Number(ctx.user!.id);
  const body = await bodyOf(c);

  const rawImages = Array.isArray(body.images) ? body.images.slice(0, attach.MAX_IMAGES) : [];
  const text = String(body.text || '').trim();
  if (!rawImages.length && !text) {
    return c.json({ ok: false, error: '请输入记账描述或发送账单截图' }, 400);
  }

  const savedImages: Array<Awaited<ReturnType<typeof attach.saveDataUrlImage>>> = [];
  const analyzeImages: Array<{ dataUrl: string }> = [];

  try {
    for (const img of rawImages) {
      const dataUrl = typeof img === 'string' ? img : String((img as { dataUrl?: string })?.dataUrl || '');
      const name = typeof img === 'object' && img ? String((img as { name?: string })?.name || '') : undefined;
      if (!dataUrl) continue;
      analyzeImages.push({ dataUrl });
      savedImages.push(
        await attach.saveDataUrlImage(db, env, {
          dataUrl,
          ledgerId,
          userId,
          name: name || undefined,
          kind: 'screenshot',
          aiStatus: 'analyzed',
        }),
      );
    }

    const res = await analyzeBill(db, { images: analyzeImages, text, ledgerId });
    if (!res.items.length) {
      return c.json(
        {
          ok: false,
          error: res.warnings[0] || '未能识别出有效金额，请试试「午饭 35 元」或上传清晰账单截图',
        },
        400,
      );
    }

    const createdIds: number[] = [];
    const source = rawImages.length ? 'ai_screenshot' : 'ai_text';
    for (const it of res.items) {
      if (!(it.amount_cents > 0)) continue;
      const id = await txn.createTransaction(db, ledgerId, userId, {
        type: it.type,
        amount_cents: it.amount_cents,
        currency: it.currency || 'CNY',
        account_id: it.account_id,
        category_id: it.category_id,
        txn_date: it.txn_date,
        note: it.note,
        merchant: it.merchant,
        source,
      });
      createdIds.push(id);
    }

    if (createdIds.length && savedImages.length) {
      await attach.linkImagesToTxns(db, {
        ledgerId,
        imageIds: savedImages.map((s) => s.id),
        txnIds: createdIds,
        aiStatus: 'linked',
      });
    }

    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      created: createdIds.length,
      ids: createdIds,
      items: res.items,
      warnings: res.warnings,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

aiRoutes.get('/attachments', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);

  const pageSize = 30;
  const page = Math.max(1, Number(c.req.query('page') || 1));
  const total = Number(
    (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM attachments WHERE ledger_id = ?', ledgerId))?.c || 0,
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const curPage = Math.min(page, totalPages);
  const offset = (curPage - 1) * pageSize;

  const rows = await db.all<attach.AttachmentRow & { linked_txn_id?: number | null; txn_date?: string | null; merchant?: string | null; amount_cents?: number | null }>(
    `SELECT a.*, t.id AS linked_txn_id, t.txn_date, t.merchant, t.amount_base_cents AS amount_cents
     FROM attachments a
     LEFT JOIN transactions t ON t.id = a.txn_id AND t.deleted_at IS NULL
     WHERE a.ledger_id = ?
     ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    ledgerId,
    pageSize,
    offset,
  );

  return c.html(
    layout({
      title: '附件存档',
      activeNav: 'attachments',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: attachmentsPage({ rows, page: curPage, total, totalPages, csrf: c.get('csrf') || '' }),
    }),
  );
});

aiRoutes.post('/attachments/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const ok = await attach.removeById(db, envOf(c), ledgerId, id);
  if (body._json === '1' || wantsJson(c)) {
    return c.json(ok ? { ok: true } : { ok: false, error: '附件不存在' }, ok ? 200 : 404);
  }
  const back = u.safeInternalPath(body.back, '/attachments');
  setFlash(c, ok ? 'success' : 'error', ok ? '附件已从数据库与 R2 存储删除' : '附件不存在');
  return c.redirect(back);
});
