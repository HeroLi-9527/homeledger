import { Hono } from 'hono';
import { isCreditGroupType, todayStr, TXN_TYPE_MAP } from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import * as attach from '../lib/attachments.js';
import * as fd from '../lib/formdata.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { groupList, layout, paginationHtml } from '../views/layout.js';
import { txnFormPage } from '../views/transactions.js';
import { bodyOf, dbOf, envOf, requireLedger, requireLogin, requireWrite, setFlash, siteMeta, takeFlash, toPublicError, wantsJson } from './helpers.js';

export const txnRoutes = new Hono<HonoEnv>();

function readForm(body: Record<string, unknown>): txn.TxnWriteInput {
  const splits: txn.SplitInput[] = [];
  const names = ([] as unknown[]).concat(body.split_name || []);
  const amounts = ([] as unknown[]).concat(body.split_amount || []);
  names.forEach((n, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (n && amt) splits.push({ member_name: String(n).slice(0, 30), share_cents: amt });
  });
  return {
    type: String(body.type || 'expense'),
    amount_cents: u.parseAmountToCents(body.amount),
    currency: String(body.currency || 'CNY'),
    rate: body.rate === undefined || body.rate === '' ? null : Number(body.rate),
    account_id: (body.account_id as string | null) || null,
    to_account_id: (body.to_account_id as string | null) || null,
    category_id: (body.category_id as string | null) || null,
    txn_date: String(body.txn_date || todayStr()),
    note: String(body.note || ''),
    merchant: String(body.merchant || ''),
    status: String(body.status || 'cleared'),
    is_reimbursable: body.is_reimbursable ? 1 : 0,
    tags: String(body.tags || ''),
    splits,
    group_id: (body.group_id as string | null) || null,
    source: String(body.source || 'manual'),
    updated_at: (body.updated_at as string | undefined) || undefined,
  };
}

txnRoutes.get('/transactions', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);
  const q = c.req.query();
  const f: txn.TxnFilter = {
    type: q.type || undefined,
    kind: q.kind === 'expense' || q.kind === 'income' ? q.kind : undefined,
    categoryId: q.category_id ? Number(q.category_id) : undefined,
    accountId: q.account_id ? Number(q.account_id) : undefined,
    memberId: q.member_id ? Number(q.member_id) : undefined,
    tagId: q.tag_id ? Number(q.tag_id) : undefined,
    source: q.source || undefined,
    month: q.month || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    keyword: q.q || undefined,
    reimbursable: q.reimbursable === 'yes' || q.reimbursable === 'done' ? q.reimbursable : undefined,
    sort: (q.sort as txn.TxnFilter['sort']) || 'date_desc',
    page: Number(q.page) || 1,
    pageSize: 40,
  };
  const [result, cats, form] = await Promise.all([
    txn.listTransactions(db, ledgerId, f),
    fd.flatCategories(db, ledgerId),
    fd.txFormData(db, ledgerId),
  ]);
  const groups = await txn.groupByDate(result.rows, db);
  const filterQuery: Record<string, string | number | undefined> = {
    type: f.type,
    kind: f.kind,
    category_id: f.categoryId,
    account_id: f.accountId,
    member_id: f.memberId,
    tag_id: f.tagId,
    source: f.source,
    month: f.month,
    from: f.from,
    to: f.to,
    q: f.keyword,
    reimbursable: f.reimbursable,
    sort: q.sort || undefined,
  };
  const hasAnyFilter = Object.values(filterQuery).some((v) => v !== undefined && v !== '');
  const hiddenFilters = [
    f.kind ? ['kind', f.kind] : null,
    f.accountId ? ['account_id', String(f.accountId)] : null,
    f.memberId ? ['member_id', String(f.memberId)] : null,
    f.tagId ? ['tag_id', String(f.tagId)] : null,
    f.source ? ['source', f.source] : null,
    f.from ? ['from', f.from] : null,
    f.to ? ['to', f.to] : null,
    f.reimbursable ? ['reimbursable', f.reimbursable] : null,
    q.sort ? ['sort', q.sort] : null,
  ].filter((x): x is [string, string] => Boolean(x));

  return c.html(
    layout({
      title: '账单明细',
      activeNav: 'transactions',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card"><form method="get" action="/transactions">
  ${hiddenFilters.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
  <div class="grid grid-4">
    <select name="type"><option value="">全部类型</option>${Object.entries(TXN_TYPE_MAP).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
    <select name="category_id"><option value="">全部分类</option>${cats.map((cc) => `<option value="${cc.id}" ${f.categoryId === cc.id ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select>
    <input type="month" name="month" value="${esc(f.month || '')}">
    <input name="q" value="${esc(f.keyword || '')}" placeholder="关键词">
  </div>
  <div class="row mt12 wrap">
    <button class="btn btn-primary" type="submit">筛选</button>
    <a class="btn" href="/transactions?reimbursable=yes">待报销</a>
    ${hasAnyFilter ? '<a class="btn" href="/transactions">清空筛选</a>' : ''}
    <span class="muted small amount">共 ${result.total} 笔 · 收入 +${u.fmtAmount(result.sum.income)} · 支出 -${u.fmtAmount(result.sum.expense)}</span>
  </div>
</form></div>
<div class="mt16">
<form id="bulk-form" method="post" action="/transactions/bulk-delete">
  <input type="hidden" name="_csrf" value="${esc(c.get('csrf') || '')}">
  <div class="card">
    <div class="row mb12">
      <label class="check"><input type="checkbox" id="bulk-all"> 全选本页</label>
      <span class="spacer"></span>
      <a class="btn btn-sm btn-ghost" href="/transactions/deleted">已删除 →</a>
    </div>
    ${groupList(groups, { bulk: true })}
  </div>
  <div class="card hidden mt12" id="bulk-bar" style="position:sticky;bottom:10px;z-index:40">
    <div class="row wrap">
      <span class="small">已选 <b id="bulk-count">0</b> 笔：</span>
      <button class="btn btn-sm btn-danger" type="submit">批量删除</button>
      <select name="account_id" style="width:auto">${accountOptionsHtml(form.accounts, { emptyLabel: '报销入账账户…' })}</select>
      <button class="btn btn-sm btn-primary" type="submit" formaction="/transactions/bulk-reimburse">报销入账</button>
    </div>
  </div>
</form>
</div>
${paginationHtml('/transactions', filterQuery, result.page, result.pages, result.total)}`,
    }),
  );
});

txnRoutes.get('/transactions/new', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const ledgerId = Number(ctx.ledger!.id);
  const q = c.req.query();
  const type = TXN_TYPE_MAP[q.type] ? q.type : 'expense';
  const form = await fd.txFormData(db, ledgerId);
  const toAccountId = q.to_account_id ? String(q.to_account_id) : '';
  let defaultAccountId = q.account_id || (form.accounts[0] ? String(form.accounts[0].id) : '');
  if (!q.account_id && type === 'transfer' && toAccountId) {
    const fallback =
      form.accounts.find((a) => String(a.id) !== toAccountId && !isCreditGroupType(a.type)) ||
      form.accounts.find((a) => String(a.id) !== toAccountId);
    defaultAccountId = fallback ? String(fallback.id) : '';
  }
  const prefill = {
    type,
    amount: q.amount || '',
    txn_date: q.date || todayStr(),
    category_id: q.category_id || '',
    account_id: defaultAccountId,
    to_account_id: toAccountId,
    note: q.note || '',
    merchant: '',
    tags: '',
    is_reimbursable: 0,
    currency: 'CNY',
    rate: '',
    status: 'cleared',
  };
  return c.html(
    layout({
      title: '记一笔',
      activeNav: 'new',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      body: txnFormPage({
        form,
        t: prefill,
        mode: 'create',
        back: q.back || '/transactions',
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        action: '/transactions',
      }),
    }),
  );
});

txnRoutes.post('/transactions', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const data = readForm(body);
  const isJson = body._json === '1' || wantsJson(c);
  try {
    const id = await txn.createTransaction(db, Number(ctx.ledger!.id), ctx.user!.id, data);
    if (isJson) return c.json({ ok: true, id, redirect: '/transactions' });
    setFlash(c, 'success', '已记一笔 ✓');
    return c.redirect(String(body.back || '/transactions'));
  } catch (e) {
    if (isJson) return c.json({ ok: false, error: toPublicError(e) }, 400);
    const [form, meta] = await Promise.all([fd.txFormData(db, Number(ctx.ledger!.id)), siteMeta(c)]);
    return c.html(
      layout({
        title: '记一笔',
        activeNav: 'new',
        ctx,
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: txnFormPage({
          form,
          t: { ...data, amount: (data.amount_cents / 100).toFixed(2) },
          mode: 'create',
          back: String(body.back || '/transactions'),
          csrf: c.get('csrf') || '',
          cspNonce: c.get('cspNonce'),
          action: '/transactions',
          splitRows: (data.splits || []).map((s) => ({ member_name: s.member_name || '', share_cents: s.share_cents })),
          error: toPublicError(e),
        }),
      }),
      400,
    );
  }
});

txnRoutes.post('/transactions/bulk-delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const ids = ([] as unknown[])
    .concat(body.ids || [], body.del_ids || [])
    .map(Number)
    .filter(Boolean);
  const res = await txn.bulkDelete(db, ids, Number(ctx.ledger!.id), { env: envOf(c) });
  if (body._json === '1' || wantsJson(c)) return c.json({ ok: true, ...res });
  const reasons = [...new Set(res.skipped.map((s) => s.reason))];
  setFlash(c, 'success', `已删除 ${res.deleted} 笔${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`);
  return c.redirect(String(body.back || '/transactions'));
});

txnRoutes.post('/transactions/bulk-reimburse', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const ids = ([] as unknown[]).concat(body.ids || []).map(Number).filter(Boolean);
  const accountId = body.account_id ? Number(body.account_id) : 0;
  const isJson = body._json === '1' || wantsJson(c);
  try {
    const res = await txn.markReimbursed(db, ids, Number(ctx.ledger!.id), ctx.user!.id, accountId);
    if (isJson) return c.json({ ok: true, ...res });
    const reasons = [...new Set(res.skipped.map((s) => s.reason))];
    setFlash(
      c,
      'success',
      `已标记 ${res.count} 笔为已报销，生成入账 ${(res.total / 100).toFixed(2)}${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
    );
    return c.redirect(u.safeInternalPath(body.back, '/transactions'));
  } catch (e) {
    if (isJson) return c.json({ ok: false, error: toPublicError(e) }, 400);
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(u.safeInternalPath(body.back, '/transactions'));
  }
});

txnRoutes.post('/transactions/:id/reimburse', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const accountId = body.account_id ? Number(body.account_id) : 0;
  const isJson = body._json === '1' || wantsJson(c);
  try {
    const res = await txn.markReimbursed(db, [id], Number(ctx.ledger!.id), ctx.user!.id, accountId);
    if (isJson) return c.json({ ok: true, ...res });
    setFlash(c, 'success', `已标记为已报销，生成入账 ${(res.total / 100).toFixed(2)}`);
    return c.redirect(u.safeInternalPath(body.back, '/transactions'));
  } catch (e) {
    if (isJson) return c.json({ ok: false, error: toPublicError(e) }, 400);
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(u.safeInternalPath(body.back, '/transactions'));
  }
});

txnRoutes.get('/transactions/deleted', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<{ id: number; txn_date: string; type: string; amount_cents: number; note: string | null; merchant: string | null; category_name: string | null; deleted_at: string }>(
    `SELECT t.*, c.name AS category_name FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 100`,
    Number(ctx.ledger!.id),
  );
  const csrf = c.get('csrf') || '';
  return c.html(
    layout({
      title: '已删除的记账',
      activeNav: 'transactions',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card"><div class="card-head"><b>已删除的记账</b><a class="btn btn-sm" href="/transactions">返回账单 →</a></div>
${
  rows.length
    ? `<table class="table"><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>备注</th><th>删除时间</th><th>操作</th></tr></thead><tbody>
${rows
  .map(
    (t) => `<tr><td>${esc(t.txn_date)}</td><td>${esc(TXN_TYPE_MAP[t.type]?.label || t.type)}</td><td class="amount">${esc(u.fmtAmount(t.amount_cents))}</td><td>${esc(t.note || t.merchant || t.category_name || '')}</td><td class="tiny muted">${esc(u.fmtDateTime(t.deleted_at))}</td>
<td><form method="post" action="/transactions/${t.id}/restore" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-sm" type="submit">恢复</button></form></td></tr>`,
  )
  .join('')}</tbody></table>`
    : '<div class="empty">没有已删除的记账</div>'
}</div>`,
    }),
  );
});

txnRoutes.post('/transactions/:id/restore', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  try {
    await txn.restoreTransaction(db, Number(c.req.param('id')), Number(ctx.ledger!.id));
    setFlash(c, 'success', '已恢复流水与余额');
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect('/transactions/deleted');
});

txnRoutes.get('/transactions/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const t = await txn.getTransaction(db, Number(c.req.param('id')), Number(ctx.ledger!.id));
  if (!t) {
    return c.html(
      layout({
        title: '不存在',
        ctx,
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: '<div class="card">这笔记录不存在或已删除。</div>',
      }),
      404,
    );
  }
  const [form, splits, attachments] = await Promise.all([
    fd.txFormData(db, Number(ctx.ledger!.id)),
    txn.splitsOf(db, t.id),
    attach.listByTxn(db, t.id),
  ]);
  return c.html(
    layout({
      title: '编辑记账',
      activeNav: 'transactions',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: txnFormPage({
        form,
        t: { ...t, amount: (t.amount_cents / 100).toFixed(2), tag_names: t.tag_names || '' },
        mode: 'edit',
        back: c.req.query('back') || '/transactions',
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        action: `/transactions/${t.id}`,
        splitRows: splits as Array<{ member_name: string; share_cents: number }>,
        attachments,
      }),
    }),
  );
});

txnRoutes.post('/transactions/:id/attachments', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const userId = Number(ctx.user!.id);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const isJson = body._json === '1' || wantsJson(c);

  const row = await db.get<{ id: number }>(
    'SELECT id FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL',
    id,
    ledgerId,
  );
  if (!row) {
    if (isJson) return c.json({ ok: false, error: '记录不存在或已删除' }, 404);
    setFlash(c, 'error', '记录不存在或已删除');
    return c.redirect('/transactions');
  }

  try {
    if (!env.ATTACHMENTS) throw new Error('当前环境未挂载 R2 存储桶');
    const prepared: Array<{ buf: Buffer; mime: string; name?: string }> = [];

    const rawImages = Array.isArray(body.images)
      ? body.images
      : typeof body.dataUrl === 'string' && body.dataUrl
        ? [{ dataUrl: body.dataUrl, name: typeof body.name === 'string' ? body.name : undefined }]
        : [];
    for (const item of rawImages) {
      const dataUrl = typeof item === 'string' ? item : String((item as { dataUrl?: string })?.dataUrl || '');
      const name = typeof item === 'object' && item ? String((item as { name?: string })?.name || '') : undefined;
      if (!dataUrl) continue;
      const parsed = attach.parseDataUrl(dataUrl);
      prepared.push({ buf: parsed.buf, mime: parsed.mime, name: name || undefined });
    }

    const rawFiles = ([] as unknown[]).concat(body.files ?? [], body.file ?? []);
    for (const f of rawFiles) {
      if (!f || typeof f !== 'object' || !('arrayBuffer' in f)) continue;
      const file = f as File;
      if (file.size === 0 && !file.name) continue;
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = attach.inferImageMime(file.type, file.name);
      const checked = attach.validateImageBuffer(mime, buf);
      prepared.push({ buf, mime: checked.mime, name: file.name || undefined });
    }

    if (!prepared.length) throw new Error('请选择要上传的图片');

    const existing = await attach.listByTxn(db, id);
    if (existing.length + prepared.length > attach.MAX_IMAGES) {
      throw new Error(`单笔流水最多保存 ${attach.MAX_IMAGES} 个附件（当前已有 ${existing.length} 个）`);
    }

    const saved = [];
    for (const img of prepared) {
      saved.push(
        await attach.saveBufferImage(db, env, {
          buf: img.buf,
          mime: img.mime,
          ledgerId,
          userId,
          txnId: id,
          name: img.name,
          kind: 'receipt',
          aiStatus: 'linked',
        }),
      );
    }

    if (isJson) return c.json({ ok: true, attachments: saved, total: existing.length + saved.length });
    setFlash(c, 'success', `已上传 ${saved.length} 个附件`);
    return c.redirect(`/transactions/${id}/edit`);
  } catch (e) {
    const msg = toPublicError(e);
    if (isJson) return c.json({ ok: false, error: msg }, 400);
    setFlash(c, 'error', msg);
    return c.redirect(`/transactions/${id}/edit`);
  }
});

txnRoutes.post('/transactions/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const data = readForm(body);
  const isJson = body._json === '1' || wantsJson(c);
  try {
    await txn.updateTransaction(db, Number(c.req.param('id')), Number(ctx.ledger!.id), ctx.user!.id, data);
    if (isJson) return c.json({ ok: true, redirect: '/transactions' });
    setFlash(c, 'success', '已保存修改');
    return c.redirect(String(body.back || '/transactions'));
  } catch (e) {
    if (isJson) return c.json({ ok: false, error: toPublicError(e) }, 400);
    const id = Number(c.req.param('id'));
    const [form, meta, attachments] = await Promise.all([
      fd.txFormData(db, Number(ctx.ledger!.id)),
      siteMeta(c),
      attach.listByTxn(db, id),
    ]);
    return c.html(
      layout({
        title: '编辑记账',
        activeNav: 'transactions',
        ctx,
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: txnFormPage({
          form,
          t: { ...data, id, amount: (data.amount_cents / 100).toFixed(2) },
          mode: 'edit',
          back: String(body.back || '/transactions'),
          csrf: c.get('csrf') || '',
          cspNonce: c.get('cspNonce'),
          action: `/transactions/${id}`,
          splitRows: (data.splits || []).map((s) => ({ member_name: s.member_name || '', share_cents: s.share_cents })),
          attachments,
          error: toPublicError(e),
        }),
      }),
      400,
    );
  }
});

txnRoutes.post('/transactions/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  try {
    const ok = await txn.softDelete(db, Number(c.req.param('id')), Number(ctx.ledger!.id), { env: envOf(c) });
    if (!ok) {
      if (body._json === '1' || wantsJson(c)) return c.json({ ok: false, error: '记录不存在或已删除' }, 404);
      setFlash(c, 'error', '记录不存在或已删除');
      return c.redirect(String(body.back || '/transactions'));
    }
    if (body._json === '1' || wantsJson(c)) return c.json({ ok: true });
    setFlash(c, 'success', '已删除');
    return c.redirect(String(body.back || '/transactions'));
  } catch (e) {
    if (body._json === '1' || wantsJson(c)) return c.json({ ok: false, error: toPublicError(e) }, 400);
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(String(body.back || '/transactions'));
  }
});
