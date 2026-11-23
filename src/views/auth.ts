import { esc } from '../lib/util.js';

export function loginPage({
  csrf,
  error = '',
  allowRegister = false,
  next = '/',
}: {
  csrf: string;
  error?: string;
  allowRegister?: boolean;
  next?: string;
}): string {
  return `${error ? `<div class="flash error"><span>${esc(error)}</span></div>` : ''}
<h1 style="font-size:18px;margin-bottom:4px">欢迎回来</h1>
<p class="muted small mb16">登录你的家庭记账空间</p>
<form method="post" action="/login">
  <input type="hidden" name="_csrf" value="${esc(csrf)}">
  <input type="hidden" name="next" value="${esc(next)}">
  <div class="field"><label>用户名</label><input type="text" name="username" required autofocus></div>
  <div class="field"><label>密码</label><input type="password" name="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary btn-lg btn-block" type="submit">登录</button>
</form>
${allowRegister ? '<div class="auth-foot">还没有账号？<a href="/register">立即注册</a></div>' : '<div class="auth-foot">请联系管理员生成邀请码加入账本</div>'}`;
}

export function setupPage({
  csrf,
  form = {},
  error = '',
}: {
  csrf: string;
  form?: { username?: string; display_name?: string; site_name?: string };
  error?: string;
}): string {
  return `${error ? `<div class="flash error"><span>${esc(error)}</span></div>` : ''}
<h1 style="font-size:18px;margin-bottom:4px">初始化家庭账本</h1>
<p class="muted small mb16">首次启动，请创建站点管理员账号</p>
<form method="post" action="/setup">
  <input type="hidden" name="_csrf" value="${esc(csrf)}">
  <div class="field"><label>站点名称</label><input type="text" name="site_name" value="${esc(form.site_name || '家账簿')}" maxlength="20"></div>
  <div class="field"><label>管理员用户名</label><input type="text" name="username" value="${esc(form.username || '')}" required autofocus><div class="help">3–32 位，字母、数字、下划线、点、@ 或短横线</div></div>
  <div class="field"><label>显示昵称</label><input type="text" name="display_name" value="${esc(form.display_name || '')}" placeholder="例如：家庭管家"></div>
  <div class="field"><label>管理员密码</label><input type="password" name="password" autocomplete="new-password" required><div class="help">至少 8 位</div></div>
  <div class="field"><label>确认密码</label><input type="password" name="password2" autocomplete="new-password" required></div>
  <button class="btn btn-primary btn-lg btn-block" type="submit">创建并进入</button>
</form>`;
}

export function registerPage({
  csrf,
  form = {},
  error = '',
}: {
  csrf: string;
  form?: { username?: string; display_name?: string; email?: string | null };
  error?: string;
}): string {
  return `${error ? `<div class="flash error"><span>${esc(error)}</span></div>` : ''}
<h1 style="font-size:18px;margin-bottom:4px">创建账号</h1>
<p class="muted small mb16">注册后会自动为你创建一个默认账本与账户</p>
<form method="post" action="/register">
  <input type="hidden" name="_csrf" value="${esc(csrf)}">
  <div class="field"><label>用户名</label><input type="text" name="username" value="${esc(form.username || '')}" required autofocus></div>
  <div class="field"><label>昵称</label><input type="text" name="display_name" value="${esc(form.display_name || '')}" placeholder="例如：成员"></div>
  <div class="field"><label>邮箱（可选）</label><input type="email" name="email" value="${esc(form.email || '')}"></div>
  <div class="field"><label>密码</label><input type="password" name="password" autocomplete="new-password" required><div class="help">至少 6 位</div></div>
  <div class="field"><label>确认密码</label><input type="password" name="password2" autocomplete="new-password" required></div>
  <button class="btn btn-primary btn-lg btn-block" type="submit">注册并开始记账</button>
</form>
<div class="auth-foot">已有账号？<a href="/login">直接登录</a></div>`;
}
