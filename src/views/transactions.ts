import { PRIMARY_TXN_TYPES, TXN_TYPES, TXN_TYPE_MAP } from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import { MAX_IMAGES, webUrl, type AttachmentRow } from '../lib/attachments.js';
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
  attachments?: AttachmentRow[];
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
  attachments = [],
  error = '',
}: TxnFormViewProps): string {
  const curType = String(t.type || 'expense');
  const mainTabKeys = [...PRIMARY_TXN_TYPES, 'reimburse', 'refund', 'borrow'];
  const extraTypes = TXN_TYPES.filter((x) => !mainTabKeys.includes(x.key));

  const renderCatTree = (tree: CategoryRow[], kind: 'expense' | 'income') => {
    const parentsBar = tree.length
      ? `<div class="cat-parents" data-cat-kind="${kind}">${tree
          .map((root) => `<button type="button" class="chip cat-parent" data-target="cat-root-${root.id}">${esc(root.icon)} ${esc(root.name)}</button>`)
          .join('')}</div>`
      : '';
    const groups = tree
      .map((root) => {
        const hasKids = Boolean(root.children && root.children.length);
        const btns = hasKids
          ? `<button type="button" class="cat-item ${Number(t.category_id) === Number(root.id) ? 'selected' : ''}" data-id="${root.id}" data-name="${esc(root.name)}" data-path="${esc(root.name)}">${esc(root.icon)} 不细分</button>` +
            root.children!
              .map(
                (ch) =>
                  `<button type="button" class="cat-item ${Number(t.category_id) === Number(ch.id) ? 'selected' : ''}" data-id="${ch.id}" data-name="${esc(ch.name)}" data-path="${esc(`${root.name}/${ch.name}`)}">${esc(ch.icon)} ${esc(ch.name)}</button>`,
              )
              .join('')
          : `<button type="button" class="cat-item ${Number(t.category_id) === Number(root.id) ? 'selected' : ''}" data-id="${root.id}" data-name="${esc(root.name)}" data-path="${esc(root.name)}">${esc(root.icon)} ${esc(root.name)}</button>`;
        return `<div class="cat-kind mb8" id="cat-root-${root.id}" data-cat-kind="${kind}">
  <div class="tiny muted bold mb8">${esc(root.icon)} ${esc(root.name)}</div>
  <div class="cat-grid">${btns}</div>
</div>`;
      })
      .join('');
    return parentsBar + groups;
  };

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
          ${accountOptionsHtml(form.accounts, { selectedId: t.account_id as string | number | undefined, emptyLabel: '请选择账户', showBalance: true })}
        </select>
      </div>
      <div class="field" data-for-type="transfer,invest_buy,invest_sell">
        <label>转入 / 投资账户</label>
        <select name="to_account_id">
          ${accountOptionsHtml(form.accounts, { selectedId: t.to_account_id as string | number | undefined, emptyLabel: '请选择目标账户', showBalance: true })}
        </select>
      </div>
      <div class="field">
        <label>账户原币金额</label>
        <input name="account_amount" inputmode="decimal" value="${error && t.account_amount_cents != null ? (Number(t.account_amount_cents) / 100).toFixed(2) : ''}" placeholder="${t.account_amount_cents == null ? '留空按汇率换算' : `已记 ${(Number(t.account_amount_cents) / 100).toFixed(2)}`}">
      </div>
      <div class="field" data-for-type="transfer,invest_buy,invest_sell">
        <label>转入 / 投资账户原币金额</label>
        <input name="to_account_amount" inputmode="decimal" value="${error && t.to_account_amount_cents != null ? (Number(t.to_account_amount_cents) / 100).toFixed(2) : ''}" placeholder="${t.to_account_amount_cents == null ? '留空按汇率换算' : `已记 ${(Number(t.to_account_amount_cents) / 100).toFixed(2)}`}">
      </div>
      <div class="field">
        <label>日期</label>
        <input type="date" name="txn_date" value="${esc(t.txn_date || '')}" required>
      </div>
      <div class="field">
        <label>币种与汇率</label>
        <div class="row">
          <input name="currency" value="${esc(t.currency || 'CNY')}" maxlength="6" style="max-width:90px">
          <input name="rate" value="${esc(t.rate ?? '')}" placeholder="汇率（留空自动查表）" inputmode="decimal" data-no-money-format>
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

  if (mode === 'edit') {
    const txnId = Number(t.id);
    const listHtml = attachments.length
      ? attachments
          .map((a) => {
            const imgUrl = webUrl(a.rel_path);
            return `<div class="between" style="border-bottom:1px solid var(--border);padding:8px 0">
  <div class="row" style="min-width:0;flex:1">
    <img src="${esc(imgUrl)}" data-zoom alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">
    <div style="min-width:0;flex:1">
      <div class="small bold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="${esc(imgUrl)}" target="_blank" rel="noopener">${esc(a.file_name || a.rel_path)}</a></div>
      <div class="tiny muted">${esc(a.created_at)}${a.size ? ` · ${(Number(a.size) / 1024).toFixed(1)} KB` : ''}</div>
    </div>
  </div>
  <div class="row">
    <a class="btn btn-sm" href="${esc(imgUrl)}" target="_blank" rel="noopener">查看</a>
    <form method="post" action="/attachments/${a.id}/delete" style="display:inline" data-confirm="确认删除该附件？将同步从 R2 存储移除。">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="back" value="/transactions/${txnId}/edit">
      <button class="btn btn-sm btn-danger" type="submit">删除</button>
    </form>
  </div>
</div>`;
          })
          .join('')
      : '<div class="empty">暂无关联凭证图片</div>';

    const remainingQuota = Math.max(0, MAX_IMAGES - attachments.length);
    const attachmentsCard = `<div class="card">
  <div class="card-head"><b>凭证与附件</b><span class="chip">${attachments.length} / ${MAX_IMAGES}</span></div>
  ${listHtml}
  <div class="mt16">
    ${
      remainingQuota > 0
        ? `<div id="txn-att-dropzone" class="dropzone" data-txn-id="${txnId}" data-existing="${attachments.length}" data-max="${MAX_IMAGES}">
      <div style="font-size:22px;margin-bottom:4px">📎</div>
      <div>拖拽图片至此、点击选择文件，或 <b>Ctrl+V</b> 粘贴补传（还可传 ${remainingQuota} 张，单张 ≤ 8MB）</div>
    </div>
    <form id="txn-att-form" method="post" action="/transactions/${txnId}/attachments" enctype="multipart/form-data" class="mt12">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <div class="row wrap">
        <input type="file" id="txn-att-file" name="files" accept="image/*" multiple style="flex:1;min-width:180px">
        <button class="btn btn-primary btn-sm" type="submit" id="txn-att-submit">补传附件</button>
      </div>
    </form>`
        : `<div class="notice warn">已达到单笔流水最多 ${MAX_IMAGES} 个附件上限，请先删除旧附件后再补传。</div>`
    }
    <div class="row mt12"><a class="btn btn-sm btn-ghost" href="/attachments">全部附件存档 →</a></div>
  </div>
</div>`;

    const canReimburse = Boolean(t.is_reimbursable) && !t.reimbursed_at && (curType === 'expense' || curType === 'fee');
    const reimburseCard = canReimburse
      ? `<div class="card mb16">
  <div class="card-head"><b>待报销 · 一键报销入账</b><span class="chip warn">未报销</span></div>
  <p class="muted small mb12">标记该笔支出为已报销，并按原币折算金额生成一笔报销入账流水。</p>
  <form method="post" action="/transactions/${txnId}/reimburse" class="row wrap">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <input type="hidden" name="back" value="/transactions/${txnId}/edit">
    <select name="account_id" style="flex:1;min-width:160px">${accountOptionsHtml(form.accounts, { selectedId: t.account_id as string | number | undefined, emptyLabel: '选择报销入账账户…' })}</select>
    <button class="btn btn-primary btn-sm" type="submit">标记已报销并入账</button>
  </form>
</div>`
      : '';

    return `<div class="split-workspace">${formCard}<div>${reimburseCard}${attachmentsCard}</div></div>`;
  }

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
