import { todayStr } from '../db.js';
import type { AiConfig } from '../lib/ai.js';
import { ROLE_LABEL } from '../lib/auth.js';
import type { AppContext } from '../types.js';
import { esc, fmtAmount, initials } from '../lib/util.js';
import { avatarHtml, simpleTable } from './layout.js';

export function settingsPage({
  ctx,
  settings,
  cfg,
  tokens,
  rates,
  csrf,
}: {
  ctx: AppContext;
  settings: Record<string, string>;
  cfg: AiConfig;
  tokens: Array<{ id: number; name: string; token_tail: string; created_at: string; expires_at: string | null }>;
  rates: Array<{ base: string; quote: string; rate: number; noted_at: string }>;
  csrf: string;
}): string {
  const user = ctx.user!;
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const S = (k: string, d = '') => esc(settings[k] ?? d);

  return `<div class="grid grid-2">
  <div class="card" id="account">
    <div class="card-head"><b>个人资料与安全</b></div>
    <div class="row mb12" style="gap:12px">
      ${user.avatar_path ? avatarHtml(user, 56) : `<span class="avatar" style="width:56px;height:56px;font-size:20px;background:${esc(user.avatar_color || '#0F766E')}">${esc(initials(user.display_name || user.username))}</span>`}
      <div>
        <button class="btn btn-sm" type="button" id="avatarPick">更换头像</button>
        <button class="btn btn-sm" type="button" id="avatarClear">恢复默认</button>
        <input type="file" id="avatarFile" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden">
        <div class="tiny muted mt8">小于 2MB（PNG / JPG / GIF / WebP）</div>
      </div>
    </div>
    <form method="post" action="/settings/profile">
      ${csrfInput}
      <div class="field"><label>用户名（3–32 位账号）</label><input name="username" value="${esc(user.username)}" required></div>
      <div class="field"><label>显示名称</label><input name="display_name" value="${esc(user.display_name)}" required></div>
      <div class="grid grid-2">
        <div class="field"><label>邮箱</label><input name="email" type="email" value="${esc(user.email || '')}"></div>
        <div class="field"><label>默认头像颜色</label><input name="avatar_color" type="color" value="${esc(user.avatar_color || '#4f7cff')}" style="height:38px;padding:2px"></div>
      </div>
      <button class="btn btn-primary" type="submit">保存资料</button>
    </form>
    <form method="post" action="/settings/password" class="mt16">
      ${csrfInput}
      <div class="field"><label>当前密码</label><input type="password" name="current_password" required></div>
      <div class="field"><label>新密码（至少 6 位，修改后全端需重登）</label><input type="password" name="password" required></div>
      <div class="field"><label>确认新密码</label><input type="password" name="password2" required></div>
      <button class="btn btn-primary" type="submit">修改密码</button>
    </form>
  </div>

  <div class="card" id="ai">
    <div class="card-head"><b>AI 模型配置</b><span class="chip ${cfg.enabled ? 'income' : ''}">${cfg.enabled ? '已启用' : '未启用'}</span></div>
    ${ctx.isAdmin ? `<form method="post" action="/settings/ai">
      ${csrfInput}
      <div class="field"><label>接口地址（Base URL）</label><input name="base_url" id="ai-base-url" value="${esc(cfg.baseUrl)}" placeholder="https://api.openai.com/v1"></div>
      <div class="field">
        <label>API Key${cfg.apiKey ? ' <span class="chip income">已配置</span>' : ''}</label>
        <input name="api_key" id="ai-api-key" type="password" value="" autocomplete="new-password" placeholder="${cfg.apiKey ? '已保存密钥（留空保持不变）' : 'sk-…（本地模型可留空）'}">
        ${cfg.apiKeyInvalid ? '<div class="tiny" style="color:var(--expense)">检测到当前保存的 API Key 含非法字符，请重新粘贴或勾选清除</div>' : ''}
        <label class="check mt8"><input type="checkbox" name="clear_api_key" value="1"> 清除已保存的 API Key</label>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>模型名称</label><input name="model" id="ai-model" value="${esc(cfg.model)}" placeholder="gpt-4o-mini"></div>
        <div class="field"><label>请求超时（毫秒）</label><input name="timeout_ms" type="number" min="5000" max="300000" step="1000" value="${Number(cfg.timeoutMs || 90000)}" placeholder="90000"></div>
      </div>
      <div class="row wrap mb12">
        <label class="check"><input type="checkbox" name="enabled" value="1" ${cfg.enabled ? 'checked' : ''}> 启用 AI</label>
        <label class="check"><input type="checkbox" name="ai.vision" value="1" ${cfg.vision ? 'checked' : ''}> 支持视觉识图</label>
        <label class="check"><input type="checkbox" name="auto_save" value="1" ${cfg.autoSave ? 'checked' : ''}> 自动入库</label>
      </div>
      <div class="row wrap">
        <button class="btn btn-primary" type="submit">保存 AI 配置</button>
        <button class="btn" type="button" id="ai-test-btn">测试连接</button>
        <button class="btn" type="button" id="ai-models-btn">拉取模型</button>
      </div>
      <select id="ai-model-select" class="hidden mt8"></select>
      <div class="small muted mt8" id="ai-test-result"></div>
      <div class="small muted mt8" id="ai-models-result"></div>
    </form>` : '<div class="empty">仅站点管理员可修改全局 AI 配置。</div>'}
  </div>
</div>

${ctx.isAdmin ? `<div class="card mt16">
  <div class="card-head"><b>站点设置（管理员）</b></div>
  <form method="post" action="/settings/site">
    ${csrfInput}
    <div class="grid grid-3">
      <div class="field"><label>站点名称</label><input name="site_name" value="${S('site.name', '家账簿')}"></div>
      <div class="field"><label>本位币</label><input name="currency" value="${S('site.currency', 'CNY')}"></div>
      <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" name="allow_register" value="true" ${S('site.allow_register') === 'true' ? 'checked' : ''}> 开放自助注册</label></div>
    </div>
    <button class="btn btn-primary" type="submit">保存站点设置</button>
  </form>
</div>` : ''}

<div class="card mt16">
  <div class="card-head"><b>开放 API 令牌</b><span class="muted small">Bearer 鉴权（零 D1 写消耗）</span></div>
  ${tokens
    .map(
      (t) => `<div class="between">
  <span><b>${esc(t.name)}</b> <span class="tiny muted">…${esc(t.token_tail)} · ${esc(t.created_at)}${t.expires_at ? ` · 有效期至 ${esc(t.expires_at.slice(0, 10))}` : ' · 永不过期'}${t.expires_at && t.expires_at.slice(0, 10) < todayStr() ? ' · 已过期' : ''}</span></span>
  <form method="post" action="/settings/api-tokens/${t.id}/revoke" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">吊销</button></form>
</div>`,
    )
    .join('') || '<div class="empty">暂无 API 令牌</div>'}
  <form method="post" action="/settings/api-tokens" class="row mt12 wrap">
    ${csrfInput}
    <input name="name" placeholder="令牌名称，如：Telegram 机器人" required style="max-width:260px">
    <select name="expires_in_days" style="max-width:140px"><option value="">永不过期</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select>
    <button class="btn btn-primary" type="submit">创建令牌</button>
  </form>
</div>

${ctx.isAdmin ? `<div class="card mt16">
  <div class="card-head"><b>汇率管理</b></div>
  <form method="post" action="/settings/rates">
    ${csrfInput}
    <div class="grid grid-3">
      ${rates
        .map(
          (r) => `<div class="field"><label>${esc(r.base)} → ${esc(r.quote)}</label><input name="rate_${esc(r.base)}_${esc(r.quote)}" type="number" step="0.000001" min="0" value="${esc(String(r.rate))}"></div>`,
        )
        .join('')}
    </div>
    <div class="row wrap mt8">
      <input name="new_base" placeholder="新增币种（如 USD）" style="max-width:160px">
      <input name="new_quote" value="CNY" placeholder="目标币种" style="max-width:120px">
      <input name="new_rate" type="number" step="0.000001" min="0" placeholder="汇率" style="max-width:140px">
      <button class="btn btn-primary" type="submit">保存汇率</button>
    </div>
  </form>
</div>
<div class="card mt16">
  <div class="card-head"><b>管理员维护</b><span class="muted small">每 4 小时自动执行周期账单、订阅扣费与提醒</span></div>
  <div class="row wrap">
    <form method="post" action="/admin/run-scheduler" style="display:inline">${csrfInput}<button class="btn btn-primary" type="submit">立即执行定时任务</button></form>
    <form method="post" action="/admin/cleanup-r2" style="display:inline" data-confirm="扫描并清理超过 24 小时的未关联 R2 孤儿文件？">${csrfInput}<button class="btn" type="submit">手动清理 R2 孤儿附件</button></form>
    <a class="btn" href="/admin">管理员用户面板 →</a>
  </div>
</div>` : ''}`;
}

export function membersPage({
  ctx,
  members,
  invites,
  csrf,
}: {
  ctx: AppContext;
  members: Array<{
    id: number;
    user_id: number;
    role: string;
    nickname?: string | null;
    username: string;
    display_name: string;
    joined_at: string;
    month_cnt?: number;
    month_expense?: number;
    month_income?: number;
  }>;
  invites: Array<{ id: number; code: string; role: string; expires_at: string | null }>;
  csrf: string;
}): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  const canManage = !ctx.ledger?.is_archived && (ctx.ledger?.role === 'owner' || ctx.ledger?.role === 'admin');
  const rows = members
    .map((m) => {
      const canEditNick = !ctx.ledger?.is_archived && (canManage || Number(m.user_id) === Number(ctx.user?.id));
      const nickCell = canEditNick
        ? `<form method="post" action="/members/${m.id}/nickname" class="row" style="display:inline-flex;gap:4px">${csrfInput}<input name="nickname" value="${esc(m.nickname || '')}" placeholder="账本内昵称" maxlength="24" style="width:110px;padding:3px 7px;font-size:12px"><button class="btn btn-sm" type="submit">保存</button></form>`
        : esc(m.nickname || '—');
      return `<tr>
  <td><b>${esc(m.nickname || m.display_name)}</b>${m.nickname ? ` <span class="tiny muted">(${esc(m.display_name)})</span>` : ''} <span class="tiny muted">@${esc(m.username)}</span></td>
  <td>${nickCell}</td>
  <td class="tiny">${Number(m.month_cnt || 0)} 笔 · <span class="income amount">+${fmtAmount(Number(m.month_income || 0))}</span> / <span class="expense amount">-${fmtAmount(Number(m.month_expense || 0))}</span></td>
  <td><span class="chip">${esc(ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] || m.role)}</span></td>
  <td class="tiny muted">${esc(m.joined_at)}</td>
  <td>${
    canManage && Number(m.user_id) !== Number(ctx.user?.id) && m.role !== 'owner'
      ? `<form method="post" action="/members/${m.id}" style="display:inline">${csrfInput}<select name="role" style="width:auto">${(['admin', 'member', 'viewer'] as const).map((k) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${ROLE_LABEL[k]}</option>`).join('')}</select><button class="btn btn-sm" type="submit">改角色</button></form> <form method="post" action="/members/${m.id}/remove" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">移出</button></form>`
      : ''
  }</td>
</tr>`;
    })
    .join('');

  return (
    simpleTable('账本成员与四档角色', ['成员', '账本昵称', '本月统计', '角色', '加入时间', '操作'], rows) +
    (canManage
      ? `<div class="card mt16"><div class="card-head"><b>邀请家庭成员</b></div>
<form method="post" action="/members/invite" class="row wrap mb12">${csrfInput}
  <select name="role" style="width:auto"><option value="member">成员（可记账）</option><option value="viewer">只读（仅查看）</option><option value="admin">管理员</option></select>
  <input name="days" type="number" value="7" min="1" max="30" style="max-width:100px" title="有效天数">
  <button class="btn btn-primary" type="submit">生成邀请码</button>
</form>
${invites
  .map(
    (i) => `<div class="between"><span><code>/join/${esc(i.code)}</code> <span class="tiny muted">${esc(ROLE_LABEL[i.role as keyof typeof ROLE_LABEL] || i.role)} · 截止 ${esc(i.expires_at || '长期')}</span></span>
<form method="post" action="/members/invites/${i.id}/revoke" style="display:inline">${csrfInput}<button class="btn btn-sm btn-danger" type="submit">吊销</button></form></div>`,
  )
  .join('') || '<div class="empty">暂无未使用的邀请码</div>'}</div>`
      : '')
  );
}
