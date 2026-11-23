import { ACCOUNT_TYPES } from '../constants.js';
import type { AccountRow, CategoryRow } from '../types.js';
import { esc, fmtAmount } from '../lib/util.js';
import { simpleTable } from './layout.js';

export function accountsPage({
  accounts,
  ov,
  csrf,
}: {
  accounts: AccountRow[];
  ov: { assets: number; liabilities: number; net: number };
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const typeLabel = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.key, `${t.icon} ${t.label}`]));
  return `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">总资产</div><div class="value amount income">${fmtAmount(ov.assets)}</div></div>
  <div class="stat"><div class="label">总负债</div><div class="value amount expense">${fmtAmount(ov.liabilities)}</div></div>
  <div class="stat"><div class="label">净资产</div><div class="value amount">${fmtAmount(ov.net)}</div></div>
  <div class="stat"><div class="label">活跃账户</div><div class="value">${accounts.filter((a) => !a.is_archived).length} 个</div></div>
</div>
<div class="card mb16">
  <div class="card-head"><b>账户列表</b><span class="muted small">支持 10 种账户类型与余额校准</span></div>
  ${accounts
    .map(
      (a) => `<div class="between" style="border-bottom:1px solid var(--border);padding:10px 0">
  <div>
    <b>${esc(a.icon || '💳')} ${esc(a.name)}</b>
    <span class="chip">${esc(typeLabel[a.type] || a.type)}</span>
    <span class="tiny muted">${esc(a.currency || 'CNY')}${a.is_archived ? ' · 已归档' : ''}</span>
  </div>
  <div class="row wrap">
    <span class="amount bold">${fmtAmount(a.balance_cents)}</span>
    <a class="btn btn-sm" href="/accounts/${a.id}">明细/校准</a>
    <form method="post" action="/accounts/${a.id}/archive" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${a.is_archived ? '恢复' : '归档'}</button></form>
    <form method="post" action="/accounts/${a.id}/delete" style="display:inline" data-confirm="确认删除该账户？">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
  </div>
</div>`,
    )
    .join('') || '<div class="empty">暂无账户</div>'}
</div>
<div class="card">
  <div class="card-head"><b>新建账户</b></div>
  <form method="post" action="/accounts">
    ${csrfInput}
    <div class="grid grid-3">
      <div class="field"><label>账户名称</label><input name="name" placeholder="如：招商银行储蓄卡" required></div>
      <div class="field"><label>账户类型</label><select name="type">${ACCOUNT_TYPES.map((t) => `<option value="${t.key}">${esc(t.icon)} ${esc(t.label)}</option>`).join('')}</select></div>
      <div class="field"><label>初始余额（元）</label><input name="balance" placeholder="0.00" inputmode="decimal"></div>
      <div class="field"><label>币种</label><input name="currency" value="CNY"></div>
      <div class="field"><label>图标</label><input name="icon" value="💳"></div>
      <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" name="include_in_net" value="1" checked> 计入净资产</label></div>
    </div>
    <button class="btn btn-primary" type="submit">创建账户</button>
  </form>
</div>`;
}

export function categoriesPage({
  tree,
  csrf,
}: {
  tree: CategoryRow[];
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  return `<div class="grid grid-2">
  ${(['expense', 'income'] as const)
    .map(
      (kind) => `<div class="card">
  <div class="card-head"><b>${kind === 'expense' ? '支出分类' : '收入分类'}</b><span class="muted small">内置 209 个系统分类 + 自定义分类</span></div>
  ${tree
    .filter((t) => t.kind === kind)
    .map(
      (root) => `<div class="mb12">
  <div class="between" style="padding:4px 0">
    <b>${esc(root.icon)} ${esc(root.name)}</b>
    ${root.ledger_id ? `<form method="post" action="/categories/${root.id}/delete" style="display:inline">${csrfInput}<button class="btn btn-sm btn-ghost" type="submit">删</button></form>` : '<span class="tiny muted">内置</span>'}
  </div>
  <div class="row wrap">${(root.children || [])
    .map((ch) => `<span class="chip">${esc(ch.icon)} ${esc(ch.name)}</span>`)
    .join('')}</div>
</div>`,
    )
    .join('')}
  <form method="post" action="/categories" class="row mt12">
    ${csrfInput}
    <input type="hidden" name="kind" value="${kind}">
    <input name="name" placeholder="新建${kind === 'expense' ? '支出' : '收入'}分类" required>
    <input name="icon" value="🏷️" style="max-width:72px">
    <button class="btn btn-primary" type="submit">添加</button>
  </form>
</div>`,
    )
    .join('')}
</div>`;
}

export function tagsPage({
  tags,
  csrf,
}: {
  tags: Array<{ id: number; name: string; cnt: number }>;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  return (
    simpleTable(
      '标签管理',
      ['标签', '使用次数', '操作'],
      tags
        .map(
          (t) => `<tr><td><span class="chip"># ${esc(t.name)}</span></td><td>${t.cnt}</td>
<td><form method="post" action="/tags/${t.id}/delete" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">删除</button></form></td></tr>`,
        )
        .join('') || '<tr><td colspan="3">暂无标签（记账时输入标签可自动创建）</td></tr>',
    ) +
    `<div class="card mt16"><div class="card-head"><b>新建标签</b></div>
<form method="post" action="/tags" class="row">${csrfInput}<input name="name" placeholder="标签名称" required><button class="btn btn-primary" type="submit">添加</button></form></div>`
  );
}
