import { Hono } from 'hono';
import { todayStr, TXN_TYPE_MAP } from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import { isAiUsable } from '../lib/ai.js';
import { attachCounts } from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import { barChart, heatmapChart } from '../lib/charts.js';
import * as fd from '../lib/formdata.js';
import { budgetPeriodRange, budgetUsedInRange, effectiveBudget, type BudgetRow } from '../lib/scheduler.js';
import { listSessionCards } from '../lib/session-cards.js';
import { overview as subsOverview } from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { dashboardPage } from '../views/dashboard.js';
import { groupList, layout, paginationHtml, simpleTable } from '../views/layout.js';
import { dbOf, envOf, getSessionSecret, requireLogin, setFlash, siteMeta, takeFlash } from './helpers.js';

export const dashboardRoutes = new Hono<HonoEnv>();
const monthOfToday = () => todayStr().slice(0, 7);

dashboardRoutes.get('/', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const flash = takeFlash(c);
  const csrf = c.get('csrf') || '';
  const cspNonce = c.get('cspNonce') || '';

  if (!ctx.ledger) {
    return c.html(
      layout({
        title: '开始使用',
        activeNav: 'home',
        ctx,
        siteName: meta.siteName,
        csrf,
        cspNonce,
        flash,
        body: '<div class="card"><h2>还没有账本</h2><p class="muted mt8">创建一个账本开始记账，或让家人邀请你加入他们的账本。</p><a class="btn btn-primary mt12" href="/ledgers">去创建账本 →</a></div>',
      }),
    );
  }

  const ledgerId = Number(ctx.ledger.id);
  const qMonth = c.req.query('month');
  const month = /^\d{4}-\d{2}$/.test(String(qMonth || '')) ? String(qMonth) : monthOfToday();
  const prevMonth = u.addMonths(month, -1);

  const [
    cur,
    prev,
    trend,
    catsAll,
    incomeCats,
    overview,
    budgetsRaw,
    recentRes,
    debts,
    goals,
    pendingReimburse,
    aiReady,
    subs,
    sessionCards,
    todayRow,
    upcomingRows,
  ] = await Promise.all([
    txn.summary(db, ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.summary(db, ledgerId, `${prevMonth}-01`, u.monthEnd(prevMonth)),
    txn.monthlyTrend(db, ledgerId, 6),
    txn.categoryBreakdown(db, ledgerId, `${month}-01`, u.monthEnd(month), 'expense'),
    txn.categoryBreakdown(db, ledgerId, `${month}-01`, u.monthEnd(month), 'income'),
    txn.accountOverview(db, ledgerId),
    db.all<BudgetRow>(
      `SELECT b.*, c.name AS category_name FROM budgets b
       LEFT JOIN categories c ON c.id = b.category_id
       WHERE b.ledger_id = ? AND b.is_active = 1 ORDER BY b.id LIMIT 4`,
      ledgerId,
    ),
    txn.listTransactions(db, ledgerId, { pageSize: 8, page: 1 }),
    db.all<{ direction: string; cnt: number; total: number }>(
      "SELECT direction, COUNT(*) AS cnt, COALESCE(SUM(balance_cents),0) AS total FROM debts WHERE ledger_id = ? AND status = 'open' GROUP BY direction",
      ledgerId,
    ),
    db.all<{ id: number; name: string; icon: string; saved_cents: number; target_cents: number }>(
      "SELECT id, name, icon, saved_cents, target_cents FROM goals WHERE ledger_id = ? AND status = 'active' ORDER BY id LIMIT 3",
      ledgerId,
    ),
    db.get<{ c: number; s: number }>(
      'SELECT COUNT(*) AS c, COALESCE(SUM(amount_base_cents),0) AS s FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND is_reimbursable = 1 AND reimbursed_at IS NULL',
      ledgerId,
    ),
    isAiUsable(db),
    subsOverview(db, ledgerId),
    listSessionCards(db, ledgerId),
    db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date = ?',
      ledgerId,
      todayStr(),
    ),
    db.all<{ id: number; name: string; frequency: string; next_run_at: string; payload: string }>(
      'SELECT id, name, frequency, next_run_at, payload FROM recurring_rules WHERE ledger_id = ? AND is_active = 1 ORDER BY next_run_at LIMIT 4',
      ledgerId,
    ),
  ]);

  const upcoming = upcomingRows.map((row) => {
    let amountCents = 0;
    try {
      const parsed = JSON.parse(row.payload || '{}') as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
          ? (parsed as { items: unknown[] }).items
          : [parsed];
      for (const it of items) {
        if (it && typeof it === 'object') {
          amountCents += Math.abs(Number((it as { amount_cents?: number }).amount_cents) || 0);
        }
      }
    } catch {
      amountCents = 0;
    }
    return {
      id: row.id,
      name: row.name,
      frequency: row.frequency,
      next_run_at: row.next_run_at,
      amount_cents: amountCents,
    };
  });

  const recent = recentRes.rows;
  const trendChart = barChart({
    labels: trend.slice(-6).map((t) => `${t.month.slice(5)}月`),
    series: [
      { name: '支出', color: '#BE123C', data: trend.slice(-6).map((t) => t.expense / 100) },
      { name: '收入', color: '#0F766E', data: trend.slice(-6).map((t) => t.income / 100) },
    ],
    height: 190,
    valueUnit: '元',
  });

  const refDate = new Date(`${todayStr()}T12:00:00Z`);
  const [budgets] = await Promise.all([
    Promise.all(
      budgetsRaw.map(async (b) => {
        const r2 = budgetPeriodRange(b, refDate);
        const [used, eff] = await Promise.all([
          budgetUsedInRange(db, b, r2.start, r2.end),
          effectiveBudget(db, b, refDate),
        ]);
        return {
          id: b.id,
          name: eff.rollover > 0 ? `${b.name}（含结转）` : b.name,
          used,
          amount_cents: eff.amount,
          ratio: eff.amount > 0 ? (used / Number(eff.amount)) * 100 : 0,
          rangeLabel: r2.label,
        };
      }),
    ),
    attachCounts(db, recent),
  ]);

  const recentGroups = await txn.groupByDate(recent, db);

  return c.html(
    layout({
      title: '总览',
      activeNav: 'home',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce,
      flash,
      aiUsable: aiReady,
      body: dashboardPage({
        cur,
        prev,
        overview,
        trendChart,
        cats: catsAll,
        incomeCats: incomeCats.slice(0, 6),
        todayCount: Number(todayRow?.c || 0),
        upcoming,
        budgets,
        recentGroups,
        debts,
        goals,
        pendingReimburse: { count: Number(pendingReimburse?.c || 0), sum: Number(pendingReimburse?.s || 0) },
        subs,
        sessionCards: { activeCount: sessionCards.activeCount, totalRemaining: sessionCards.totalRemaining },
        aiReady,
        writable: auth.canWrite(ctx.ledger.role),
        month,
        monthLabel: u.monthLabel(month),
      }),
    }),
  );
});

dashboardRoutes.get('/calendar', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);
  const qMonth = c.req.query('month');
  const month = /^\d{4}-\d{2}$/.test(String(qMonth || '')) ? String(qMonth) : monthOfToday();
  const selected = c.req.query('date') || todayStr();

  const [days, monthSummary, selectedRes] = await Promise.all([
    txn.dailyBreakdown(db, ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.summary(db, ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.listTransactions(db, ledgerId, { from: selected, to: selected, pageSize: 100 }),
  ]);

  const dayMap = new Map(days.map((d) => [d.date, d]));
  const cells: Array<{ date: string; day: number; expense: number; income: number } | null> = [];
  for (let i = 0; i < u.firstWeekday(month); i++) cells.push(null);
  for (let d = 1; d <= u.daysInMonth(month); d++) {
    const date = `${month}-${u.pad(d)}`;
    const found = dayMap.get(date);
    cells.push({ date, day: d, expense: found?.expense || 0, income: found?.income || 0 });
  }
  const selectedGroups = await txn.groupByDate(selectedRes.rows, db);
  const prevM = u.addMonths(month, -1);
  const nextM = u.addMonths(month, 1);

  const cellHtml = cells
    .map((cell) =>
      cell
        ? `<a class="cal-cell ${cell.date === selected ? 'sel' : ''}" href="/calendar?month=${month}&date=${cell.date}">
<span class="d">${cell.day}</span>
<span class="day-sum expense">${cell.expense ? `-${u.fmtAmount(cell.expense)}` : ''}</span>
<span class="day-sum income">${cell.income ? `+${u.fmtAmount(cell.income)}` : ''}</span>
</a>`
        : '<span class="cal-cell empty"></span>',
    )
    .join('');

  const writable = auth.canWrite(ctx.ledger.role);
  return c.html(
    layout({
      title: '记账日历',
      activeNav: 'calendar',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      body: `<div class="grid grid-2-1">
  <div class="card">
    <div class="card-head">
      <div class="row"><a class="btn btn-sm" href="/calendar?month=${prevM}">←</a><b>${esc(u.monthLabel(month))}</b><a class="btn btn-sm" href="/calendar?month=${nextM}">→</a></div>
      <span class="muted small amount">支出 ${u.fmtAmount(monthSummary.expense)} · 收入 ${u.fmtAmount(monthSummary.income)}</span>
    </div>
    <div class="cal-head">${u.WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cellHtml}</div>
  </div>
  <div class="card">
    <div class="card-head"><b>消费热力分布</b></div>
    <div class="chart-box">${heatmapChart({ month, days, valueUnit: '元' })}</div>
  </div>
</div>
<div class="card mt16"><div class="card-head"><b>${esc(selected)} 当日明细</b></div>${groupList(selectedGroups, { writable })}</div>`,
    }),
  );
});

dashboardRoutes.get('/search', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);
  const q = c.req.query();
  const minRaw = q.min ? Math.abs(u.parseAmountToCents(q.min)) : 0;
  const maxRaw = q.max ? Math.abs(u.parseAmountToCents(q.max)) : 0;
  const SORT_KEYS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] as const;
  type TxnSort = (typeof SORT_KEYS)[number];
  const sort: TxnSort = SORT_KEYS.includes(String(q.sort || '') as TxnSort)
    ? (String(q.sort) as TxnSort)
    : 'date_desc';
  const f: txn.TxnFilter = {
    keyword: String(q.q || '').trim(),
    type: q.type || '',
    categoryId: q.category_id ? Number(q.category_id) : undefined,
    accountId: q.account_id ? Number(q.account_id) : undefined,
    memberId: q.member_id ? Number(q.member_id) : undefined,
    tagId: q.tag_id ? Number(q.tag_id) : undefined,
    source: q.source ? String(q.source).trim() : '',
    minCents: minRaw > 0 ? minRaw : undefined,
    maxCents: maxRaw > 0 ? maxRaw : undefined,
    from: q.from || '',
    to: q.to || '',
    sort,
    page: Number(q.page || 1),
    pageSize: 30,
  };
  const hasFilter = Boolean(
    f.keyword ||
      f.type ||
      f.categoryId ||
      f.accountId ||
      f.memberId ||
      f.tagId ||
      f.source ||
      f.minCents ||
      f.maxCents ||
      f.from ||
      f.to ||
      sort !== 'date_desc',
  );
  const [result, form, cats] = await Promise.all([
    hasFilter ? txn.listTransactions(db, ledgerId, f) : Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 30, pages: 1, sum: { income: 0, expense: 0 } }),
    fd.txFormData(db, ledgerId),
    fd.flatCategories(db, ledgerId),
  ]);
  const searchQuery = {
    q: f.keyword || undefined,
    type: f.type || undefined,
    category_id: f.categoryId,
    account_id: f.accountId,
    member_id: f.memberId,
    tag_id: f.tagId,
    source: f.source || undefined,
    min: q.min || undefined,
    max: q.max || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    sort: sort !== 'date_desc' ? sort : undefined,
  };
  const SORT_OPTS: Array<[string, string]> = [
    ['date_desc', '日期从新到旧'],
    ['date_asc', '日期从旧到新'],
    ['amount_desc', '金额从大到小'],
    ['amount_asc', '金额从小到大'],
  ];
  const SOURCE_OPTS: Array<[string, string]> = [
    ['manual', '手工记账'],
    ['ai_screenshot', 'AI 截图'],
    ['ai_text', 'AI 文字'],
    ['import', '账单导入'],
    ['recurring', '周期账单'],
    ['subscription', '订阅扣费'],
    ['openapi', '开放 API'],
  ];
  const writable = auth.canWrite(ctx.ledger.role);
  return c.html(
    layout({
      title: '搜索筛选',
      activeNav: 'search',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      body: `<div class="card"><form method="get" action="/search">
<div class="grid grid-3">
  <input name="q" value="${esc(f.keyword)}" placeholder="关键词：商家 / 备注 / 分类">
  <select name="type"><option value="">全部类型</option>${Object.entries(TXN_TYPE_MAP).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
  <select name="category_id"><option value="">全部分类</option>${cats.map((cc) => `<option value="${cc.id}" ${f.categoryId === cc.id ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select>
  <select name="account_id">${accountOptionsHtml(form.accounts, { selectedId: f.accountId, emptyLabel: '全部账户' })}</select>
  <select name="member_id"><option value="">全部成员</option>${form.members.map((m) => `<option value="${m.user_id}" ${f.memberId === Number(m.user_id) ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('')}</select>
  <select name="tag_id"><option value="">全部标签</option>${form.tags.map((tg) => `<option value="${tg.id}" ${f.tagId === Number(tg.id) ? 'selected' : ''}>#${esc(tg.name)}</option>`).join('')}</select>
  <select name="source"><option value="">全部来源</option>${SOURCE_OPTS.map(([k, lbl]) => `<option value="${k}" ${f.source === k ? 'selected' : ''}>${lbl}</option>`).join('')}</select>
  <input name="min" value="${esc(q.min || '')}" placeholder="最小金额（元）" inputmode="decimal">
  <input name="max" value="${esc(q.max || '')}" placeholder="最大金额（元）" inputmode="decimal">
  <input type="date" name="from" value="${esc(f.from)}" title="开始日期">
  <input type="date" name="to" value="${esc(f.to)}" title="结束日期">
  <select name="sort" title="排序方式">${SORT_OPTS.map(([k, lbl]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${lbl}</option>`).join('')}</select>
</div>
<div class="row mt12 wrap"><button class="btn btn-primary" type="submit">搜索</button>${hasFilter ? `<a class="btn" href="/search">清空</a><span class="muted small">共 ${result.total} 笔 · 收入 <b class="income">+${u.fmtAmount(result.sum.income)}</b> · 支出 <b class="expense">-${u.fmtAmount(result.sum.expense)}</b></span>` : ''}</div>
</form></div>
<div class="card mt16">${hasFilter ? groupList(await txn.groupByDate(result.rows, db), { writable }) : '<div class="empty">输入条件后搜索账单</div>'}</div>
${hasFilter ? paginationHtml('/search', searchQuery, result.page, result.pages, result.total) : ''}`,
    }),
  );
});

const NOTIF_KIND_CHIP: Record<string, { cls: string; label: string }> = {
  danger: { cls: 'expense', label: '告警' },
  warn: { cls: 'warn', label: '提醒' },
  success: { cls: 'income', label: '达成' },
  recurring: { cls: 'primary', label: '周期' },
  info: { cls: '', label: '通知' },
};

dashboardRoutes.get('/notifications', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<{
    id: number;
    ledger_id: number | null;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    created_at: string;
    ledger_name: string | null;
  }>(
    `SELECT n.id, n.ledger_id, n.kind, n.title, n.body, n.link, n.created_at, l.name AS ledger_name
     FROM notifications n
     LEFT JOIN ledgers l ON l.id = n.ledger_id
     WHERE n.user_id = ?
     ORDER BY n.id DESC LIMIT 50`,
    ctx.user!.id,
  );
  if (ctx.unreadCount > 0) {
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', ctx.user!.id);
  }
  return c.html(
    layout({
      title: '通知中心',
      activeNav: 'notifications',
      ctx: { ...ctx, unreadCount: 0 },
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: simpleTable(
        '通知中心',
        ['时间', '类型', '标题', '内容', '操作'],
        rows
          .map((n) => {
            const safeLink = u.safeInternalPath(n.link, '');
            const kMeta = NOTIF_KIND_CHIP[n.kind] || NOTIF_KIND_CHIP.info;
            const titleHtml = safeLink
              ? `<a href="/notifications/${n.id}/open"><b>${esc(n.title)}</b></a>`
              : `<b>${esc(n.title)}</b>`;
            const ledgerChip = n.ledger_name ? ` <span class="chip">${esc(n.ledger_name)}</span>` : '';
            const opHtml = safeLink
              ? `<a class="btn btn-sm" href="/notifications/${n.id}/open">查看 →</a>`
              : '<span class="tiny muted">—</span>';
            return `<tr><td class="tiny muted nowrap">${esc(n.created_at)}</td><td><span class="chip ${kMeta.cls}">${kMeta.label}</span></td><td>${titleHtml}${ledgerChip}</td><td>${esc(n.body || '')}</td><td>${opHtml}</td></tr>`;
          })
          .join('') || '<tr><td colspan="5">暂无通知</td></tr>',
      ),
    }),
  );
});

dashboardRoutes.get('/notifications/:id/open', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const sess = c.get('sess');
  const id = Number(c.req.param('id'));
  const row = await db.get<{ id: number; ledger_id: number | null; link: string | null }>(
    'SELECT id, ledger_id, link FROM notifications WHERE id = ? AND user_id = ?',
    id,
    ctx.user!.id,
  );
  const target = row ? u.safeInternalPath(row.link, '') : '';
  if (!row || !target) {
    return c.redirect('/notifications');
  }
  if (row.ledger_id && Number(row.ledger_id) !== Number(ctx.ledger?.id)) {
    const member = await db.get<{ role: string; is_archived: number }>(
      `SELECT lm.role, l.is_archived
       FROM ledger_members lm JOIN ledgers l ON l.id = lm.ledger_id
       WHERE lm.user_id = ? AND lm.ledger_id = ?`,
      ctx.user!.id,
      Number(row.ledger_id),
    );
    if (!member || member.is_archived) {
      setFlash(c, 'warn', '通知所属账本已归档或已无访问权限');
      return c.redirect('/notifications');
    }
    if (sess) {
      const nextPayload = auth.createSessionPayload(sess.uid, Number(row.ledger_id), sess.tv, sess.csrf);
      const token = await auth.signSession(nextPayload, getSessionSecret(envOf(c)));
      c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
    }
  }
  return c.redirect(target);
});
