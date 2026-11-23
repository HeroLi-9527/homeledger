import { Hono } from 'hono';
import { todayStr } from '../db.js';
import { isAiUsable } from '../lib/ai.js';
import { attachCounts } from '../lib/attachments.js';
import { barChart, heatmapChart } from '../lib/charts.js';
import * as fd from '../lib/formdata.js';
import { budgetPeriodRange, budgetUsedInRange, effectiveBudget, type BudgetRow } from '../lib/scheduler.js';
import { overview as subsOverview } from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { dashboardPage } from '../views/dashboard.js';
import { groupList, layout, simpleTable } from '../views/layout.js';
import { dbOf, requireLogin, siteMeta, takeFlash } from './helpers.js';

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
    overview,
    budgetsRaw,
    recentRes,
    debts,
    goals,
    pendingReimburse,
    aiReady,
    subs,
  ] = await Promise.all([
    txn.summary(db, ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.summary(db, ledgerId, `${prevMonth}-01`, u.monthEnd(prevMonth)),
    txn.monthlyTrend(db, ledgerId, 6),
    txn.categoryBreakdown(db, ledgerId, `${month}-01`, u.monthEnd(month), 'expense'),
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
  ]);

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
        budgets,
        recentGroups,
        debts,
        goals,
        pendingReimburse: { count: Number(pendingReimburse?.c || 0), sum: Number(pendingReimburse?.s || 0) },
        subs,
        aiReady,
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
<div class="card mt16"><div class="card-head"><b>${esc(selected)} 当日明细</b></div>${groupList(selectedGroups)}</div>`,
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
  const f: txn.TxnFilter = {
    keyword: String(q.q || '').trim(),
    type: q.type || '',
    categoryId: q.category_id ? Number(q.category_id) : undefined,
    accountId: q.account_id ? Number(q.account_id) : undefined,
    from: q.from || '',
    to: q.to || '',
    page: Number(q.page || 1),
    pageSize: 30,
  };
  const hasFilter = Boolean(f.keyword || f.type || f.categoryId || f.accountId || f.from || f.to);
  const [result, form, cats] = await Promise.all([
    hasFilter ? txn.listTransactions(db, ledgerId, f) : Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 30, pages: 1, sum: { income: 0, expense: 0 } }),
    fd.txFormData(db, ledgerId),
    fd.flatCategories(db, ledgerId),
  ]);
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
  <select name="type"><option value="">全部类型</option>${['expense', 'income', 'transfer', 'lend', 'borrow', 'adjust'].map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
  <select name="category_id"><option value="">全部分类</option>${cats.map((cc) => `<option value="${cc.id}" ${f.categoryId === cc.id ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select>
  <select name="account_id"><option value="">全部账户</option>${form.accounts.map((a) => `<option value="${a.id}" ${f.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
  <input type="date" name="from" value="${esc(f.from)}">
  <input type="date" name="to" value="${esc(f.to)}">
</div>
<div class="row mt12"><button class="btn btn-primary" type="submit">搜索</button>${hasFilter ? `<a class="btn" href="/search">清空</a><span class="muted small">共 ${result.total} 笔</span>` : ''}</div>
</form></div>
<div class="card mt16">${hasFilter ? groupList(await txn.groupByDate(result.rows, db)) : '<div class="empty">输入条件后搜索账单</div>'}</div>`,
    }),
  );
});

dashboardRoutes.get('/notifications', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<{ id: number; created_at: string; title: string; body: string | null }>(
    'SELECT id, created_at, title, body FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
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
      body: simpleTable(
        '通知中心',
        ['时间', '标题', '内容'],
        rows
          .map((n) => `<tr><td class="tiny muted">${esc(n.created_at)}</td><td><b>${esc(n.title)}</b></td><td>${esc(n.body || '')}</td></tr>`)
          .join('') || '<tr><td colspan="3">暂无通知</td></tr>',
      ),
    }),
  );
});
