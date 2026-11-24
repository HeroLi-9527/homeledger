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
  TXN_TYPE_MAP,
} from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import {
  classifyByKeywords,
  getAiConfig,
  isHeaderSafe,
  isMaskedSecret,
  listModels,
  resolveDefaultAccount,
  testConnection,
} from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import {
  BACKUP_TABLES,
  MAX_BACKUP_BYTES,
  validateAndBuildRestorePlan,
  type TableColumnInfo,
} from '../lib/backup.js';
import { csvLine, EXPORT_HEADER, exportRows, importRecords, parseBill, type ParsedBillRecord } from '../lib/importers.js';
import { cleanupOrphanR2, runScheduled } from '../lib/scheduler.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc } from '../lib/util.js';
import type { AccountRow, BatchStatement, HonoEnv, LedgerRow, Role, UserRow } from '../types.js';
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
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LEDGER_KINDS: Record<string, string> = {
  family: '家庭共享',
  personal: '个人私账',
  trip: '旅行专项',
  business: '生意经营',
  project: '项目专项',
};
const toBoolSetting = (v: unknown): 'true' | 'false' =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 'true' : 'false';

const PREVIEW_TTL_MS = 2 * 3600 * 1000;

const previewCache = new Map<
  string,
  {
    userId: number;
    ledgerId: number;
    source: string;
    fileName: string;
    records: ParsedBillRecord[];
    neutralRecords: ParsedBillRecord[];
    created_at: number;
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
  const user = ctx.user!;
  const body = await bodyOf(c);
  const displayName = String(body.display_name || '').trim().slice(0, 24);
  const email = body.email ? String(body.email).trim().slice(0, 80) : null;
  if (!displayName) {
    setFlash(c, 'error', '显示名称不能为空');
    return c.redirect('/settings');
  }
  let username = user.username;
  if (body.username !== undefined) {
    username = String(body.username || '').trim();
    if (!USERNAME_RE.test(username)) {
      setFlash(c, 'error', '用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线');
      return c.redirect('/settings');
    }
    if (username !== user.username) {
      const dup = await db.get<{ id: number }>('SELECT id FROM users WHERE username = ? AND id != ?', username, user.id);
      if (dup) {
        setFlash(c, 'error', '该用户名已被占用');
        return c.redirect('/settings');
      }
    }
  }
  const colorRaw = String(body.avatar_color || '').trim();
  const avatarColor = HEX_COLOR_RE.test(colorRaw) ? colorRaw.toLowerCase() : user.avatar_color || '#4f7cff';
  await db.run(
    'UPDATE users SET username = ?, display_name = ?, email = ?, avatar_color = ? WHERE id = ?',
    username,
    displayName,
    email,
    avatarColor,
    user.id,
  );
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
  const rawBaseUrl = String(body.base_url ?? '');
  const rawModel = String(body.model ?? '');
  const rawApiKey = String(body.api_key ?? '');
  const clearApiKey = toBoolSetting(body.clear_api_key) === 'true';

  if (!clearApiKey && rawApiKey && !isMaskedSecret(rawApiKey.trim()) && !isHeaderSafe(rawApiKey)) {
    setFlash(c, 'error', 'API Key 含有非法字符（如中文、全角符号或换行），请在「设置 → AI 模型配置」重新粘贴');
    return c.redirect('/settings#ai');
  }
  if (rawBaseUrl && !isHeaderSafe(rawBaseUrl)) {
    setFlash(c, 'error', '接口地址含有非法字符，请检查后重试');
    return c.redirect('/settings#ai');
  }
  if (rawModel && !isHeaderSafe(rawModel)) {
    setFlash(c, 'error', '模型名称含有非法字符，请检查后重试');
    return c.redirect('/settings#ai');
  }

  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '');
  const model = rawModel.trim();
  const apiKey = rawApiKey.trim();

  const rawTimeout = body.timeout_ms ?? body['ai.timeout_ms'];
  let timeoutMsToSave: number | null = null;
  if (rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    const n = Number(String(rawTimeout).trim());
    if (!Number.isFinite(n) || n <= 0) {
      setFlash(c, 'error', '请求超时需为大于 0 的毫秒数（建议 5000–300000）');
      return c.redirect('/settings#ai');
    }
    timeoutMsToSave = Math.max(5000, Math.min(300000, Math.round(n)));
  }

  await setSetting(db, 'ai.base_url', baseUrl);
  await setSetting(db, 'ai.model', model);
  await setSetting(db, 'ai.enabled', toBoolSetting(body.enabled));
  await setSetting(db, 'ai.vision', toBoolSetting(body['ai.vision'] ?? body.vision));
  await setSetting(db, 'ai.auto_save', toBoolSetting(body.auto_save));
  if (timeoutMsToSave !== null) {
    await setSetting(db, 'ai.timeout_ms', String(timeoutMsToSave));
  }
  if (clearApiKey) {
    await setSetting(db, 'ai.api_key', '');
  } else if (apiKey && !isMaskedSecret(apiKey)) {
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
    color: string;
    note: string | null;
    is_archived: number;
    role: string;
    txn_cnt: number;
    member_cnt: number;
    acc_cnt: number;
  }>(
    `SELECT l.id, l.name, l.kind, l.currency, l.icon, l.color, l.note, l.is_archived, m.role,
            (SELECT COUNT(*) FROM transactions t WHERE t.ledger_id = l.id AND t.deleted_at IS NULL) AS txn_cnt,
            (SELECT COUNT(*) FROM ledger_members lm WHERE lm.ledger_id = l.id) AS member_cnt,
            (SELECT COUNT(*) FROM accounts a WHERE a.ledger_id = l.id AND a.is_archived = 0) AS acc_cnt
     FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
     WHERE m.user_id = ? ORDER BY l.is_archived, l.sort_order, l.id`,
    ctx.user!.id,
  );

  const tableRows = rows
    .map(
      (l) => `<tr>
  <td>
    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(l.color || '#4f7cff')};vertical-align:middle"></span>
    ${esc(l.icon)} <b>${esc(l.name)}</b> ${Number(ctx.ledger?.id) === Number(l.id) ? '<span class="chip income">当前</span>' : ''} ${l.is_archived ? '<span class="chip">已归档</span>' : ''}
    ${l.note ? `<div class="tiny muted">${esc(l.note)}</div>` : ''}
  </td>
  <td><span class="chip">${esc(LEDGER_KINDS[l.kind] || l.kind)}</span></td>
  <td>${esc(l.currency)}</td>
  <td class="tiny muted">${Number(l.txn_cnt || 0)} 笔 · ${Number(l.member_cnt || 0)} 人 · ${Number(l.acc_cnt || 0)} 户</td>
  <td>${esc(auth.ROLE_LABEL[l.role as Role] || l.role)}</td>
  <td><div class="row wrap">
    <form method="post" action="/ledgers/switch" style="display:inline">${csrfInput}<input type="hidden" name="ledger_id" value="${l.id}"><button class="btn btn-sm" type="submit">切换</button></form>
    ${auth.canManage(l.role) ? `<a class="btn btn-sm" href="/ledgers/${l.id}/edit">编辑</a>` : ''}
    ${l.role === 'owner' ? `<form method="post" action="/ledgers/${l.id}/archive" style="display:inline">${csrfInput}<button class="btn btn-sm" type="submit">${l.is_archived ? '取消归档' : '归档'}</button></form>` : ''}
  </div></td>
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
  <div>${simpleTable('我的账本', ['账本名称', '类型', '币种', '统计', '我的角色', '操作'], tableRows || '<tr><td colspan="6">暂无账本</td></tr>')}</div>
  <div class="card">
    <div class="card-head"><b>新建账本</b></div>
    <form method="post" action="/ledgers">
      ${csrfInput}
      <div class="field"><label>账本名称</label><input name="name" required placeholder="例如：家庭共同账本"></div>
      <div class="grid grid-2">
        <div class="field"><label>类型</label><select name="kind">${Object.entries(LEDGER_KINDS).map(([k, lbl]) => `<option value="${k}">${lbl}</option>`).join('')}</select></div>
        <div class="field"><label>本位币</label><input name="currency" value="${esc(meta.baseCurrency)}"></div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>图标</label><input name="icon" value="📒"></div>
        <div class="field"><label>标识颜色</label><input name="color" type="color" value="#4f7cff" style="height:38px;padding:2px"></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" maxlength="200" placeholder="账本用途或说明"></div>
      <label class="check mb12"><input type="checkbox" name="skip_default_accounts" value="1"> 跳过初始化默认账户（稍后自行添加）</label>
      <button class="btn btn-primary btn-block" type="submit">创建账本</button>
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
  const kind = body.kind && LEDGER_KINDS[String(body.kind)] ? String(body.kind) : 'family';
  const icon = String(body.icon || '📒').slice(0, 8) || '📒';
  const colorRaw = String(body.color || '').trim();
  const color = HEX_COLOR_RE.test(colorRaw) ? colorRaw.toLowerCase() : '#4f7cff';
  const note = String(body.note || '').trim().slice(0, 200) || null;
  const skipDefaults = toBoolSetting(body.skip_default_accounts) === 'true';

  const res = await db.run(
    'INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    name,
    kind,
    currency,
    icon,
    color,
    ctx.user!.id,
    note,
    nowStr(),
  );
  const ledgerId = Number(res.lastInsertRowid);
  await addLedgerMember(db, ledgerId, ctx.user!.id, 'owner');
  if (!skipDefaults) {
    await createDefaultAccounts(db, ledgerId, currency);
  }

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

adminRoutes.get('/ledgers/:id/edit', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const id = Number(c.req.param('id'));
  const m = await auth.membership(db, ctx.user!.id, id);
  const ledger = await db.get<LedgerRow>('SELECT * FROM ledgers WHERE id = ?', id);
  if (!ledger || !m || !auth.canManage(m.role)) {
    setFlash(c, 'error', '无权编辑该账本');
    return c.redirect('/ledgers');
  }
  const csrf = c.get('csrf') || '';
  const csrfInput = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

  return c.html(
    layout({
      title: `编辑账本 · ${ledger.name}`,
      activeNav: 'ledgers',
      ctx,
      siteName: meta.siteName,
      csrf,
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="grid grid-2">
  <div class="card">
    <div class="card-head"><b>编辑账本信息</b><a class="btn btn-sm" href="/ledgers">← 返回账本列表</a></div>
    <form method="post" action="/ledgers/${ledger.id}">
      ${csrfInput}
      <div class="field"><label>账本名称</label><input name="name" value="${esc(ledger.name)}" maxlength="30" required></div>
      <div class="grid grid-2">
        <div class="field"><label>类型</label><select name="kind">${Object.entries(LEDGER_KINDS).map(([k, lbl]) => `<option value="${k}" ${ledger.kind === k ? 'selected' : ''}>${lbl}</option>`).join('')}</select></div>
        <div class="field"><label>本位币（创建后不可改）</label><input value="${esc(ledger.currency)}" disabled></div>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>图标</label><input name="icon" value="${esc(ledger.icon || '📒')}" maxlength="8"></div>
        <div class="field"><label>标识颜色</label><input name="color" type="color" value="${esc(ledger.color || '#4f7cff')}" style="height:38px;padding:2px"></div>
      </div>
      <div class="field"><label>备注（可选）</label><input name="note" value="${esc(ledger.note || '')}" maxlength="200"></div>
      <button class="btn btn-primary" type="submit">保存账本信息</button>
    </form>
  </div>
  ${
    m.role === 'owner'
      ? `<div class="card">
    <div class="card-head"><b>危险操作：永久删除账本</b><span class="chip expense">不可恢复</span></div>
    <div class="notice warn mb12">删除账本将永久清空该账本下的全部流水、账户、预算、周期账单、订阅、借贷、储蓄目标、次卡、通知、R2 附件及绑定在该账本的 API 令牌。</div>
    <form method="post" action="/ledgers/${ledger.id}/delete" data-confirm="确认永久删除账本「${esc(ledger.name)}」及全部数据？">
      ${csrfInput}
      <div class="field"><label>请输入账本名称「${esc(ledger.name)}」以确认删除</label><input name="confirm_name" placeholder="${esc(ledger.name)}" required></div>
      <button class="btn btn-danger btn-block" type="submit">确认永久删除该账本</button>
    </form>
  </div>`
      : `<div class="card"><div class="card-head"><b>删除账本</b></div><div class="empty">仅账本所有者（owner）可执行永久删除操作。</div></div>`
  }
</div>`,
    }),
  );
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
  const ledger = await db.get<LedgerRow>('SELECT * FROM ledgers WHERE id = ?', id);
  if (!ledger) {
    setFlash(c, 'error', '账本不存在');
    return c.redirect('/ledgers');
  }
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) {
    setFlash(c, 'error', '账本名称不能为空');
    return c.redirect(`/ledgers/${id}/edit`);
  }
  const icon = body.icon !== undefined && String(body.icon).trim() ? String(body.icon).trim().slice(0, 8) : ledger.icon;
  const kind =
    body.kind !== undefined && LEDGER_KINDS[String(body.kind)]
      ? String(body.kind)
      : ledger.kind;
  const colorRaw = String(body.color || '').trim();
  const color = body.color !== undefined && HEX_COLOR_RE.test(colorRaw) ? colorRaw.toLowerCase() : ledger.color || '#4f7cff';
  const note = body.note !== undefined ? String(body.note).trim().slice(0, 200) || null : ledger.note;
  await db.run(
    'UPDATE ledgers SET name = ?, icon = ?, kind = ?, color = ?, note = ? WHERE id = ?',
    name,
    icon,
    kind,
    color,
    note,
    id,
  );
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
  const env = envOf(c);
  const ctx = c.get('ctx');
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const isJson = body._json === '1' || wantsJson(c);

  const m = await auth.membership(db, ctx.user!.id, id);
  if (!m || m.role !== 'owner') {
    if (isJson) return c.json({ ok: false, error: '仅账本所有者可删除' }, 403);
    setFlash(c, 'error', '仅账本所有者可删除');
    return c.redirect('/ledgers');
  }
  const ledger = await db.get<LedgerRow>('SELECT * FROM ledgers WHERE id = ?', id);
  if (!ledger) {
    if (isJson) return c.json({ ok: false, error: '账本不存在' }, 404);
    setFlash(c, 'error', '账本不存在');
    return c.redirect('/ledgers');
  }
  const confirmName = String(body.confirm_name || '').trim();
  if (confirmName !== ledger.name) {
    if (isJson) return c.json({ ok: false, error: '账本名称确认不匹配' }, 400);
    setFlash(c, 'error', '输入的账本名称不匹配，已取消删除');
    return c.redirect(`/ledgers/${id}/edit`);
  }

  const [attRows, jobRows] = await Promise.all([
    db.all<{ rel_path: string }>('SELECT rel_path FROM attachments WHERE ledger_id = ?', id),
    db.all<{ id: number }>('SELECT id FROM import_jobs WHERE ledger_id = ? AND failed > 10', id),
  ]);
  const r2Keys = [
    ...attRows.map((a) => a.rel_path),
    ...jobRows.map((j) => `imports/failures-${j.id}.json`),
  ];

  const stamp = nowStr();
  const stmts: BatchStatement[] = [
    [
      'DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE ledger_id = ?) OR tag_id IN (SELECT id FROM tags WHERE ledger_id = ?)',
      [id, id],
    ],
    ['DELETE FROM splits WHERE ledger_id = ?', [id]],
    ['DELETE FROM attachments WHERE ledger_id = ?', [id]],
    ['DELETE FROM session_card_logs WHERE ledger_id = ?', [id]],
    ['DELETE FROM session_cards WHERE ledger_id = ?', [id]],
    ['DELETE FROM transactions WHERE ledger_id = ?', [id]],
    ['DELETE FROM tags WHERE ledger_id = ?', [id]],
    ['DELETE FROM categories WHERE ledger_id = ?', [id]],
    ['DELETE FROM budgets WHERE ledger_id = ?', [id]],
    ['DELETE FROM recurring_rules WHERE ledger_id = ?', [id]],
    ['DELETE FROM goals WHERE ledger_id = ?', [id]],
    ['DELETE FROM subscriptions WHERE ledger_id = ?', [id]],
    ['DELETE FROM debts WHERE ledger_id = ?', [id]],
    ['DELETE FROM notifications WHERE ledger_id = ?', [id]],
    ['DELETE FROM import_jobs WHERE ledger_id = ?', [id]],
    ['DELETE FROM accounts WHERE ledger_id = ?', [id]],
    ['DELETE FROM ledger_invites WHERE ledger_id = ?', [id]],
    ['DELETE FROM ledger_members WHERE ledger_id = ?', [id]],
    ['UPDATE api_tokens SET revoked_at = ? WHERE ledger_id = ? AND revoked_at IS NULL', [stamp, id]],
    ['DELETE FROM ledgers WHERE id = ?', [id]],
  ];
  await db.batch(stmts);

  if (r2Keys.length) {
    await attach.deleteKeysFromR2(env, r2Keys);
  }

  if (Number(ctx.ledger?.id) === id) {
    const nextLedger = await db.get<{ id: number }>(
      `SELECT l.id FROM ledgers l JOIN ledger_members lm ON lm.ledger_id = l.id
       WHERE lm.user_id = ? AND l.is_archived = 0 ORDER BY l.sort_order, l.id LIMIT 1`,
      ctx.user!.id,
    );
    const sess = c.get('sess');
    if (sess) {
      const token = await auth.signSession(
        auth.createSessionPayload(sess.uid, nextLedger ? Number(nextLedger.id) : null, sess.tv, sess.csrf),
        getSessionSecret(env),
      );
      c.header('Set-Cookie', auth.sessionCookie(token, env), { append: true });
    }
  }

  if (isJson) return c.json({ ok: true });
  setFlash(c, 'success', `账本「${ledger.name}」及相关数据已永久删除`);
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
  const curMonth = todayStr().slice(0, 7);
  const [rawMembers, invites, mStats] = await Promise.all([
    db.all<{ id: number; user_id: number; role: string; nickname: string | null; username: string; display_name: string; joined_at: string }>(
      `SELECT m.id, m.user_id, m.role, m.nickname, m.joined_at, u.username, u.display_name
       FROM ledger_members m JOIN users u ON u.id = m.user_id
       WHERE m.ledger_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.id`,
      ledgerId,
    ),
    db.all<{ id: number; code: string; role: string; expires_at: string | null }>(
      'SELECT id, code, role, expires_at FROM ledger_invites WHERE ledger_id = ? AND used_by IS NULL ORDER BY id DESC',
      ledgerId,
    ),
    txn.memberBreakdown(db, ledgerId, `${curMonth}-01`, u.monthEnd(curMonth)),
  ]);
  const statMap = new Map(mStats.map((s) => [Number(s.id), s]));
  const members = rawMembers.map((m) => {
    const st = statMap.get(Number(m.user_id));
    return {
      ...m,
      month_cnt: st?.cnt ?? 0,
      month_expense: st?.expense ?? 0,
      month_income: st?.income ?? 0,
    };
  });
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

adminRoutes.post('/members/:id/nickname', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const mid = Number(c.req.param('id'));
  const target = await db.get<{ id: number; user_id: number }>(
    'SELECT id, user_id FROM ledger_members WHERE id = ? AND ledger_id = ?',
    mid,
    ledgerId,
  );
  if (!target) {
    setFlash(c, 'error', '成员不存在');
    return c.redirect('/members');
  }
  if (Number(target.user_id) !== Number(ctx.user!.id) && !auth.canManage(ctx.ledger!.role)) {
    setFlash(c, 'error', '无权修改该成员账本昵称');
    return c.redirect('/members');
  }
  const body = await bodyOf(c);
  const nickname = String(body.nickname || '').trim().slice(0, 24) || null;
  await db.run('UPDATE ledger_members SET nickname = ? WHERE id = ? AND ledger_id = ?', nickname, mid, ledgerId);
  setFlash(c, 'success', nickname ? `账本昵称已更新为「${nickname}」` : '账本昵称已清空');
  return c.redirect('/members');
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

  const ledgerId = Number(ctx.ledger.id);
  const [jobs, accounts] = await Promise.all([
    db.all<{
      id: number;
      source: string;
      file_name: string | null;
      total: number;
      imported: number;
      skipped: number;
      failed: number;
      message: string | null;
      created_at: string;
    }>('SELECT * FROM import_jobs WHERE ledger_id = ? ORDER BY id DESC LIMIT 15', ledgerId),
    fd.accounts(db, ledgerId),
  ]);

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
  <div class="field mb12">
    <label for="imp-default-acc">默认入账账户（账单支付方式缺失或关闭自动建户时使用）</label>
    <select id="imp-default-acc" name="default_account_id">${accountOptionsHtml(accounts, { emptyLabel: '自动按名称匹配或建户（否则用默认账户）' })}</select>
  </div>
  <details class="notice mb12">
    <summary class="bold" style="cursor:pointer">📖 如何从支付宝 / 微信导出账单 CSV？</summary>
    <div class="small mt8">
      <div><b>支付宝：</b>打开支付宝 App → 我的 → 账单 → 右上角「…」→ 开具交易流水证明 → 用于个人对账 → 选择时间范围后下载解压得到的 <code>.csv</code> 文件。</div>
      <div class="mt4"><b>微信：</b>打开微信 → 我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账 → 选择时间范围，通过邮箱/微信文件传输接收并解压得到 <code>.csv</code> 文件（微信新版部分导出为 <code>.xlsx</code>，需在电子表格软件中另存为 CSV 后上传）。</div>
    </div>
  </details>
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
      created_at: Date.now(),
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

    const decorateSample = (rec: ParsedBillRecord) => ({
      ...rec,
      type_label: rec.type === 'income' ? '收入' : rec.type === 'transfer' ? '转账' : '支出',
      guess_category:
        rec.category_hint ||
        classifyByKeywords(rec.text)?.category ||
        (rec.type === 'transfer' ? '转账' : rec.type === 'income' ? '其他收入' : '其他支出'),
      guess_account: rec.account_hint || null,
      guess_account_missing: !rec.account_hint,
    });

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
      skippedDates: parsed.skippedDates,
      stat: { expense, income, transfer, minDate, maxDate },
      sample: parsed.records.slice(0, 60).map(decorateSample),
      neutralSample: parsed.neutralRecords.slice(0, 5).map(decorateSample),
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
  if (!payload.created_at || Date.now() - Number(payload.created_at) > PREVIEW_TTL_MS) {
    previewCache.delete(token);
    if (env.ATTACHMENTS) await env.ATTACHMENTS.delete(r2Key).catch(() => {});
    return c.json({ ok: false, error: '导入预览已过期（超过 2 小时），请重新上传文件预览' }, 400);
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

const EXPORT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseExportFilter(q: Record<string, string | undefined>): txn.TxnFilter {
  const validDay = (s: string) => {
    if (!EXPORT_DAY_RE.test(s)) return '';
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
  };
  let from = validDay(String(q.from || '').trim());
  let to = validDay(String(q.to || '').trim());
  if (from && to && from > to) [from, to] = [to, from];
  const type = q.type && TXN_TYPE_MAP[q.type] ? q.type : undefined;
  const kind = q.kind === 'expense' || q.kind === 'income' ? q.kind : undefined;
  const accNum = Number(q.account_id);
  const accountId = Number.isInteger(accNum) && accNum > 0 ? accNum : undefined;
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(type ? { type } : {}),
    ...(kind ? { kind } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

adminRoutes.get('/export', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const csrf = c.get('csrf') || '';
  const ledgerId = Number(ctx.ledger!.id);
  const accounts = await db.all<AccountRow>(
    'SELECT * FROM accounts WHERE ledger_id = ? ORDER BY is_archived, sort_order, id',
    ledgerId,
  );
  const typeOptions = Object.entries(TXN_TYPE_MAP)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
    .join('');
  const accOptions = accountOptionsHtml(accounts, { emptyLabel: '全部账户' });

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
    <p class="muted small mb12">支持按起止日期、交易类型、账户筛选导出未删除流水，带 UTF-8 BOM，可直接用 Excel 或 WPS 打开。</p>
    <form method="get" action="/export/csv">
      <div class="grid grid-2">
        <div class="field"><label>开始日期（可选）</label><input type="date" name="from"></div>
        <div class="field"><label>结束日期（可选）</label><input type="date" name="to"></div>
        <div class="field"><label>交易类型</label><select name="type"><option value="">全部类型</option>${typeOptions}</select></div>
        <div class="field"><label>账户</label><select name="account_id">${accOptions}</select></div>
      </div>
      <div class="row wrap mt8">
        <button class="btn btn-primary" type="submit">下载筛选 CSV</button>
        <a class="btn" href="/export/csv">导出全部 CSV</a>
      </div>
    </form>
  </div>
  <div class="card">
    <div class="card-head"><b>导出当前账本结构化 JSON</b><span class="chip">成员可用</span></div>
    <p class="muted small mb12">导出当前账本（${esc(ctx.ledger!.name)}）的账户、分类、标签、预算、周期账单、订阅、借贷、储蓄目标、次卡与流水明细（支持按条件筛选流水）。</p>
    <form method="get" action="/export/ledger.json">
      <div class="grid grid-2">
        <div class="field"><label>流水开始日期</label><input type="date" name="from"></div>
        <div class="field"><label>流水结束日期</label><input type="date" name="to"></div>
        <div class="field"><label>交易类型</label><select name="type"><option value="">全部类型</option>${typeOptions}</select></div>
        <div class="field"><label>账户</label><select name="account_id">${accOptions}</select></div>
      </div>
      <div class="row wrap mt8">
        <button class="btn btn-primary" type="submit">下载当前账本 JSON</button>
        <a class="btn" href="/export/ledger.json">全量账本 JSON</a>
      </div>
    </form>
  </div>
</div>
<div class="card mt16">
  <div class="card-head"><b>整库 JSON 备份与恢复（站点管理员）</b></div>
  <p class="muted small mb12">${ctx.isAdmin ? '管理员可导出全库（含所有用户与账本）JSON 快照并在必要时覆盖恢复。' : '仅站点管理员可执行全库级 JSON 备份与恢复；普通账本成员请使用上方「导出当前账本结构化 JSON」。'}</p>
  ${ctx.isAdmin ? `<div class="row wrap"><a class="btn btn-primary" href="/export/json">下载全库 JSON 备份</a><label class="btn" style="cursor:pointer">从 JSON 恢复<input type="file" id="restore-file" accept=".json,application/json" class="hidden"></label></div>` : ''}
</div>`,
    }),
  );
});

adminRoutes.get('/export/csv', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const filter = parseExportFilter(c.req.query());
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(`\uFEFF${csvLine(EXPORT_HEADER)}`));
        for await (const batch of txn.iterateAllForExport(db, ledgerId, 1000, filter)) {
          const rows = exportRows(ledgerId, batch);
          let chunk = '';
          for (const row of rows) chunk += csvLine(row);
          if (chunk) controller.enqueue(enc.encode(chunk));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  const suffix = filter.from || filter.to ? `-${filter.from || 'start'}_${filter.to || 'end'}` : `-${todayStr()}`;
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="homeledger${suffix}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

adminRoutes.get('/export/ledger.json', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const ledgerId = Number(ctx.ledger!.id);
  const filter = parseExportFilter(c.req.query());
  const [
    ledger,
    accounts,
    categories,
    tags,
    budgets,
    recurring_rules,
    subscriptions,
    debts,
    goals,
    session_cards,
    session_card_logs,
    transactions,
  ] = await Promise.all([
    db.get('SELECT id, name, kind, currency, icon, color, note, is_archived, created_at FROM ledgers WHERE id = ?', ledgerId),
    db.all('SELECT * FROM accounts WHERE ledger_id = ? ORDER BY sort_order, id', ledgerId),
    db.all(
      'SELECT * FROM categories WHERE ledger_id IS NULL OR ledger_id = ? ORDER BY kind, sort_order, id',
      ledgerId,
    ),
    db.all('SELECT * FROM tags WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM budgets WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM recurring_rules WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM subscriptions WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM debts WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM goals WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM session_cards WHERE ledger_id = ? ORDER BY id', ledgerId),
    db.all('SELECT * FROM session_card_logs WHERE ledger_id = ? ORDER BY id', ledgerId),
    txn.listAllForExport(db, ledgerId, 1000, filter),
  ]);

  const payload = JSON.stringify(
    {
      app: 'homeledger',
      scope: 'ledger',
      exported_at: nowStr(),
      ledger_id: ledgerId,
      filter,
      ledger,
      accounts,
      categories,
      tags,
      budgets,
      recurring_rules,
      subscriptions,
      debts,
      goals,
      session_cards,
      session_card_logs,
      transactions,
      total_transactions: transactions.length,
    },
    null,
    2,
  );
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="homeledger-ledger-${ledgerId}-${todayStr()}.json"`);
  c.header('Cache-Control', 'no-store');
  return c.body(payload);
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
  const env = envOf(c);
  const body = await bodyOf(c);

  try {
    let rawJson = '';
    if (body.dataUrl) {
      const bytes = parseBase64Payload(String(body.dataUrl));
      if (bytes.byteLength > MAX_BACKUP_BYTES) {
        return c.json({ ok: false, error: '备份文件过大（请小于 20MB）' }, 400);
      }
      rawJson = new TextDecoder('utf-8').decode(bytes);
    } else if (body.backup) {
      rawJson = typeof body.backup === 'string' ? body.backup : JSON.stringify(body.backup);
      if (Buffer.byteLength(rawJson, 'utf8') > MAX_BACKUP_BYTES) {
        return c.json({ ok: false, error: '备份内容过大（请小于 20MB）' }, 400);
      }
    }
    if (!rawJson) return c.json({ ok: false, error: '未提供备份 JSON 内容' }, 400);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return c.json({ ok: false, error: '备份文件不是合法的 JSON 格式' }, 400);
    }

    const schema = new Map<string, TableColumnInfo[]>();
    for (const tbl of BACKUP_TABLES) {
      const info = await db.all<TableColumnInfo>(`PRAGMA table_info(${tbl})`);
      schema.set(tbl, info);
    }

    const { stmts, counts } = validateAndBuildRestorePlan(parsed, schema);
    await db.batch(stmts);

    const ledgers = await db.all<{ id: number }>('SELECT id FROM ledgers');
    for (const l of ledgers) await recalcBalances(db, Number(l.id));

    c.header('Set-Cookie', auth.clearSessionCookie(env), { append: true });
    c.header('Cache-Control', 'no-store');
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

  const activeReceivers = users.filter((x) => x.status === 'active');
  const rows = users
    .map((usr) => {
      const receiverOpts = activeReceivers
        .filter((x) => Number(x.id) !== Number(usr.id))
        .map(
          (x) =>
            `<option value="${x.id}" ${Number(x.id) === Number(ctx.user!.id) ? 'selected' : ''}>转交→${esc(x.display_name)}(@${esc(x.username)})</option>`,
        )
        .join('');
      return `<tr>
  <td><b>${esc(usr.display_name)}</b> <span class="tiny muted">@${esc(usr.username)}</span></td>
  <td>${usr.is_admin ? '<span class="chip primary">站点管理员</span>' : '普通用户'}</td>
  <td><span class="chip ${usr.status === 'active' ? 'income' : 'expense'}">${usr.status === 'active' ? '正常' : '已停用'}</span></td>
  <td class="tiny muted">${esc(usr.last_login_at || '从未登录')}</td>
  <td>${
    Number(usr.id) !== Number(ctx.user!.id)
      ? `<div class="row wrap">
         <form method="post" action="/admin/users/${usr.id}" style="display:inline">${csrfInput}<input type="hidden" name="action" value="toggle_status"><button class="btn btn-sm" type="submit">${usr.status === 'active' ? '停用' : '启用'}</button></form>
         <form method="post" action="/admin/users/${usr.id}" style="display:inline">${csrfInput}<input type="hidden" name="action" value="toggle_admin"><button class="btn btn-sm" type="submit">${usr.is_admin ? '取消管理' : '设为管理'}</button></form>
         <form method="post" action="/admin/users/${usr.id}" style="display:inline-flex;gap:4px;align-items:center" data-confirm="确认重置 @${esc(usr.username)} 的密码并令其全部登录失效？">${csrfInput}<input type="hidden" name="action" value="reset_password"><input type="password" name="password" placeholder="新密码(留空随机)" minlength="6" style="width:130px;padding:3px 7px;font-size:12px"><button class="btn btn-sm btn-danger" type="submit">重置密码</button></form>
         ${receiverOpts ? `<form method="post" action="/admin/users/${usr.id}" style="display:inline-flex;gap:4px;align-items:center" data-confirm="确认永久删除 @${esc(usr.username)} 并将其拥有的账本及记账流水转交给所选用户？">${csrfInput}<input type="hidden" name="action" value="delete_user"><select name="transfer_to_user_id" style="width:auto;padding:3px 6px;font-size:12px">${receiverOpts}</select><button class="btn btn-sm btn-danger" type="submit">删除并转交</button></form>` : ''}
         </div>`
      : '<span class="tiny muted">当前账号</span>'
  }</td>
</tr>`;
    })
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

async function deleteUserAndTransfer(
  db: ReturnType<typeof dbOf>,
  env: ReturnType<typeof envOf>,
  target: UserRow,
  rawTransferTo: unknown,
): Promise<{ ok: true; receiverUsername: string; avatarCleanupFailed: boolean } | { ok: false; error: string }> {
  const id = Number(target.id);
  const transferToId = Number(rawTransferTo || 0);
  if (!Number.isInteger(transferToId) || transferToId <= 0 || transferToId === id) {
    return { ok: false, error: '请选择除被删除用户外的有效接收人' };
  }
  const receiver = await db.get<{ id: number; username: string; status: string }>(
    'SELECT id, username, status FROM users WHERE id = ?',
    transferToId,
  );
  if (!receiver || receiver.status !== 'active') {
    return { ok: false, error: '转交接收人不存在或已被停用' };
  }
  const stamp = nowStr();
  await db.batch([
    [
      'UPDATE ledger_members SET role = ? WHERE user_id = ? AND ledger_id IN (SELECT id FROM ledgers WHERE owner_id = ?)',
      ['owner', transferToId, id],
    ],
    [
      'INSERT OR IGNORE INTO ledger_members (ledger_id, user_id, role, joined_at) SELECT id, ?, ?, ? FROM ledgers WHERE owner_id = ?',
      [transferToId, 'owner', stamp, id],
    ],
    ['UPDATE ledgers SET owner_id = ? WHERE owner_id = ?', [transferToId, id]],
    ['UPDATE transactions SET user_id = ? WHERE user_id = ?', [transferToId, id]],
    ['UPDATE attachments SET user_id = ? WHERE user_id = ?', [transferToId, id]],
    ['UPDATE session_card_logs SET user_id = ? WHERE user_id = ?', [transferToId, id]],
    ['UPDATE import_jobs SET user_id = ? WHERE user_id = ?', [transferToId, id]],
    ['UPDATE recurring_rules SET created_by_user_id = ? WHERE created_by_user_id = ?', [transferToId, id]],
    ['UPDATE subscriptions SET created_by_user_id = ? WHERE created_by_user_id = ?', [transferToId, id]],
    ['UPDATE ledger_invites SET created_by = ? WHERE created_by = ?', [transferToId, id]],
    ['UPDATE ledger_invites SET used_by = NULL WHERE used_by = ?', [id]],
    ['UPDATE splits SET user_id = NULL WHERE user_id = ?', [id]],
    ['DELETE FROM ledger_members WHERE user_id = ?', [id]],
    ['DELETE FROM api_tokens WHERE user_id = ?', [id]],
    ['DELETE FROM notifications WHERE user_id = ?', [id]],
    ['DELETE FROM users WHERE id = ?', [id]],
  ]);
  let avatarCleanupFailed = false;
  if (target.avatar_path) {
    try {
      await attach.removeAvatar(env, target.avatar_path, { throwOnError: true });
    } catch (e) {
      avatarCleanupFailed = true;
      console.error('removeAvatar failed after delete user', id, e);
    }
  }
  return { ok: true, receiverUsername: receiver.username, avatarCleanupFailed };
}

adminRoutes.post('/admin/users/:id/delete', async (c) => {
  const r = requireAdmin(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  if (id === Number(c.get('ctx').user!.id)) {
    setFlash(c, 'error', '不可删除当前登录管理员自身账号');
    return c.redirect('/admin');
  }
  const target = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!target) {
    setFlash(c, 'error', '用户不存在');
    return c.redirect('/admin');
  }
  const body = await bodyOf(c);
  const res = await deleteUserAndTransfer(db, envOf(c), target, body.transfer_to_user_id);
  if (!res.ok) setFlash(c, 'error', res.error);
  else if (res.avatarCleanupFailed) {
    setFlash(
      c,
      'warn',
      `用户 @${target.username} 已删除并将账本转交给 @${res.receiverUsername}，但 R2 头像清理失败，请稍后运行「手动清理 R2 孤儿附件」`,
    );
  } else {
    setFlash(c, 'success', `用户 @${target.username} 已删除，其账本与记录已转交给 @${res.receiverUsername}`);
  }
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
  } else if (action === 'delete_user') {
    const res = await deleteUserAndTransfer(db, envOf(c), target, body.transfer_to_user_id);
    if (!res.ok) setFlash(c, 'error', res.error);
    else if (res.avatarCleanupFailed) {
      setFlash(
        c,
        'warn',
        `用户 @${target.username} 已删除并将账本转交给 @${res.receiverUsername}，但 R2 头像清理失败，请稍后运行「手动清理 R2 孤儿附件」`,
      );
    } else {
      setFlash(c, 'success', `用户 @${target.username} 已删除，其账本与记录已转交给 @${res.receiverUsername}`);
    }
  } else if (action === 'reset_password') {
    const rawPwd = String(body.password || '').trim();
    if (rawPwd && rawPwd.length < 6) {
      if (body._json === '1' || wantsJson(c)) return c.json({ ok: false, error: '自定义新密码长度至少 6 位' }, 400);
      setFlash(c, 'error', '自定义新密码长度至少 6 位');
      return c.redirect('/admin');
    }
    const newPwd = rawPwd || u.uid(12);
    const hash = await auth.hashPassword(newPwd);
    await db.batch([
      ['UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, id]],
      ['UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [stamp, id]],
    ]);
    c.header('Cache-Control', 'no-store');
    if (body._json === '1' || wantsJson(c)) {
      return c.json({ ok: true, user_id: id, username: target.username, password: newPwd });
    }
    const meta = await siteMeta(c);
    return c.html(
      layout({
        title: '用户密码已重置',
        activeNav: 'admin',
        ctx: c.get('ctx'),
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: `<div class="card">
  <div class="card-head"><b>用户密码重置成功</b><span class="chip income">仅此一次展示</span></div>
  <p class="muted small mb12">已重置用户 <b>${esc(target.display_name)}</b>（@${esc(target.username)}）的登录密码，其全部旧会话与 API 令牌已立即失效。请立即复制并转交本人：</p>
  <div class="notice mb16"><code>${esc(newPwd)}</code></div>
  <a class="btn btn-primary" href="/admin">返回管理面板</a>
</div>`,
      }),
    );
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
