import { TXN_TYPE_MAP } from '../db.js';
import { canWrite } from '../lib/auth.js';
import type { AppContext, TxnRow } from '../types.js';
import type { TxnDateGroup } from '../lib/txn.js';
import { avatarUrl, esc, fmtAmount, initials, relDate } from '../lib/util.js';

export interface FlashMsg {
  type: 'success' | 'error' | 'warn' | 'info';
  message: string;
}

export interface LayoutOpts {
  title: string;
  activeNav?: string;
  ctx: AppContext;
  siteName?: string;
  csrf: string;
  cspNonce?: string;
  flash?: FlashMsg | null;
  aiUsable?: boolean;
  body: string;
}

export function avatarHtml(
  u: { display_name?: string | null; username?: string | null; avatar_color?: string | null; avatar_path?: string | null; avatar_ver?: number | null } | null | undefined,
  size = 30,
): string {
  if (!u) return '';
  const url = avatarUrl(u);
  if (url) {
    return `<img src="${esc(url)}" class="avatar avatar-img" style="width:${size}px;height:${size}px" alt="">`;
  }
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${esc(u.avatar_color || '#0F766E')}">${esc(initials(u.display_name || u.username || '?'))}</span>`;
}

export function blank({
  title,
  siteName = '家账簿',
  csrf = '',
  cspNonce = '',
  flash = null,
  body,
}: {
  title: string;
  siteName?: string;
  csrf?: string;
  cspNonce?: string;
  flash?: FlashMsg | null;
  body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf" content="${esc(csrf)}">
<title>${esc(title)} · ${esc(siteName)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">
<link rel="stylesheet" href="/css/app.css">
<script nonce="${esc(cspNonce)}">try{var t=localStorage.getItem('hl_theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
</head>
<body>
<div class="auth-shell">
  <div class="auth-card">
    <div class="brand" style="padding:0 0 16px">
      <div class="brand-logo">📒</div>
      <div><div class="brand-title">${esc(siteName)}</div><div class="brand-sub">HomeLedger · Technical Ledger</div></div>
    </div>
    ${flash ? `<div class="flash ${esc(flash.type)}"><span>${esc(flash.message)}</span></div>` : ''}
    ${body}
  </div>
</div>
<script src="/js/app.js"></script>
</body>
</html>`;
}

export function layout({
  title,
  activeNav = '',
  ctx,
  siteName = '家账簿',
  csrf,
  cspNonce = '',
  flash = null,
  body,
}: LayoutOpts): string {
  const user = ctx.user;
  const theme = user?.theme === 'dark' ? 'dark' : 'light';
  const navGroups: Array<{ label: string; items: Array<[string, string, string, string, number?]> }> = [
    {
      label: '记账',
      items: [
        ['home', '/', '📊', '总览'],
        ['transactions', '/transactions', '📋', '账单明细'],
        ['new', '/transactions/new', '✏️', '记一笔'],
        ['ai', '/ai', '🤖', 'AI 智能记账'],
        ['calendar', '/calendar', '🗓️', '记账日历'],
        ['search', '/search', '🔍', '搜索筛选'],
        ['attachments', '/attachments', '📎', '附件存档'],
      ],
    },
    {
      label: '资产',
      items: [
        ['accounts', '/accounts', '💳', '账户管理'],
        ['categories', '/categories', '🏷️', '分类管理'],
        ['tags', '/tags', '🔖', '标签管理'],
      ],
    },
    {
      label: '规划',
      items: [
        ['budgets', '/budgets', '🎯', '预算中心'],
        ['recurring', '/recurring', '🔁', '周期账单'],
        ['subscriptions', '/subscriptions', '🧾', '订阅扣费'],
        ['debts', '/debts', '🤝', '借贷台账'],
        ['goals', '/goals', '🐖', '储蓄目标'],
      ],
    },
    {
      label: '系统',
      items: [
        ['reports', '/reports', '📈', '报表分析'],
        ['import', '/import', '📥', '账单导入'],
        ['export', '/export', '📤', '导出备份'],
        ['members', '/members', '👥', '成员权限'],
        ['settings', '/settings', '⚙️', '系统设置'],
        ['about', '/about', 'ℹ️', '关于'],
      ],
    },
  ];
  const writable = Boolean(ctx.ledger && canWrite(ctx.ledger.role));

  const ledgerSwitcher = ctx.ledgers.length
    ? `<div class="ledger-switch">
  <label>当前账本</label>
  <form method="post" action="/ledgers/switch">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <select name="ledger_id" data-autosubmit>
      ${ctx.ledgers.map((l) => `<option value="${l.id}" ${ctx.ledger && Number(l.id) === Number(ctx.ledger.id) ? 'selected' : ''}>${esc(l.icon || '📒')} ${esc(l.name)}</option>`).join('')}
    </select>
  </form>
</div>`
    : '';

  const navHtml = navGroups
    .map(
      (g) => `<div class="nav-group-label">${esc(g.label)}</div>
${g.items
  .map(
    ([key, href, ico, label]) =>
      `<a class="nav-item ${activeNav === key ? 'active' : ''}" href="${href}"><span class="nav-ico">${ico}</span><span>${esc(label)}</span></a>`,
  )
  .join('')}`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf" content="${esc(csrf)}">
<title>${esc(title)} · ${esc(siteName)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">
<link rel="stylesheet" href="/css/app.css">
<script nonce="${esc(cspNonce)}">try{var t=localStorage.getItem('hl_theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
</head>
<body>
<div class="sidebar-backdrop" id="sidebar-backdrop"></div>
<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="/">
      <div class="brand-logo">📒</div>
      <div>
        <div class="brand-title">${esc(siteName)}</div>
        <div class="brand-sub">HomeLedger</div>
      </div>
    </a>
    ${ledgerSwitcher}
    <nav>${navHtml}</nav>
    ${
      user
        ? `<div class="sidebar-foot">
      ${avatarHtml(user, 32)}
      <div style="min-width:0;flex:1">
        <div class="bold small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(user.display_name)}</div>
        <div class="tiny muted">${esc(ctx.ledger?.role || (ctx.isAdmin ? '管理员' : '成员'))}</div>
      </div>
    </div>`
        : ''
    }
  </aside>
  <div class="main-wrap">
    <header class="topbar">
      <button class="nav-toggle" id="nav-toggle" type="button" aria-label="菜单">☰</button>
      <div>
        <div class="topbar-title">${esc(title)}</div>
        ${ctx.ledger ? `<div class="topbar-sub">${esc(ctx.ledger.name)} · ${esc(ctx.ledger.currency || 'CNY')}</div>` : ''}
      </div>
      <div class="spacer"></div>
      <a class="btn btn-sm" href="/search" title="搜索">🔍</a>
      <a class="btn btn-sm" href="/ai">🤖 AI 截图记账</a>
      <a class="btn btn-sm btn-primary" href="/transactions/new">+ 记一笔</a>
      <a class="btn btn-sm" href="/notifications" title="通知中心">🔔${ctx.unreadCount > 0 ? ` <span class="chip expense" style="padding:0 5px">${ctx.unreadCount}</span>` : ''}</a>
      <button class="btn btn-sm" id="theme-toggle-btn" type="button" title="切换主题">🌙</button>
      ${
        user
          ? `<div class="user-menu">
        <button class="btn btn-sm" id="userMenuBtn" type="button">${avatarHtml(user, 22)} <span>${esc(user.display_name)}</span></button>
        <div class="user-drop hidden" id="userMenuDrop">
          <button type="button" id="userMenuAvatar" style="display:flex;align-items:center;gap:8px">${avatarHtml(user, 24)} <span>更换头像</span></button>
          <input type="file" id="userAvatarFile" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden">
          <a href="/settings">⚙️ 系统设置</a>
          <a href="/ledgers">📒 账本管理</a>
          ${ctx.isAdmin ? '<a href="/admin">🛡️ 管理员面板</a>' : ''}
          <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit">🚪 退出登录</button></form>
        </div>
      </div>`
          : ''
      }
    </header>
    <main class="content">
      ${flash ? `<div class="flash ${esc(flash.type)}"><span>${esc(flash.message)}</span></div>` : ''}
      ${body}
    </main>
  </div>
</div>
${
  user
    ? writable
      ? `<nav class="mobile-nav" aria-label="移动端主导航">
  <a class="mnav-item ${activeNav === 'home' ? 'active' : ''}" href="/"><span>📊</span><span>总览</span></a>
  <a class="mnav-item ${activeNav === 'transactions' ? 'active' : ''}" href="/transactions"><span>📋</span><span>明细</span></a>
  <a class="mnav-item mnav-add ${activeNav === 'new' ? 'active' : ''}" href="/transactions/new"><span>＋</span><span>记一笔</span></a>
  <a class="mnav-item ${activeNav === 'reports' ? 'active' : ''}" href="/reports"><span>📈</span><span>报表</span></a>
  <a class="mnav-item ${activeNav === 'ai' ? 'active' : ''}" href="/ai"><span>🤖</span><span>AI</span></a>
</nav>`
      : `<nav class="mobile-nav" aria-label="移动端主导航">
  <a class="mnav-item ${activeNav === 'home' ? 'active' : ''}" href="/"><span>📊</span><span>总览</span></a>
  <a class="mnav-item ${activeNav === 'transactions' ? 'active' : ''}" href="/transactions"><span>📋</span><span>明细</span></a>
  <a class="mnav-item ${activeNav === 'calendar' ? 'active' : ''}" href="/calendar"><span>🗓️</span><span>日历</span></a>
  <a class="mnav-item ${activeNav === 'reports' ? 'active' : ''}" href="/reports"><span>📈</span><span>报表</span></a>
  <a class="mnav-item ${activeNav === 'search' ? 'active' : ''}" href="/search"><span>🔍</span><span>搜索</span></a>
</nav>`
    : ''
}
${
  writable
    ? `<button class="ai-fab" id="aiFab" type="button">✨ AI 记一笔</button>
<div class="ai-panel hidden" id="aiPanel">
  <div class="ai-panel-head">
    <span>🤖 AI 记账助手</span>
    <div class="row"><button class="btn btn-sm btn-ghost" id="aiClear" type="button">清空</button><button class="btn btn-sm btn-ghost" id="aiClose" type="button">✕</button></div>
  </div>
  <div class="ai-msgs" id="aiMsgs">
    <div class="ai-bubble bot">说一句消费（如「午饭 35 元 支付宝」）或传一张账单截图，自动识别入库。</div>
  </div>
  <div class="ai-panel-foot">
    <div class="thumbs hidden" id="aiThumbs"></div>
    <div class="row">
      <button class="btn btn-sm" id="aiAttach" type="button" title="上传账单截图">📎</button>
      <input type="file" id="aiFile" accept="image/*" multiple class="hidden">
      <textarea id="aiText" rows="1" placeholder="输入一句话或上传截图…" style="flex:1;resize:none"></textarea>
      <button class="btn btn-sm btn-primary" id="aiSend" type="button">发送</button>
    </div>
  </div>
</div>`
    : ''
}
<script src="/js/app.js"></script>
${writable ? '<script src="/js/assistant.js"></script>' : ''}
</body>
</html>`;
}

export function simpleTable(title: string, headers: string[], rowsHtml: string, rightSlot = ''): string {
  return `<div class="card">
  <div class="card-head"><b>${esc(title)}</b>${rightSlot ? `<div>${rightSlot}</div>` : ''}</div>
  <div class="scroll-x">
    <table class="table">
      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</div>`;
}

export function groupList(groups: TxnDateGroup[], opts: { bulk?: boolean; csrf?: string } = {}): string {
  if (!groups.length) return '<div class="empty">暂无流水记录</div>';
  return groups
    .map(
      (g) => `<div class="txn-day-head">
  <span>${esc(g.date)} · ${esc(relDate(g.date))}</span>
  <span class="amount">${g.income ? `<span class="income">+${fmtAmount(g.income)}</span>` : ''}${g.income && g.expense ? ' · ' : ''}${g.expense ? `<span class="expense">-${fmtAmount(g.expense)}</span>` : ''}</span>
</div>
${g.items.map((t) => txnRowHtml(t, opts)).join('')}`,
    )
    .join('');
}

function txnRowHtml(t: TxnRow, opts: { bulk?: boolean }): string {
  const isIncome = t.is_income;
  const isExpense = t.is_expense;
  const cls = isIncome ? 'income' : isExpense ? 'expense' : 'neutral';
  const sign = isIncome ? '+' : isExpense ? '-' : '';
  const meta = TXN_TYPE_MAP[t.type];
  const title = t.merchant || t.category_name || meta?.label || t.type;
  const checkboxName = t.is_reimbursable && !t.reimbursed_at && (t.type === 'expense' || t.type === 'fee') ? 'ids' : 'del_ids';
  return `<div class="txn">
  ${opts.bulk ? `<input type="checkbox" class="bulk-item" name="${checkboxName}" value="${t.id}">` : ''}
  <div class="txn-ico">${esc(t.category_icon || t.type_icon || '💳')}</div>
  <div class="txn-main">
    <div class="txn-title">
      <span>${esc(title)}</span>
      <span class="chip">${esc(t.category_path || meta?.label || t.type)}</span>
      ${t.attachment_count ? `<span class="chip primary">📎 ${t.attachment_count}</span>` : ''}
      ${t.is_reimbursable ? `<span class="chip ${t.reimbursed_at ? 'income' : 'warn'}">${t.reimbursed_at ? '已报销' : '待报销'}</span>` : ''}
    </div>
    <div class="txn-sub">
      <span>${esc(t.account_icon || '')} ${esc(t.account_name || '未指定账户')}${t.to_account_name ? ` → ${esc(t.to_account_name)}` : ''}</span>
      ${t.member_name ? `<span>· ${esc(t.member_name)}</span>` : ''}
      ${t.note ? `<span>· ${esc(t.note)}</span>` : ''}
      ${t.tag_names ? `<span>· #${esc(t.tag_names)}</span>` : ''}
    </div>
  </div>
  <div class="txn-right">
    <div class="txn-amt amount ${cls}">${sign}${fmtAmount(t.amount_base_cents)}</div>
    <div class="row mt8" style="justify-content:flex-end">
      <a class="btn btn-sm btn-ghost" href="/transactions/${t.id}/edit">编辑</a>
      <button class="btn btn-sm btn-ghost" type="button" data-del-txn="${t.id}">删除</button>
    </div>
  </div>
</div>`;
}

export function paginationHtml(
  basePath: string,
  query: Record<string, string | number | undefined | null>,
  page: number,
  totalPages: number,
  total?: number,
): string {
  if (totalPages <= 1) return '';
  const buildHref = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    sp.set('page', String(p));
    return `${basePath}?${sp.toString()}`;
  };

  const items: Array<number | '...'> = [];
  if (totalPages <= 9) {
    for (let i = 1; i <= totalPages; i++) items.push(i);
  } else {
    const set = new Set<number>([1, totalPages]);
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) set.add(i);
    const sorted = [...set].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) items.push('...');
      items.push(sorted[i]);
    }
  }

  const btns: string[] = [];
  if (page > 1) btns.push(`<a class="btn btn-sm" href="${esc(buildHref(page - 1))}">← 上一页</a>`);
  for (const it of items) {
    if (it === '...') {
      btns.push('<span class="muted small" style="padding:0 4px">…</span>');
    } else {
      btns.push(
        `<a class="btn btn-sm ${it === page ? 'btn-primary' : ''}" href="${esc(buildHref(it))}">${it}</a>`,
      );
    }
  }
  if (page < totalPages) btns.push(`<a class="btn btn-sm" href="${esc(buildHref(page + 1))}">下一页 →</a>`);

  return `<div class="between mt16 wrap">
  <span class="muted small">第 ${page} / ${totalPages} 页${total != null ? `，共 ${total} 条` : ''}</span>
  <div class="row wrap">${btns.join('')}</div>
</div>`;
}
