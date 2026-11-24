import { isCreditGroupType } from '../db.js';
import { groupAccountsSummary } from '../lib/accounts.js';
import { donutChart, donutLegend, progressBar } from '../lib/charts.js';
import type { TxnDateGroup } from '../lib/txn.js';
import { addMonths, compactMoney, esc, fmtAmount, money } from '../lib/util.js';
import type { AccountRow } from '../types.js';
import { groupList } from './layout.js';

export interface DashboardViewData {
  cur: { income: number; expense: number; net: number; count: number };
  prev: { income: number; expense: number; net: number; count: number };
  overview: { accounts: AccountRow[]; assets: number; liabilities: number; net: number };
  trendChart: string;
  cats: Array<{ name: string; icon: string; color: string; total: number; cnt: number }>;
  incomeCats: Array<{ name: string; icon: string; color: string; total: number; cnt: number }>;
  todayCount: number;
  upcoming: Array<{ id: number; name: string; frequency: string; next_run_at: string; amount_cents: number }>;
  budgets: Array<{ id: number; name: string; used: number; amount_cents: number; ratio: number; rangeLabel: string }>;
  recentGroups: TxnDateGroup[];
  debts: Array<{ direction: string; cnt: number; total: number }>;
  goals: Array<{ id: number; name: string; icon: string; saved_cents: number; target_cents: number }>;
  pendingReimburse: { count: number; sum: number };
  subs: { monthlyTotal: number; live: unknown[] };
  sessionCards: { activeCount: number; totalRemaining: number };
  aiReady: boolean;
  month: string;
  monthLabel: string;
}

export function dashboardPage(d: DashboardViewData): string {
  const prevM = addMonths(d.month, -1);
  const nextM = addMonths(d.month, 1);
  const savingsRate = d.cur.income > 0 ? Math.round(((d.cur.income - d.cur.expense) / d.cur.income) * 100) : 0;

  const topCats = d.cats.slice(0, 6);
  const restExp = d.cats.slice(6).reduce((s, x) => s + Number(x.total || 0), 0);
  const donutItems = topCats.map((c) => ({ name: c.name, value: c.total / 100, color: c.color }));
  if (restExp > 0) donutItems.push({ name: '其他', value: restExp / 100, color: '#94A3B8' });
  const donut = d.cats.length
    ? donutChart(donutItems, {
        size: 168,
        thickness: 22,
        centerValue: compactMoney(d.cur.expense),
        centerTitle: '本月支出',
      })
    : '<div class="empty">本月暂无支出</div>';

  const expDiff = d.prev.expense ? Math.round(((d.cur.expense - d.prev.expense) / d.prev.expense) * 100) : null;
  const incDiff = d.prev.income ? Math.round(((d.cur.income - d.prev.income) / d.prev.income) * 100) : null;

  return `<div class="between mb16" style="padding:0">
  <div class="row wrap">
    <a class="btn btn-sm" href="/?month=${prevM}">← 上月</a>
    <h1 style="margin:0 6px">${esc(d.monthLabel)}</h1>
    <a class="btn btn-sm" href="/?month=${nextM}">下月 →</a>
  </div>
  <div class="row wrap">
    <span class="chip">${d.aiReady ? '🤖 AI 已就绪' : '⚙️ 离线规则引擎可用'}</span>
    <a class="btn btn-sm" href="/reports?month=${d.month}">📈 完整报表</a>
    <a class="btn btn-sm" href="/export/csv">导出 CSV</a>
  </div>
</div>

<div class="kpi-grid mb16">
  <div class="stat">
    <div class="label"><span>本月总支出</span>${expDiff !== null ? `<span class="chip ${expDiff > 0 ? 'expense' : 'income'}">${expDiff > 0 ? '↑' : '↓'} ${Math.abs(expDiff)}% 环比</span>` : ''}</div>
    <div class="value amount expense">-${fmtAmount(d.cur.expense)}</div>
    <div class="delta">上月支出 ${fmtAmount(d.prev.expense)} · 共 ${d.cur.count} 笔 · 今日已记 ${d.todayCount} 笔</div>
  </div>
  <div class="stat">
    <div class="label"><span>本月总收入</span>${incDiff !== null ? `<span class="chip ${incDiff >= 0 ? 'income' : 'warn'}">${incDiff >= 0 ? '↑' : '↓'} ${Math.abs(incDiff)}% 环比</span>` : ''}</div>
    <div class="value amount income">+${fmtAmount(d.cur.income)}</div>
    <div class="delta">上月收入 ${fmtAmount(d.prev.income)}</div>
  </div>
  <div class="stat">
    <div class="label"><span>当月结余净值</span><span class="chip primary">储蓄率 ${savingsRate}%</span></div>
    <div class="value amount ${d.cur.net >= 0 ? 'income' : 'expense'}">${d.cur.net >= 0 ? '+' : ''}${fmtAmount(d.cur.net)}</div>
    <div class="delta">收入减去支出净额</div>
  </div>
  <div class="stat">
    <div class="label"><span>家庭总净资产</span><span class="chip">${d.overview.accounts.length} 个账户</span></div>
    <div class="value amount">${fmtAmount(d.overview.net)}</div>
    <div class="delta">资产 ${fmtAmount(d.overview.assets)} · 负债 ${fmtAmount(d.overview.liabilities)}</div>
  </div>
</div>

<div class="grid grid-2-1 mb16">
  <div class="card">
    <div class="card-head"><b>近 6 个月收支趋势</b><a class="btn btn-sm btn-ghost" href="/reports">详情 →</a></div>
    <div class="chart-box">${d.trendChart}</div>
  </div>
  <div class="card">
    <div class="card-head"><b>支出构成占比</b><a class="btn btn-sm btn-ghost" href="/reports?month=${d.month}">分类报表 →</a></div>
    <div style="display:flex;justify-content:center;margin-bottom:10px">${donut}</div>
    ${d.cats.length ? donutLegend(donutItems, d.cur.expense / 100, '元') : ''}
    ${
      d.incomeCats.length
        ? `<div class="mt12" style="border-top:1px solid var(--border);padding-top:10px">
      <div class="tiny muted bold mb8">本月收入分类 TOP</div>
      ${d.incomeCats
        .map(
          (c) => `<div class="between" style="padding:3px 0"><span class="small">${esc(c.icon)} ${esc(c.name)} <span class="tiny muted">${c.cnt}笔</span></span><span class="amount small income">+${fmtAmount(c.total)}</span></div>`,
        )
        .join('')}
    </div>`
        : ''
    }
  </div>
</div>

<div class="grid grid-2-1">
  <div class="card">
    <div class="card-head">
      <b>近期收支明细</b>
      <div class="row">
        <a class="btn btn-sm btn-ghost" href="/transactions?kind=expense">只看支出</a>
        <a class="btn btn-sm btn-ghost" href="/transactions?kind=income">只看收入</a>
        <a class="btn btn-sm" href="/transactions">全部明细 →</a>
      </div>
    </div>
    ${groupList(d.recentGroups)}
  </div>
  <div class="grid" style="align-content:start">
    <div class="card">
      <div class="card-head"><b>账户分层与余额</b><a class="btn btn-sm btn-ghost" href="/accounts">管理 →</a></div>
      ${(() => {
        const g = groupAccountsSummary(d.overview.accounts);
        return `<div class="tiny muted mb8" style="padding-bottom:8px;border-bottom:1px solid var(--border)">
  <div class="between" style="padding:2px 0"><span>💰 资金账户</span><span class="amount bold">${money(g.fundsTotalCents)}</span></div>
  <div class="between" style="padding:2px 0"><span>🎟️ 充值账户</span><span class="amount bold">${money(g.prepaidTotalCents)}</span></div>
  <div class="between" style="padding:2px 0"><span>💳 信用待还</span><span class="amount bold ${g.creditDebtCents > 0 ? 'expense' : ''}">${money(g.creditDebtCents)}</span></div>
  ${
    d.sessionCards.activeCount > 0
      ? `<div class="between" style="padding:2px 0"><a href="/accounts#session-cards">🎟️ 有效次卡（${d.sessionCards.activeCount} 张）</a><a href="/accounts#session-cards" class="amount bold">余 ${d.sessionCards.totalRemaining} 次</a></div>`
      : ''
  }
</div>`;
      })()}
      ${d.overview.accounts
        .slice(0, 5)
        .map((a) => {
          const b = Number(a.balance_cents || 0);
          const isDebt = isCreditGroupType(a.type) && b < 0;
          return `<div class="between"><span>${esc(a.icon || '💳')} ${esc(a.name)}</span><span class="amount bold ${isDebt ? 'expense' : ''}">${isDebt ? `待还 ${fmtAmount(Math.abs(b))}` : fmtAmount(b)}</span></div>`;
        })
        .join('') || '<div class="empty">暂无账户</div>'}
    </div>
    <div class="card">
      <div class="card-head"><b>预算进度</b><a class="btn btn-sm btn-ghost" href="/budgets">全部 →</a></div>
      ${d.budgets
        .map(
          (b) => `<div class="mb12">
  <div class="between" style="padding:0 0 4px"><span class="small bold">${esc(b.name)}</span><span class="tiny muted amount">${fmtAmount(b.used)} / ${fmtAmount(b.amount_cents)} (${Math.round(b.ratio)}%)</span></div>
  ${progressBar(b.used, b.amount_cents)}
</div>`,
        )
        .join('') || '<div class="empty">暂无活跃预算</div>'}
    </div>
    <div class="card">
      <div class="card-head"><b>待办与规划摘要</b></div>
      <div class="between"><span>待报销支出</span><a href="/transactions?reimbursable=yes" class="amount bold">${d.pendingReimburse.count} 笔 · ${fmtAmount(d.pendingReimburse.sum)}</a></div>
      <div class="between"><span>订阅月均成本</span><a href="/subscriptions" class="amount bold">${fmtAmount(d.subs.monthlyTotal)} / 月（${d.subs.live.length} 个）</a></div>
      ${d.debts
        .map(
          (x) => `<div class="between"><span>${x.direction === 'receivable' ? '待收借款' : '待还借款'}</span><a href="/debts" class="amount bold">${x.cnt} 笔 · ${fmtAmount(x.total)}</a></div>`,
        )
        .join('')}
      ${d.goals
        .map(
          (g) => `<div class="between"><span>${esc(g.icon)} ${esc(g.name)}</span><span class="tiny amount">${fmtAmount(g.saved_cents)} / ${fmtAmount(g.target_cents)}</span></div>`,
        )
        .join('')}
      ${d.upcoming
        .map(
          (r) => `<div class="between"><span>🔁 ${esc(r.name)} <span class="tiny muted">(${esc(r.next_run_at)})</span></span><a href="/recurring" class="amount small">${fmtAmount(r.amount_cents)}</a></div>`,
        )
        .join('')}
    </div>
  </div>
</div>`;
}
