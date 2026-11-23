import { barChart, donutChart, donutLegend, heatmapChart, lineChart, progressBar } from '../lib/charts.js';
import { compactMoney, esc, fmtAmount } from '../lib/util.js';

export interface ReportsViewProps {
  range: { start: string; end: string; label: string; preset: string; month?: string };
  kind: 'expense' | 'income';
  sum: { income: number; expense: number; net: number; count: number };
  compare: {
    prevMonth: { label: string; income: number; expense: number };
    lastYear: { label: string; income: number; expense: number };
  } | null;
  cats: Array<{ name: string; icon: string; color: string; total: number; cnt: number }>;
  subcats: Array<{ name: string; parent: string; total: number; cnt: number }>;
  trend: Array<{ month: string; income: number; expense: number }>;
  days: Array<{ date: string; income: number; expense: number; count: number }>;
  members: Array<{ id: number; name: string; color: string; expense: number; income: number; cnt: number }>;
  netWorth: Array<{ month: string; value: number }>;
  overview: { net: number; assets: number; liabilities: number };
  expenseCount: { c: number; avg: number };
  heatmapMonth: string;
  linkWith: (overrides: Record<string, string>, opts?: { keepPeriod?: boolean }) => string;
}

export function reportsPage(p: ReportsViewProps): string {
  const maxDay = p.days.reduce<(typeof p.days)[number] | null>((a, b) => (b.expense > (a?.expense || 0) ? b : a), null);
  const activeDays = p.days.filter((d) => d.count > 0).length;
  const donutTotal = (p.kind === 'expense' ? p.sum.expense : p.sum.income) / 100;
  const topCats = p.cats.slice(0, 8);
  const restTotal = p.cats.slice(8).reduce((a, x) => a + (x.total || 0), 0);
  const donutItems = topCats.map((x) => ({ name: x.name, value: x.total / 100, color: x.color }));
  if (restTotal > 0) donutItems.push({ name: '其他', value: restTotal / 100, color: '#94A3B8' });

  const donut = p.cats.length
    ? donutChart(donutItems, {
        size: 185,
        thickness: 24,
        centerValue: compactMoney(p.kind === 'expense' ? p.sum.expense : p.sum.income),
        centerTitle: p.kind === 'expense' ? '总支出' : '总收入',
      })
    : '<div class="empty">本期暂无数据</div>';

  const trendChart = barChart({
    labels: p.trend.slice(-6).map((t) => `${t.month.slice(5)}月`),
    series: [
      { name: '支出', color: '#BE123C', data: p.trend.slice(-6).map((t) => t.expense / 100) },
      { name: '收入', color: '#0F766E', data: p.trend.slice(-6).map((t) => t.income / 100) },
    ],
    height: 190,
    valueUnit: '元',
  });

  const netWorthSvg = lineChart({
    labels: p.netWorth.map((n) => `${n.month.slice(5)}月`),
    series: [{ name: '家庭净资产', color: '#0F766E', data: p.netWorth.map((n) => n.value / 100) }],
    height: 210,
    valueUnit: '元',
  });

  const heatmapSvg = heatmapChart({ month: p.heatmapMonth, days: p.days, valueUnit: '元' });
  const totalMemberExp = Math.max(1, p.members.reduce((s, m) => s + m.expense, 0));
  const presetBtn = (k: string, label: string) =>
    `<a class="btn btn-sm ${p.range.preset === k ? 'btn-primary' : ''}" href="${esc(p.linkWith({ preset: k }, { keepPeriod: false }))}">${label}</a>`;

  return `<div class="card mb16">
  <div class="card-head">
    <b>报表分析 · ${esc(p.range.label)}</b>
    <div class="row wrap">
      ${presetBtn('month', '本月')}
      ${presetBtn('quarter', '本季度')}
      ${presetBtn('year', '本年')}
      ${presetBtn('all', '全部')}
      <a class="btn btn-sm" href="/export/csv">导出 CSV</a>
    </div>
  </div>
  <div class="kpi-grid">
    <div class="stat"><div class="label">当前家庭净资产</div><div class="value amount">${fmtAmount(p.overview.net)}</div><div class="delta">资产 ${fmtAmount(p.overview.assets)} · 负债 ${fmtAmount(p.overview.liabilities)}</div></div>
    <div class="stat"><div class="label">本期总支出</div><div class="value amount expense">-${fmtAmount(p.sum.expense)}</div><div class="delta">支出 ${p.expenseCount.c} 笔 · 笔均 ${fmtAmount(Math.round(p.expenseCount.avg))}</div></div>
    <div class="stat"><div class="label">本期总收入</div><div class="value amount income">+${fmtAmount(p.sum.income)}</div><div class="delta">活跃记账 ${activeDays} 天</div></div>
    <div class="stat"><div class="label">本期净结余</div><div class="value amount">${fmtAmount(p.sum.net)}</div><div class="delta">单日最高 ${maxDay ? `${fmtAmount(maxDay.expense)} (${maxDay.date})` : '—'}</div></div>
  </div>
</div>

<div class="card mb16">
  <div class="card-head"><b>家庭净资产曲线（近 12 个月）</b><span class="muted small">服务端离线 SVG 渲染</span></div>
  <div class="chart-box">${netWorthSvg}</div>
</div>

<div class="grid grid-2 mb16">
  <div class="card">
    <div class="card-head">
      <b>${p.kind === 'expense' ? '支出' : '收入'}分类构成</b>
      <div class="row">
        <a class="btn btn-sm ${p.kind === 'expense' ? 'btn-primary' : ''}" href="${esc(p.linkWith({ kind: 'expense' }))}">支出</a>
        <a class="btn btn-sm ${p.kind === 'income' ? 'btn-primary' : ''}" href="${esc(p.linkWith({ kind: 'income' }))}">收入</a>
      </div>
    </div>
    <div style="display:flex;justify-content:center;margin-bottom:12px">${donut}</div>
    ${p.cats.length ? donutLegend(donutItems, donutTotal, '元') : ''}
  </div>
  <div class="card">
    <div class="card-head"><b>近 6 个月收支趋势</b></div>
    <div class="chart-box">${trendChart}</div>
    ${p.compare ? `<div class="notice mt12">上月（${esc(p.compare.prevMonth.label)}）：支出 ${fmtAmount(p.compare.prevMonth.expense)} · 收入 ${fmtAmount(p.compare.prevMonth.income)}<br>去年同期（${esc(p.compare.lastYear.label)}）：支出 ${fmtAmount(p.compare.lastYear.expense)} · 收入 ${fmtAmount(p.compare.lastYear.income)}</div>` : ''}
  </div>
</div>

<div class="grid grid-2 mb16">
  <div class="card">
    <div class="card-head"><b>家庭成员收支拆分</b><span class="muted small">按记账人聚合</span></div>
    ${p.members
      .map(
        (m) => `<div class="mb12">
  <div class="between" style="padding:0 0 4px">
    <span><b>${esc(m.name)}</b> <span class="tiny muted">${m.cnt} 笔</span></span>
    <span class="amount small">支出 <b class="expense">${fmtAmount(m.expense)}</b> · 收入 <b class="income">${fmtAmount(m.income)}</b></span>
  </div>
  ${progressBar(m.expense, totalMemberExp, { color: m.color || '#0F766E' })}
</div>`,
      )
      .join('') || '<div class="empty">暂无成员记账数据</div>'}
  </div>
  <div class="card">
    <div class="card-head"><b>消费日历热力图（${esc(p.heatmapMonth)}）</b></div>
    <div class="chart-box">${heatmapSvg}</div>
  </div>
</div>`;
}
