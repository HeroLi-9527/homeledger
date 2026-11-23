import { Hono } from 'hono';
import { addLedgerMember, createDefaultLedger, nowStr, todayStr } from '../db.js';
import * as auth from '../lib/auth.js';
import { colorFor, esc } from '../lib/util.js';
import type { HonoEnv, Role, UserRow } from '../types.js';
import { loginPage, registerPage, setupPage, joinRegisterPage } from '../views/auth.js';
import { blank, layout } from '../views/layout.js';
import {
  bodyOf,
  dbOf,
  envOf,
  getSessionSecret,
  requireLogin,
  setFlash,
  siteMeta,
  takeFlash,
} from './helpers.js';

const USERNAME_RE = /^[A-Za-z0-9_.@-]{3,32}$/;
const INVITE_ROLES: Role[] = ['viewer', 'member', 'admin'];

function safeNext(next: unknown): string {
  if (!next || typeof next !== 'string') return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function safeInviteRole(role: unknown): Role {
  return INVITE_ROLES.includes(role as Role) ? (role as Role) : 'member';
}

export const authRoutes = new Hono<HonoEnv>();

authRoutes.get('/login', async (c) => {
  if (c.get('ctx')?.user) return c.redirect('/');
  const db = dbOf(c);
  const hasUser = Number((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users'))?.c || 0) > 0;
  if (!hasUser) return c.redirect('/setup');
  const meta = await siteMeta(c);
  const notices: Record<string, string> = {
    password_changed: '密码已修改，全部 API 令牌已吊销，请重新登录',
    restored: '备份已恢复，请重新登录',
  };
  const noticeMsg = notices[c.req.query('notice') || ''];
  const flash = noticeMsg ? ({ type: 'success', message: noticeMsg } as const) : takeFlash(c);
  return c.html(
    blank({
      title: '登录',
      siteName: meta.siteName,
      cspNonce: c.get('cspNonce'),
      flash,
      body: loginPage({
        csrf: c.get('csrf') || '',
        allowRegister: meta.allowRegister,
        next: safeNext(c.req.query('next')),
      }),
    }),
  );
});

authRoutes.post('/login', async (c) => {
  const db = dbOf(c);
  const body = await bodyOf(c);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const next = safeNext(body.next);
  const meta = await siteMeta(c);

  const fail = (error: string, status: 401 | 400 = 401) =>
    c.html(
      blank({
        title: '登录',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: loginPage({ error, csrf: '', allowRegister: meta.allowRegister, next }),
      }),
      status,
    );

  const user = await db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  const ok = user && user.status === 'active' && (await auth.verifyPassword(password, user.password_hash));
  if (!ok) {
    if (!user || user.status !== 'active') await auth.verifyPassword(password, auth.DUMMY_PASSWORD_HASH);
    return fail('用户名或密码不正确。');
  }

  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowStr(), user.id);
  const m = await db.get<{ ledger_id: number }>(
    'SELECT ledger_id FROM ledger_members WHERE user_id = ? ORDER BY id LIMIT 1',
    user.id,
  );
  const payload = auth.createSessionPayload(
    Number(user.id),
    m ? Number(m.ledger_id) : null,
    Number(user.token_version) || 1,
  );
  const token = await auth.signSession(payload, getSessionSecret(envOf(c)));
  c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  return c.redirect(next);
});

authRoutes.post('/logout', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  c.header('Set-Cookie', auth.clearSessionCookie(envOf(c)), { append: true });
  return c.redirect('/login');
});

authRoutes.get('/register', async (c) => {
  if (c.get('ctx')?.user) return c.redirect('/');
  const meta = await siteMeta(c);
  if (!meta.allowRegister) {
    return c.html(
      blank({
        title: '登录',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: loginPage({
          error: '本站未开放自助注册，请联系管理员邀请你加入账本。',
          csrf: '',
          allowRegister: false,
        }),
      }),
    );
  }
  return c.html(
    blank({
      title: '注册',
      siteName: meta.siteName,
      cspNonce: c.get('cspNonce'),
      body: registerPage({ csrf: '' }),
    }),
  );
});

authRoutes.post('/register', async (c) => {
  const db = dbOf(c);
  const body = await bodyOf(c);
  const meta = await siteMeta(c);
  if (!meta.allowRegister) {
    return c.html(
      blank({
        title: '注册已关闭',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: '<p>本站未开放自助注册。</p>',
      }),
      403,
    );
  }
  const username = String(body.username || '').trim();
  const displayName = String(body.display_name || '').trim() || username;
  const password = String(body.password || '');
  const password2 = String(body.password2 || '');
  const email = String(body.email || '').trim() || null;

  const fail = (error: string) =>
    c.html(
      blank({
        title: '注册',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: registerPage({ csrf: '', form: { username, display_name: displayName, email }, error }),
      }),
      400,
    );

  if (!USERNAME_RE.test(username)) return fail('用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线。');
  if (password.length < 6) return fail('密码至少 6 位。');
  if (password !== password2) return fail('两次输入的密码不一致。');
  if (await db.get('SELECT id FROM users WHERE username = ?', username)) return fail('该用户名已被占用。');

  const info = await db.run(
    'INSERT INTO users (username, email, password_hash, display_name, avatar_color, is_admin, token_version, created_at) VALUES (?,?,?,?,?,0,1,?)',
    username,
    email,
    await auth.hashPassword(password),
    displayName.slice(0, 30),
    colorFor(username),
    nowStr(),
  );
  const ledgerId = await createDefaultLedger(db, info.lastInsertRowid, displayName);
  const payload = auth.createSessionPayload(info.lastInsertRowid, ledgerId, 1);
  const token = await auth.signSession(payload, getSessionSecret(envOf(c)));
  c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  setFlash(c, 'success', '注册成功，已为你创建默认账本与账户。');
  return c.redirect('/');
});

authRoutes.get('/setup', async (c) => {
  const db = dbOf(c);
  const hasUser = Number((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users'))?.c || 0) > 0;
  if (hasUser) return c.redirect('/login');
  const meta = await siteMeta(c);
  return c.html(
    blank({
      title: '初始化',
      siteName: meta.siteName,
      cspNonce: c.get('cspNonce'),
      body: setupPage({ csrf: '' }),
    }),
  );
});

authRoutes.post('/setup', async (c) => {
  const db = dbOf(c);
  const body = await bodyOf(c);
  const hasUser = Number((await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users'))?.c || 0) > 0;
  if (hasUser) return c.redirect('/login');
  const meta = await siteMeta(c);
  const username = String(body.username || '').trim();
  const displayName = String(body.display_name || '').trim() || username;
  const password = String(body.password || '');
  const password2 = String(body.password2 || '');
  const siteName = String(body.site_name || '').trim();

  const fail = (error: string) =>
    c.html(
      blank({
        title: '初始化',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: setupPage({ csrf: '', form: { username, display_name: displayName, site_name: siteName }, error }),
      }),
      400,
    );

  if (!USERNAME_RE.test(username)) return fail('用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线。');
  if (password.length < 8) return fail('管理员密码至少 8 位。');
  if (password !== password2) return fail('两次输入的密码不一致。');

  const info = await db.run(
    'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, token_version, created_at) SELECT ?,?,?,?,1,1,? WHERE (SELECT COUNT(*) FROM users) = 0',
    username,
    await auth.hashPassword(password),
    displayName.slice(0, 30),
    colorFor(username),
    nowStr(),
  );
  if (info.changes !== 1 || !info.lastInsertRowid) return c.redirect('/login');
  const ledgerId = await createDefaultLedger(db, info.lastInsertRowid, displayName);
  if (siteName) {
    await db.run(
      "INSERT INTO settings (key, value) VALUES ('site.name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      siteName.slice(0, 20),
    );
  }
  const payload = auth.createSessionPayload(info.lastInsertRowid, ledgerId, 1);
  const token = await auth.signSession(payload, getSessionSecret(envOf(c)));
  c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  setFlash(c, 'success', '初始化完成，欢迎使用家账簿！');
  return c.redirect('/');
});

authRoutes.post('/ledgers/switch', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const id = Number(body.ledger_id);
  const ctx = c.get('ctx');
  const sess = c.get('sess');
  const m = await auth.membership(db, ctx.user!.id, id);
  if (m && sess) {
    const nextPayload = auth.createSessionPayload(sess.uid, id, sess.tv, sess.csrf);
    const token = await auth.signSession(nextPayload, getSessionSecret(envOf(c)));
    c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  }
  return c.redirect(safeNext(body.back));
});

async function loadJoinInvite(db: ReturnType<typeof dbOf>, code: string) {
  const invite = await db.get<{
    id: number;
    ledger_id: number;
    code: string;
    role: string;
    expires_at: string | null;
    used_by: number | null;
  }>('SELECT * FROM ledger_invites WHERE code = ?', code);
  if (!invite) return { error: { title: '邀请无效', message: '邀请链接不存在或已被删除。', status: 404 as const } };
  if (invite.expires_at && invite.expires_at < todayStr()) {
    return { error: { title: '邀请已过期', message: '请让账本管理员重新生成邀请链接。', status: 410 as const } };
  }
  const ledger = await db.get<{ id: number; name: string }>('SELECT id, name FROM ledgers WHERE id = ?', invite.ledger_id);
  if (!ledger) return { error: { title: '账本不存在', message: '该账本已被删除。', status: 404 as const } };
  return { invite, ledger };
}

authRoutes.get('/join/:code', async (c) => {
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const code = String(c.req.param('code') || '').trim();
  const { invite, ledger, error } = await loadJoinInvite(db, code);
  const renderErr = (title: string, msg: string, status: 404 | 410) => {
    if (ctx?.user) {
      return c.html(
        layout({
          title,
          ctx,
          siteName: meta.siteName,
          csrf: c.get('csrf'),
          cspNonce: c.get('cspNonce'),
          body: `<div class="card"><h2>${esc(title)}</h2><p class="muted mt8">${esc(msg)}</p></div>`,
        }),
        status,
      );
    }
    return c.html(
      blank({
        title,
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: `<h2>${esc(title)}</h2><p class="muted mt8">${esc(msg)}</p><a class="btn btn-primary mt12" href="/login">前往登录</a>`,
      }),
      status,
    );
  };
  if (error || !invite || !ledger) {
    return renderErr(error?.title || '错误', error?.message || '', error?.status || 404);
  }
  const alreadyMember = ctx?.user ? await auth.membership(db, ctx.user.id, invite.ledger_id) : null;
  if (Number(invite.used_by) && !alreadyMember) {
    return renderErr('邀请已使用', '该邀请链接已被使用，请让账本管理员重新生成。', 410);
  }
  const roleLabel = auth.ROLE_LABEL[safeInviteRole(invite.role)];
  if (!ctx?.user) {
    return c.html(
      blank({
        title: '受邀注册并加入',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: joinRegisterPage({
          code,
          ledgerName: ledger.name,
          roleLabel,
          csrf: '',
        }),
      }),
    );
  }
  return c.html(
    layout({
      title: '加入账本',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf'),
      cspNonce: c.get('cspNonce'),
      body: `<div class="card"><h2>加入账本「${esc(ledger.name)}」</h2>
<p class="muted mt8">邀请你以「${esc(roleLabel)}」身份加入该账本。${alreadyMember ? '你已是成员，确认后将切换至该账本。' : ''}</p>
<form method="post" action="/join/${esc(code)}" class="row mt16">
  <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}">
  <button class="btn btn-primary" type="submit">确认加入</button>
  <a class="btn" href="/">取消</a>
</form></div>`,
    }),
  );
});

authRoutes.post('/join/:code/register', async (c) => {
  if (c.get('ctx')?.user) return c.redirect(`/join/${encodeURIComponent(String(c.req.param('code') || '').trim())}`);
  const db = dbOf(c);
  const body = await bodyOf(c);
  const meta = await siteMeta(c);
  const code = String(c.req.param('code') || '').trim();
  const { invite, ledger, error } = await loadJoinInvite(db, code);
  const renderErr = (title: string, msg: string, status: 404 | 410) =>
    c.html(
      blank({
        title,
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: `<h2>${esc(title)}</h2><p class="muted mt8">${esc(msg)}</p><a class="btn btn-primary mt12" href="/login">前往登录</a>`,
      }),
      status,
    );
  if (error || !invite || !ledger) {
    return renderErr(error?.title || '错误', error?.message || '', error?.status || 404);
  }
  if (Number(invite.used_by)) {
    return renderErr('邀请已使用', '该邀请链接已被使用，请让账本管理员重新生成。', 410);
  }

  const roleLabel = auth.ROLE_LABEL[safeInviteRole(invite.role)];
  const username = String(body.username || '').trim();
  const displayName = String(body.display_name || '').trim() || username;
  const email = String(body.email || '').trim() || null;
  const password = String(body.password || '');
  const password2 = String(body.password2 || '');

  const fail = (errMsg: string) =>
    c.html(
      blank({
        title: '受邀注册并加入',
        siteName: meta.siteName,
        cspNonce: c.get('cspNonce'),
        body: joinRegisterPage({
          code,
          ledgerName: ledger.name,
          roleLabel,
          csrf: '',
          form: { username, display_name: displayName, email },
          error: errMsg,
        }),
      }),
      400,
    );

  if (!USERNAME_RE.test(username)) return fail('用户名需 3–32 位，仅支持字母、数字、下划线、点、@ 和短横线。');
  if (password.length < 6) return fail('密码至少 6 位。');
  if (password !== password2) return fail('两次输入的密码不一致。');
  if (await db.get('SELECT id FROM users WHERE username = ?', username)) return fail('该用户名已被占用。');

  const stamp = nowStr();
  const info = await db.run(
    'INSERT INTO users (username, email, password_hash, display_name, avatar_color, is_admin, token_version, created_at) VALUES (?,?,?,?,?,0,1,?)',
    username,
    email,
    await auth.hashPassword(password),
    displayName.slice(0, 30),
    colorFor(username),
    stamp,
  );
  const newUserId = Number(info.lastInsertRowid);
  const claim = await db.run(
    'UPDATE ledger_invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL',
    newUserId,
    stamp,
    invite.id,
  );
  if (claim.changes !== 1) {
    await db.run('DELETE FROM users WHERE id = ?', newUserId);
    return renderErr('邀请已使用', '该邀请链接已被使用，请让账本管理员重新生成。', 410);
  }

  await addLedgerMember(db, invite.ledger_id, newUserId, safeInviteRole(invite.role));
  const payload = auth.createSessionPayload(newUserId, Number(invite.ledger_id), 1);
  const token = await auth.signSession(payload, getSessionSecret(envOf(c)));
  c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  setFlash(c, 'success', `注册成功，已加入账本「${ledger.name}」`);
  for (const uid of await auth.ledgerWriterIds(db, invite.ledger_id)) {
    if (Number(uid) === newUserId) continue;
    await auth.notify(db, uid, {
      kind: 'info',
      ledgerId: Number(invite.ledger_id),
      title: `${displayName.slice(0, 30)} 加入了账本「${ledger.name}」`,
      link: '/members',
    });
  }
  return c.redirect('/');
});

authRoutes.post('/join/:code', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const code = String(c.req.param('code') || '').trim();
  const { invite, ledger, error } = await loadJoinInvite(db, code);
  if (error || !invite || !ledger) {
    setFlash(c, 'error', error?.message || '邀请无效');
    return c.redirect('/');
  }
  const alreadyMember = await auth.membership(db, ctx.user!.id, invite.ledger_id);
  if (Number(invite.used_by) && !alreadyMember) {
    setFlash(c, 'error', '该邀请链接已被使用');
    return c.redirect('/');
  }
  if (!alreadyMember) {
    const claim = await db.run(
      'UPDATE ledger_invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL',
      ctx.user!.id,
      nowStr(),
      invite.id,
    );
    if (claim.changes !== 1) {
      setFlash(c, 'error', '该邀请链接已被使用');
      return c.redirect('/');
    }
    await addLedgerMember(db, invite.ledger_id, ctx.user!.id, safeInviteRole(invite.role));
  }
  const sess = c.get('sess')!;
  const token = await auth.signSession(
    auth.createSessionPayload(sess.uid, Number(invite.ledger_id), sess.tv, sess.csrf),
    getSessionSecret(envOf(c)),
  );
  c.header('Set-Cookie', auth.sessionCookie(token, envOf(c)), { append: true });
  setFlash(c, 'success', `已加入账本「${ledger.name}」`);
  if (!alreadyMember) {
    for (const uid of await auth.ledgerWriterIds(db, invite.ledger_id)) {
      if (Number(uid) === Number(ctx.user!.id)) continue;
      await auth.notify(db, uid, {
        kind: 'info',
        ledgerId: Number(invite.ledger_id),
        title: `${ctx.user!.display_name} 加入了账本「${ledger.name}」`,
        link: '/members',
      });
    }
  }
  return c.redirect('/');
});
