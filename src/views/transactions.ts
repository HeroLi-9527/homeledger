import { PRIMARY_TXN_TYPES, TXN_TYPES, TXN_TYPE_MAP } from '../db.js';
import type { AccountRow, CategoryRow } from '../types.js';
import { esc } from '../lib/util.js';

export interface TxnFormViewProps {
  form: {
    expenseTree: CategoryRow[];
    incomeTree: CategoryRow[];
    expenseCats: Array<CategoryRow & { path: string }>;
    incomeCats: Array<CategoryRow & { path: string }>;
    accounts: AccountRow[];
  };
  t: Record<string, unknown>;
  mode: 'create' | 'edit';
  back: string;
  csrf: string;
  cspNonce?: string;
  action: string;
  splitRows?: Array<{ member_name: string; share_cents: number }>;
  error?: string;
}

export function txnFormPage({
  form,
  t,
  mode,
  back,
  csrf,
  cspNonce = '',
  action,
  splitRows = [],
  error = '',
}: TxnFormViewProps): string {
  const curType = String(t.type || 'expense');
  const mainTabKeys = [...PRIMARY_TXN_TYPES, 'reimburse', 'refund', 'borrow'];
  const extraTypes = TXN_TYPES.filter((x) => !mainTabKeys.includes(x.key));

  const renderCatTree = (tree: CategoryRow[], kind: 'expense' | 'income') =>
    tree
      .map(
        (root) => `<div class="cat-kind mb8" data-cat-kind="${kind}">
  <div class="tiny muted bold mb8">${esc(root.icon)} ${esc(root.name)}</div>
  <div class="cat-grid">
    ${(root.children && root.children.length ? root.children : [root])
      .map(
        (ch) => `<button type="button" class="cat-item ${Number(t.category_id) === Number(ch.id) ? 'selected' : ''}" data-id="${ch.id}" data-name="${esc(ch.name)}" data-path="${esc(root.id === ch.id ? root.name : `${root.name}/${ch.name}`)}">${esc(ch.icon)} ${esc(ch.name)}</button>`,
      )
      .join('')}
  </div>
</div>`,
      )
      .join('');

  const aiForm = {
    categories: [...form.expenseCats, ...form.incomeCats].map((c) => ({
      id: c.id,
      name: c.name,
      path: c.parent_id ? c.path : c.name,
      kind: c.kind,
    })),
    accounts: form.accounts.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
  };

  const formCard = `<div class="card">
  <div class="card-head">
    <b>${mode === 'edit' ? '编辑账目' : '精细化手工记账'}</b>
    <a class="btn btn-sm btn-ghost" href="${esc(back)}">返回 →</a>
  </div>
  ${error ? `<div class="flash error"><span>${esc(error)}</span></div>` : ''}
  <form id="txn-form" method="post" action="${esc(action)}">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <input type="hidden" name="back" value="${esc(back)}">
    <input type="hidden" name="type" id="f-type" value="${esc(curType)}">
    <input type="hidden" name="category_id" id="f-category" value="${esc(t.category_id || '')}">
    ${t.updated_at ? `<input type="hidden" name="updated_at" value="${esc(t.updated_at)}">` : ''}

    <div class="mb12">
      <div class="type-tabs">
        ${mainTabKeys
          .map((k) => {
            const m = TXN_TYPE_MAP[k];
            return `<button type="button" class="type-tab ${curType === k ? 'active' : ''}" data-type="${k}">${esc(m.label)}</button>`;
          })
          .join('')}
      </div>
      <div class="row wrap mt8">
        <span class="tiny muted">更多类型：</span>
        ${extraTypes
          .map(
            (m) =>
              `<button type="button" class="chip ${curType === m.key ? 'primary' : ''}" data-type="${m.key}">${esc(m.icon)} ${esc(m.label)}</button>`,
          )
          .join('')}
      </div>
    </div>

    <div class="field">
      <label>金额</label>
      <div class="amount-hero">
        <span class="sym">¥</span>
        <input id="f-amount" name="amount" inputmode="decimal" value="${esc(t.amount || '')}" placeholder="0.00" required>
      </div>
      <div class="row wrap mt8">
        <button type="button" class="chip" data-amt-add="10">+10</button>
        <button type="button" class="chip" data-amt-add="50">+50</button>
        <button type="button" class="chip" data-amt-add="100">+100</button>
        <button type="button" class="chip" data-amt-add="clear">清空</button>
      </div>
    </div>

    <div id="f-cat-wrap" class="field">
      <div class="between" style="padding:0"><label>分类</label><span class="tiny muted" id="cat-hint">点击选择分类</span></div>
      <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;background:var(--card-2)">
        ${renderCatTree(form.expenseTree, 'expense')}
        ${renderCatTree(form.incomeTree, 'income')}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="field">
        <label id="acc-label">账户</label>
        <select name="account_id">
          <option value="">请选择账户</option>
          ${form.accounts.map((a) => `<option value="${a.id}" ${Number(t.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}（¥${(Number(a.balance_cents) / 100).toFixed(2)}）</option>`).join('')}
        </select>
      </div>
      <div class="field" data-for-type="transfer,invest_buy,invest_sell">
        <label>转入 / 投资账户</label>
        <select name="to_account_id">
          <option value="">请选择目标账户</option>
          ${form.accounts.map((a) => `<option value="${a.id}" ${Number(t.to_account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>日期</label>
        <input type="date" name="txn_date" value="${esc(t.txn_date || '')}" required>
      </div>
      <div class="field">
        <label>币种与汇率</label>
        <div class="row">
          <input name="currency" value="${esc(t.currency || 'CNY')}" maxlength="6" style="max-width:90px">
          <input name="rate" value="${esc(t.rate ?? '')}" placeholder="汇率（留空自动查表）" inputmode="decimal">
        </div>
      </div>
      <div class="field">
        <label>商家 / 借贷对方</label>
        <input name="merchant" value="${esc(t.merchant || '')}" placeholder="如：瑞幸咖啡 / 张三">
      </div>
      <div class="field">
        <label>标签（空格或逗号分隔）</label>
        <input name="tags" value="${esc(t.tag_names ?? t.tags ?? '')}" placeholder="如：出差 聚餐">
      </div>
    </div>

    <div class="field">
      <label>备注</label>
      <input name="note" value="${esc(t.note || '')}" placeholder="补充说明…">
    </div>

    <div class="row wrap mb12">
      <label class="check" data-for-type="expense,fee"><input type="checkbox" name="is_reimbursable" value="1" ${t.is_reimbursable ? 'checked' : ''}> 可报销支出</label>
      <select name="status" style="width:auto">
        <option value="cleared" ${t.status !== 'pending' ? 'selected' : ''}>已入账</option>
        <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>待确认</option>
      </select>
    </div>

    <div class="card mb16" style="padding:12px;background:var(--card-2)">
      <div class="between" style="padding:0 0 8px">
        <span class="small bold">AA 分账（可选）</span>
        <div class="row">
          <button type="button" class="btn btn-sm" id="split-average">一键均摊</button>
          <button type="button" class="btn btn-sm" id="add-split">+ 添加成员</button>
        </div>
      </div>
      <div id="split-rows">
        ${splitRows
          .map(
            (s) => `<div class="row split-row mb8">
  <input type="text" name="split_name" value="${esc(s.member_name)}" placeholder="成员" style="flex:1">
  <input type="text" name="split_amount" value="${(Number(s.share_cents) / 100).toFixed(2)}" placeholder="金额" inputmode="decimal" style="flex:1">
  <button type="button" class="btn btn-sm btn-ghost del-split">✕</button>
</div>`,
          )
          .join('')}
      </div>
    </div>

    <button id="submit-btn" class="btn btn-primary btn-lg btn-block" type="submit">${mode === 'edit' ? '保存修改' : '确认记账入库'}</button>
  </form>
</div>`;

  if (mode === 'edit') return formCard;

  const aiSideCard = `<div class="card">
  <div class="card-head"><b>AI 智能小票与文本感知</b><span class="chip primary">双引擎</span></div>
  <p class="muted small mb12">上传账单截图或直接输入一句话，AI 自动提取分类、账户与金额，原图同步归档至 R2。</p>
  <div id="ai-dropzone" class="dropzone">
    <div style="font-size:22px;margin-bottom:4px">📸</div>
    <div>拖拽小票图片、付款截图至此，或 <b>Ctrl+V</b> 粘贴</div>
    <input type="file" id="ai-file" accept="image/*" multiple class="hidden">
  </div>
  <div class="thumbs" id="ai-thumbs"></div>
  <div class="field mt12">
    <label>自然语言快速记账</label>
    <div class="row">
      <input type="text" id="ai-quick-text" placeholder="例如：午饭 35 元 支付宝">
      <button class="btn btn-primary" id="ai-text-quick" type="button">解析</button>
    </div>
  </div>
  <div class="field">
    <label>批量账单文字（可选）</label>
    <textarea id="ai-text" rows="3" placeholder="多笔文字每行一笔，点击下方开始识别"></textarea>
  </div>
  <button class="btn btn-block" id="ai-scan-btn" type="button">开始识别图片 / 文本</button>
  <div id="ai-result"></div>
</div>
<script nonce="${esc(cspNonce)}">window.__AI_FORM__ = ${JSON.stringify(aiForm).replace(/</g, '\\u003c')};</script>`;

  return `<div class="split-workspace">${formCard}${aiSideCard}</div>`;
}
