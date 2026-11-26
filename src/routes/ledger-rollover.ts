import { Hono } from 'hono';
import * as auth from '../lib/auth.js';
import { executeLedgerRollover, previewLedgerRollover, requireRolloverOwner, RolloverError } from '../lib/ledger-rollover.js';
import { esc, money } from '../lib/util.js';
import type { HonoEnv } from '../types.js';
import { layout, simpleTable } from '../views/layout.js';
import { bodyOf, dbOf, envOf, getSessionSecret, requireLogin, setFlash, siteMeta, takeFlash } from './helpers.js';
import { readJsonObject } from './openapi-helpers.js';

export const rolloverRoutes = new Hono<HonoEnv>();

function year(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{4}$/.test(String(value))) {
    throw new RolloverError('目标年度须为四位年份', 400);
  }
  return Number(value);
}

function options(body: Record<string, unknown>) {
  if (body.name != null && typeof body.name !== 'string') throw new RolloverError('账本名称须为文本', 400);
  return { targetYear: year(body.target_year), name: body.name as string | undefined };
}

rolloverRoutes.get('/ledgers/:id/rollover', async (c) => {
  const login = requireLogin(c);
  if (login) return login;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const id = Number(c.req.param('id'));
  try {
    await requireRolloverOwner(db, id, ctx.user!.id);
    const p = await previewLedgerRollover(db, id, year(c.req.query('target_year')));
    const csrf = c.get('csrf');
    const title = `年度结转 · ${p.ledgerName}`;
    const table = (heading: string, columns: string[], rows: string[][]) =>
      rows.length
        ? simpleTable(heading, columns, rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join(''))
        : `<section class="card"><div class="card-head"><b>${esc(heading)}</b></div><div class="empty">无</div></section>`;
    const periods = (rules: typeof p.recurringRules) => rules.map((r) => [
      esc(r.name), esc(r.next_date), r.automatic ? '自动入账' : '仅提醒',
    ]);
    const txnRows = (transactions: typeof p.blockingTransactions) => transactions.map((t) => [
      String(t.id), esc(t.txn_date), esc(t.type), esc(money(t.amount_cents, t.currency)), esc(t.note || ''),
    ]);
    return c.html(layout({
      title, ctx, siteName: (await siteMeta(c)).siteName, csrf, cspNonce: c.get('cspNonce'),
      activeNav: 'ledgers', flash: takeFlash(c),
      body: `<section class="card">
        <div class="card-head"><b>${esc(title)}</b><a class="btn btn-sm" href="/ledgers">返回账本管理</a></div>
        <form method="get" class="row wrap">
          <label for="target-year">目标年度</label>
          <input id="target-year" name="target_year" type="number" min="1001" max="9999" value="${p.targetYear}" required>
          <button class="btn" type="submit">刷新预览</button>
        </form>
        <p>期末截止时间为 ${esc(p.cutoffDate)}。确认后旧账本归档，仍可查阅和导出。</p>
        ${p.blockers.length ? `<div class="notice warn" role="alert"><b>当前无法确认结转</b><ul>${p.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      </section>
      ${p.blockingTransactions.length ? table('需要处理的新年度流水', ['编号', '日期', '类型', '金额', '备注'],
        txnRows(p.blockingTransactions)) : ''}
      ${p.unresolvedTransactions.length ? table('需要补齐原币金额的旧年度流水', ['编号', '日期', '类型', '金额', '备注'],
        txnRows(p.unresolvedTransactions)) : ''}
      ${p.blockingCardActions.length ? table('需要核对的新年度次卡记录', ['次卡', '日期'],
        p.blockingCardActions.map((a) => [esc(a.name), esc(a.activity_date)])) : ''}
      ${p.blockingPeriods.length ? table('需要核对的旧年度期次', ['名称', '计划日', '入账方式'], periods(p.blockingPeriods)) : ''}
      ${table('期末账户余额', ['账户', '原币余额', '状态'],
        p.accounts.map((a) => [esc(a.name), esc(money(a.closing_cents, a.currency)), a.is_archived ? '已归档' : '活跃']))}
      ${table('未结应收应付', ['往来对象', '方向', '未结金额', '到期日'],
        p.debts.map((d) => [esc(d.counterparty), d.direction === 'receivable' ? '应收' : '应付',
          esc(money(d.balance_cents, d.currency)), esc(d.due_date || '—')]))}
      ${table('承接次卡', ['次卡', '剩余次数', '折算金额', '到期日'],
        p.sessionCards.map((a) => [esc(a.name), String(a.remaining_sessions), esc(money(a.carry_cost_cents, a.currency)), esc(a.expires_at || '—')]))}
      ${table('接续周期账单', ['名称', '计划日', '入账方式'], periods(p.recurringRules))}
      ${table('接续订阅', ['名称', '计划日', '入账方式'], periods(p.subscriptions))}
      ${p.canConfirm ? `<form class="card" method="post" data-confirm="确认创建新年度账本并归档旧账本？">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="target_year" value="${p.targetYear}">
        <div class="field"><label for="rollover-name">新账本名称</label>
          <input id="rollover-name" name="name" value="${esc(p.name)}" maxlength="30" required></div>
        <button class="btn btn-primary" type="submit">确认结转</button>
      </form>` : ''}
      `,
    }));
  } catch (error) {
    if (error instanceof RolloverError) return c.html(`<h1>年度结转</h1><p>${esc(error.message)}</p>`, error.status);
    throw error;
  }
});

rolloverRoutes.post('/ledgers/:id/rollover', async (c) => {
  const login = requireLogin(c);
  if (login) return login;
  const id = Number(c.req.param('id'));
  const db = dbOf(c);
  let targetYear: number | undefined;
  try {
    if (!Number.isSafeInteger(id) || id < 1) throw new RolloverError('账本不存在', 404);
    const input = options(await bodyOf(c));
    targetYear = input.targetYear;
    const session = c.get('sess')!;
    const result = await executeLedgerRollover(db, id, session.uid, input);
    const env = envOf(c);
    const token = await auth.signSession(
      auth.createSessionPayload(session.uid, result.ledgerId, session.tv, session.csrf), getSessionSecret(env),
    );
    c.header('Set-Cookie', auth.sessionCookie(token, env), { append: true });
    setFlash(c, 'success', `年度结转已完成。${result.message}`);
    return c.redirect('/ledgers', 303);
  } catch (error) {
    if (error instanceof RolloverError) {
      if (error.status === 403 || error.status === 404) return c.html(`<h1>年度结转</h1><p>${esc(error.message)}</p>`, error.status);
      setFlash(c, 'error', error.message);
      return c.redirect(`/ledgers/${id}/rollover${targetYear ? `?target_year=${targetYear}` : ''}`, 303);
    }
    throw error;
  }
});

export function registerRolloverOpenApi(routes: Hono<HonoEnv>) {
  routes.get('/ledgers/:id/rollover', async (c) => {
    const id = Number(c.req.param('id'));
    const db = dbOf(c);
    try {
      await requireRolloverOwner(db, id, c.get('openAuth')!.userId);
      const preview = await previewLedgerRollover(db, id, year(c.req.query('target_year')));
      // Preview exposes the fields needed to reconcile the closing state.
      const accounts = preview.accounts.map(({ id, name, currency, closing_cents, is_archived }) =>
        ({ id, name, currency, closing_cents, is_archived }));
      return c.json({ ok: true, ...preview, accounts });
    } catch (error) {
      if (error instanceof RolloverError) return c.json({ ok: false, error: error.message }, error.status);
      throw error;
    }
  });

  routes.post('/ledgers/:id/rollover', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ ok: false, error: '账本不存在' }, 404);
    let input: ReturnType<typeof options>;
    try {
      input = options(await readJsonObject(c, { optional: true }));
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : '无效请求' }, 400);
    }
    try {
      const result = await executeLedgerRollover(dbOf(c), id, c.get('openAuth')!.userId, input);
      return c.json({ ok: true, ...result }, result.alreadyCompleted ? 200 : 201);
    } catch (error) {
      if (error instanceof RolloverError) return c.json({ ok: false, error: error.message }, error.status);
      throw error;
    }
  });
}
