import type { AiConfig } from '../lib/ai.js';
import type { AttachmentRow } from '../lib/attachments.js';
import { webUrl } from '../lib/attachments.js';
import type { AccountRow, CategoryRow } from '../types.js';
import { esc } from '../lib/util.js';
import { simpleTable } from './layout.js';

export function aiPage({
  cfg,
  recent,
  aiForm,
  csrf,
  cspNonce,
}: {
  cfg: AiConfig;
  recent: Array<AttachmentRow & { amount_cents?: number | null; txn_date?: string | null; merchant?: string | null }>;
  aiForm: { categories: Array<{ id: number; name: string; path: string; kind: string }>; accounts: Array<Pick<AccountRow, 'id' | 'name' | 'icon'>> };
  csrf: string;
  cspNonce: string;
}): string {
  void csrf;
  return `<div class="split-workspace">
  <div class="card">
    <div class="card-head">
      <b>AI 截图与文本自动记账</b>
      <span class="chip ${cfg.enabled ? 'income' : ''}">${cfg.enabled ? `已启用 · ${esc(cfg.model || '')}` : '离线规则引擎兜底'}</span>
    </div>
    <p class="muted small mb12">支持拖入/粘贴最多 6 张账单截图或输入消费描述，识别结果可逐条核对后入库，原图随流水保存在 R2。</p>
    <div id="ai-dropzone" class="dropzone">
      <div style="font-size:24px;margin-bottom:4px">🧾</div>
      <div>拖放账单截图到这里、点击选择文件，或按 <b>Ctrl+V</b> 粘贴</div>
      <input type="file" id="ai-file" accept="image/*" multiple class="hidden">
    </div>
    <div class="thumbs" id="ai-thumbs"></div>
    <div class="field mt12">
      <label>或输入账单文字（每行一笔）</label>
      <textarea id="ai-text" rows="3" placeholder="例如：午饭 35 元 支付宝&#10;打车回家 28.5 微信"></textarea>
    </div>
    <button class="btn btn-primary btn-block" id="ai-scan-btn" type="button">开始识别</button>
    <div class="mt16">
      <label class="small bold">一句话快速解析</label>
      <div class="row mt8">
        <input type="text" id="ai-quick-text" placeholder="昨天晚饭 88 微信">
        <button class="btn" id="ai-text-quick" type="button">解析</button>
      </div>
    </div>
  </div>
  <div>
    <div id="ai-result" class="mb16">
      <div class="card"><div class="empty">识别后的草稿卡片将在此显示，确认后直接入库</div></div>
    </div>
    <div class="card">
      <div class="card-head"><b>最近存档附件</b><a class="btn btn-sm btn-ghost" href="/attachments">全部附件 →</a></div>
      ${recent
        .map(
          (a) => `<div class="between"><span><a href="${esc(webUrl(a.rel_path))}" target="_blank">${esc(a.file_name || a.rel_path)}</a> <span class="chip">${esc(a.ai_status)}</span></span><span class="tiny muted">${esc(a.created_at)}</span></div>`,
        )
        .join('') || '<div class="empty">暂无附件</div>'}
    </div>
  </div>
</div>
<script nonce="${esc(cspNonce)}">window.__AI_FORM__ = ${JSON.stringify(aiForm).replace(/</g, '\\u003c')};</script>`;
}

export function attachmentsPage({
  rows,
  page,
  total,
  totalPages,
  csrf,
}: {
  rows: Array<AttachmentRow & { linked_txn_id?: number | null; txn_date?: string | null; merchant?: string | null; amount_cents?: number | null }>;
  page: number;
  total: number;
  totalPages: number;
  csrf: string;
}): string {
  const bodyRows =
    rows
      .map((a) => {
        const imgUrl = webUrl(a.rel_path);
        const txnLabel = a.linked_txn_id
          ? `<a href="/transactions/${a.linked_txn_id}/edit">${esc(a.merchant || `流水 #${a.linked_txn_id}`)}${a.amount_cents != null ? ` · ¥${(Number(a.amount_cents) / 100).toFixed(2)}` : ''}${a.txn_date ? ` (${esc(a.txn_date)})` : ''}</a>`
          : '—';
        return `<tr>
  <td>
    <div class="row">
      <a href="${esc(imgUrl)}" target="_blank" rel="noopener"><img src="${esc(imgUrl)}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:6px;border:1px solid var(--border)"></a>
      <a href="${esc(imgUrl)}" target="_blank" rel="noopener">${esc(a.file_name || a.rel_path)}</a>
    </div>
  </td>
  <td>${txnLabel}</td>
  <td><span class="chip">${esc(a.ai_status)}</span></td>
  <td class="tiny muted">${esc(a.created_at)}</td>
  <td><form method="post" action="/attachments/${a.id}/delete" style="display:inline" data-confirm="确认删除该附件？将同步从 R2 存储移除。"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-sm btn-danger" type="submit">删除</button></form></td>
</tr>`;
      })
      .join('') || '<tr><td colspan="5">暂无附件</td></tr>';

  const pager =
    totalPages > 1
      ? `<div class="between mt12"><span class="muted small">第 ${page} / ${totalPages} 页，共 ${total} 个附件</span><div class="row">${page > 1 ? `<a class="btn btn-sm" href="/attachments?page=${page - 1}">上一页</a>` : ''}${page < totalPages ? `<a class="btn btn-sm" href="/attachments?page=${page + 1}">下一页</a>` : ''}</div></div>`
      : '';

  return simpleTable('附件存档管理（R2）', ['文件', '关联流水', '识别状态', '上传时间', '操作'], bodyRows) + pager;
}

export type AiFormBuilder = {
  expenseCats: Array<CategoryRow & { path: string }>;
  incomeCats: Array<CategoryRow & { path: string }>;
  accounts: AccountRow[];
};
