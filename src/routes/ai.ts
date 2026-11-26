import { canWriteLedger } from '../lib/auth.js';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { analyzeBill, getAiConfig } from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as fd from '../lib/formdata.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { Db, Env, HonoEnv } from '../types.js';
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

export const MAX_AI_TEXT_LEN = 4000;

export interface RawAiImage {
  dataUrl: string;
  name?: string;
}

export interface ValidatedAiImage {
  dataUrl: string;
  mime: string;
  buf: Buffer;
  name?: string;
}

export type SavedAiImage = Awaited<ReturnType<typeof attach.saveBufferImage>>;

export function extractRawImages(body: Record<string, unknown>): RawAiImage[] {
  const rawList = Array.isArray(body.images) ? body.images.slice(0, attach.MAX_IMAGES) : [];
  const out: RawAiImage[] = [];
  for (const img of rawList) {
    const dataUrl = typeof img === 'string' ? img : String((img as { dataUrl?: string })?.dataUrl || '');
    const name = typeof img === 'object' && img ? String((img as { name?: string })?.name || '').trim() : '';
    if (!dataUrl) continue;
    out.push({ dataUrl, ...(name ? { name } : {}) });
  }
  return out;
}

export function validateRawImages(rawImages: RawAiImage[]): ValidatedAiImage[] {
  return rawImages.map((img) => {
    const { mime, buf } = attach.parseDataUrl(img.dataUrl);
    return {
      dataUrl: img.dataUrl,
      mime,
      buf,
      ...(img.name ? { name: img.name } : {}),
    };
  });
}

export async function saveAiImagesBestEffort(
  db: Db,
  env: Pick<Env, 'ATTACHMENTS'>,
  {
    ledgerId,
    userId,
    rawImages,
    aiStatus = 'pending',
  }: { ledgerId: number; userId: number; rawImages: ValidatedAiImage[]; aiStatus?: string },
): Promise<{ saved: SavedAiImage[]; failed: boolean }> {
  if (!rawImages.length) return { saved: [], failed: false };
  if (!env?.ATTACHMENTS) return { saved: [], failed: true };
  const saved: SavedAiImage[] = [];
  let failed = false;
  for (const img of rawImages) {
    try {
      saved.push(
        await attach.saveBufferImage(db, env, {
          buf: img.buf,
          mime: img.mime,
          ledgerId,
          userId,
          name: img.name,
          kind: 'screenshot',
          aiStatus,
        }),
      );
    } catch (e) {
      console.error('[ai] save image failed:', e);
      failed = true;
    }
  }
  return { saved, failed };
}

export async function cleanupSavedAiImages(
  db: Db,
  env: Pick<Env, 'ATTACHMENTS'>,
  ledgerId: number,
  savedImages: Array<{ id: number }>,
): Promise<void> {
  if (!savedImages.length) return;
  for (const img of savedImages) {
    await attach.removeById(db, env, ledgerId, img.id).catch(() => {});
  }
}

export function buildAiJson(draftId?: string | null, extra?: Record<string, unknown>): string {
  const cleanDraft = draftId ? String(draftId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
  const payload: Record<string, unknown> = {
    ...(cleanDraft ? { draft_id: cleanDraft } : {}),
    ...(extra || {}),
  };
  const json = JSON.stringify(payload);
  if (json.length <= 4000) return json;
  return cleanDraft ? JSON.stringify({ draft_id: cleanDraft }).slice(0, 4000) : json.slice(0, 4000);
}

export async function findDuplicateAiTxn(
  db: Db,
  ledgerId: number,
  item: {
    draft_id?: string | null;
    type?: string;
    txn_date?: string;
    amount_cents?: number;
    currency?: string | null;
    account_id?: number | null;
    merchant?: string | null;
  },
  source: string,
  opts: { allowNaturalKey?: boolean; excludeIds?: number[]; windowSeconds?: number } = {},
): Promise<number | null> {
  const exclude = (opts.excludeIds || []).filter((n) => Number.isInteger(n) && n > 0);
  const excludeSql = exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
  const draftId = item.draft_id ? String(item.draft_id).replace(/[^A-Za-z0-9_-]/g, '') : '';
  if (draftId) {
    const byDraft = await db.get<{ id: number }>(
      `SELECT id FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND ai_json LIKE ?${excludeSql}`,
      ledgerId,
      `%"draft_id":"${draftId}"%`,
      ...exclude,
    );
    if (byDraft) return Number(byDraft.id);
  }
  if (!opts.allowNaturalKey) return null;

  const type = String(item.type || 'expense');
  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(item.txn_date || '')) ? String(item.txn_date) : todayStr();
  const amt = Math.abs(Math.round(Number(item.amount_cents || 0)));
  if (!(amt > 0)) return null;
  const currency = String(item.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
  const accountId = item.account_id ? Number(item.account_id) : 0;
  const merchant = item.merchant != null ? String(item.merchant).trim().slice(0, 60) : '';
  const winSec = Math.max(1, Number(opts.windowSeconds ?? 120));
  const since = nowStr(new Date(Date.now() - winSec * 1000));
  const byNatural = await db.get<{ id: number }>(
    `SELECT id FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND type = ? AND txn_date = ?
       AND UPPER(currency) = ? AND amount_cents = ? AND COALESCE(account_id, 0) = ?
       AND COALESCE(merchant, '') = ? AND source = ? AND created_at >= ?${excludeSql}
     LIMIT 1`,
    ledgerId,
    type,
    txnDate,
    currency,
    amt,
    accountId,
    merchant,
    source,
    since,
    ...exclude,
  );
  return byNatural ? Number(byNatural.id) : null;
}

aiRoutes.get('/ai', async (c) => {
  const r = requireWrite(c);
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
       WHERE a.ledger_id = ? AND ${attach.visibleAttachment}
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

  const rawImages = extractRawImages(body);
  const text = String(body.text || '').trim();
  if (!rawImages.length && !text) {
    return c.json({ ok: false, error: '请上传账单截图或输入消费描述' }, 400);
  }
  if (text.length > MAX_AI_TEXT_LEN) {
    return c.json({ ok: false, error: `输入文字不能超过 ${MAX_AI_TEXT_LEN} 字` }, 400);
  }

  try {
    const validImages = validateRawImages(rawImages);
    const [cfg, res] = await Promise.all([
      getAiConfig(db),
      analyzeBill(db, { images: validImages, text, ledgerId }),
    ]);
    const items = res.items.map((it) => ({
      ...it,
      draft_id: it.draft_id || u.uid(12),
    }));

    const warnings = [...res.warnings];
    let savedImages: SavedAiImage[] = [];
    let imageSaveFailed = false;
    if (items.length > 0 && validImages.length > 0) {
      const saved = await saveAiImagesBestEffort(db, env, {
        ledgerId,
        userId,
        rawImages: validImages,
        aiStatus: 'pending',
      });
      savedImages = saved.saved;
      imageSaveFailed = saved.failed;
      if (imageSaveFailed) {
        warnings.push('部分凭证图片保存失败，仍可继续核对入库');
      }
    }

    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      autoSave: cfg.autoSave,
      items,
      warnings,
      images: savedImages,
      ...(imageSaveFailed ? { imageSaveFailed: true } : {}),
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
    const type = String(it.type || 'expense');
    const txnDate = String(it.txn_date || '');
    const merchant = it.merchant != null ? String(it.merchant) : null;
    const draftId = it.draft_id ? String(it.draft_id).replace(/[^A-Za-z0-9_-]/g, '') : '';

    const currency = String(it.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';

    const dupId = await findDuplicateAiTxn(
      db,
      ledgerId,
      { draft_id: draftId, type, txn_date: txnDate, amount_cents: amountCents, currency, merchant },
      source,
      { allowNaturalKey: false },
    );
    if (dupId) {
      duplicates++;
      continue;
    }
    try {
      const id = await txn.createTransaction(db, ledgerId, userId, {
        type,
        amount_cents: amountCents,
        currency,
        account_id: (it.account_id as string | number | null) ?? null,
        to_account_id: (it.to_account_id as string | number | null) ?? null,
        category_id: (it.category_id as string | number | null) ?? null,
        txn_date: txnDate,
        note: it.note != null ? String(it.note) : null,
        merchant,
        source,
        ai_json: buildAiJson(draftId, it.confidence != null ? { confidence: it.confidence } : undefined),
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
  if (text.length > MAX_AI_TEXT_LEN) {
    return c.json({ ok: false, error: `输入文字不能超过 ${MAX_AI_TEXT_LEN} 字` }, 400);
  }

  try {
    const [cfg, res] = await Promise.all([getAiConfig(db), analyzeBill(db, { text, ledgerId })]);
    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      autoSave: cfg.autoSave,
      items: res.items.map((it) => ({ ...it, draft_id: it.draft_id || u.uid(12) })),
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

  const rawImages = extractRawImages(body);
  const text = String(body.text || '').trim();
  if (!rawImages.length && !text) {
    return c.json({ ok: false, error: '请输入记账描述或发送账单截图' }, 400);
  }
  if (text.length > MAX_AI_TEXT_LEN) {
    return c.json({ ok: false, error: `输入文字不能超过 ${MAX_AI_TEXT_LEN} 字` }, 400);
  }

  let savedImages: SavedAiImage[] = [];
  const createdIds: number[] = [];
  try {
    const validImages = validateRawImages(rawImages);
    const res = await analyzeBill(db, { images: validImages, text, ledgerId });
    if (!res.items.length) {
      return c.json(
        {
          ok: false,
          error: res.warnings[0] || '未能识别出有效金额，请试试「午饭 35 元」或上传清晰账单截图',
        },
        400,
      );
    }

    const warnings = [...res.warnings];
    let imageSaveFailed = false;
    if (validImages.length > 0) {
      const saved = await saveAiImagesBestEffort(db, env, {
        ledgerId,
        userId,
        rawImages: validImages,
        aiStatus: 'pending',
      });
      savedImages = saved.saved;
      imageSaveFailed = saved.failed;
      if (imageSaveFailed) warnings.push('凭证图片保存失败，流水已继续入库');
    }

    const source = validImages.length ? 'ai_screenshot' : 'ai_text';
    let duplicates = 0;
    const errors: string[] = [];
    for (let i = 0; i < res.items.length; i++) {
      const it = res.items[i];
      if (!(it.amount_cents > 0)) continue;
      const currency = String(it.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
      const dupId = await findDuplicateAiTxn(
        db,
        ledgerId,
        {
          draft_id: it.draft_id,
          type: it.type,
          txn_date: it.txn_date,
          amount_cents: it.amount_cents,
          currency,
          account_id: it.account_id,
          merchant: it.merchant,
        },
        source,
        { allowNaturalKey: true, excludeIds: createdIds, windowSeconds: 120 },
      );
      if (dupId) {
        duplicates++;
        continue;
      }
      try {
        const id = await txn.createTransaction(db, ledgerId, userId, {
          type: it.type,
          amount_cents: it.amount_cents,
          currency,
          account_id: it.account_id,
          category_id: it.category_id,
          txn_date: it.txn_date,
          note: it.note,
          merchant: it.merchant,
          source,
          ai_json: buildAiJson(it.draft_id, { engine: res.engine, ...(res.model ? { model: res.model } : {}) }),
        });
        createdIds.push(id);
      } catch (e) {
        errors.push(`第 ${i + 1} 笔（${toPublicError(e)}）`);
      }
    }

    if (createdIds.length && savedImages.length) {
      await attach.linkImagesToTxns(db, {
        ledgerId,
        imageIds: savedImages.map((s) => s.id),
        txnIds: createdIds,
        aiStatus: 'linked',
      });
    } else if (!createdIds.length && savedImages.length) {
      await cleanupSavedAiImages(db, env, ledgerId, savedImages);
      savedImages = [];
    }

    if (!createdIds.length && errors.length && duplicates === 0) {
      return c.json({ ok: false, error: errors[0], errors }, 400);
    }

    return c.json({
      ok: true,
      engine: res.engine,
      model: res.model,
      created: createdIds.length,
      duplicates,
      ids: createdIds,
      items: res.items,
      warnings,
      ...(errors.length ? { errors } : {}),
      ...(imageSaveFailed ? { imageSaveFailed: true } : {}),
    });
  } catch (e) {
    if (!createdIds.length && savedImages.length) {
      await cleanupSavedAiImages(db, env, ledgerId, savedImages);
    }
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
    (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM attachments a WHERE a.ledger_id = ? AND ${attach.visibleAttachment}`, ledgerId))?.c || 0,
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const curPage = Math.min(page, totalPages);
  const offset = (curPage - 1) * pageSize;

  const rows = await db.all<attach.AttachmentRow & { linked_txn_id?: number | null; txn_date?: string | null; merchant?: string | null; amount_cents?: number | null }>(
    `SELECT a.*, t.id AS linked_txn_id, t.txn_date, t.merchant, t.amount_base_cents AS amount_cents
     FROM attachments a
     LEFT JOIN transactions t ON t.id = a.txn_id AND t.deleted_at IS NULL
     WHERE a.ledger_id = ? AND ${attach.visibleAttachment}
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
      body: attachmentsPage({ writable: canWriteLedger(ctx.ledger), rows, page: curPage, total, totalPages, csrf: c.get('csrf') || '' }),
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
