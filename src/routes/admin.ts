import { Hono } from 'hono';
import {
  addLedgerMember,
  allSettings,
  createDefaultAccounts,
  createDefaultLedger,
  nowStr,
  recalcBalances,
  setSetting,
  todayStr,
} from '../db.js';
import {
  classifyByKeywords,
  getAiConfig,
  isMaskedSecret,
  listModels,
  resolveDefaultAccount,
  testConnection,
} from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import { EXPORT_HEADER, exportRows, importRecords, parseBill, toCsv, type ParsedBillRecord } from '../lib/importers.js';
import { cleanupOrphanR2, runScheduled } from '../lib/scheduler.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { HonoEnv, Role, UserRow } from '../types.js';
import { membersPage, settingsPage } from '../views/admin.js';
import { layout, simpleTable } from '../views/layout.js';
import {
  bodyOf,
  dbOf,
  envOf,
  getSessionSecret,
  requireAdmin,
  requireLedger,
  requireLogin,
  requireManage,
  requireWrite,
  setFlash,
  siteMeta,
  takeFlash,
  toPublicError,
  wantsJson,
} from './helpers.js';

export const adminRoutes = new Hono<HonoEnv>();

const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,32}$/;
const toBoolSetting = (v: unknown): 'true' | 'false' =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 'true' : 'false';

const BACKUP_TABLES = [
  'users',
  'settings',
  'ledgers',
  'ledger_members',
  'ledger_invites',
  'accounts',
  'categories',
  'tags',
  'transactions',
  'transaction_tags',
  'splits',
  'attachments',
  'session_cards',
  'session_card_logs',
  'budgets',
  'recurring_rules',
  'goals',
  'subscriptions',
  'debts',
  'notifications',
  'exchange_rates',
  'import_jobs',
  'api_tokens',
] as const;

const previewCache = new Map<
  string,
  {
    userId: number;
    ledgerId: number;
    source: string;
    fileName: string;
    records: ParsedBillRecord[];
    neutralRecords: ParsedBillRecord[];
  }
>();

function parseBase64Payload(raw: string): Uint8Array {
  const clean = String(raw || '').trim();
  const b64 = clean.startsWith('data:') ? clean.slice(clean.indexOf(',') + 1) : clean;
  return Buffer.from(b64, 'base64');
}

/* ============================ 设置与安全 ============================ */

adminRoutes.get('/settings', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const [settings, cfg, tokens, rates] = await Promise.all([
    allSettings(db),
    getAiConfig(db),
    db.all<{ id: number; name: string; token_tail: string; created_at: string; expires_at: string | null }>(
      'SELECT id, name, token_tail, created_at, expires_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
      ctx.user!.id,
    ),
    db.all<{ base: string; quote: string; rate: number; noted_at: string }>(
      'SELECT base, quote, rate, noted_at FROM exchange_rates ORDER BY base, quote',
    ),
  ]);
  const csrf = c.get('csrf') || '';
  return c.html(
    layout({
      title: '系统设置',
      activeNav: 'settings',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: settingsPage({ ctx, settings, cfg, tokens, rates, csrf }),
    }),
  );
});

adminRoutes.post('/settings/profile', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const displayName = String(body.display_name || '').trim().slice(0, 24);
  const email = body.email ? String(body.email).trim().slice(0, 80) : null;
  if (!displayName) {
    setFlash(c, 'error', '显示名称不能为空');
    return c.redirect('/settings');
  }
  await db.run('UPDATE users SET display_name = ?, email = ? WHERE id = ?', displayName, email, ctx.user!.id);
  setFlash(c, 'success', '个人资料已更新');
  return c.redirect('/settings');
});

adminRoutes.post('/settings/password', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const curPwd = String(body.current_password || '');
  const newPwd = String(body.password || '');
  const pwd2 = String(body.password2 || '');

  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', ctx.user!.id);
  if (!user || !(await auth.verifyPassword(curPwd, user.password_hash))) {
    setFlash(c, 'error', '当前密码不正确');
    return c.redirect('/settings');
  }
  if (newPwd.length < 6) {
    setFlash(c, 'error', '新密码长度至少 6 位');
    return c.redirect('/settings');
  }
  if (newPwd !== pwd2) {
    setFlash(c, 'error', '两次输入的新密码不一致');
    return c.redirect('/settings');
  }

  const nextHash = await auth.hashPassword(newPwd);
  const stamp = nowStr();
  await db.batch([
    ['UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [nextHash, user.id]],
    ['UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [stamp, user.id]],
  ]);
  c.header('Set-Cookie', auth.clearSessionCookie(envOf(c)), { append: true });
  return c.redirect('/login?notice=password_changed');
});

adminRoutes.post('/settings/avatar', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  try {
    const { mime, buf } = attach.parseDataUrl(String(body.dataUrl || ''));
    if (buf.length > 2 * 1024 * 1024) throw new Error('头像图片请小于 2MB');
    const ext = attach.MIME_EXT[mime];
    if (!ext || !['png', 'jpg', 'gif', 'webp'].includes(ext)) throw new Error('头像仅支持 PNG / JPG / GIF / WebP');
    const saved = await attach.saveAvatar(env, ctx.user!.id, { mime, buf, ext });
    await db.run('UPDATE users SET avatar_path = ?, avatar_ver = avatar_ver + 1 WHERE id = ?', saved, ctx.user!.id);
    const nextVer = Number(ctx.user!.avatar_ver || 0) + 1;
    return c.json({ ok: true, avatar_url: `/uploads/avatars/${saved}?v=${nextVer}` });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

adminRoutes.post('/settings/avatar/clear', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  await attach.removeAvatar(env, ctx.user!.avatar_path);
  await db.run('UPDATE users SET avatar_path = NULL, avatar_ver = avatar_ver + 1 WHERE id = ?', ctx.user!.id);
  return c.json({ ok: true });
});

adminRoutes.post('/settings/ai', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const baseUrl = String(body.base_url || '').trim().replace(/\/+$/, '');
  const model = String(body.model || '').trim();
  const apiKey = String(body.api_key || '').trim();

  await setSetting(db, 'ai.base_url', baseUrl);
  await setSetting(db, 'ai.model', model);
  await setSetting(db, 'ai.enabled', toBoolSetting(body.enabled));
  await setSetting(db, 'ai.vision', toBoolSetting(body['ai.vision'] ?? body.vision));
  await setSetting(db, 'ai.auto_save', toBoolSetting(body.auto_save));
  if (apiKey && !isMaskedSecret(apiKey)) {
    await setSetting(db, 'ai.api_key', apiKey);
  }
  setFlash(c, 'success', 'AI 配置已保存');
  return c.redirect('/settings#ai');
});

adminRoutes.post('/settings/ai/test', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  return c.json(await testConnection(db, body));
});

adminRoutes.post('/settings/ai/models', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  try {
    const res = await listModels(db, body);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

adminRoutes.post('/settings/site', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  await setSetting(db, 'site.name', String(body.site_name || '家账簿').trim().slice(0, 40) || '家账簿');
  await setSetting(db, 'site.currency', String(body.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY');
  await setSetting(db, 'site.allow_register', body.allow_register ? 'true' : 'false');
  setFlash(c, 'success', '站点设置已更新');
  return c.redirect('/settings');
});

adminRoutes.post('/settings/rates', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const today = todayStr();
  const stmts: Array<[string, unknown[]]> = [];

  for (const [k, v] of Object.entries(body)) {
    const m = /^rate_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(k);
    if (!m) continue;
    const rate = Number(v);
    if (rate > 0) {
      stmts.push([
        'INSERT OR REPLACE INTO exchange_rates (base, quote, rate, noted_at) VALUES (?,?,?,?)',
        [m[1], m[2], rate, today],
      ]);
    }
  }
  const nb = String(body.new_base || '').trim().toUpperCase();
  const nq = String(body.new_quote || 'CNY').trim().toUpperCase();
  const nr = Number(body.new_rate);
  if (nb && nq && nr > 0) {
    stmts.push(['INSERT OR REPLACE INTO exchange_rates (base, quote, rate, noted_at) VALUES (?,?,?,?)', [nb, nq, nr, today]]);
  }
  if (stmts.length) await db.batch(stmts);
  setFlash(c, 'success', '汇率配置已更新');
  return c.redirect('/settings');
});

adminRoutes.post('/settings/api-tokens', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const body = await bodyOf(c);
  const name = String(body.name || 'API 令牌').trim().slice(0, 40) || 'API 令牌';
  const days = Number(body.expires_in_days || 0);
  const expiresAt = days > 0 ? `${u.addDays(todayStr(), days)} 23:59:59` : null;

  const raw = `hl_${u.uid(24)}`;
  const tokenHash = await auth.sha256Hex(raw);
  const tail = raw.slice(-6);
  const res = await db.run(
    `INSERT INTO api_tokens (user_id, ledger_id, name, token_hash, token_tail, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    ctx.user!.id,
    ctx.ledger ? Number(ctx.ledger.id) : null,
    name,
    tokenHash,
    tail,
    expiresAt,
    nowStr(),
  );

  c.header('Cache-Control', 'no-store');
  if (wantsJson(c)) {
    return c.json({ ok: true, id: res.lastInsertRowid, name, token: raw, token_tail: tail, expires_at: expiresAt });
  }
  return c.html(
    layout({
      title: 'API 令牌已生成',
      activeNav: 'settings',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      body: `<div class="card">
  <div class="card-head"><b>API 令牌创建成功</b><span class="chip income">仅此一次展示</span></div>
  <p class="muted small mb12">请立即复制保存以下 Bearer Token，刷新页面后将不再展示明文：</p>
  <div class="notice mb16"><code>${esc(raw)}</code></div>
  <a class="btn btn-primary" href="/settings">返回系统设置</a>
</div>`,
    }),
  );
});

adminRoutes.post('/settings/api-tokens/:id/revoke', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  await db.run(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    nowStr(),
    id,
    c.get('ctx').user!.id,
  );
  setFlash(c, 'success', 'API 令牌已吊销');
  return c.redirect('/settings');
});

adminRoutes.post('/theme/:mode', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const mode = c.req.param('mode') === 'dark' ? 'dark' : 'light';
  await dbOf(c).run('UPDATE users SET theme = ? WHERE id = ?', mode, c.get('ctx').user!.id);
  return c.json({ ok: true, theme: mode });
});

/* ============================ 账本管理 ============================ */

adminRoutes.get('/ledgers', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const csrf = c.get('csrf') || '';
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

  const rows = await db.all<{
    id: number;
    name: string;
    kind: string;
    currency: string;
    icon: string;
    is_archived: number;
    role: string;
  }>(
    `SELECT l.id, l.name, l.kind, l.currency, l.icon, l.is_archived, m.role
     FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
     WHERE m.user_id = ? ORDER BY l.is_archived, l.sort_order, l.id`,
    ctx.user!.id,
  );

  const tableRows = rows
    .map(
      (l) => `<tr>
  <td>${esc(l.icon)} <b>${esc(l.name)}</b> ${Number(ctx.ledger?.id) === Number(l.id) ? '<span class="chip income">当前</span>' : ''} ${l.is_archived ? '<span class="chip">已归档</span>' : ''}</td>
  <td>${esc(l.currency)}</td>
  <td>${esc(auth.ROLE_LABEL[l.role as Role] || l.role)}</td>
  <td>
    <form method="post" action="/ledgers/switch" style="display:inline">${csrfInput}<input type="hidden" name="ledger_id" value="${l.id}"><button class="btn btn-sm" type="submit">切换</button></form>
    ${l.role === 'owner' ? `<form method="post" action="/ledgers/${l.id}/archive" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${l.is_archived ? '取消归档' : '归档'}</button></form>` : ''}
  </td>
</tr>`,
    )
    .join('');

  return c.html(
    layout({
      title: '多账本管理',
      activeNav: 'ledgers',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="grid grid-2">
  <div>${simpleTable('我的账本', ['账本名称', '币种', '我的角色', '操作'], tableRows || '<tr><td colspan="4">暂无账本</td></tr>')}</div>
  <div class="card">
    <div class="card-head"><b>新建账本</b></div>
    <form method="post" action="/ledgers">
      ${csrfInput}
      <div class="field"><label>账本名称</label><input name="name" required placeholder="例如：家庭共同账本"></div>
      <div class="grid grid-2">
        <div class="field"><label>类型</label><select name="kind"><option value="family">家庭共享</option><option value="personal">个人私账</option><option value="trip">旅行专项</option></select></div>
        <div class="field"><label>本位币</label><input name="currency" value="${esc(meta.baseCurrency)}"></div>
      </div>
      <div class="field"><label>图标</label><input name="icon" value="📒"></div>
      <button class="btn btn-primary btn-block" type="submit">创建账本并初始化默认账户</button>
    </form>
  </div>
</div>`,
    }),
  );
});

adminRoutes.post('/ledgers', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) {
    setFlash(c, 'error', '请输入账本名称');
    return c.redirect('/ledgers');
  }
  const currency = String(body.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
  const kind = ['family', 'personal', 'trip'].includes(String(body.kind)) ? String(body.kind) : 'family';
  const icon = String(body.icon || '📒').slice(0, 8) || '📒';
  const res = await db.run(
    'INSERT INTO ledgers (name, kind, currency, icon, owner_id, created_at) VALUES (?,?,?,?,?,?)',
    name,
    kind,
    currency,
    icon,
    ctx.user!.id,
    nowStr(),
  );
  const ledgerId = Number(res.lastInsertRowid);
  await addLedgerMember(db, ledgerId, ctx.user!.id, 'owner');
  await createDefaultAccounts(db, ledgerId, currency);

  const sess = c.get('sess');
  if (sess) {
    const token = await auth.signSession(
      auth.createSessionPayload(sess.uid, ledgerId, sess.tv, sess.csrf),
      getSessionSecret(envOf(c)),
    );
    c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  }
  setFlash(c, 'success', `账本「${name}」已创建并切换`);
  return c.redirect('/ledgers');
});

adminRoutes.post('/ledgers/:id', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const m = await auth.membership(db, c.get('ctx').user!.id, id);
  if (!m || !auth.canManage(m.role)) {
    setFlash(c, 'error', '无权修改该账本');
    return c.redirect('/ledgers');
  }
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 30);
  if (name) {
    await db.run('UPDATE ledgers SET name = ?, icon = ? WHERE id = ?', name, String(body.icon || '📒').slice(0, 8), id);
  }
  setFlash(c, 'success', '账本已更新');
  return c.redirect('/ledgers');
});

adminRoutes.post('/ledgers/:id/archive', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const m = await auth.membership(db, c.get('ctx').user!.id, id);
  if (!m || m.role !== 'owner') {
    setFlash(c, 'error', '仅账本所有者可归档');
    return c.redirect('/ledgers');
  }
  const row = await db.get<{ is_archived: number }>('SELECT is_archived FROM ledgers WHERE id = ?', id);
  if (row) await db.run('UPDATE ledgers SET is_archived = ? WHERE id = ?', row.is_archived ? 0 : 1, id);
  return c.redirect('/ledgers');
});

adminRoutes.post('/ledgers/:id/delete', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const m = await auth.membership(db, c.get('ctx').user!.id, id);
  if (!m || m.role !== 'owner') {
    setFlash(c, 'error', '仅账本所有者可删除');
    return c.redirect('/ledgers');
  }
  await db.batch([
    ['DELETE FROM ledger_invites WHERE ledger_id = ?', [id]],
    ['DELETE FROM ledger_members WHERE ledger_id = ?', [id]],
    ['DELETE FROM ledgers WHERE id = ?', [id]],
  ]);
  setFlash(c, 'success', '账本已删除');
  return c.redirect('/ledgers');
});

/* ============================ 成员与邀请 ============================ */

adminRoutes.get('/members', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const ledgerId = Number(ctx.ledger!.id);
  const [members, invites] = await Promise.all([
    db.all<{ id: number; user_id: number; role: string; username: string; display_name: string; joined_at: string }>(
      `SELECT m.id, m.user_id, m.role, m.joined_at, u.username, u.display_name
       FROM ledger_members m JOIN users u ON u.id = m.user_id
       WHERE m.ledger_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.id`,
      ledgerId,
    ),
    db.all<{ id: number; code: string; role: string; expires_at: string | null }>(
      'SELECT id, code, role, expires_at FROM ledger_invites WHERE ledger_id = ? AND used_by IS NULL ORDER BY id DESC',
      ledgerId,
    ),
  ]);
  const csrf = c.get('csrf') || '';
  return c.html(
    layout({
      title: '成员权限',
      activeNav: 'members',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: membersPage({ ctx, members, invites, csrf }),
    }),
  );
});

adminRoutes.post('/members/invite', async (c) => {
  const r = requireManage(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const role: Role = ['admin', 'member', 'viewer'].includes(String(body.role)) ? (String(body.role) as Role) : 'member';
  const days = Math.max(1, Math.min(30, Number(body.days) || 7));
  const code = u.uid(12);
  const expiresAt = u.addDays(todayStr(), days);
  await db.run(
    'INSERT INTO ledger_invites (ledger_id, code, role, created_by, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    Number(ctx.ledger!.id),
    code,
    role,
    ctx.user!.id,
    expiresAt,
    nowStr(),
  );
  setFlash(c, 'success', `已生成邀请链接：/join/${code}`);
  return c.redirect('/members');
});

adminRoutes.post('/members/invites/:id/revoke', async (c) => {
  const r = requireManage(c);
  if (r) return r;
  await dbOf(c).run(
    'DELETE FROM ledger_invites WHERE id = ? AND ledger_id = ?',
    Number(c.req.param('id')),
    Number(c.get('ctx').ledger!.id),
  );
  setFlash(c, 'success', '邀请码已吊销');
  return c.redirect('/members');
});

adminRoutes.post('/members/:id', async (c) => {
  const r = requireManage(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const mid = Number(c.req.param('id'));
  const target = await db.get<{ id: number; user_id: number; role: string }>(
    'SELECT id, user_id, role FROM ledger_members WHERE id = ? AND ledger_id = ?',
    mid,
    ledgerId,
  );
  if (!target || target.role === 'owner' || Number(target.user_id) === Number(c.get('ctx').user!.id)) {
    setFlash(c, 'error', '不可修改该成员角色');
    return c.redirect('/members');
  }
  const role = String((await bodyOf(c)).role || '');
  if (!['admin', 'member', 'viewer'].includes(role)) {
    setFlash(c, 'error', '无效角色');
    return c.redirect('/members');
  }
  await db.run('UPDATE ledger_members SET role = ? WHERE id = ?', role, mid);
  setFlash(c, 'success', '成员角色已更新');
  return c.redirect('/members');
});

adminRoutes.post('/members/:id/remove', async (c) => {
  const r = requireManage(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const mid = Number(c.req.param('id'));
  const target = await db.get<{ id: number; user_id: number; role: string }>(
    'SELECT id, user_id, role FROM ledger_members WHERE id = ? AND ledger_id = ?',
    mid,
    ledgerId,
  );
  if (!target || target.role === 'owner' || Number(target.user_id) === Number(c.get('ctx').user!.id)) {
    setFlash(c, 'error', '不能移除自己或账本所有者');
    return c.redirect('/members');
  }
  await db.run('DELETE FROM ledger_members WHERE id = ?', mid);
  setFlash(c, 'success', '成员已移出');
  return c.redirect('/members');
});

/* ============================ 账单导入 ============================ */

adminRoutes.get('/import', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');

  const jobs = await db.all<{
    id: number;
    source: string;
    file_name: string | null;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    message: string | null;
    created_at: string;
  }>('SELECT * FROM import_jobs WHERE ledger_id = ? ORDER BY id DESC LIMIT 15', Number(ctx.ledger.id));

  const jobRows = jobs
    .map(
      (j) => `<tr>
  <td>${esc(j.file_name || j.source)}</td>
  <td>${esc(j.source)}</td>
  <td>${j.imported} / ${j.total}${j.skipped ? `（跳过 ${j.skipped}）` : ''}</td>
  <td>${j.failed ? `<span class="chip expense">${j.failed} 失败</span> <a class="btn btn-sm" href="/import/failures/${j.id}">失败清单</a>` : '0'}</td>
  <td class="tiny muted">${esc(j.created_at)}</td>
</tr>`,
    )
    .join('');

  return c.html(
    layout({
      title: '账单导入',
      activeNav: 'import',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card mb16">
  <div class="card-head"><b>导入支付宝 / 微信账单（CSV）</b><span class="muted small">自动识别 UTF-8 / GBK 编码与订单号去重</span></div>
  <div id="import-dropzone" class="dropzone">
    <div style="font-size:24px;margin-bottom:4px">📥</div>
    <div>拖放支付宝 / 微信 CSV 账单文件到这里，或点击选择文件</div>
    <input type="file" id="import-file" accept=".csv,text/csv" class="hidden">
  </div>
  <div id="import-preview"></div>
</div>
${simpleTable('最近导入记录', ['文件名', '来源', '导入/总计', '失败', '时间'], jobRows || '<tr><td colspan="5">暂无导入记录</td></tr>')}`,
    }),
  );
});

adminRoutes.post('/api/import/preview', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const ctx = c.get('ctx');
  const env = envOf(c);
  const body = await bodyOf(c);
  const dataUrl = String(body.dataUrl || '');
  const fileName = String(body.fileName || 'bill.csv').slice(0, 100);
  if (!dataUrl) return c.json({ ok: false, error: '请选择 CSV 文件' }, 400);

  try {
    const buf = parseBase64Payload(dataUrl);
    const parsed = parseBill(buf);
    if ('error' in parsed && parsed.error) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }

    const token = u.uid(16);
    const payload = {
      userId: ctx.user!.id,
      ledgerId: Number(ctx.ledger!.id),
      source: parsed.source,
      fileName,
      records: parsed.records,
      neutralRecords: parsed.neutralRecords,
    };

    if (env.ATTACHMENTS) {
      await env.ATTACHMENTS.put(`imports/preview-${token}.json`, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
      });
    } else {
      previewCache.set(token, payload);
    }

    let expense = 0;
    let income = 0;
    let transfer = 0;
    let minDate = '';
    let maxDate = '';
    for (const rec of parsed.records) {
      if (rec.type === 'expense') expense += rec.amount_cents;
      else if (rec.type === 'income') income += rec.amount_cents;
      else transfer += rec.amount_cents;
      if (rec.txn_date) {
        if (!minDate || rec.txn_date < minDate) minDate = rec.txn_date;
        if (!maxDate || rec.txn_date > maxDate) maxDate = rec.txn_date;
      }
    }

    const sourceLabel = parsed.source === 'alipay' ? '支付宝账单' : parsed.source === 'wechat' ? '微信账单' : '通用 CSV';
    return c.json({
      ok: true,
      token,
      source: parsed.source,
      sourceLabel,
      encoding: parsed.encoding,
      count: parsed.records.length,
      neutralCount: parsed.neutralRecords.length,
      skipped: parsed.skipped,
      stat: { expense, income, transfer, minDate, maxDate },
      sample: parsed.records.slice(0, 60).map((rec) => ({
        ...rec,
        type_label: rec.type === 'income' ? '收入' : rec.type === 'transfer' ? '转账' : '支出',
        guess_category:
          rec.category_hint ||
          classifyByKeywords(rec.text)?.category ||
          (rec.type === 'transfer' ? '转账' : rec.type === 'income' ? '其他收入' : '其他支出'),
        guess_account: rec.account_hint || null,
      })),
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

adminRoutes.post('/api/import/commit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const env = envOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const token = String(body.token || '').trim();
  if (!token) return c.json({ ok: false, error: '导入预览令牌无效或已过期' }, 400);

  let payload = previewCache.get(token) || null;
  const r2Key = `imports/preview-${token}.json`;
  if (!payload && env.ATTACHMENTS) {
    const obj = await env.ATTACHMENTS.get(r2Key);
    if (obj) {
      payload = JSON.parse(await obj.text()) as NonNullable<typeof payload>;
    }
  }
  if (!payload || Number(payload.ledgerId) !== Number(ctx.ledger!.id) || Number(payload.userId) !== Number(ctx.user!.id)) {
    return c.json({ ok: false, error: '导入预览已失效，请重新上传文件预览' }, 400);
  }

  try {
    const defaultAcc = await resolveDefaultAccount(
      db,
      Number(ctx.ledger!.id),
      body.default_account_id ? Number(body.default_account_id) : null,
    );
    const result = await importRecords(db, {
      ledgerId: Number(ctx.ledger!.id),
      userId: Number(ctx.user!.id),
      records: payload.records,
      neutralRecords: payload.neutralRecords,
      includeNeutral: Boolean(body.include_neutral),
      source: payload.source,
      fileName: payload.fileName,
      autoCreateAccount: body.auto_create_account !== false,
      defaultAccountId: defaultAcc?.id ?? null,
      env,
    });
    previewCache.delete(token);
    if (env.ATTACHMENTS) await env.ATTACHMENTS.delete(r2Key).catch(() => {});
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

adminRoutes.get('/import/failures/:jobId', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const env = envOf(c);
  const jobId = Number(c.req.param('jobId'));
  const job = await dbOf(c).get<{ id: number; ledger_id: number; message: string | null }>(
    'SELECT id, ledger_id, message FROM import_jobs WHERE id = ? AND ledger_id = ?',
    jobId,
    Number(c.get('ctx').ledger!.id),
  );
  if (!job) return c.text('未找到导入记录', 404);
  if (env.ATTACHMENTS) {
    const obj = await env.ATTACHMENTS.get(`imports/failures-${jobId}.json`);
    if (obj) {
      c.header('Content-Type', 'application/json; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="failures-${jobId}.json"`);
      return c.body(await obj.text());
    }
  }
  return c.json({ jobId: job.id, message: job.message || '无失败详情' });
});

/* ============================ 导出与全量备份恢复 ============================ */

adminRoutes.get('/export', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const csrf = c.get('csrf') || '';
  return c.html(
    layout({
      title: '数据导出与备份',
      activeNav: 'export',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="grid grid-2">
  <div class="card">
    <div class="card-head"><b>导出账单流水（CSV）</b></div>
    <p class="muted small mb12">导出当前账本全部未删除流水，带 UTF-8 BOM，可直接用 Excel 或 WPS 打开。</p>
    <a class="btn btn-primary" href="/export/csv">下载 CSV 流水明细</a>
  </div>
  <div class="card">
    <div class="card-head"><b>整库 JSON 备份与恢复</b></div>
    <p class="muted small mb12">${ctx.isAdmin ? '管理员可导出全库 JSON 快照并在必要时覆盖恢复。' : '仅站点管理员可执行全库 JSON 备份与恢复。'}</p>
    ${ctx.isAdmin ? `<div class="row wrap"><a class="btn btn-primary" href="/export/json">下载全库 JSON 备份</a><label class="btn" style="cursor:pointer">从 JSON 恢复<input type="file" id="restore-file" accept=".json,application/json" class="hidden"></label></div>` : ''}
  </div>
</div>`,
    }),
  );
});

adminRoutes.get('/export/csv', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const res = await txn.listTransactions(db, ledgerId, { page: 1, pageSize: 50000 });
  const csv = toCsv(EXPORT_HEADER, exportRows(ledgerId, res.rows));
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="homeledger-${todayStr()}.csv"`);
  return c.body(csv);
});

adminRoutes.get('/export/json', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const tables: Record<string, unknown[]> = {};
  for (const tbl of BACKUP_TABLES) {
    tables[tbl] = await db.all(`SELECT * FROM ${tbl}`);
  }
  const dump = JSON.stringify({ app: 'homeledger', version: 2, exported_at: nowStr(), tables }, null, 2);
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="homeledger-backup-${todayStr()}.json"`);
  c.header('Cache-Control', 'no-store');
  return c.body(dump);
});

adminRoutes.post('/backup/restore', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);

  try {
    let rawJson = '';
    if (body.dataUrl) {
      rawJson = new TextDecoder('utf-8').decode(parseBase64Payload(String(body.dataUrl)));
    } else if (body.backup) {
      rawJson = typeof body.backup === 'string' ? body.backup : JSON.stringify(body.backup);
    }
    if (!rawJson) return c.json({ ok: false, error: '未提供备份 JSON 内容' }, 400);

    const parsed = JSON.parse(rawJson) as { tables?: Record<string, Record<string, unknown>[]> };
    if (!parsed || typeof parsed !== 'object' || !parsed.tables || typeof parsed.tables !== 'object') {
      return c.json({ ok: false, error: '备份文件格式无效（缺少 tables 字段）' }, 400);
    }

    const existingCols = new Map<string, string[]>();
    for (const tbl of BACKUP_TABLES) {
      const info = await db.all<{ name: string }>(`PRAGMA table_info(${tbl})`);
      existingCols.set(
        tbl,
        info.map((col) => col.name),
      );
    }

    const stmts: Array<[string, unknown[]?]> = [];
    for (const tbl of [...BACKUP_TABLES].reverse()) {
      stmts.push([`DELETE FROM ${tbl}`]);
    }
    const counts: Record<string, number> = {};
    for (const tbl of BACKUP_TABLES) {
      const rows = Array.isArray(parsed.tables[tbl]) ? parsed.tables[tbl] : [];
      const validCols = existingCols.get(tbl) || [];
      if (!rows.length || !validCols.length) {
        counts[tbl] = 0;
        continue;
      }
      const cols = validCols.filter((col) => col in rows[0]);
      if (!cols.length) {
        counts[tbl] = 0;
        continue;
      }
      const sql = `INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      for (const row of rows) {
        stmts.push([sql, cols.map((col) => (row[col] === undefined ? null : row[col]))]);
      }
      counts[tbl] = rows.length;
    }

    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
    const ledgers = await db.all<{ id: number }>('SELECT id FROM ledgers');
    for (const l of ledgers) await recalcBalances(db, Number(l.id));

    return c.json({ ok: true, restored: counts });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

/* ============================ 管理员后台与维护 ============================ */

adminRoutes.get('/admin', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const csrf = c.get('csrf') || '';
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

  const [users, stats] = await Promise.all([
    db.all<{
      id: number;
      username: string;
      display_name: string;
      is_admin: number;
      status: string;
      last_login_at: string | null;
      created_at: string;
    }>('SELECT id, username, display_name, is_admin, status, last_login_at, created_at FROM users ORDER BY id'),
    db.get<{ users: number; ledgers: number; txns: number }>(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM ledgers) AS ledgers,
              (SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL) AS txns`,
    ),
  ]);

  const rows = users
    .map(
      (usr) => `<tr>
  <td><b>${esc(usr.display_name)}</b> <span class="tiny muted">@${esc(usr.username)}</span></td>
  <td>${usr.is_admin ? '<span class="chip primary">站点管理员</span>' : '普通用户'}</td>
  <td><span class="chip ${usr.status === 'active' ? 'income' : 'expense'}">${usr.status === 'active' ? '正常' : '已停用'}</span></td>
  <td class="tiny muted">${esc(usr.last_login_at || '从未登录')}</td>
  <td>${
    Number(usr.id) !== Number(ctx.user!.id)
      ? `<form method="post" action="/admin/users/${usr.id}" style="display:inline">${csrfInput}<input type="hidden" name="action" value="toggle_status"><button class="btn btn-sm" type="submit">${usr.status === 'active' ? '停用' : '启用'}</button></form>
         <form method="post" action="/admin/users/${usr.id}" style="display:inline">${csrfInput}<input type="hidden" name="action" value="toggle_admin"><button class="btn btn-sm" type="submit">${usr.is_admin ? '取消管理' : '设为管理'}</button></form>`
      : '<span class="tiny muted">当前账号</span>'
  }</td>
</tr>`,
    )
    .join('');

  return c.html(
    layout({
      title: '管理面板',
      activeNav: 'admin',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="kpi-grid mb16">
  <div class="stat"><div class="label">注册用户</div><div class="value">${stats?.users || 0}</div></div>
  <div class="stat"><div class="label">账本数量</div><div class="value">${stats?.ledgers || 0}</div></div>
  <div class="stat"><div class="label">有效流水</div><div class="value">${stats?.txns || 0}</div></div>
</div>
<div class="card mb16">
  <div class="card-head"><b>维护任务</b><span class="muted small">自动任务每 4 小时运行一次</span></div>
  <div class="row wrap">
    <form method="post" action="/admin/run-scheduler" style="display:inline">${csrfInput}<button class="btn btn-primary" type="submit">立即执行周期/订阅/提醒任务</button></form>
    <form method="post" action="/admin/cleanup-r2" style="display:inline">${csrfInput}<button class="btn" type="submit">手动扫描并清理孤儿 R2 文件</button></form>
  </div>
</div>
${simpleTable('站点用户管理', ['用户', '权限', '状态', '最近登录', '操作'], rows)}
<div class="card mt16">
  <div class="card-head"><b>新建用户</b><span class="muted small">关闭自助注册时可由管理员直接开设家庭成员账号</span></div>
  <form method="post" action="/admin/users">${csrfInput}
    <div class="grid grid-4">
      <div class="field"><label>用户名</label><input name="username" required placeholder="3–32 位账号"></div>
      <div class="field"><label>显示昵称</label><input name="display_name" placeholder="例如：家人"></div>
      <div class="field"><label>初始密码（≥6 位）</label><input type="password" name="password" required></div>
      <div class="field" style="justify-content:flex-end"><label class="check"><input type="checkbox" name="is_admin" value="1"> 设为站点管理员</label></div>
    </div>
    <button class="btn btn-primary" type="submit">创建用户并初始化账本</button>
  </form>
</div>`,
    }),
  );
});

adminRoutes.post('/admin/users', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const username = String(body.username || '').trim();
  const displayName = String(body.display_name || '').trim() || username;
  const password = String(body.password || '');
  const isAdmin = body.is_admin ? 1 : 0;

  if (!USERNAME_RE.test(username)) {
    setFlash(c, 'error', '用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线');
    return c.redirect('/admin');
  }
  if (password.length < 6) {
    setFlash(c, 'error', '密码长度至少 6 位');
    return c.redirect('/admin');
  }
  if (await db.get('SELECT id FROM users WHERE username = ?', username)) {
    setFlash(c, 'error', '该用户名已被占用');
    return c.redirect('/admin');
  }

  const info = await db.run(
    'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, token_version, created_at) VALUES (?,?,?,?,?,1,?)',
    username,
    await auth.hashPassword(password),
    displayName.slice(0, 30),
    u.colorFor(username),
    isAdmin,
    nowStr(),
  );
  await createDefaultLedger(db, info.lastInsertRowid, displayName);
  setFlash(c, 'success', `用户「${displayName}」已创建，并初始化默认账本`);
  return c.redirect('/admin');
});

adminRoutes.post('/admin/users/:id', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  if (id === Number(c.get('ctx').user!.id)) {
    setFlash(c, 'error', '不可修改当前登录管理员自身状态');
    return c.redirect('/admin');
  }
  const target = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    setFlash(c, 'error', '用户不存在');
    return c.redirect('/admin');
  }
  const body = await bodyOf(c);
  const action = String(body.action || '');
  const stamp = nowStr();

  if (action === 'toggle_status') {
    const nextStatus = target.status === 'active' ? 'disabled' : 'active';
    await db.batch([
      ['UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?', [nextStatus, id]],
      ...(nextStatus === 'disabled'
        ? [['UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [stamp, id]] as [string, unknown[]]]
        : []),
    ]);
    setFlash(c, 'success', `用户已${nextStatus === 'active' ? '启用' : '停用'}`);
  } else if (action === 'toggle_admin') {
    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', target.is_admin ? 0 : 1, id);
    setFlash(c, 'success', '管理员权限已更新');
  } else if (action === 'reset_password') {
    const newPwd = String(body.password || u.uid(12));
    const hash = await auth.hashPassword(newPwd);
    await db.batch([
      ['UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, id]],
      ['UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [stamp, id]],
    ]);
    setFlash(c, 'success', `密码已重置为 ${newPwd}，原有登录已失效`);
  }
  return c.redirect('/admin');
});

adminRoutes.post('/admin/run-scheduler', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const res = await runScheduled(dbOf(c), envOf(c));
  setFlash(
    c,
    'success',
    `定时任务执行完成：周期 ${res.recurring} 笔 · 订阅扣费 ${res.subscriptions.charged} 笔 · 提醒 ${res.budgets + res.debts + res.goals + res.subscriptions.notified} 条`,
  );
  return c.redirect('/admin');
});

adminRoutes.post('/admin/cleanup-r2', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const env = envOf(c);
  if (!env.ATTACHMENTS) {
    setFlash(c, 'warn', '当前环境未挂载 R2 存储桶');
    return c.redirect('/admin');
  }
  const res = await cleanupOrphanR2(dbOf(c), env);
  setFlash(
    c,
    'success',
    `R2 孤儿文件清理完成：移除导入缓存 ${res.deletedImports} 个、孤儿附件 ${res.deletedUploads} 个`,
  );
  return c.redirect('/admin');
});
