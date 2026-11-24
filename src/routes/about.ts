import { Hono } from 'hono';
import { todayStr } from '../db.js';
import {
  APP,
  CHANGELOG,
  FEATURES,
  fmtBytes,
  issuesUrl,
  repoLabel,
  repoUrl,
  TECH,
  UPSTREAM_GITHUB_REPO,
} from '../lib/about.js';
import { esc } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { layout } from '../views/layout.js';
import { dbOf, requireLogin, siteMeta, takeFlash } from './helpers.js';

export const aboutRoutes = new Hono<HonoEnv>();

aboutRoutes.get('/about', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const userId = Number(ctx.user!.id);
  const [meta, statRow] = await Promise.all([
    siteMeta(c),
    db.get<{ txns: number; ledgers: number; att_cnt: number; att_bytes: number }>(
      `SELECT
         (SELECT COUNT(*) FROM transactions t JOIN ledger_members lm ON lm.ledger_id = t.ledger_id
          WHERE lm.user_id = ? AND t.deleted_at IS NULL) AS txns,
         (SELECT COUNT(*) FROM ledger_members WHERE user_id = ?) AS ledgers,
         (SELECT COUNT(*) FROM attachments a JOIN ledger_members lm ON lm.ledger_id = a.ledger_id
          WHERE lm.user_id = ?) AS att_cnt,
         (SELECT COALESCE(SUM(a.size), 0) FROM attachments a JOIN ledger_members lm ON lm.ledger_id = a.ledger_id
          WHERE lm.user_id = ?) AS att_bytes`,
      userId,
      userId,
      userId,
      userId,
    ),
  ]);

  const createdDay = String(ctx.user?.created_at || todayStr()).slice(0, 10);
  const startMs = Date.parse(`${createdDay}T00:00:00Z`);
  const todayMs = Date.parse(`${todayStr()}T00:00:00Z`);
  const daysTogether = Number.isFinite(startMs) && Number.isFinite(todayMs)
    ? Math.max(1, Math.floor((todayMs - startMs) / 86400000) + 1)
    : 1;

  const envRepo = repoUrl(c.env);
  const issues = issuesUrl(c.env);
  const repoCreditHtml =
    envRepo && envRepo !== UPSTREAM_GITHUB_REPO
      ? `当前仓库：<a href="${esc(envRepo)}" target="_blank" rel="noopener noreferrer">${esc(repoLabel(envRepo))}</a> · 原型项目：<a href="${esc(UPSTREAM_GITHUB_REPO)}" target="_blank" rel="noopener noreferrer">sucraft-hub/homeledger</a>（MIT 协议）`
      : `原型项目：<a href="${esc(UPSTREAM_GITHUB_REPO)}" target="_blank" rel="noopener noreferrer">sucraft-hub/homeledger</a>（MIT 协议）`;

  return c.html(
    layout({
      title: '关于',
      activeNav: 'about',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card about-hero">
  <div class="about-hero-main">
    <h1>📒 ${esc(APP.name)}</h1>
    <p class="muted mt8">${esc(APP.slogan)}</p>
    <p class="mt12">${esc(APP.description)}</p>
    <div class="row wrap mt12">
      <span class="chip primary">版本 ${esc(CHANGELOG[0].version)}</span>
      <span class="chip">作者 ${esc(APP.author)}</span>
      ${envRepo ? `<a class="btn btn-sm" href="${esc(envRepo)}" target="_blank" rel="noopener noreferrer">项目源码 ↗</a>` : ''}
      ${issues ? `<a class="btn btn-sm" href="${esc(issues)}" target="_blank" rel="noopener noreferrer">问题反馈 ↗</a>` : ''}
    </div>
  </div>
</div>

<div class="kpi-grid mt16">
  <div class="stat"><div class="label">记录笔数</div><div class="value amount">${Number(statRow?.txns || 0)} 笔</div><div class="delta">所参与账本有效流水</div></div>
  <div class="stat"><div class="label">账本数</div><div class="value amount">${Number(statRow?.ledgers || 0)} 本</div><div class="delta">当前参与的账本</div></div>
  <div class="stat"><div class="label">陪伴天数</div><div class="value amount">${daysTogether} 天</div><div class="delta">加入于 ${esc(createdDay)}</div></div>
  <div class="stat"><div class="label">附件规模</div><div class="value amount">${fmtBytes(Number(statRow?.att_bytes || 0))}</div><div class="delta">共 ${Number(statRow?.att_cnt || 0)} 个凭证文件</div></div>
</div>

<div class="card mt16">
  <div class="card-head"><b>技术栈</b><span class="muted small">零构建 · 边缘计算</span></div>
  <div class="about-features">
    ${TECH.map((t) => `<div class="about-feature"><b>${esc(t.name)}</b><p class="muted small mt8">${esc(t.desc)}</p></div>`).join('')}
  </div>
</div>

<div class="card mt16">
  <div class="card-head"><b>核心特性</b></div>
  <div class="about-features">
    ${FEATURES.map((f) => `<div class="about-feature"><b>${esc(f.ico)} ${esc(f.title)}</b><p class="muted small mt8">${esc(f.desc)}</p></div>`).join('')}
  </div>
</div>

<div class="card mt16">
  <div class="card-head"><b>更新记录</b></div>
  ${CHANGELOG.map(
    (v) => `<div class="mb12">
  <div class="row wrap mb8"><b>v${esc(v.version)}</b> <span class="chip">${esc(v.tag)}</span> <span class="tiny muted">${esc(v.date)}</span></div>
  <ul style="padding-left:18px;list-style:disc">${v.items.map((i) => `<li class="small muted">${esc(i)}</li>`).join('')}</ul>
</div>`,
  ).join('')}
</div>

<div class="card mt16">
  <div class="card-head"><b>数据与隐私</b></div>
  <p class="muted small">所有账本流水、账户余额与配置保存在你自己的 Cloudflare D1 数据库中，账单截图与头像保存在你自己的 R2 存储桶中；AI 识别仅在你显式启用模型后把截图或文字发往你配置的模型接口，默认使用本地离线规则引擎兜底。</p>
  <p class="muted tiny mt12">${repoCreditHtml} · 备份请前往「<a href="/export">导出备份</a>」。${esc(APP.aiNote)}</p>
</div>`,
    }),
  );
});
