import { Hono } from 'hono';
import { isCreditGroupType, todayStr, TXN_TYPE_MAP } from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { groupList, layout, paginationHtml } from '../views/layout.js';
import { txnFormPage } from '../views/transactions.js';
import { bodyOf, dbOf, envOf, requireLedger, requireLogin, requireWrite, setFlash, siteMeta, takeFlash, toPublicError, wantsJson } from './helpers.js';

export const txnRoutes = new Hono<HonoEnv>();

const TXN_SOURCE_OPTS: Array<[string, string]> = [
  ['manual', '手工记账'],
  ['ai_screenshot', 'AI 截图'],
  ['ai_text', 'AI 文字'],
  ['import', '账单导入'],
  ['recurring', '周期账单'],
  ['subscription', '订阅扣费'],
  ['openapi', '开放 API'],
];

const TXN_SORT_OPTS: Array<[NonNullable<txn.TxnFilter['sort']>, string]> = [
  ['date_desc', '日期从新到旧'],
  ['date_asc', '日期从旧到新'],
  ['amount_desc', '金额从大到小'],
  ['amount_asc', '金额从小到大'],
];

function collectBulkIds(body: Record<string, unknown>): number[] {
  return [...new Set(([] as unknown[]).concat(body.ids || [], body.del_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

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
    account_amount_cents: body.account_amount ? u.parseAmountToCents(body.account_amount) : undefined,
    to_account_amount_cents: body.to_account_amount ? u.parseAmountToCents(body.to_account_amount) : undefined,
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
  const sort: txn.TxnFilter['sort'] =
    q.sort === 'date_asc' || q.sort === 'amount_desc' || q.sort === 'amount_asc' ? q.sort : 'date_desc';
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
    sort,
    page: Number(q.page) || 1,
    pageSize: 40,
  };
  const [result, cats, form] = await Promise.all([
    txn.listTransactions(db, ledgerId, f),
    fd.flatCategories(db, ledgerId),
    fd.txFormData(db, ledgerId),
  ]);
  const groups = await txn.groupByDate(result.rows, db);
  const writable = auth.canWrite(ctx.ledger.role);
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
  const qHref = (patch: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filterQuery, ...patch })) {
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/transactions?${qs}` : '/transactions';
  };
  const today = todayStr();
  const curMonth = today.slice(0, 7);
  const prevMonth = u.addMonths(curMonth, -1);
  const todayUtc = new Date(`${today}T00:00:00Z`);
  const weekOffset = (todayUtc.getUTCDay() + 6) % 7;
  const weekStart = u.addDays(today, -weekOffset);
  const weekEnd = u.addDays(weekStart, 6);
  const last30Start = u.addDays(today, -29);
  const isTodayActive = f.from === today && f.to === today && !f.month;
  const isWeekActive = f.from === weekStart && f.to === weekEnd && !f.month;
  const isMonthActive = f.month === curMonth && !f.from && !f.to;
  const isPrevMonthActive = f.month === prevMonth && !f.from && !f.to;
  const isLast30Active = f.from === last30Start && f.to === today && !f.month;
  const isAllTimeActive = !f.month && !f.from && !f.to;
  const hasAnyFilter = Object.values(filterQuery).some((v) => v !== undefined && v !== '');
  const hiddenFilters = [
    f.kind ? ['kind', f.kind] : null,
    f.reimbursable ? ['reimbursable', f.reimbursable] : null,
  ].filter((x): x is [string, string] => Boolean(x));

  const csrf = c.get('csrf') || '';
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

  return c.html(
    layout({
      title: '账单明细',
      activeNav: 'transactions',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card"><form method="get" action="/transactions">
  ${hiddenFilters.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
  <div class="row wrap mb8" style="gap:6px">
    <span class="tiny muted">时间：</span>
    <a class="chip ${isAllTimeActive ? 'primary' : ''}" href="${esc(qHref({ month: undefined, from: undefined, to: undefined }))}">全部</a>
    <a class="chip ${isTodayActive ? 'primary' : ''}" href="${esc(qHref({ month: undefined, from: today, to: today }))}">今天</a>
    <a class="chip ${isWeekActive ? 'primary' : ''}" href="${esc(qHref({ month: undefined, from: weekStart, to: weekEnd }))}">本周</a>
    <a class="chip ${isMonthActive ? 'primary' : ''}" href="${esc(qHref({ month: curMonth, from: undefined, to: undefined }))}">本月</a>
    <a class="chip ${isPrevMonthActive ? 'primary' : ''}" href="${esc(qHref({ month: prevMonth, from: undefined, to: undefined }))}">上月</a>
    <a class="chip ${isLast30Active ? 'primary' : ''}" href="${esc(qHref({ month: undefined, from: last30Start, to: today }))}">近 30 天</a>
  </div>
  <div class="row wrap mb8" style="gap:6px">
    <span class="tiny muted">类型：</span>
    <a class="chip ${!f.type && !f.kind && !f.reimbursable ? 'primary' : ''}" href="${esc(qHref({ type: undefined, kind: undefined, reimbursable: undefined }))}">全部</a>
    <a class="chip ${f.kind === 'expense' && !f.type ? 'primary' : ''}" href="${esc(qHref({ kind: 'expense', type: undefined, reimbursable: undefined }))}">支出</a>
    <a class="chip ${f.kind === 'income' && !f.type ? 'primary' : ''}" href="${esc(qHref({ kind: 'income', type: undefined, reimbursable: undefined }))}">收入</a>
    <a class="chip ${f.type === 'transfer' ? 'primary' : ''}" href="${esc(qHref({ type: 'transfer', kind: undefined, reimbursable: undefined }))}">转账</a>
    <a class="chip ${f.reimbursable === 'yes' ? 'primary' : ''}" href="${esc(qHref({ reimbursable: 'yes', type: undefined, kind: undefined }))}">待报销</a>
  </div>
  <div class="row wrap mb12" style="gap:6px">
    <span class="tiny muted">来源：</span>
    <a class="chip ${!f.source ? 'primary' : ''}" href="${esc(qHref({ source: undefined }))}">全部</a>
    ${TXN_SOURCE_OPTS.map(([k, lbl]) => `<a class="chip ${f.source === k ? 'primary' : ''}" href="${esc(qHref({ source: k }))}">${esc(lbl)}</a>`).join('')}
  </div>
  <div class="grid grid-4">
    <select name="type"><option value="">全部类型</option>${Object.entries(TXN_TYPE_MAP).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
    <select name="category_id"><option value="">全部分类</option>${cats.map((cc) => `<option value="${cc.id}" ${f.categoryId === cc.id ? 'selected' : ''}>${cc.kind === 'income' ? '[收] ' : ''}${esc(cc.path)}</option>`).join('')}</select>
    <select name="account_id">${accountOptionsHtml(form.accounts, { selectedId: f.accountId, emptyLabel: '全部账户' })}</select>
    <select name="member_id"><option value="">全部成员</option>${form.members.map((m) => `<option value="${m.user_id}" ${f.memberId === Number(m.user_id) ? 'selected' : ''}>${esc(m.nickname || m.display_name)}</option>`).join('')}</select>
    <select name="tag_id"><option value="">全部标签</option>${form.tags.map((tg) => `<option value="${tg.id}" ${f.tagId === Number(tg.id) ? 'selected' : ''}>#${esc(tg.name)}</option>`).join('')}</select>
    <select name="source"><option value="">全部来源</option>${TXN_SOURCE_OPTS.map(([k, lbl]) => `<option value="${k}" ${f.source === k ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
    <input type="month" name="month" value="${esc(f.month || '')}" title="按月份">
    <input type="date" name="from" value="${esc(f.from || '')}" title="开始日期">
    <input type="date" name="to" value="${esc(f.to || '')}" title="结束日期">
    <select name="sort">${TXN_SORT_OPTS.map(([k, lbl]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
    <input name="q" value="${esc(f.keyword || '')}" placeholder="关键词：商家 / 备注 / 分类">
  </div>
  <div class="row mt12 wrap">
    <button class="btn btn-primary" type="submit">筛选</button>
    ${hasAnyFilter ? '<a class="btn" href="/transactions">清空筛选</a>' : ''}
    <span class="muted small amount">共 ${result.total} 笔 · 收入 +${u.fmtAmount(result.sum.income)} · 支出 -${u.fmtAmount(result.sum.expense)}</span>
  </div>
</form></div>
<div class="mt16">
<form id="bulk-form" method="post" action="/transactions/bulk">
  ${csrfInput}
  <div class="card">
    <div class="row mb12">
      ${writable ? '<label class="check"><input type="checkbox" id="bulk-all"> 全选本页</label>' : '<span class="muted small">只读预览</span>'}
      <span class="spacer"></span>
      <a class="btn btn-sm btn-ghost" href="/transactions/deleted">已删除 →</a>
    </div>
    ${groupList(groups, { bulk: writable, writable })}
  </div>
  ${
    writable
      ? `<div class="card hidden mt12" id="bulk-bar" style="position:sticky;bottom:10px;z-index:40">
    <div class="row wrap" style="gap:8px">
      <span class="small">已选 <b id="bulk-count">0</b> 笔：</span>
      <button class="btn btn-sm btn-danger" type="submit" name="action" value="delete">批量删除</button>
      <select name="category_id" style="width:auto"><option value="">批量改分类…</option>${cats.map((cc) => `<option value="${cc.id}">${cc.kind === 'income' ? '[收] ' : ''}${esc(cc.path)}</option>`).join('')}</select>
      <button class="btn btn-sm" type="submit" name="action" value="category">改分类</button>
      <input name="tags" list="bulk-tag-list" placeholder="批量加标签…" style="width:130px">
      <datalist id="bulk-tag-list">${form.tags.map((tg) => `<option value="${esc(tg.name)}">`).join('')}</datalist>
      <button class="btn btn-sm" type="submit" name="action" value="tag">加标签</button>
      <button class="btn btn-sm" type="submit" name="action" value="mark_reimbursable">标记待报销</button>
      <select name="account_id" style="width:auto">${accountOptionsHtml(form.accounts, { emptyLabel: '报销入账账户…' })}</select>
      <button class="btn btn-sm btn-primary" type="submit" name="action" value="reimburse">报销入账</button>
    </div>
  </div>`
      : ''
  }
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
    currency: (type === 'transfer' && toAccountId ? form.accounts.find((a) => String(a.id) === toAccountId)?.currency :
      form.accounts.find((a) => String(a.id) === defaultAccountId)?.currency) || meta.baseCurrency,
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

txnRoutes.post('/transactions/bulk', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const body = await bodyOf(c);
  const ids = collectBulkIds(body);
  const action = String(body.action || '').trim();
  const isJson = body._json === '1' || wantsJson(c);
  const fallbackBack = action === 'restore' ? '/transactions/deleted' : '/transactions';
  const back = u.safeInternalPath(body.back, fallbackBack);

  try {
    if (!ids.length) throw new Error('请先选择要操作的流水');
    if (action === 'delete') {
      const res = await txn.bulkDelete(db, ids, ledgerId);
      if (isJson) return c.json({ ok: true, action, ...res });
      const reasons = [...new Set(res.skipped.map((s) => s.reason))];
      setFlash(
        c,
        'success',
        `已删除 ${res.deleted} 笔${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
      );
      return c.redirect(back);
    }
    if (action === 'reimburse') {
      const accountId = body.account_id ? Number(body.account_id) : 0;
      const res = await txn.markReimbursed(db, ids, ledgerId, ctx.user!.id, accountId);
      if (isJson) return c.json({ ok: true, action, ...res });
      const reasons = [...new Set(res.skipped.map((s) => s.reason))];
      setFlash(
        c,
        'success',
        `已标记 ${res.count} 笔为已报销，生成入账 ${(res.total / 100).toFixed(2)}${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
      );
      return c.redirect(back);
    }
    if (action === 'category') {
      const categoryId = body.category_id ? Number(body.category_id) : 0;
      const res = await txn.bulkUpdateCategory(db, ids, ledgerId, categoryId);
      if (isJson) return c.json({ ok: true, action, ...res });
      const reasons = [...new Set(res.skipped.map((s) => s.reason))];
      setFlash(
        c,
        res.updated > 0 ? 'success' : 'warn',
        `已批量修改分类 ${res.updated} 笔${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
      );
      return c.redirect(back);
    }
    if (action === 'tag') {
      let tagsInput = String(body.tags ?? body.tag_name ?? '').trim();
      if (!tagsInput && body.tag_id) {
        const tagRow = await db.get<{ name: string }>(
          'SELECT name FROM tags WHERE id = ? AND ledger_id = ?',
          Number(body.tag_id),
          ledgerId,
        );
        tagsInput = tagRow?.name || '';
      }
      const res = await txn.bulkAddTags(db, ids, ledgerId, tagsInput);
      if (isJson) return c.json({ ok: true, action, ...res });
      setFlash(
        c,
        'success',
        `已为 ${res.updated} 笔添加标签${res.skipped.length ? `，${res.skipped.length} 笔跳过` : ''}`,
      );
      return c.redirect(back);
    }
    if (action === 'mark_reimbursable') {
      const res = await txn.bulkMarkReimbursable(db, ids, ledgerId);
      if (isJson) return c.json({ ok: true, action, ...res });
      const reasons = [...new Set(res.skipped.map((s) => s.reason))];
      setFlash(
        c,
        res.updated > 0 ? 'success' : 'warn',
        `已标记 ${res.updated} 笔为待报销${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
      );
      return c.redirect(back);
    }
    if (action === 'restore') {
      const res = await txn.bulkRestore(db, ids, ledgerId);
      if (isJson) return c.json({ ok: true, action, ...res });
      const reasons = [...new Set(res.skipped.map((s) => s.reason))];
      setFlash(
        c,
        res.restored > 0 ? 'success' : 'warn',
        `已恢复 ${res.restored} 笔流水与余额${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`,
      );
      return c.redirect(back);
    }
    throw new Error('不支持的批量操作类型');
  } catch (e) {
    if (isJson) return c.json({ ok: false, error: toPublicError(e) }, 400);
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(back);
  }
});

txnRoutes.post('/transactions/bulk-delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const ids = collectBulkIds(body);
  const res = await txn.bulkDelete(db, ids, Number(ctx.ledger!.id));
  if (body._json === '1' || wantsJson(c)) return c.json({ ok: true, ...res });
  const reasons = [...new Set(res.skipped.map((s) => s.reason))];
  setFlash(c, 'success', `已删除 ${res.deleted} 笔${res.skipped.length ? `，${res.skipped.length} 笔跳过（${reasons.join('；')}）` : ''}`);
  return c.redirect(u.safeInternalPath(body.back, '/transactions'));
});

txnRoutes.post('/transactions/bulk-reimburse', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const ids = collectBulkIds(body);
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
  const writable = auth.canWrite(ctx.ledger!.role);
  const rows = await db.all<{ id: number; txn_date: string; type: string; amount_cents: number; note: string | null; merchant: string | null; category_name: string | null; deleted_at: string; purge_started: number }>(
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
      body: `<form id="bulk-form" method="post" action="/transactions/bulk">
  <input type="hidden" name="_csrf" value="${esc(csrf)}">
  <input type="hidden" name="back" value="/transactions/deleted">
  <div class="card"><div class="card-head"><b>已删除的记账</b><a class="btn btn-sm" href="/transactions">返回账单 →</a></div>
${
  rows.length
    ? `<div class="scroll-x"><table class="table"><thead><tr>${writable ? '<th style="width:32px"><input type="checkbox" id="bulk-all" title="全选"></th>' : ''}<th>日期</th><th>类型</th><th>金额</th><th>备注</th><th>删除时间</th>${writable ? '<th>操作</th>' : ''}</tr></thead><tbody>
${rows
  .map(
    (t) => `<tr>${writable ? `<td><input type="checkbox" class="bulk-item" name="ids" value="${t.id}" ${t.purge_started ? 'disabled' : ''}></td>` : ''}<td>${esc(t.txn_date)}</td><td>${esc(TXN_TYPE_MAP[t.type]?.label || t.type)}</td><td class="amount">${esc(u.fmtAmount(t.amount_cents))}</td><td>${esc(t.note || t.merchant || t.category_name || '')}</td><td class="tiny muted">${esc(u.fmtDateTime(t.deleted_at))}</td>
${writable ? `<td>${t.purge_started ? '<span class="chip warn">待完成永久删除</span>' : `<button class="btn btn-sm" type="submit" formaction="/transactions/${t.id}/restore">恢复</button>`} <button class="btn btn-sm btn-danger" type="submit" formaction="/transactions/${t.id}/purge" form="purge-${t.id}">永久删除</button></td>` : ''}</tr>`,
  )
  .join('')}</tbody></table></div>`
    : '<div class="empty">没有已删除的记账</div>'
}</div>
  ${
    writable && rows.length
      ? `<div class="card hidden mt12" id="bulk-bar" style="position:sticky;bottom:10px;z-index:40">
    <div class="row wrap">
      <span class="small">已选 <b id="bulk-count">0</b> 笔：</span>
      <button class="btn btn-sm btn-primary" type="submit" name="action" value="restore">批量恢复</button>
    </div>
  </div>`
      : ''
  }
</form>
${writable ? rows.map((t) => `<form id="purge-${t.id}" method="post" data-confirm="永久删除此流水及其附件？此操作无法撤销。"><input type="hidden" name="_csrf" value="${esc(csrf)}"></form>`).join('') : ''}`,
    }),
  );
});

txnRoutes.post('/transactions/:id/purge', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  try {
    await txn.purgeTransaction(dbOf(c), envOf(c), Number(c.req.param('id')), Number(c.get('ctx').ledger!.id));
    setFlash(c, 'success', '已永久删除流水及其附件');
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
  return c.redirect('/transactions/deleted');
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
    const ok = await txn.softDelete(db, Number(c.req.param('id')), Number(ctx.ledger!.id));
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
