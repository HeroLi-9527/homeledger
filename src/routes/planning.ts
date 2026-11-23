import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { ledgerWriterIds, notify } from '../lib/auth.js';
import { progressBar } from '../lib/charts.js';
import * as fd from '../lib/formdata.js';
import {
  advanceDate,
  budgetPeriodRange,
  budgetUsedInRange,
  effectiveBudget,
  recurringPostStmts,
  ruleBadAccount,
  tzRefDate,
  type BudgetRow,
  type RecurringRuleRow,
} from '../lib/scheduler.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc, fmtAmount } from '../lib/util.js';
import type { AccountRow, CategoryRow, HonoEnv } from '../types.js';
import { layout, simpleTable } from '../views/layout.js';
import { budgetsPage } from '../views/planning.js';
import { bodyOf, dbOf, requireLedger, requireWrite, setFlash, siteMeta, takeFlash, toPublicError } from './helpers.js';

export const planningRoutes = new Hono<HonoEnv>();
const csrfInput = (c: { get: (k: 'csrf') => string }) => `<input type="hidden" name="_csrf" value="${esc(c.get('csrf') || '')}">`;
const ledgerId = (c: { get: (k: 'ctx') => { ledger: { id: number } | null } }) => Number(c.get('ctx').ledger!.id);

planningRoutes.get('/budgets', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, cats, accounts] = await Promise.all([
    db.all<BudgetRow & { category_name?: string | null }>(
      'SELECT b.*, c.name AS category_name FROM budgets b LEFT JOIN categories c ON c.id = b.category_id WHERE b.ledger_id = ? ORDER BY b.is_active DESC, b.id',
      lid,
    ),
    db.all<CategoryRow>("SELECT * FROM categories WHERE (ledger_id IS NULL OR ledger_id = ?) AND kind = 'expense' ORDER BY sort_order", lid),
    db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0', lid),
  ]);
  const ref = tzRefDate();
  const items = await Promise.all(
    rows.map(async (b) => {
      const r2 = budgetPeriodRange(b, ref);
      const isUnset = b.period === 'custom' && (!b.start_date || !b.end_date);
      const [used, eff] = await Promise.all([
        isUnset ? Promise.resolve(null) : budgetUsedInRange(db, b, r2.start, r2.end),
        isUnset ? Promise.resolve({ amount: Number(b.amount_cents), rollover: 0 }) : effectiveBudget(db, b, ref),
      ]);
      const catLabel = b.category_id ? b.category_name || '分类已删除' : '全部';
      const rangeLabel = isUnset ? '周期未设置' : r2.label;
      return {
        ...b,
        used,
        amount_cents: eff.amount,
        rollover: eff.rollover,
        catLabel,
        ratio: isUnset || used == null ? null : eff.amount > 0 ? (used / Number(eff.amount)) * 100 : 0,
        rangeLabel,
      };
    }),
  );
  return c.html(
    layout({
      title: '预算管理',
      activeNav: 'budgets',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: budgetsPage({ items, cats, accounts, csrf: c.get('csrf') || '' }),
    }),
  );
});

planningRoutes.post('/budgets', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  const amount = Math.abs(u.parseAmountToCents(body.amount));
  if (!name || !amount) {
    setFlash(c, 'error', '请填写预算名称与有效金额');
    return c.redirect('/budgets');
  }
  const scope = ['overall', 'category', 'account'].includes(String(body.scope)) ? String(body.scope) : 'overall';
  const period = ['monthly', 'yearly', 'weekly', 'custom'].includes(String(body.period)) ? String(body.period) : 'monthly';
  if (period === 'custom' && (!body.start_date || !body.end_date)) {
    setFlash(c, 'error', '自定义周期请填写起止日期');
    return c.redirect('/budgets');
  }
  let effScope = scope;
  if (scope === 'category' && !body.category_id) effScope = 'overall';
  if (scope === 'account' && !body.account_id) effScope = 'overall';

  await db.run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    ledgerId(c),
    name.slice(0, 30),
    effScope,
    effScope === 'category' && body.category_id ? Number(body.category_id) : null,
    effScope === 'account' && body.account_id ? Number(body.account_id) : null,
    period,
    amount,
    String(body.currency || 'CNY'),
    body.trigger_type === 'income' ? 'income' : 'expense',
    body.rollover ? 1 : 0,
    Number(body.alert_pct) || 80,
    body.start_date || null,
    body.end_date || null,
    nowStr(),
  );
  setFlash(c, 'success', `预算「${name}」已创建`);
  return c.redirect('/budgets');
});

planningRoutes.get('/budgets/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const b = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), lid);
  if (!b) return c.redirect('/budgets');
  const [cats, accounts] = await Promise.all([
    db.all<CategoryRow>("SELECT * FROM categories WHERE (ledger_id IS NULL OR ledger_id = ?) AND kind = 'expense' ORDER BY sort_order", lid),
    db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0', lid),
  ]);
  return c.html(
    layout({
      title: '编辑预算',
      activeNav: 'budgets',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      body: `<div class="card"><form method="post" action="/budgets/${b.id}">${csrfInput(c)}
<div class="grid grid-2">
  <div class="field"><label>名称</label><input name="name" value="${esc(b.name)}" required></div>
  <div class="field"><label>金额（元）</label><input name="amount" inputmode="decimal" value="${(b.amount_cents / 100).toFixed(2)}" required></div>
  <div class="field"><label>范围</label><select name="scope"><option value="overall" ${b.scope === 'overall' ? 'selected' : ''}>总预算</option><option value="category" ${b.scope === 'category' ? 'selected' : ''}>按分类</option><option value="account" ${b.scope === 'account' ? 'selected' : ''}>按账户</option></select></div>
  <div class="field"><label>分类</label><select name="category_id"><option value="">—</option>${cats.map((cc) => `<option value="${cc.id}" ${Number(b.category_id) === Number(cc.id) ? 'selected' : ''}>${esc(cc.name)}</option>`).join('')}</select></div>
  <div class="field"><label>账户</label><select name="account_id"><option value="">—</option>${accounts.map((a) => `<option value="${a.id}" ${Number(b.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
  <div class="field"><label>周期</label><select name="period"><option value="monthly" ${b.period === 'monthly' ? 'selected' : ''}>每月</option><option value="weekly" ${b.period === 'weekly' ? 'selected' : ''}>每周</option><option value="yearly" ${b.period === 'yearly' ? 'selected' : ''}>每年</option><option value="custom" ${b.period === 'custom' ? 'selected' : ''}>自定义</option></select></div>
  <div class="field"><label>自定义开始</label><input type="date" name="start_date" value="${esc(b.start_date || '')}"></div>
  <div class="field"><label>自定义结束</label><input type="date" name="end_date" value="${esc(b.end_date || '')}"></div>
  <div class="field"><label>预警阈值（%）</label><input name="alert_pct" type="number" min="1" max="100" value="${b.alert_pct}"></div>
  <div class="field"><label><input type="checkbox" name="rollover" ${b.rollover ? 'checked' : ''}> 剩余额度结转下期</label><label><input type="checkbox" name="is_active" ${b.is_active ? 'checked' : ''}> 启用</label></div>
</div>
<div class="row mt12"><button class="btn btn-primary" type="submit">保存</button><a class="btn" href="/budgets">取消</a></div></form></div>`,
    }),
  );
});

planningRoutes.post('/budgets/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const b = await db.get<BudgetRow>('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, ledgerId(c));
  if (!b) return c.redirect('/budgets');
  const amount = body.amount ? Math.abs(u.parseAmountToCents(body.amount)) : Number(b.amount_cents);
  if (!amount) {
    setFlash(c, 'error', '预算金额需大于 0');
    return c.redirect(`/budgets/${id}/edit`);
  }
  const period = ['monthly', 'yearly', 'weekly', 'custom'].includes(String(body.period)) ? String(body.period) : b.period;
  let effScope = ['overall', 'category', 'account'].includes(String(body.scope)) ? String(body.scope) : b.scope;
  if (effScope === 'category' && !body.category_id) effScope = 'overall';
  if (effScope === 'account' && !body.account_id) effScope = 'overall';
  await db.run(
    `UPDATE budgets SET name=?, scope=?, category_id=?, account_id=?, period=?, amount_cents=?, rollover=?, alert_pct=?, start_date=?, end_date=?, is_active=? WHERE id=? AND ledger_id=?`,
    String(body.name || b.name).slice(0, 30),
    effScope,
    effScope === 'category' && body.category_id ? Number(body.category_id) : null,
    effScope === 'account' && body.account_id ? Number(body.account_id) : null,
    period,
    amount,
    body.rollover ? 1 : 0,
    Number(body.alert_pct) || Number(b.alert_pct),
    body.start_date || null,
    body.end_date || null,
    body.is_active ? 1 : 0,
    id,
    ledgerId(c),
  );
  setFlash(c, 'success', '预算已更新');
  return c.redirect('/budgets');
});

planningRoutes.post('/budgets/:id/toggle', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const row = await db.get<{ is_active: number }>('SELECT is_active FROM budgets WHERE id = ? AND ledger_id = ?', id, ledgerId(c));
  if (row) await db.run('UPDATE budgets SET is_active = ? WHERE id = ?', row.is_active ? 0 : 1, id);
  return c.redirect('/budgets');
});

planningRoutes.post('/budgets/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  await dbOf(c).run('DELETE FROM budgets WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  return c.redirect('/budgets');
});

// ---- 周期账单 ----
planningRoutes.get('/recurring', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, accounts, cats] = await Promise.all([
    db.all<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE ledger_id = ? ORDER BY next_run_at', lid),
    fd.accounts(db, lid),
    fd.flatCategories(db, lid),
  ]);
  const bodyRows =
    rows
      .map((x) => {
        let items: Array<{ amount_cents?: number }> = [];
        try {
          const p = JSON.parse(x.payload || '{}');
          items = Array.isArray(p) ? p : Array.isArray(p.items) ? p.items : [p];
        } catch {
          items = [];
        }
        const total = items.reduce((s, i) => s + Math.abs(Number(i.amount_cents) || 0), 0);
        return `<tr><td><b>${esc(x.name)}</b></td><td class="num amount">${fmtAmount(total)}</td><td>${esc(x.frequency)}</td><td>${esc(x.next_run_at)}</td><td><span class="chip">${x.is_active ? '启用' : '停用'}</span></td>
<td><form method="post" action="/recurring/${x.id}/run" style="display:inline">${csrfInput(c)}<input type="hidden" name="next_run_at" value="${esc(x.next_run_at)}"><button class="btn btn-sm" type="submit">立即执行</button></form>
<form method="post" action="/recurring/${x.id}/toggle" style="display:inline">${csrfInput(c)}<button class="btn btn-sm" type="submit">${x.is_active ? '停用' : '启用'}</button></form>
<form method="post" action="/recurring/${x.id}/delete" style="display:inline">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form></td></tr>`;
      })
      .join('') || '<tr><td colspan="6">暂无周期账单</td></tr>';

  return c.html(
    layout({
      title: '周期账单',
      activeNav: 'recurring',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body:
        simpleTable('周期账单', ['名称', '金额', '频率', '下次执行', '状态', '操作'], bodyRows) +
        `<div class="card mt16"><div class="card-head"><b>新建周期账单</b></div>
<form method="post" action="/recurring">${csrfInput(c)}
  <div class="grid grid-3">
    <input name="name" placeholder="名称，如：房租" required>
    <select name="frequency"><option value="monthly">每月</option><option value="weekly">每周</option><option value="daily">每天</option><option value="yearly">每年</option></select>
    <input name="interval_n" type="number" min="1" value="1">
    <input name="day_of_month" type="number" min="1" max="31" placeholder="每月几号（默认取下次执行日）">
    <input type="date" name="next_run_at" value="${todayStr()}">
  </div>
  <div class="mt12">
    ${[0, 1]
      .map(
        () => `<div class="grid grid-5 mb8">
  <select name="item_type"><option value="expense">支出</option><option value="income">收入</option></select>
  <input name="item_amount" placeholder="金额（元）" inputmode="decimal">
  <select name="item_category_id"><option value="">分类</option>${cats.map((cc) => `<option value="${cc.id}">${esc(cc.path)}</option>`).join('')}</select>
  <select name="item_account_id"><option value="">账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
  <input name="item_note" placeholder="备注">
</div>`,
      )
      .join('')}
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="auto_post" checked> 到期自动入账</label><button class="btn btn-primary" type="submit">创建</button></div>
</form></div>`,
    }),
  );
});

planningRoutes.post('/recurring', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (!name) {
    setFlash(c, 'error', '请填写名称');
    return c.redirect('/recurring');
  }
  const types = ([] as unknown[]).concat(body.item_type || []);
  const amounts = ([] as unknown[]).concat(body.item_amount || []);
  const cats = ([] as unknown[]).concat(body.item_category_id || []);
  const accs = ([] as unknown[]).concat(body.item_account_id || []);
  const notes = ([] as unknown[]).concat(body.item_note || []);
  const items: Array<Record<string, unknown>> = [];
  types.forEach((t, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (!amt) return;
    items.push({
      type: t || 'expense',
      amount_cents: amt,
      category_id: cats[i] ? Number(cats[i]) : null,
      account_id: accs[i] ? Number(accs[i]) : null,
      note: notes[i] || name,
      currency: 'CNY',
    });
  });
  if (!items.length) {
    setFlash(c, 'error', '请至少填写一项金额');
    return c.redirect('/recurring');
  }
  const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(String(body.frequency))
    ? String(body.frequency)
    : 'monthly';
  const intervalN = Math.max(1, Number(body.interval_n) || 1);
  const dayOfMonth = body.day_of_month ? Math.max(1, Math.min(31, Number(body.day_of_month))) : null;
  let next = String(body.next_run_at || todayStr());
  let guard = 0;
  while (next < todayStr() && guard++ < 400) {
    next = advanceDate(next, { frequency, interval_n: intervalN, day_of_month: dayOfMonth });
  }
  await db.run(
    'INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, next_run_at, auto_post, is_active, created_by_user_id, created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
    ledgerId(c),
    name.slice(0, 40),
    JSON.stringify({ items, user_id: ctx.user!.id }),
    frequency,
    intervalN,
    dayOfMonth || Number(next.slice(8, 10)),
    next,
    body.auto_post ? 1 : 0,
    ctx.user!.id,
    nowStr(),
  );
  setFlash(c, 'success', `周期账单「${name}」已创建，下次执行 ${next}`);
  return c.redirect('/recurring');
});

planningRoutes.post('/recurring/:id/run', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const rule = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, ledgerId(c));
  if (!rule) return c.redirect('/recurring');
  try {
    const { stmts, created } = await recurringPostStmts(db, rule, todayStr());
    const period = String(body.next_run_at || rule.next_run_at);
    const next = advanceDate(period, rule);
    const claim = await db.run('UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?', next, id, period);
    if (claim.changes !== 1) {
      setFlash(c, 'error', '该期已执行，请勿重复提交');
      return c.redirect('/recurring');
    }
    const bad = await ruleBadAccount(db, rule);
    if (bad) {
      setFlash(c, 'error', `本期已跳过：${bad}`);
      return c.redirect('/recurring');
    }
    stmts.push(['UPDATE recurring_rules SET last_run_at = ? WHERE id = ?', [nowStr(), id]]);
    await db.batch(stmts);
    setFlash(c, 'success', `已立即记账 ${created} 笔`);
  } catch (e) {
    setFlash(c, 'error', `执行失败：${toPublicError(e)}`);
  }
  return c.redirect('/recurring');
});

planningRoutes.post('/recurring/:id/toggle', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const row = await db.get<{ is_active: number }>('SELECT is_active FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, ledgerId(c));
  if (row) await db.run('UPDATE recurring_rules SET is_active = ? WHERE id = ?', row.is_active ? 0 : 1, id);
  return c.redirect('/recurring');
});

planningRoutes.post('/recurring/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  await dbOf(c).run('DELETE FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  return c.redirect('/recurring');
});

// ---- 借贷台账 ----
planningRoutes.get('/debts', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, accounts] = await Promise.all([
    db.all<{ id: number; direction: string; counterparty: string; principal_cents: number; balance_cents: number; account_id: number | null; due_date: string | null; status: string; note: string | null }>(
      'SELECT * FROM debts WHERE ledger_id = ? ORDER BY status, id DESC',
      lid,
    ),
    fd.accounts(db, lid),
  ]);
  const bodyRows =
    rows
      .map(
        (d) => `<tr>
  <td><b>${esc(d.counterparty)}</b>${d.note === '系统自动汇总' ? ' <span class="chip">自动汇总</span>' : ''}</td>
  <td><span class="chip ${d.direction === 'receivable' ? 'income' : 'expense'}">${d.direction === 'receivable' ? '借出/应收' : '借入/应付'}</span></td>
  <td class="num amount">${fmtAmount(d.principal_cents)}</td>
  <td class="num amount">${fmtAmount(d.balance_cents)}</td>
  <td>${esc(d.due_date || '—')}</td>
  <td>${d.status === 'open' ? '进行中' : '已结清'}</td>
  <td>${
    d.status === 'open'
      ? `<form method="post" action="/debts/${d.id}/settle" class="row" style="display:inline-flex">${csrfInput(c)}<input name="amount" placeholder="金额" inputmode="decimal" style="width:90px"><select name="account_id" style="width:auto">${accounts.map((a) => `<option value="${a.id}" ${Number(d.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><button class="btn btn-sm btn-primary" type="submit">结清</button></form>`
      : ''
  } ${
    d.note === '系统自动汇总'
      ? ''
      : `<form method="post" action="/debts/${d.id}/delete" style="display:inline">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>`
  }</td>
</tr>`,
      )
      .join('') || '<tr><td colspan="7">暂无借贷台账</td></tr>';

  return c.html(
    layout({
      title: '借贷台账',
      activeNav: 'debts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body:
        simpleTable('借贷台账', ['对方', '方向', '本金', '待还/待收', '到期日', '状态', '操作'], bodyRows) +
        `<div class="card mt16"><div class="card-head"><b>新建借贷</b></div>
<form method="post" action="/debts">${csrfInput(c)}
  <div class="grid grid-3">
    <select name="direction"><option value="receivable">借出（应收）</option><option value="payable">借入（应付）</option></select>
    <input name="counterparty" placeholder="对方姓名" required>
    <input name="amount" placeholder="金额（元）" inputmode="decimal" required>
    <input type="date" name="due_date">
    <select name="account_id"><option value="">关联账户</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="create_txn" value="1" checked> 同时生成账户流水</label><button class="btn btn-primary" type="submit">创建</button></div>
</form></div>`,
    }),
  );
});

planningRoutes.post('/debts', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const amount = Math.abs(u.parseAmountToCents(body.amount));
  const counterparty = String(body.counterparty || '').trim();
  if (!amount || !counterparty) {
    setFlash(c, 'error', '请填写对方姓名与有效金额');
    return c.redirect('/debts');
  }
  const direction = body.direction === 'payable' ? 'payable' : 'receivable';
  if (body.create_txn) {
    const accountId = body.account_id ? Number(body.account_id) : 0;
    if (!accountId) {
      setFlash(c, 'error', '生成流水需要选择账户');
      return c.redirect('/debts');
    }
    await txn.createTransaction(db, ledgerId(c), ctx.user!.id, {
      type: direction === 'receivable' ? 'lend' : 'borrow',
      amount_cents: amount,
      account_id: accountId,
      txn_date: String(body.date || todayStr()),
      merchant: counterparty.slice(0, 30),
      note: String(body.note || (direction === 'receivable' ? '借出' : '借入')),
      source: 'manual',
    });
    setFlash(c, 'success', '已记一笔并同步到借贷台账');
    return c.redirect('/debts');
  }
  await db.run(
    'INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, account_id, due_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId(c),
    direction,
    counterparty.slice(0, 30),
    amount,
    amount,
    body.account_id ? Number(body.account_id) : null,
    body.due_date || null,
    'open',
    String(body.note || ''),
    nowStr(),
  );
  await txn.syncDebts(db, ledgerId(c));
  return c.redirect('/debts');
});

planningRoutes.post('/debts/:id/settle', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const d = await db.get<{ id: number; direction: string; counterparty: string; balance_cents: number; account_id: number | null; note: string | null }>(
    'SELECT * FROM debts WHERE id = ? AND ledger_id = ?',
    id,
    ledgerId(c),
  );
  if (!d) return c.redirect('/debts');
  const input = Math.abs(u.parseAmountToCents(body.amount));
  const amount = Math.min(input || Number(d.balance_cents), Number(d.balance_cents));
  const accountId = body.account_id ? Number(body.account_id) : Number(d.account_id || 0);
  if (!amount || !accountId) {
    setFlash(c, 'error', '请填写有效金额并选择账户');
    return c.redirect('/debts');
  }
  await txn.createTransaction(db, ledgerId(c), ctx.user!.id, {
    type: d.direction === 'receivable' ? 'repay_receive' : 'repay_pay',
    amount_cents: amount,
    account_id: accountId,
    txn_date: todayStr(),
    merchant: d.counterparty,
    note: `${d.direction === 'receivable' ? '收回借款 · ' : '偿还借款 · '}${d.counterparty}`,
    source: 'manual',
  });
  if (d.note !== '系统自动汇总') {
    const newBalance = Math.max(0, Number(d.balance_cents) - amount);
    await db.run('UPDATE debts SET balance_cents = ?, status = ? WHERE id = ?', newBalance, newBalance <= 0 ? 'closed' : 'open', id);
  }
  setFlash(c, 'success', `已${d.direction === 'receivable' ? '收款' : '还款'} ${fmtAmount(amount)}`);
  return c.redirect('/debts');
});

planningRoutes.post('/debts/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  await db.run("DELETE FROM debts WHERE id = ? AND ledger_id = ? AND note != '系统自动汇总'", id, ledgerId(c));
  return c.redirect('/debts');
});

// ---- 储蓄目标 ----
planningRoutes.get('/goals', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, accounts] = await Promise.all([
    db.all<{ id: number; name: string; icon: string; target_cents: number; saved_cents: number; account_id: number | null; target_date: string | null; status: string; account_name: string | null }>(
      'SELECT g.*, a.name AS account_name FROM goals g LEFT JOIN accounts a ON a.id = g.account_id WHERE g.ledger_id = ? ORDER BY g.status, g.id DESC',
      lid,
    ),
    fd.accounts(db, lid),
  ]);
  const bodyRows =
    rows
      .map((g) => {
        const pct = g.target_cents > 0 ? Math.min(100, Math.round((g.saved_cents / g.target_cents) * 100)) : 0;
        return `<tr>
  <td>${esc(g.icon)} <b>${esc(g.name)}</b></td>
  <td class="num amount">${fmtAmount(g.target_cents)}</td>
  <td class="num amount">${fmtAmount(g.saved_cents)}</td>
  <td style="min-width:140px">${progressBar(g.saved_cents, g.target_cents)} <span class="tiny muted">${pct}%</span></td>
  <td>${esc(g.target_date || '—')}</td>
  <td><span class="chip ${g.status === 'completed' ? 'income' : ''}">${g.status === 'completed' ? '已完成' : '进行中'}</span></td>
  <td><form method="post" action="/goals/${g.id}/deposit" class="row" style="display:inline-flex">${csrfInput(c)}<input name="amount" placeholder="存入（元）" inputmode="decimal" style="width:90px"><select name="account_id" style="width:auto"><option value="">账户</option>${accounts.map((a) => `<option value="${a.id}" ${Number(g.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><label class="check tiny"><input type="checkbox" name="create_txn" value="1" checked>记流水</label><button class="btn btn-sm btn-primary" type="submit">存入</button></form>
<form method="post" action="/goals/${g.id}/delete" style="display:inline">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form></td>
</tr>`;
      })
      .join('') || '<tr><td colspan="7">暂无储蓄目标</td></tr>';

  return c.html(
    layout({
      title: '储蓄目标',
      activeNav: 'goals',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body:
        simpleTable('储蓄目标', ['目标', '目标金额', '已存', '进度', '目标日期', '状态', '操作'], bodyRows) +
        `<div class="card mt16"><div class="card-head"><b>新建储蓄目标</b></div>
<form method="post" action="/goals">${csrfInput(c)}
  <div class="grid grid-3">
    <input name="name" placeholder="目标名称，如：家庭应急基金" required>
    <input name="target" placeholder="目标金额（元）" inputmode="decimal" required>
    <input type="date" name="target_date">
    <input name="saved_amount" placeholder="已存金额（元，可空）" inputmode="decimal">
    <select name="account_id"><option value="">关联账户（可选）</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><button class="btn btn-primary" type="submit">创建目标</button></div>
</form></div>`,
    }),
  );
});

planningRoutes.post('/goals', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const target = Math.abs(u.parseAmountToCents(body.target));
  if (!target) {
    setFlash(c, 'error', '目标金额无效');
    return c.redirect('/goals');
  }
  const saved = Math.max(0, u.parseAmountToCents(body.saved_amount));
  await db.run(
    'INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId(c),
    String(body.name || '').trim().slice(0, 30),
    String(body.icon || '🎯'),
    target,
    saved,
    body.account_id ? Number(body.account_id) : null,
    body.target_date || null,
    saved >= target ? 'completed' : 'active',
    body.note ? String(body.note).slice(0, 200) : null,
    nowStr(),
  );
  return c.redirect('/goals');
});

planningRoutes.post('/goals/:id/deposit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const g = await db.get<{ id: number; name: string; target_cents: number; saved_cents: number; account_id: number | null; status: string }>(
    'SELECT * FROM goals WHERE id = ? AND ledger_id = ?',
    id,
    ledgerId(c),
  );
  if (!g) return c.redirect('/goals');
  const rawAmt = u.parseAmountToCents(body.amount);
  if (!rawAmt) {
    setFlash(c, 'error', '请填写金额');
    return c.redirect('/goals');
  }
  const amt = rawAmt > 0 ? rawAmt : -Math.min(Math.abs(rawAmt), Number(g.saved_cents));
  if (!amt) return c.redirect('/goals');

  let accountId: number | null = null;
  if (body.create_txn) {
    accountId = body.account_id ? Number(body.account_id) : g.account_id;
    if (!accountId) {
      setFlash(c, 'error', '生成流水需要选择账户');
      return c.redirect('/goals');
    }
  }
  const saved = Math.max(0, Number(g.saved_cents) + amt);
  const done = Number(g.target_cents) > 0 && saved >= Number(g.target_cents);
  await db.run('UPDATE goals SET saved_cents = ?, status = ? WHERE id = ? AND ledger_id = ?', saved, done ? 'completed' : 'active', id, ledgerId(c));
  if (body.create_txn && accountId) {
    try {
      await txn.createTransaction(db, ledgerId(c), ctx.user!.id, {
        type: amt > 0 ? 'expense' : 'income',
        amount_cents: Math.abs(amt),
        account_id: accountId,
        txn_date: todayStr(),
        note: `储蓄目标「${g.name}」${amt > 0 ? '存入' : '取出'}`,
        source: 'manual',
      });
    } catch (e) {
      await db.run('UPDATE goals SET saved_cents = ?, status = ? WHERE id = ? AND ledger_id = ?', g.saved_cents, g.status, id, ledgerId(c));
      throw e;
    }
  }
  if (done && g.status !== 'completed') {
    const key = `goal-done:${g.id}`;
    for (const uid of await ledgerWriterIds(db, ledgerId(c))) {
      await notify(db, uid, {
        kind: 'success',
        ledgerId: ledgerId(c),
        title: `储蓄目标达成：${g.name}`,
        body: `已存 ${(saved / 100).toFixed(2)}，目标 ${(Number(g.target_cents) / 100).toFixed(2)}`,
        link: '/goals',
        dedupeKey: key,
      });
    }
  }
  setFlash(c, 'success', done ? '目标已达成 🎉' : '进度已更新');
  return c.redirect('/goals');
});

planningRoutes.post('/goals/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  await dbOf(c).run('DELETE FROM goals WHERE id = ? AND ledger_id = ?', Number(c.req.param('id')), ledgerId(c));
  return c.redirect('/goals');
});
