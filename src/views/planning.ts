import { progressBar } from '../lib/charts.js';
import { CYCLE_LABEL, cycleLabel, statusLabel } from '../lib/subscriptions.js';
import type { AccountRow, CategoryRow } from '../types.js';
import { esc, fmtAmount } from '../lib/util.js';
import { simpleTable } from './layout.js';

const SUB_PRESETS = [
  { name: 'Netflix', icon: '🎬', amount: '68', currency: 'CNY', cycle: 'monthly', plan: '标准套餐' },
  { name: 'iCloud+', icon: '☁️', amount: '21', currency: 'CNY', cycle: 'monthly', plan: '200GB' },
  { name: 'ChatGPT Plus', icon: '🤖', amount: '20', currency: 'USD', cycle: 'monthly', plan: 'Plus' },
  { name: 'Spotify', icon: '🎵', amount: '18', currency: 'CNY', cycle: 'monthly', plan: '个人版' },
  { name: 'YouTube Premium', icon: '▶️', amount: '23', currency: 'CNY', cycle: 'monthly', plan: '个人版' },
  { name: 'Apple One', icon: '🍎', amount: '88', currency: 'CNY', cycle: 'monthly', plan: '家庭版' },
  { name: 'Microsoft 365', icon: '💼', amount: '398', currency: 'CNY', cycle: 'yearly', plan: '个人版' },
  { name: 'Adobe CC', icon: '🎨', amount: '88', currency: 'CNY', cycle: 'monthly', plan: '摄影计划' },
  { name: 'GitHub Copilot', icon: '💻', amount: '10', currency: 'USD', cycle: 'monthly', plan: 'Pro' },
  { name: 'Claude Pro', icon: '🧠', amount: '20', currency: 'USD', cycle: 'monthly', plan: 'Pro' },
  { name: '百度网盘', icon: '💾', amount: '30', currency: 'CNY', cycle: 'monthly', plan: 'SVIP' },
  { name: 'B站大会员', icon: '📺', amount: '25', currency: 'CNY', cycle: 'monthly', plan: '连续包月' },
] as const;

export function budgetsPage({
  items,
  cats,
  accounts,
  monthSum = { income: 0, expense: 0 },
  baseCurrency = 'CNY',
  csrf,
}: {
  items: Array<Record<string, unknown>>;
  cats: Array<CategoryRow & { path?: string }>;
  accounts: AccountRow[];
  monthSum?: { income: number; expense: number };
  baseCurrency?: string;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const activeItems = items.filter((b) => Number(b.is_active) === 1);
  const activeBudgetTotal = activeItems.reduce((s, b) => s + Number(b.amount_cents || 0), 0);
  const rows =
    items
      .map((b) => {
        const used = b.used as number | null;
        const ratio = b.ratio as number | null;
        const rem = b.remainingCents as number | null;
        const remDays = b.remainingDays as number | null;
        const dailyAvail = b.dailyAvailCents as number | null;
        const amt = Number(b.amount_cents);
        const origAmt = Number(b.orig_amount_cents ?? amt);
        const diffCurrency =
          b.currency && b.baseCurrency && String(b.currency).toUpperCase() !== String(b.baseCurrency).toUpperCase();
        const remHtml =
          rem == null
            ? '—'
            : rem < 0
              ? `<span class="expense">超支 ${fmtAmount(Math.abs(rem))}</span>`
              : fmtAmount(rem);
        const dailyHtml =
          dailyAvail == null
            ? '<span class="muted">—</span>'
            : `${fmtAmount(dailyAvail)}/天<div class="tiny muted">剩 ${remDays} 天</div>`;
        return `<tr>
  <td><b>${esc(b.name)}</b> <span class="chip">${esc(b.catLabel)}</span>${Number(b.rollover) > 0 ? ` <span class="tiny muted">含结转 ${fmtAmount(Number(b.rollover))}</span>` : ''}</td>
  <td>${esc(b.rangeLabel || b.period)}</td>
  <td class="num amount">${fmtAmount(amt)}${diffCurrency ? `<div class="tiny muted">${(origAmt / 100).toFixed(2)} ${esc(b.currency)}</div>` : ''}</td>
  <td class="num amount">${used == null ? '—' : fmtAmount(used)}</td>
  <td class="num amount">${remHtml}</td>
  <td class="num amount">${dailyHtml}</td>
  <td style="min-width:150px">${ratio == null || used == null ? '—' : `${progressBar(used, amt)} <span class="tiny muted">${Math.round(ratio)}%</span>`}</td>
  <td>
    <a class="btn btn-sm" href="/budgets/${b.id}/edit">编辑</a>
    <form method="post" action="/budgets/${b.id}/toggle" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${b.is_active ? '停用' : '启用'}</button></form>
    <form method="post" action="/budgets/${b.id}/delete" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
  </td>
</tr>`;
      })
      .join('') || '<tr><td colspan="8">暂无预算</td></tr>';

  return (
    `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">本月支出</div><div class="value amount expense">-${fmtAmount(monthSum.expense)}</div></div>
  <div class="stat"><div class="label">本月收入</div><div class="value amount income">+${fmtAmount(monthSum.income)}</div></div>
  <div class="stat"><div class="label">生效预算数</div><div class="value">${activeItems.length} 个</div><div class="delta">共 ${items.length} 条配置</div></div>
  <div class="stat"><div class="label">生效预算总额</div><div class="value amount">${fmtAmount(activeBudgetTotal)}</div></div>
</div>` +
    simpleTable('预算中心', ['名称', '周期', '有效预算', '已用', '剩余', '日均可用', '进度', '操作'], rows) +
    `<div class="card mt16"><div class="card-head"><b>新建预算</b></div>
<form method="post" action="/budgets">${csrfInput}
  <div class="grid grid-3">
    <input name="name" placeholder="预算名称，如：月度餐饮预算" required>
    <select name="scope"><option value="overall">总预算</option><option value="category">按分类</option><option value="account">按账户</option></select>
    <select name="category_id"><option value="">全部分类</option>${cats.map((cc) => `<option value="${cc.id}">${cc.kind === 'income' ? '[收] ' : ''}${esc(cc.path || cc.name)}</option>`).join('')}</select>
    <select name="account_id"><option value="">全部账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <select name="period"><option value="monthly">每月</option><option value="weekly">每周</option><option value="yearly">每年</option><option value="custom">自定义</option></select>
    <input name="amount" placeholder="预算金额（元）" inputmode="decimal" required>
    <input name="currency" value="${esc(baseCurrency || 'CNY')}" maxlength="8" placeholder="币种，如 CNY" title="币种">
    <select name="trigger_type"><option value="expense">支出预算</option><option value="income">收入预算</option></select>
    <input name="alert_pct" type="number" min="1" max="100" value="80" title="预警阈值（%）">
    <input type="date" name="start_date" title="自定义开始">
    <input type="date" name="end_date" title="自定义结束">
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="rollover"> 剩余额度结转下期</label><button class="btn btn-primary" type="submit">创建预算</button></div>
</form></div>`
  );
}

export function subscriptionsPage({
  ov,
  accounts,
  cats,
  today,
  csrf,
}: {
  ov: {
    monthlyTotal: number;
    annualTotal: number;
    dueThisMonth?: number;
    thisMonthPending?: number;
    thisMonthCharged?: number;
    live: unknown[];
    active?: Array<Record<string, unknown>>;
    trials?: Array<Record<string, unknown>>;
    paused?: Array<Record<string, unknown>>;
    canceled?: Array<Record<string, unknown>>;
    items: Array<Record<string, unknown>>;
  };
  accounts: AccountRow[];
  cats: Array<CategoryRow & { path: string }>;
  today: string;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const renderSubRow = (s: Record<string, unknown>) => {
    const anchorHint =
      s.cycle === 'monthly' &&
      s.anchor_day &&
      s.next_charge_at &&
      Number(String(s.next_charge_at).slice(8, 10)) !== Number(s.anchor_day)
        ? ` <span class="tiny muted">（锚点 ${s.anchor_day} 日）</span>`
        : '';
    return `<tr>
  <td>${esc(s.icon || '🧾')} <b>${esc(s.name)}</b> <span class="tiny muted">${esc(s.plan || '')}</span><div class="tiny muted">已扣 ${Number(s.charge_count || 0)} 期</div></td>
  <td class="num amount">${fmtAmount(Number(s.amount_cents))} <span class="tiny muted">${esc(s.currency || 'CNY')}</span></td>
  <td>${esc(cycleLabel(String(s.cycle), Number(s.cycle_n)))}</td>
  <td>${esc(s.next_charge_at || '')}${anchorHint}${s.daysLeft != null ? ` <span class="tiny muted">(${s.daysLeft}天)</span>` : ''}</td>
  <td><span class="chip">${esc(statusLabel(String(s.status)))}</span></td>
  <td>
    <div class="row wrap">
      <a class="btn btn-sm" href="/subscriptions/${s.id}/edit">编辑</a>
      <form method="post" action="/subscriptions/${s.id}/charge" style="display:inline">${csrfInput}<input type="hidden" name="next_charge_at" value="${esc(s.next_charge_at || '')}"><button class="btn btn-sm" type="submit">扣费</button></form>
      <form method="post" action="/subscriptions/${s.id}/skip" style="display:inline">${csrfInput}<input type="hidden" name="next_charge_at" value="${esc(s.next_charge_at || '')}"><button class="btn btn-sm" type="submit">跳过</button></form>
      <form method="post" action="/subscriptions/${s.id}/toggle" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${s.status === 'paused' || s.status === 'canceled' ? '恢复' : '暂停'}</button></form>
      <form method="post" action="/subscriptions/${s.id}/cancel" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">取消</button></form>
      <form method="post" action="/subscriptions/${s.id}/delete" style="display:inline" data-confirm="确认永久删除该订阅？（不会删除已生成的历史扣费流水）">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
    </div>
  </td>
</tr>`;
  };

  const groups: Array<{ title: string; list: Array<Record<string, unknown>> }> = [
    { title: '试用中', list: ov.trials ?? ov.items.filter((s) => s.status === 'trial') },
    { title: '生效中', list: ov.active ?? ov.items.filter((s) => s.status === 'active') },
    { title: '已暂停', list: ov.paused ?? ov.items.filter((s) => s.status === 'paused') },
    { title: '已取消', list: ov.canceled ?? ov.items.filter((s) => s.status === 'canceled') },
  ];
  const groupHtml = ov.items.length
    ? groups
        .filter((g) => g.list.length > 0)
        .map((g) =>
          simpleTable(
            `${g.title}（${g.list.length}）`,
            ['名称', '金额', '周期', '下次扣费', '状态', '操作'],
            g.list.map(renderSubRow).join(''),
          ),
        )
        .join('<div class="mb16"></div>')
    : simpleTable('订阅扣费管理', ['名称', '金额', '周期', '下次扣费', '状态', '操作'], '<tr><td colspan="6">暂无订阅</td></tr>');

  const presetChips = SUB_PRESETS.map(
    (p) =>
      `<button type="button" class="chip" data-sub-preset="${esc(JSON.stringify(p))}">${esc(p.icon)} ${esc(p.name)}</button>`,
  ).join('');

  return `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">月均摊销合计</div><div class="value amount">${fmtAmount(ov.monthlyTotal)}</div><div class="delta">生效中 ${ov.live.length} / 共 ${ov.items.length} 个</div></div>
  <div class="stat"><div class="label">年化成本合计</div><div class="value amount">${fmtAmount(ov.annualTotal)}</div></div>
  <div class="stat"><div class="label">本月待扣</div><div class="value amount">${fmtAmount(Number(ov.thisMonthPending || 0))}</div><div class="delta">本月到期 ${Number(ov.dueThisMonth || 0)} 项</div></div>
  <div class="stat"><div class="label">本月已扣</div><div class="value amount expense">-${fmtAmount(Number(ov.thisMonthCharged || 0))}</div></div>
</div>
${groupHtml}
<div class="card mt16"><div class="card-head"><b>新建订阅</b><span class="muted small">点击常用服务可快速填充</span></div>
<div class="row wrap mb12" style="gap:6px">${presetChips}</div>
<form method="post" action="/subscriptions" data-require-trial-end>${csrfInput}
  <div class="grid grid-3">
    <input name="name" placeholder="订阅名称，如：iCloud+" required>
    <input name="icon" placeholder="图标，默认 🧾" value="🧾" maxlength="8">
    <input name="amount" placeholder="每期金额（元）" inputmode="decimal" required>
    <input name="currency" placeholder="币种，默认 CNY" value="CNY" maxlength="8">
    <select name="cycle">${Object.entries(CYCLE_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    <input name="cycle_n" type="number" min="1" max="12" value="1" title="每 N 个周期">
    <input name="anchor_month" type="number" min="1" max="12" placeholder="扣费月（1-12，年付可选）">
    <select name="account_id"><option value="">扣费账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <select name="category_id"><option value="">分类</option>${cats.map((cc) => `<option value="${cc.id}">${esc(cc.path)}</option>`).join('')}</select>
    <input type="date" name="next_charge_at" value="${today}">
    <input name="plan" placeholder="套餐名称">
    <input type="date" name="trial_ends_on" title="试用结束日">
    <select name="status"><option value="active">生效中</option><option value="trial">试用中</option><option value="paused">已暂停</option></select>
    <input name="reminder_days" type="number" min="0" max="60" value="3" title="提前提醒天数">
    <input name="vendor_url" type="url" placeholder="官网 / 退订链接（可选）">
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="auto_renew" checked> 到期自动扣费记账</label><button class="btn btn-primary" type="submit">创建订阅</button></div>
</form></div>`;
}
