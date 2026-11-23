import { progressBar } from '../lib/charts.js';
import { CYCLE_LABEL, cycleLabel, statusLabel } from '../lib/subscriptions.js';
import type { AccountRow, CategoryRow } from '../types.js';
import { esc, fmtAmount } from '../lib/util.js';
import { simpleTable } from './layout.js';

export function budgetsPage({
  items,
  cats,
  accounts,
  csrf,
}: {
  items: Array<Record<string, unknown>>;
  cats: CategoryRow[];
  accounts: AccountRow[];
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const rows =
    items
      .map((b) => {
        const used = b.used as number | null;
        const ratio = b.ratio as number | null;
        const amt = Number(b.amount_cents);
        return `<tr>
  <td><b>${esc(b.name)}</b> <span class="chip">${esc(b.catLabel)}</span>${Number(b.rollover) > 0 ? ` <span class="tiny muted">含结转 ${fmtAmount(Number(b.rollover))}</span>` : ''}</td>
  <td>${esc(b.rangeLabel || b.period)}</td>
  <td class="num amount">${fmtAmount(amt)}</td>
  <td class="num amount">${used == null ? '—' : fmtAmount(used)}</td>
  <td style="min-width:150px">${ratio == null || used == null ? '—' : `${progressBar(used, amt)} <span class="tiny muted">${Math.round(ratio)}%</span>`}</td>
  <td>
    <a class="btn btn-sm" href="/budgets/${b.id}/edit">编辑</a>
    <form method="post" action="/budgets/${b.id}/toggle" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${b.is_active ? '停用' : '启用'}</button></form>
    <form method="post" action="/budgets/${b.id}/delete" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
  </td>
</tr>`;
      })
      .join('') || '<tr><td colspan="6">暂无预算</td></tr>';

  return (
    simpleTable('预算中心', ['名称', '周期', '有效预算', '已用', '进度', '操作'], rows) +
    `<div class="card mt16"><div class="card-head"><b>新建预算</b></div>
<form method="post" action="/budgets">${csrfInput}
  <div class="grid grid-3">
    <input name="name" placeholder="预算名称，如：月度餐饮预算" required>
    <select name="scope"><option value="overall">总预算</option><option value="category">按分类</option><option value="account">按账户</option></select>
    <select name="category_id"><option value="">全部支出分类</option>${cats.map((cc) => `<option value="${cc.id}">${esc(cc.name)}</option>`).join('')}</select>
    <select name="account_id"><option value="">全部账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <select name="period"><option value="monthly">每月</option><option value="weekly">每周</option><option value="yearly">每年</option><option value="custom">自定义</option></select>
    <input name="amount" placeholder="预算金额（元）" inputmode="decimal" required>
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
  ov: { monthlyTotal: number; annualTotal: number; live: unknown[]; items: Array<Record<string, unknown>> };
  accounts: AccountRow[];
  cats: Array<CategoryRow & { path: string }>;
  today: string;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const rows =
    ov.items
      .map(
        (s) => `<tr>
  <td>${esc(s.icon || '🧾')} <b>${esc(s.name)}</b> <span class="tiny muted">${esc(s.plan || '')}</span></td>
  <td class="num amount">${fmtAmount(Number(s.amount_cents))}</td>
  <td>${esc(cycleLabel(String(s.cycle), Number(s.cycle_n)))}</td>
  <td>${esc(s.next_charge_at || '')}${s.daysLeft != null ? ` <span class="tiny muted">(${s.daysLeft}天)</span>` : ''}</td>
  <td><span class="chip">${esc(statusLabel(String(s.status)))}</span></td>
  <td>
    <a class="btn btn-sm" href="/subscriptions/${s.id}/edit">编辑</a>
    <form method="post" action="/subscriptions/${s.id}/charge" style="display:inline">${csrfInput}<input type="hidden" name="next_charge_at" value="${esc(s.next_charge_at || '')}"><button class="btn btn-sm" type="submit">扣费</button></form>
    <form method="post" action="/subscriptions/${s.id}/skip" style="display:inline">${csrfInput}<input type="hidden" name="next_charge_at" value="${esc(s.next_charge_at || '')}"><button class="btn btn-sm" type="submit">跳过</button></form>
    <form method="post" action="/subscriptions/${s.id}/toggle" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${s.status === 'paused' || s.status === 'canceled' ? '恢复' : '暂停'}</button></form>
    <form method="post" action="/subscriptions/${s.id}/cancel" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">取消</button></form>
  </td>
</tr>`,
      )
      .join('') || '<tr><td colspan="6">暂无订阅</td></tr>';

  return `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">月均摊销合计</div><div class="value amount">${fmtAmount(ov.monthlyTotal)}</div></div>
  <div class="stat"><div class="label">年化成本合计</div><div class="value amount">${fmtAmount(ov.annualTotal)}</div></div>
  <div class="stat"><div class="label">生效中订阅</div><div class="value">${ov.live.length} 个</div></div>
  <div class="stat"><div class="label">总订阅项</div><div class="value">${ov.items.length} 个</div></div>
</div>
${simpleTable('订阅扣费管理', ['名称', '金额', '周期', '下次扣费', '状态', '操作'], rows)}
<div class="card mt16"><div class="card-head"><b>新建订阅</b></div>
<form method="post" action="/subscriptions" data-require-trial-end>${csrfInput}
  <div class="grid grid-3">
    <input name="name" placeholder="订阅名称，如：iCloud+" required>
    <input name="amount" placeholder="每期金额（元）" inputmode="decimal" required>
    <select name="cycle">${Object.entries(CYCLE_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    <input name="cycle_n" type="number" min="1" max="12" value="1" title="每 N 个周期">
    <select name="account_id"><option value="">扣费账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <select name="category_id"><option value="">分类</option>${cats.map((cc) => `<option value="${cc.id}">${esc(cc.path)}</option>`).join('')}</select>
    <input type="date" name="next_charge_at" value="${today}">
    <input name="plan" placeholder="套餐名称">
    <input type="date" name="trial_ends_on" title="试用结束日">
    <select name="status"><option value="active">生效中</option><option value="trial">试用中</option><option value="paused">已暂停</option></select>
    <input name="reminder_days" type="number" min="0" max="60" value="3" title="提前提醒天数">
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="auto_renew" checked> 到期自动扣费记账</label><button class="btn btn-primary" type="submit">创建订阅</button></div>
</form></div>`;
}
