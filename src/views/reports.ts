import { ACCOUNT_TYPE_MAP, isCreditGroupType } from '../db.js';
import { creditMetrics } from '../lib/accounts.js';
import { barChart, donutChart, heatmapChart, lineChart, progressBar } from '../lib/charts.js';
import { compactMoney, daysInMonth, esc, fmtAmount, pad } from '../lib/util.js';
import type { AccountRow } from '../types.js';

export interface ReportsViewProps {
  range: { start: string; end: string; label: string; preset: string; month?: string; from?: string; to?: string; year?: string };
  kind: 'expense' | 'income';
  selectedCat: string | null;
  sum: { income: number; expense: number; net: number; count: number };
  compare: {
    prevMonth: { label: string; income: number; expense: number };
    lastYear: { label: string; income: number; expense: number };
  } | null;
  cats: Array<{ name: string; icon: string; color: string; total: number; cnt: number }>;
  subcats: Array<{ category_id: number | null; name: string; icon: string; color: string; parent: string; total: number; cnt: number }>;
  trend: Array<{ month: string; income: number; expense: number }>;
  days: Array<{ date: string; income: number; expense: number; count: number }>;
  weekdayExpense: Array<{ wd: number; label: string; expense: number; cnt: number }>;
  members: Array<{ id: number; name: string; color: string; expense: number; income: number; cnt: number }>;
  netWorth: Array<{ month: string; value: number }>;
  overview: { accounts: AccountRow[]; net: number; assets: number; liabilities: number; baseCurrency: string; missingCurrencies: string[] };
  expenseCount: { c: number; avg: number };
  heatmapMonth: string;
  linkWith: (overrides: Record<string, string>, opts?: { keepPeriod?: boolean }) => string;
}

export function reportsPage(p: ReportsViewProps): string {
  const maxDay = p.days.reduce<(typeof p.days)[number] | null>((a, b) => (b.expense > (a?.expense || 0) ? b : a), null);
  const activeDays = p.days.filter((d) => d.count > 0).length;
  const kindTotalCents = Math.max(1, p.kind === 'expense' ? p.sum.expense : p.sum.income);
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

  const catDrillRows = p.cats
    .map((c) => {
      const pct = ((Number(c.total) / kindTotalCents) * 100).toFixed(1);
      const isSelected = p.selectedCat === c.name;
      const href = p.linkWith({ cat: isSelected ? '' : c.name });
      return `<a href="${esc(href)}" class="legend-row" style="padding:6px 8px;border-radius:6px;text-decoration:none;${isSelected ? 'background:var(--primary-soft);outline:1px solid var(--primary);' : ''}">
  <span class="legend-dot" style="background:${esc(c.color)}"></span>
  <span class="legend-name">${esc(c.icon)} ${esc(c.name)} <span class="tiny muted">${c.cnt}笔</span></span>
  <span class="legend-bar"><i style="width:${pct}%;background:${esc(c.color)}"></i></span>
  <span class="legend-pct">${pct}%</span>
  <span class="legend-val amount">${fmtAmount(c.total)}</span>
</a>`;
    })
    .join('');

  const subTotalCents = Math.max(1, p.subcats.reduce((acc, s) => acc + Number(s.total || 0), 0));
  const subcatRows = p.subcats
    .map((s) => {
      const pctNum = (Number(s.total) / subTotalCents) * 100;
      const pctLabel = pctNum.toFixed(1);
      const txnHref = s.category_id
        ? `/transactions?category_id=${s.category_id}&from=${encodeURIComponent(p.range.start)}&to=${encodeURIComponent(p.range.end)}&kind=${p.kind}`
        : `/transactions?from=${encodeURIComponent(p.range.start)}&to=${encodeURIComponent(p.range.end)}&kind=${p.kind}`;
      return `<tr>
  <td>${esc(s.icon)} <b>${esc(s.name)}</b></td>
  <td><a class="chip ${p.selectedCat === s.parent ? 'primary' : ''}" href="${esc(p.linkWith({ cat: s.parent }))}">${esc(s.parent)}</a></td>
  <td class="num">${s.cnt} 笔</td>
  <td class="num amount">${fmtAmount(s.total)}</td>
  <td style="min-width:160px"><div class="row">${progressBar(s.total, subTotalCents, { color: s.color || '#0F766E' })} <span class="tiny muted nowrap">${pctLabel}%</span></div></td>
  <td><a class="btn btn-sm" href="${esc(txnHref)}">查看流水 →</a></td>
</tr>`;
    })
    .join('');

  const trendChart = barChart({
    labels: p.trend.map((t) => `${t.month.slice(5)}月`),
    series: [
      { name: '支出', color: '#BE123C', data: p.trend.map((t) => t.expense / 100) },
      { name: '收入', color: '#0F766E', data: p.trend.map((t) => t.income / 100) },
    ],
    height: 190,
    valueUnit: '元',
  });

  const dayMap = new Map(p.days.map((d) => [d.date, d]));
  const monthDayCount = daysInMonth(p.heatmapMonth);
  const dailyLabels: string[] = [];
  const dailyExpenseData: number[] = [];
  for (let d = 1; d <= monthDayCount; d++) {
    const iso = `${p.heatmapMonth}-${pad(d)}`;
    dailyLabels.push(`${d}日`);
    dailyExpenseData.push(Number(dayMap.get(iso)?.expense || 0) / 100);
  }
  const dailyExpenseSvg = lineChart({
    labels: dailyLabels,
    series: [{ name: '日支出', color: '#BE123C', data: dailyExpenseData }],
    height: 195,
    showLegend: false,
    valueUnit: '元',
  });

  const accountSummaryRows =
    p.overview.accounts
      .map((a) => {
        const typeLabel = ACCOUNT_TYPE_MAP[a.type]?.label || a.type;
        let balDetail = '';
        if (isCreditGroupType(a.type)) {
          const cm = creditMetrics(a);
          balDetail =
            cm.limitCents !== null
              ? `<div class="tiny muted">可用 ${fmtAmount(cm.availableCents ?? 0)} / 额度 ${fmtAmount(cm.limitCents)}</div>`
              : cm.debtCents > 0
                ? `<div class="tiny muted">待还 ${fmtAmount(cm.debtCents)}</div>`
                : '';
        }
        return `<tr>
  <td><a href="/accounts/${a.id}">${esc(a.icon || '💳')} <b>${esc(a.name)}</b></a></td>
  <td>${esc(typeLabel)}</td>
  <td>${esc(a.currency || 'CNY')}</td>
  <td>${a.include_in_net ? '计入' : '<span class="muted">不计</span>'}</td>
  <td class="num amount ${Number(a.balance_cents) < 0 ? 'expense' : ''}">${fmtAmount(a.balance_cents)}${balDetail}</td>
</tr>`;
      })
      .join('') || '<tr><td colspan="5">暂无活跃账户</td></tr>';

  const csvHref =
    p.range.preset === 'all'
      ? '/export/csv'
      : `/export/csv?from=${encodeURIComponent(p.range.start)}&to=${encodeURIComponent(p.range.end)}`;

  const netWorthSvg = lineChart({
    labels: p.netWorth.map((n) => `${n.month.slice(5)}月`),
    series: [{ name: '家庭净资产', color: '#0F766E', data: p.netWorth.map((n) => n.value / 100) }],
    height: 210,
    valueUnit: '元',
  });

  const heatmapSvg = heatmapChart({ month: p.heatmapMonth, days: p.days, valueUnit: '元' });
  const weekdayChart = barChart({
    labels: p.weekdayExpense.map((w) => w.label),
    series: [{ name: '支出', color: '#BE123C', data: p.weekdayExpense.map((w) => w.expense / 100) }],
    height: 185,
    showLegend: false,
    valueUnit: '元',
  });
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
      <a class="btn btn-sm" href="${esc(csvHref)}">导出 CSV</a>
    </div>
  </div>
  <form method="get" action="/reports" class="row wrap mb12">
    <input type="hidden" name="preset" value="custom">
    ${p.kind !== 'expense' ? `<input type="hidden" name="kind" value="${esc(p.kind)}">` : ''}
    ${p.selectedCat ? `<input type="hidden" name="cat" value="${esc(p.selectedCat)}">` : ''}
    <span class="tiny muted">自定义区间：</span>
    <input type="date" name="from" value="${esc(p.range.start)}" style="width:auto">
    <span class="tiny muted">~</span>
    <input type="date" name="to" value="${esc(p.range.end)}" style="width:auto">
    <button class="btn btn-sm ${p.range.preset === 'custom' ? 'btn-primary' : ''}" type="submit">查询</button>
  </form>
  <div class="kpi-grid">
    <div class="stat"><div class="label">当前家庭净资产</div><div class="value amount">${fmtAmount(p.overview.net)}</div><div class="delta">资产 ${fmtAmount(p.overview.assets)} · 负债 ${fmtAmount(p.overview.liabilities)}</div></div>
    <div class="stat"><div class="label">本期总支出</div><div class="value amount expense">-${fmtAmount(p.sum.expense)}</div><div class="delta">支出 ${p.expenseCount.c} 笔 · 笔均 ${fmtAmount(Math.round(p.expenseCount.avg))}</div></div>
    <div class="stat"><div class="label">本期总收入</div><div class="value amount income">+${fmtAmount(p.sum.income)}</div><div class="delta">活跃记账 ${activeDays} 天</div></div>
    <div class="stat"><div class="label">本期净结余</div><div class="value amount">${fmtAmount(p.sum.net)}</div><div class="delta">单日最高 ${maxDay ? `${fmtAmount(maxDay.expense)} (${maxDay.date})` : '—'}</div></div>
  </div>
</div>

<div class="card mb16">
  <div class="card-head"><b>家庭净资产曲线（近 12 个月）</b><span class="muted small">按当前汇率估值 · ${esc(p.overview.baseCurrency)}</span></div>
  <div class="chart-box">${netWorthSvg}</div>
</div>

<div class="grid grid-2 mb16">
  <div class="card">
    <div class="card-head">
      <b>${p.kind === 'expense' ? '支出' : '收入'}分类构成</b>
      <div class="row">
        <a class="btn btn-sm ${p.kind === 'expense' ? 'btn-primary' : ''}" href="${esc(p.linkWith({ kind: 'expense', cat: '' }))}">支出</a>
        <a class="btn btn-sm ${p.kind === 'income' ? 'btn-primary' : ''}" href="${esc(p.linkWith({ kind: 'income', cat: '' }))}">收入</a>
      </div>
    </div>
    <div style="display:flex;justify-content:center;margin-bottom:12px">${donut}</div>
    ${p.cats.length ? `<div class="tiny muted mb8">点击一级分类可下钻查看二级明细</div>${catDrillRows}` : ''}
  </div>
  <div class="card">
    <div class="card-head"><b>近 12 个月收支趋势</b></div>
    <div class="chart-box">${trendChart}</div>
    ${p.compare ? `<div class="notice mt12">上月（${esc(p.compare.prevMonth.label)}）：支出 ${fmtAmount(p.compare.prevMonth.expense)} · 收入 ${fmtAmount(p.compare.prevMonth.income)}<br>去年同期（${esc(p.compare.lastYear.label)}）：支出 ${fmtAmount(p.compare.lastYear.expense)} · 收入 ${fmtAmount(p.compare.lastYear.income)}</div>` : ''}
  </div>
</div>

<div class="card mb16">
  <div class="card-head"><b>每日支出折线图（${esc(p.heatmapMonth)}）</b><span class="muted small">按自然日汇总</span></div>
  <div class="chart-box">${dailyExpenseSvg}</div>
</div>

<div class="card mb16">
  <div class="card-head">
    <b>${p.kind === 'expense' ? '支出' : '收入'}二级分类下钻明细${p.selectedCat ? ` · ${esc(p.selectedCat)}` : ''}</b>
    ${p.selectedCat ? `<a class="btn btn-sm" href="${esc(p.linkWith({ cat: '' }))}">查看全部分类</a>` : '<span class="muted small">按二级分类汇总，点击所属大类可筛选</span>'}
  </div>
  ${
    p.subcats.length
      ? `<div class="scroll-x"><table class="table"><thead><tr><th>二级分类</th><th>所属大类</th><th class="num">笔数</th><th class="num">金额</th><th>${p.selectedCat ? '大类内占比' : '占比'}</th><th>操作</th></tr></thead><tbody>${subcatRows}</tbody></table></div>`
      : '<div class="empty">本期暂无二级分类明细</div>'
  }
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
</div>
<div class="card mb16">
  <div class="card-head"><b>星期分布（支出）</b><span class="muted small">按周一至周日汇总</span></div>
  <div class="chart-box">${weekdayChart}</div>
  <div class="row wrap mt8" style="justify-content:space-around">
    ${p.weekdayExpense
      .map(
        (w) => `<div class="tiny" style="text-align:center"><div class="muted">${esc(w.label)}（${w.cnt}笔）</div><div class="amount bold">${fmtAmount(w.expense)}</div></div>`,
      )
      .join('')}
  </div>
</div>

<div class="card mb16">
  <div class="card-head">
    <b>账户余额一览表</b>
    ${p.overview.missingCurrencies.length ? `<p class="muted">汇总未计入缺少汇率的币种 ${esc(p.overview.missingCurrencies.join('、'))}</p>` : ''}
    <span class="muted small">总资产 ${fmtAmount(p.overview.assets)} · 总负债 ${fmtAmount(p.overview.liabilities)} · 净资产 ${fmtAmount(p.overview.net)}</span>
  </div>
  <div class="scroll-x">
    <table class="table">
      <thead><tr><th>账户</th><th>类型</th><th>币种</th><th>计入净资产</th><th class="num">当前余额</th></tr></thead>
      <tbody>${accountSummaryRows}</tbody>
    </table>
  </div>
</div>`;
}
