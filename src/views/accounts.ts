import { ACCOUNT_GROUPS, ACCOUNT_TYPES, isCreditGroupType, todayStr } from '../db.js';
import { accountOptionsHtml, creditMetrics, groupAccountsSummary } from '../lib/accounts.js';
import { progressBar } from '../lib/charts.js';
import type { DecoratedSessionCard } from '../lib/session-cards.js';
import type { TxnDateGroup } from '../lib/txn.js';
import { esc, fmtAmount, money } from '../lib/util.js';
import type { AccountRow, CategoryRow, SessionCardLogRow } from '../types.js';
import { groupList, paginationHtml, simpleTable } from './layout.js';

const typeLabelMap = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.key, `${t.icon} ${t.label}`]));

function renderAccountRow(a: AccountRow, csrfInput: string, opts: { isCredit?: boolean; writable: boolean }): string {
  const m = opts.isCredit ? creditMetrics(a) : null;
  const metaParts: string[] = [];
  if (a.institution) metaParts.push(esc(a.institution));
  if (a.card_no) metaParts.push(`尾号 ${esc(a.card_no)}`);
  metaParts.push(esc(a.currency || 'CNY'));
  if (!a.include_in_net) metaParts.push('不计入净资产');
  if (a.is_archived) metaParts.push('已归档');

  let creditExtra = '';
  if (m) {
    const chips: string[] = [];
    if (m.limitCents !== null) {
      chips.push(
        `额度 ${fmtAmount(m.limitCents)} · 可用 ${fmtAmount(m.availableCents ?? 0)} · 已用 ${m.usagePct}%`,
      );
    }
    if (m.nextBill) {
      chips.push(`账单日 ${a.bill_day}日（${m.nextBill.daysUntil === 0 ? '今日' : `${m.nextBill.daysUntil}天后`}）`);
    }
    if (m.nextDue) {
      chips.push(`还款日 ${a.due_day}日（${m.nextDue.daysUntil === 0 ? '今日到期' : `${m.nextDue.daysUntil}天后`}）`);
    }
    creditExtra = `${chips.length ? `<div class="tiny muted mt8">${esc(chips.join(' · '))}</div>` : ''}
${m.limitCents !== null && m.limitCents > 0 ? `<div class="mt8" style="max-width:340px">${progressBar(m.debtCents, m.limitCents, { height: 6, warn: m.usagePct >= 85 })}</div>` : ''}`;
  }

  const rightBalance = m
    ? m.debtCents > 0
      ? `<span class="amount bold expense">待还 ${fmtAmount(m.debtCents)}</span>`
      : m.overflowCents > 0
        ? `<span class="amount bold income">溢缴 +${fmtAmount(m.overflowCents)}</span>`
        : '<span class="amount bold">待还 0.00</span>'
    : `<span class="amount bold">${money(a.balance_cents, a.currency)}</span>`;

  const repayBtn =
    opts.writable && m && !a.is_archived
      ? `<a class="btn btn-sm btn-primary" href="/transactions/new?type=transfer&to_account_id=${a.id}${m.debtCents > 0 ? `&amount=${(m.debtCents / 100).toFixed(2)}` : ''}">去还款</a>`
      : '';

  return `<div class="between" style="border-bottom:1px solid var(--border);padding:12px 0;align-items:flex-start">
  <div style="flex:1;min-width:220px">
    <div class="row wrap" style="gap:6px">
      <b>${esc(a.icon || '💳')} ${esc(a.name)}</b>
      <span class="chip">${esc(typeLabelMap[a.type] || a.type)}</span>
      <span class="tiny muted">${metaParts.join(' · ')}</span>
    </div>
    ${a.note ? `<div class="tiny muted mt8">${esc(a.note)}</div>` : ''}
    ${creditExtra}
  </div>
  <div class="row wrap" style="justify-content:flex-end">
    ${rightBalance}
    ${repayBtn}
    <a class="btn btn-sm" href="/accounts/${a.id}">${opts.writable ? '明细/编辑' : '明细'}</a>
${opts.writable ? `    <form method="post" action="/accounts/${a.id}/archive" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${a.is_archived ? '恢复' : '归档'}</button></form>
    <form method="post" action="/accounts/${a.id}/delete" style="display:inline" data-confirm="确认删除该账户？">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>` : ''}
  </div>
</div>`;
}

function renderSessionCardItem(c: DecoratedSessionCard, csrfInput: string, writable: boolean): string {
  const badges: string[] = [];
  if (c.merchant) badges.push(`<span class="chip">${esc(c.merchant)}</span>`);
  if (c.is_archived) badges.push('<span class="chip">已归档</span>');
  else if (c.isExhausted) badges.push('<span class="chip">已用完</span>');
  else if (c.isExpired) badges.push('<span class="chip expense">已过期</span>');
  else if (c.isExpiringSoon) {
    badges.push(
      `<span class="chip warn">${c.daysUntilExpiry === 0 ? '今日到期' : `${c.daysUntilExpiry}天后到期`}</span>`,
    );
  }
  if (c.isLowSessions && !c.is_archived) badges.push('<span class="chip warn">余次不足</span>');

  const canUse = writable && !c.is_archived && c.remaining_sessions > 0;
  return `<div class="card" style="padding:14px;background:var(--card-2)">
  <div class="between" style="padding:0 0 8px">
    <div class="row wrap" style="gap:6px">
      <b>${esc(c.icon || '🎟️')} ${esc(c.name)}</b>
      ${badges.join('')}
    </div>
    <span class="amount bold">${c.remaining_sessions} / ${c.total_sessions} 次</span>
  </div>
  ${progressBar(c.remaining_sessions, c.total_sessions, { height: 6, warn: c.isExpired || c.isLowSessions })}
  <div class="between mt8" style="padding:0">
    <span class="tiny muted">单次约 ${fmtAmount(c.unitCostCents)} 元 · 累计 ${fmtAmount(c.total_cost_cents)} 元${c.expires_at ? ` · 有效期至 ${esc(c.expires_at)}` : ' · 长期有效'}</span>
    <div class="row">
      ${
        canUse
          ? `<form method="post" action="/session-cards/${c.id}/use" style="display:inline">${csrfInput}<input type="hidden" name="count" value="1"><input type="hidden" name="back" value="/accounts#session-cards"><button class="btn btn-sm btn-primary" type="submit">核销 -1 次</button></form>`
          : ''
      }
      <a class="btn btn-sm" href="/session-cards/${c.id}">${writable ? '详情/续费' : '详情'}</a>
    </div>
  </div>
</div>`;
}

export function accountsPage({
  accounts,
  ov,
  sessionCards,
  expenseCats,
  csrf,
  writable,
}: {
  accounts: AccountRow[];
  ov: { assets: number; liabilities: number; net: number; rates: ReadonlyMap<string, number>; baseCurrency: string; missingCurrencies: string[] };
  sessionCards: {
    all: DecoratedSessionCard[];
    active: DecoratedSessionCard[];
    archivedOrExhausted: DecoratedSessionCard[];
    activeCount: number;
    totalRemaining: number;
  };
  expenseCats: Array<CategoryRow & { path: string }>;
  csrf: string;
  writable: boolean;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const grouped = groupAccountsSummary(accounts, ov.rates);
  const today = todayStr();

  const archivedCount = grouped.archived.length + sessionCards.archivedOrExhausted.length;

  return `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">总资产</div><div class="value amount income">${money(ov.assets, ov.baseCurrency)}</div></div>
  <div class="stat"><div class="label">总负债</div><div class="value amount expense">${money(ov.liabilities, ov.baseCurrency)}</div></div>
  <div class="stat"><div class="label">净资产</div><div class="value amount">${money(ov.net, ov.baseCurrency)}</div></div>
  <div class="stat"><div class="label">活跃账户与次卡</div><div class="value">${grouped.active.length} 账户${sessionCards.activeCount ? ` · ${sessionCards.activeCount} 次卡` : ''}</div></div>
</div>

${ov.missingCurrencies.length ? `<p class="muted">汇总未计入缺少汇率的币种 ${esc(ov.missingCurrencies.join('、'))}</p>` : ''}
<div class="card mb16">
  <div class="card-head">
    <b>${ACCOUNT_GROUPS[0].icon} ${ACCOUNT_GROUPS[0].label}</b>
    <span class="amount bold">小计 ${money(grouped.fundsTotalCents, ov.baseCurrency)}</span>
  </div>
  ${grouped.groups.funds.map((a) => renderAccountRow(a, csrfInput, { writable })).join('') || '<div class="empty">暂无活跃资金账户</div>'}
</div>

<div class="card mb16" id="session-cards">
  <div class="card-head">
    <b>${ACCOUNT_GROUPS[1].icon} ${ACCOUNT_GROUPS[1].label}与次卡</b>
    <span class="amount bold">储值余额 ${money(grouped.prepaidTotalCents, ov.baseCurrency)}${sessionCards.activeCount ? ` · 有效次卡 ${sessionCards.activeCount} 张（余 ${sessionCards.totalRemaining} 次）` : ''}</span>
  </div>
  ${grouped.groups.prepaid.length ? `<div class="mb12">${grouped.groups.prepaid.map((a) => renderAccountRow(a, csrfInput, { writable })).join('')}</div>` : ''}
  ${
    sessionCards.active.length
      ? `<div class="grid grid-2">${sessionCards.active.map((c) => renderSessionCardItem(c, csrfInput, writable)).join('')}</div>`
      : '<div class="empty">暂无有效次卡</div>'
  }
</div>

<div class="card mb16">
  <div class="card-head">
    <b>${ACCOUNT_GROUPS[2].icon} ${ACCOUNT_GROUPS[2].label}（信用卡 / 花呗 / 白条）</b>
    <span class="amount bold expense">总待还 ${money(grouped.creditDebtCents, ov.baseCurrency)}${grouped.creditLimitCents > 0 ? ` · 总额度 ${money(grouped.creditLimitCents, ov.baseCurrency)} · 可用 ${money(grouped.creditAvailableCents, ov.baseCurrency)}` : ''}</span>
  </div>
  ${grouped.groups.credit.map((a) => renderAccountRow(a, csrfInput, { isCredit: true, writable })).join('') || '<div class="empty">暂无活跃信用账户</div>'}
</div>

${writable ? `<div class="grid grid-2 mb16">
  <div class="card">
    <div class="card-head"><b>新建账户</b><span class="tiny muted">支持三层分组与信用账期</span></div>
    <div class="row wrap mb12">
      <span class="tiny muted">信用快捷预设：</span>
      <button type="button" class="chip" data-credit-preset data-name="信用卡" data-icon="💳" data-inst="">💳 信用卡</button>
      <button type="button" class="chip" data-credit-preset data-name="花呗" data-icon="🟦" data-inst="支付宝">🟦 花呗</button>
      <button type="button" class="chip" data-credit-preset data-name="京东白条" data-icon="🟨" data-inst="京东金融">🟨 京东白条</button>
    </div>
    <form method="post" action="/accounts" data-account-form>
      ${csrfInput}
      <input type="hidden" name="_include_in_net_present" value="1">
      <div class="grid grid-2">
        <div class="field"><label>账户名称</label><input name="name" placeholder="如：招商银行储蓄卡 / 花呗" required></div>
        <div class="field"><label>账户类型</label><select name="type">${ACCOUNT_TYPES.map((t) => `<option value="${t.key}">${esc(t.icon)} ${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label data-balance-label>初始余额（元）</label><input name="balance" placeholder="0.00" inputmode="decimal"></div>
        <div class="field"><label>币种</label><input name="currency" value="CNY"></div>
        <div class="field"><label>图标</label><input name="icon" value="💳"></div>
        <div class="field"><label>机构 / 平台</label><input name="institution" placeholder="如：招商银行 / 支付宝"></div>
        <div class="field"><label>卡号后四位（可选）</label><input name="card_no" maxlength="16" placeholder="如：8866"></div>
        <div class="field"><label>排序权重</label><input type="number" name="sort_order" value="0"></div>
      </div>
      <div class="grid grid-3 hidden" data-credit-fields>
        <div class="field"><label>信用额度（元）</label><input name="credit_limit" placeholder="如：20000" inputmode="decimal"></div>
        <div class="field"><label>账单日（1-31）</label><input type="number" name="bill_day" min="1" max="31" placeholder="如：5"></div>
        <div class="field"><label>还款日（1-31）</label><input type="number" name="due_day" min="1" max="31" placeholder="如：25"></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" placeholder="账户说明或还款备注"></div>
      <div class="between" style="padding:4px 0 10px">
        <label class="check"><input type="checkbox" name="include_in_net" value="1" checked> 计入净资产</label>
        <button class="btn btn-primary" type="submit">创建账户</button>
      </div>
    </form>
  </div>

  <div class="card">
    <div class="card-head"><b>新建次卡（按次台账）</b><span class="tiny muted">购卡记支出 · 核销扣次数</span></div>
    <form method="post" action="/session-cards" data-session-card-form>
      ${csrfInput}
      <input type="hidden" name="back" value="/accounts#session-cards">
      <div class="grid grid-2">
        <div class="field"><label>次卡名称</label><input name="name" placeholder="如：10次洗车卡 / 20次理发卡" required></div>
        <div class="field"><label>图标</label><input name="icon" value="🎟️"></div>
        <div class="field"><label>总次数</label><input type="number" name="total_sessions" min="1" max="9999" placeholder="如：10" required></div>
        <div class="field"><label>初始剩余次数（补录老卡可填）</label><input type="number" name="remaining_sessions" min="0" max="9999" placeholder="留空默认等于总次数"></div>
        <div class="field"><label>购卡总金额（元）</label><input name="total_cost" placeholder="0.00" inputmode="decimal"></div>
        <div class="field"><label>商家 / 门店（可选）</label><input name="merchant" placeholder="如：途虎养车"></div>
        <div class="field"><label>购卡日期</label><input type="date" name="purchase_date" value="${esc(today)}"></div>
        <div class="field"><label>有效期至（可选）</label><input type="date" name="expires_at"></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" placeholder="如：周末通用，门店电话…"></div>
      <div class="mb12">
        <label class="check"><input type="checkbox" name="record_expense" value="1" checked> 同步记一笔购卡支出（补录存量老卡/赠卡可取消勾选）</label>
      </div>
      <div class="grid grid-2" data-sc-expense-fields>
        <div class="field"><label>付款账户</label><select name="account_id">${accountOptionsHtml(grouped.active, { emptyLabel: '请选择付款账户', showBalance: true })}</select></div>
        <div class="field"><label>支出分类</label><select name="category_id"><option value="">默认 / 未分类</option>${expenseCats.map((c) => `<option value="${c.id}">${esc(c.path)}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary btn-block" type="submit">创建次卡</button>
    </form>
  </div>
</div>` : ''}

${
  archivedCount
    ? `<details class="card mt16">
  <summary class="bold" style="cursor:pointer">已归档账户与已用完/归档次卡（${archivedCount}）</summary>
  <div class="mt12">
    ${grouped.archived.map((a) => renderAccountRow(a, csrfInput, { isCredit: isCreditGroupType(a.type), writable })).join('')}
    ${
      sessionCards.archivedOrExhausted.length
        ? `<div class="grid grid-2 mt12">${sessionCards.archivedOrExhausted.map((c) => renderSessionCardItem(c, csrfInput, writable)).join('')}</div>`
        : ''
    }
  </div>
</details>`
    : ''
}`;
}

export function accountDetailPage({
  acc,
  groups,
  unresolved,
  result,
  from = '',
  to = '',
  writable = true,
  csrf,
}: {
  acc: AccountRow;
  unresolved: Array<{ id: number; txn_date: string }>;
  groups: TxnDateGroup[];
  result: { total: number; page: number; pages: number; sum: { income: number; expense: number } };
  from?: string;
  to?: string;
  writable?: boolean;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const isCredit = isCreditGroupType(acc.type);
  const m = isCredit ? creditMetrics(acc) : null;

  const headerCard = `<div class="card mb16">
  <div class="card-head">
    <div class="row wrap">
      <b>${esc(acc.icon || '💳')} ${esc(acc.name)}</b>
      <span class="chip">${esc(typeLabelMap[acc.type] || acc.type)}</span>
      ${acc.institution ? `<span class="chip">${esc(acc.institution)}</span>` : ''}
      ${acc.card_no ? `<span class="chip">尾号 ${esc(acc.card_no)}</span>` : ''}
      ${acc.is_archived ? '<span class="chip warn">已归档</span>' : ''}
    </div>
    <div class="row wrap">
      ${
        writable && !acc.is_archived
          ? `<a class="btn btn-sm btn-primary" href="/transactions/new?account_id=${acc.id}&back=${encodeURIComponent(`/accounts/${acc.id}`)}">+ 记一笔</a>`
          : ''
      }
      ${
        writable && m && !acc.is_archived
          ? `<a class="btn btn-sm" href="/transactions/new?type=transfer&to_account_id=${acc.id}${m.debtCents > 0 ? `&amount=${(m.debtCents / 100).toFixed(2)}` : ''}">去还款</a>`
          : ''
      }
      <a class="btn btn-sm" href="/accounts">← 返回列表</a>
    </div>
  </div>
  ${
    m
      ? `<div class="kpi-grid mb12">
    <div class="stat"><div class="label">当前待还</div><div class="value amount ${m.debtCents > 0 ? 'expense' : ''}">${money(m.debtCents, acc.currency)}</div></div>
    <div class="stat"><div class="label">信用额度</div><div class="value amount">${m.limitCents !== null ? money(m.limitCents, acc.currency) : '未设置'}</div></div>
    <div class="stat"><div class="label">剩余可用额度</div><div class="value amount income">${m.availableCents !== null ? money(m.availableCents, acc.currency) : '—'}</div></div>
    <div class="stat"><div class="label">账单 / 还款日</div><div class="value" style="font-size:16px">${acc.bill_day ? `${acc.bill_day}日` : '—'} / ${acc.due_day ? `${acc.due_day}日` : '—'}</div><div class="delta">${m.nextDue ? `距还款 ${m.nextDue.daysUntil === 0 ? '今日到期' : `${m.nextDue.daysUntil}天`}（${m.nextDue.date}）` : '未设还款日'}</div></div>
  </div>
  ${m.limitCents !== null && m.limitCents > 0 ? `${progressBar(m.debtCents, m.limitCents, { warn: m.usagePct >= 85 })}<div class="tiny muted mt8">额度使用率 ${m.usagePct}%</div>` : ''}`
      : `<div class="between" style="padding:0"><span class="muted small">币种：${esc(acc.currency || 'CNY')} · ${acc.include_in_net ? '计入净资产' : '不计入净资产'}</span><span class="amount bold" style="font-size:20px">当前余额 ${money(acc.balance_cents, acc.currency)}</span></div>`
  }
</div>`;

  const editAndAdjustGrid = writable
    ? `<div class="grid grid-2 mb16">
  <div class="card" id="edit">
    <div class="card-head"><b>编辑账户信息</b><span class="tiny muted">不直接修改期初或当前余额</span></div>
    <form method="post" action="/accounts/${acc.id}/edit" data-account-form>
      ${csrfInput}
      <input type="hidden" name="_include_in_net_present" value="1">
      <div class="grid grid-2">
        <div class="field"><label>账户名称</label><input name="name" value="${esc(acc.name)}" required></div>
        <div class="field"><label>账户类型</label><select name="type">${ACCOUNT_TYPES.map((t) => `<option value="${t.key}" ${acc.type === t.key ? 'selected' : ''}>${esc(t.icon)} ${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label>图标</label><input name="icon" value="${esc(acc.icon || '💳')}"></div>
        <div class="field"><label>币种</label><input name="currency" value="${esc(acc.currency || 'CNY')}"></div>
        <div class="field"><label>机构 / 平台</label><input name="institution" value="${esc(acc.institution || '')}" placeholder="如：招商银行 / 支付宝"></div>
        <div class="field"><label>卡号后四位</label><input name="card_no" value="${esc(acc.card_no || '')}" maxlength="16"></div>
        <div class="field"><label>排序权重</label><input type="number" name="sort_order" value="${Number(acc.sort_order || 0)}"></div>
        <div class="field"><label>备注</label><input name="note" value="${esc(acc.note || '')}"></div>
      </div>
      <div class="grid grid-3${isCredit ? '' : ' hidden'}" data-credit-fields>
        <div class="field"><label>信用额度（元）</label><input name="credit_limit" value="${acc.credit_limit != null ? (Number(acc.credit_limit) / 100).toFixed(2) : ''}" inputmode="decimal" placeholder="留空表示不限"></div>
        <div class="field"><label>账单日（1-31）</label><input type="number" name="bill_day" min="1" max="31" value="${acc.bill_day ?? ''}"></div>
        <div class="field"><label>还款日（1-31）</label><input type="number" name="due_day" min="1" max="31" value="${acc.due_day ?? ''}"></div>
      </div>
      <div class="between" style="padding:4px 0 0">
        <label class="check"><input type="checkbox" name="include_in_net" value="1" ${acc.include_in_net ? 'checked' : ''}> 计入净资产</label>
        <button class="btn btn-primary" type="submit">保存账户信息</button>
      </div>
    </form>
  </div>

  <div class="card">
    <div class="card-head"><b>校准余额</b><span class="tiny muted">自动生成一条余额调整流水</span></div>
    <p class="muted small mb12">${isCredit ? '信用账户账面余额以负数表示待还欠款（如待还 500 元请填 -500.00）。' : '填写当前实际账户余额，系统会自动计算差额并生成校准流水。'}</p>
    <form method="post" action="/accounts/${acc.id}/adjust" class="row wrap mb16">
      ${csrfInput}
      <input name="actual_balance" inputmode="decimal" placeholder="校准到（元）" value="${(Number(acc.balance_cents) / 100).toFixed(2)}" style="max-width:200px">
      <button class="btn btn-primary" type="submit">校准余额</button>
    </form>
    <div class="row wrap" style="border-top:1px solid var(--border);padding-top:12px">
      <form method="post" action="/accounts/${acc.id}/archive" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${acc.is_archived ? '恢复活跃' : '归档账户'}</button></form>
      <form method="post" action="/accounts/${acc.id}/delete" style="display:inline" data-confirm="确认删除该账户？">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除账户</button></form>
    </div>
  </div>
</div>`
    : '';

  const hasRange = Boolean(from || to);
  const txnsCard = `<div class="card">
  <div class="card-head">
    <b>关联流水明细</b>
    <span class="muted small amount">共 ${result.total} 笔 · 收入 +${fmtAmount(result.sum.income)} · 支出 -${fmtAmount(result.sum.expense)}</span>
  </div>
  <form method="get" action="/accounts/${acc.id}" class="row wrap mb12">
    <span class="tiny muted">日期区间：</span>
    <input type="date" name="from" value="${esc(from)}" style="width:auto">
    <span class="tiny muted">~</span>
    <input type="date" name="to" value="${esc(to)}" style="width:auto">
    <button class="btn btn-sm btn-primary" type="submit">筛选</button>
    ${hasRange ? `<a class="btn btn-sm" href="/accounts/${acc.id}">清空</a>` : ''}
  </form>
  ${groupList(groups, { writable })}
  ${paginationHtml(`/accounts/${acc.id}`, { from: from || undefined, to: to || undefined }, result.page, result.pages, result.total)}
</div>`;
  const reconcile = unresolved.length ? `<div class="flash warn mb16"><div>
    <b>历史流水待补原币金额</b><p>以下历史流水缺少账户原币金额，相关变动暂未计入此账户余额，最多显示 30 条。</p>
    <ul>${unresolved.map((t) => `<li>${esc(t.txn_date)} ${writable ? `<a href="/transactions/${t.id}/edit">流水 #${t.id}</a>` : `流水 #${t.id}`}</li>`).join('')}</ul>
  </div></div>` : '';
  return headerCard + reconcile + editAndAdjustGrid + txnsCard;
}

export function sessionCardDetailPage({
  card,
  logs,
  accounts,
  expenseCats,
  csrf,
  writable,
}: {
  writable: boolean;
  card: DecoratedSessionCard;
  logs: SessionCardLogRow[];
  accounts: AccountRow[];
  expenseCats: Array<CategoryRow & { path: string }>;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const today = todayStr();
  const statusChip = card.is_archived
    ? '<span class="chip">已归档</span>'
    : card.isExhausted
      ? '<span class="chip">已用完</span>'
      : card.isExpired
        ? '<span class="chip expense">已过期（仍可核销）</span>'
        : card.isExpiringSoon
          ? `<span class="chip warn">${card.daysUntilExpiry === 0 ? '今日到期' : `${card.daysUntilExpiry}天后到期`}</span>`
          : '<span class="chip income">有效</span>';

  const header = `<div class="card mb16">
  <div class="card-head">
    <div class="row wrap">
      <b>${esc(card.icon || '🎟️')} ${esc(card.name)}</b>
      ${card.merchant ? `<span class="chip">${esc(card.merchant)}</span>` : ''}
      ${statusChip}
    </div>
    <div class="row wrap">
      <a class="btn btn-sm" href="/accounts#session-cards">← 返回账户与次卡</a>
      ${writable ? `<form method="post" action="/session-cards/${card.id}/archive" style="display:inline">${csrfInput}<input type="hidden" name="back" value="/session-cards/${card.id}"><button class="btn btn-sm" type="submit">${card.is_archived ? '恢复' : '归档'}</button></form>
      <form method="post" action="/session-cards/${card.id}/delete" style="display:inline" data-confirm="确认删除该次卡？（不会删除已产生的购卡支出流水）">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>` : ''}
    </div>
  </div>
  <div class="kpi-grid mb12">
    <div class="stat"><div class="label">剩余次数</div><div class="value amount">${card.remaining_sessions} / ${card.total_sessions}</div></div>
    <div class="stat"><div class="label">累计投入</div><div class="value amount">${money(card.total_cost_cents, card.currency)}</div></div>
    <div class="stat"><div class="label">参考单次成本</div><div class="value amount">${money(card.unitCostCents, card.currency)}</div></div>
    <div class="stat"><div class="label">有效期</div><div class="value" style="font-size:17px">${esc(card.expires_at || '长期有效')}</div><div class="delta">购卡日 ${esc(card.purchase_date)}</div></div>
  </div>
  ${progressBar(card.remaining_sessions, card.total_sessions, { warn: card.isExpired || card.isLowSessions })}
  ${card.note ? `<div class="tiny muted mt8">备注：${esc(card.note)}</div>` : ''}
</div>`;

  const actionsGrid = `<div class="grid grid-2 mb16">
  <div class="card">
    <div class="card-head"><b>核销记次</b><span class="tiny muted">仅记次数台账，不产生额外支出</span></div>
    <form method="post" action="/session-cards/${card.id}/use">
      ${csrfInput}
      <input type="hidden" name="back" value="/session-cards/${card.id}">
      <div class="grid grid-2">
        <div class="field"><label>本次核销次数</label><input type="number" name="count" min="1" max="${Math.max(1, card.remaining_sessions)}" value="1" required></div>
        <div class="field"><label>使用日期</label><input type="date" name="used_at" value="${esc(today)}" required></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" placeholder="如：洗车精洗 / 周末带家人"></div>
      <button class="btn btn-primary btn-block" type="submit" ${card.is_archived || card.remaining_sessions <= 0 ? 'disabled' : ''}>确认核销</button>
    </form>
  </div>

  <div class="card">
    <div class="card-head"><b>同卡续费 / 加次</b><span class="tiny muted">累加总次数与余次</span></div>
    <form method="post" action="/session-cards/${card.id}/topup" data-session-card-form>
      ${csrfInput}
      <div class="grid grid-2">
        <div class="field"><label>新增次数</label><input type="number" name="add_sessions" min="1" max="9999" placeholder="如：10" required></div>
        <div class="field"><label>续费金额（元）</label><input name="add_cost" placeholder="0.00" inputmode="decimal"></div>
        <div class="field"><label>续费日期</label><input type="date" name="topup_date" value="${esc(today)}"></div>
        <div class="field"><label>延长有效期至（可选）</label><input type="date" name="expires_at"></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" placeholder="如：充值续卡"></div>
      <div class="mb12">
        <label class="check"><input type="checkbox" name="record_expense" value="1" checked> 同步记一笔续费支出</label>
      </div>
      <div class="grid grid-2" data-sc-expense-fields>
        <div class="field"><label>付款账户</label><select name="account_id">${accountOptionsHtml(accounts, { emptyLabel: '请选择付款账户', showBalance: true })}</select></div>
        <div class="field"><label>支出分类</label><select name="category_id"><option value="">默认 / 未分类</option>${expenseCats.map((c) => `<option value="${c.id}">${esc(c.path)}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary btn-block" type="submit">确认续费加次</button>
    </form>
  </div>
</div>`;

  const editCard = `<div class="card mb16">
  <div class="card-head"><b>编辑次卡信息</b></div>
  <form method="post" action="/session-cards/${card.id}/edit">
    ${csrfInput}
    <div class="grid grid-3">
      <div class="field"><label>次卡名称</label><input name="name" value="${esc(card.name)}" required></div>
      <div class="field"><label>图标</label><input name="icon" value="${esc(card.icon || '🎟️')}"></div>
      <div class="field"><label>商家 / 门店</label><input name="merchant" value="${esc(card.merchant || '')}"></div>
      <div class="field"><label>累计投入金额（元）</label><input name="total_cost" value="${(Number(card.total_cost_cents) / 100).toFixed(2)}" inputmode="decimal"></div>
      <div class="field"><label>有效期至</label><input type="date" name="expires_at" value="${esc(card.expires_at || '')}"></div>
      <div class="field"><label>备注</label><input name="note" value="${esc(card.note || '')}"></div>
    </div>
    <button class="btn btn-primary" type="submit">保存次卡信息</button>
  </form>
</div>`;

  const logsTable = simpleTable(
    '核销与加次记录',
    ['日期', '次数变动', '操作人', '备注', '操作'],
    logs
      .map((l) => {
        const isUse = Number(l.delta) < 0;
        const deltaHtml = isUse
          ? `<span class="chip expense">${l.delta} 次</span>`
          : `<span class="chip income">+${l.delta} 次</span>`;
        const ops: string[] = [];
        if (writable && l.txn_id) ops.push(`<a class="btn btn-sm" href="/transactions/${l.txn_id}/edit">关联流水</a>`);
        if (writable && isUse) {
          ops.push(
            `<form method="post" action="/session-cards/${card.id}/logs/${l.id}/undo" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">撤销</button></form>`,
          );
        }
        return `<tr>
  <td class="tiny muted">${esc(l.used_at)}</td>
  <td>${deltaHtml}</td>
  <td>${esc(l.member_name || '成员')}</td>
  <td>${esc(l.note || '—')}</td>
  <td><div class="row">${ops.join('') || '<span class="tiny muted">—</span>'}</div></td>
</tr>`;
      })
      .join('') || '<tr><td colspan="5">暂无使用记录</td></tr>',
  );

  return header + (writable ? actionsGrid + editCard : '') + logsTable;
}

export type CategoryTreeItem = Omit<CategoryRow, 'children'> & {
  year_cnt?: number;
  year_total_cents?: number;
  children?: CategoryTreeItem[];
};

export function categoriesPage({
  tree,
  csrf,
  writable,
}: {
  tree: CategoryTreeItem[];
  csrf: string;
  writable: boolean;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const dot = (color?: string | null) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(color || '#4f7cff')};vertical-align:middle"></span>`;
  return `<div class="grid grid-2">
  ${(['expense', 'income'] as const)
    .map((kind) => {
      const kindRoots = tree.filter((t) => t.kind === kind);
      return `<div class="card">
  <div class="card-head"><b>${kind === 'expense' ? '支出分类' : '收入分类'}</b><span class="muted small">近一年统计 + 自定义颜色与一/二级分类</span></div>
  ${kindRoots
    .map(
      (root) => `<div class="mb12">
  <div class="between" style="padding:4px 0">
    <span>${dot(root.color)} <b>${esc(root.icon)} ${esc(root.name)}</b>${Number(root.year_cnt) > 0 ? ` <span class="tiny muted">近1年 ${root.year_cnt} 笔 · ${fmtAmount(root.year_total_cents || 0)}</span>` : ''}</span>
    ${root.ledger_id && writable ? `<div class="row" style="gap:4px"><details style="display:inline-block"><summary class="btn btn-sm btn-ghost">编辑</summary><form method="post" action="/categories/${root.id}" class="row mt8" style="gap:4px">${csrfInput}<input name="icon" value="${esc(root.icon)}" style="width:46px" maxlength="8"><input name="name" value="${esc(root.name)}" style="width:110px" maxlength="20" required><input type="color" name="color" value="${esc(root.color || '#4f7cff')}" title="颜色" style="width:36px;padding:2px"><button class="btn btn-sm btn-primary" type="submit">保存</button></form></details><form method="post" action="/categories/${root.id}/delete" style="display:inline" data-confirm="确认删除一级分类「${esc(root.name)}」？">${csrfInput}<button class="btn btn-sm btn-ghost" type="submit">删</button></form></div>` : root.ledger_id ? '' : '<span class="tiny muted">内置</span>'}
  </div>
  <div class="row wrap">${(root.children || [])
    .map((ch) => {
      const chStat = Number(ch.year_cnt) > 0 ? ` <span class="tiny muted">${ch.year_cnt}笔/${fmtAmount(ch.year_total_cents || 0)}</span>` : '';
      return ch.ledger_id && writable
        ? `<span class="chip" style="gap:4px;flex-wrap:wrap"><span>${dot(ch.color)} ${esc(ch.icon)} ${esc(ch.name)}${chStat}</span><details style="display:inline"><summary style="cursor:pointer;font-size:11px;color:var(--muted)" title="编辑二级分类">✎</summary><form method="post" action="/categories/${ch.id}" class="row" style="gap:4px;margin-top:4px">${csrfInput}<input name="icon" value="${esc(ch.icon)}" style="width:42px;padding:2px 4px;font-size:12px" maxlength="8"><input name="name" value="${esc(ch.name)}" style="width:88px;padding:2px 6px;font-size:12px" maxlength="20" required><input type="color" name="color" value="${esc(ch.color || '#4f7cff')}" title="颜色" style="width:32px;padding:1px"><button class="btn btn-sm btn-primary" type="submit">保存</button></form></details><form method="post" action="/categories/${ch.id}/delete" style="display:inline" data-confirm="确认删除二级分类「${esc(ch.name)}」？">${csrfInput}<button type="submit" title="删除二级分类" style="border:0;background:transparent;color:var(--expense);cursor:pointer;padding:0 2px;font-size:12px;line-height:1">✕</button></form></span>`
        : `<span class="chip">${esc(ch.icon)} ${esc(ch.name)}${chStat}</span>`;
    })
    .join('')}</div>
</div>`,
    )
    .join('')}
${writable ? `  <form method="post" action="/categories" class="mt16" style="border-top:1px solid var(--border);padding-top:12px">
    ${csrfInput}
    <input type="hidden" name="kind" value="${kind}">
    <div class="grid grid-2 mb8">
      <select name="parent_id">
        <option value="">作为一级分类</option>
        ${kindRoots.map((rt) => `<option value="${rt.id}">隶属于：${esc(rt.icon)} ${esc(rt.name)}</option>`).join('')}
      </select>
      <div class="row">
        <input name="name" placeholder="新建${kind === 'expense' ? '支出' : '收入'}分类名称" required>
        <input name="icon" value="🏷️" style="max-width:64px">
        <input type="color" name="color" value="${kind === 'expense' ? '#4f7cff' : '#52c41a'}" title="分类颜色" style="max-width:44px;padding:2px">
      </div>
    </div>
    <button class="btn btn-primary btn-sm" type="submit">添加分类</button>
  </form>` : ''}
</div>`;
    })
    .join('')}
</div>`;
}

export function tagsPage({
  tags,
  csrf,
  writable,
}: {
  tags: Array<{ id: number; name: string; color?: string; cnt: number; total_cents?: number }>;
  csrf: string;
  writable: boolean;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  return (
    simpleTable(
      '标签管理',
      ['标签', '使用次数', '合计金额', '操作'],
      tags
        .map(
          (t) => `<tr><td><span class="chip" style="border-left:4px solid ${esc(t.color || '#0F766E')}"># ${esc(t.name)}</span></td><td>${t.cnt}</td><td class="num amount">${fmtAmount(Number(t.total_cents || 0))}</td>
<td>${writable ? `<div class="row wrap"><form method="post" action="/tags/${t.id}" class="row" style="display:inline-flex;gap:4px">${csrfInput}<input name="name" value="${esc(t.name)}" maxlength="20" style="width:120px;padding:4px 8px;font-size:12px" required><input type="color" name="color" value="${esc(t.color || '#0F766E')}" title="标签颜色" style="width:36px;padding:2px"><button class="btn btn-sm" type="submit">保存</button></form><form method="post" action="/tags/${t.id}/delete" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form></div>` : ''}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4">暂无标签（记账时输入标签可自动创建）</td></tr>',
    ) +
    (writable ? `<div class="card mt16"><div class="card-head"><b>新建标签</b></div>
<form method="post" action="/tags" class="row wrap">${csrfInput}<input name="name" placeholder="标签名称" required><input type="color" name="color" value="#0F766E" title="标签颜色" style="max-width:48px;padding:2px"><button class="btn btn-primary" type="submit">添加</button></form></div>` : '')
  );
}
