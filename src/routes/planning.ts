import { Hono } from 'hono';
import { getSetting, nowStr, todayStr } from '../db.js';
import { accountOptionsHtml } from '../lib/accounts.js';
import { ledgerWriterIds, notify } from '../lib/auth.js';
import { progressBar } from '../lib/charts.js';
import * as fd from '../lib/formdata.js';
import {
  advanceDate,
  budgetAmountInBaseCents,
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
import { assertAccountInLedger, assertCategoryInLedger } from './openapi-helpers.js';

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
  const [rows, cats, accounts, baseCurrency] = await Promise.all([
    db.all<BudgetRow & { category_name?: string | null }>(
      'SELECT b.*, c.name AS category_name FROM budgets b LEFT JOIN categories c ON c.id = b.category_id AND (c.ledger_id IS NULL OR c.ledger_id = b.ledger_id) WHERE b.ledger_id = ? ORDER BY b.is_active DESC, b.id',
      lid,
    ),
    db.all<CategoryRow>("SELECT * FROM categories WHERE (ledger_id IS NULL OR ledger_id = ?) AND kind = 'expense' ORDER BY sort_order", lid),
    db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0', lid),
    getSetting(db, 'site.currency', 'CNY'),
  ]);
  const ref = tzRefDate();
  const items = await Promise.all(
    rows.map(async (b) => {
      const r2 = budgetPeriodRange(b, ref);
      const isUnset = b.period === 'custom' && (!b.start_date || !b.end_date);
      const [used, eff] = await Promise.all([
        isUnset ? Promise.resolve(null) : budgetUsedInRange(db, b, r2.start, r2.end),
        isUnset ? budgetAmountInBaseCents(db, b).then((amount) => ({ amount, rollover: 0 })) : effectiveBudget(db, b, ref),
      ]);
      const catLabel = b.category_id ? b.category_name || '分类已删除' : '全部';
      const rangeLabel = isUnset ? '周期未设置' : r2.label;
      return {
        ...b,
        used,
        orig_amount_cents: Number(b.amount_cents),
        baseCurrency: String(baseCurrency || 'CNY').toUpperCase(),
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
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || '')) ? String(body.start_date) : '';
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || '')) ? String(body.end_date) : '';
  if (period === 'custom' && (!startDate || !endDate)) {
    setFlash(c, 'error', '自定义周期请填写起止日期');
    return c.redirect('/budgets');
  }
  if (period === 'custom' && startDate > endDate) {
    setFlash(c, 'error', '开始日期不能晚于结束日期');
    return c.redirect('/budgets');
  }
  let effScope = scope;
  if (scope === 'category' && !body.category_id) effScope = 'overall';
  if (scope === 'account' && !body.account_id) effScope = 'overall';
  const currency = String(body.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
  const triggerType: 'expense' | 'income' = body.trigger_type === 'income' ? 'income' : 'expense';
  const lid = ledgerId(c);
  const categoryId = effScope === 'category' && body.category_id ? Number(body.category_id) : null;
  const accountId = effScope === 'account' && body.account_id ? Number(body.account_id) : null;
  try {
    await txn.resolveRate(db, currency);
    if (categoryId !== null) await assertCategoryInLedger(db, lid, categoryId, triggerType);
    if (accountId !== null) await assertAccountInLedger(db, lid, accountId);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
    return c.redirect('/budgets');
  }

  await db.run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    lid,
    name.slice(0, 30),
    effScope,
    categoryId,
    accountId,
    period,
    amount,
    currency,
    triggerType,
    body.rollover ? 1 : 0,
    Number(body.alert_pct) || 80,
    period === 'custom' ? startDate : null,
    period === 'custom' ? endDate : null,
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
    db.all<CategoryRow>('SELECT * FROM categories WHERE (ledger_id IS NULL OR ledger_id = ?) ORDER BY kind DESC, sort_order', lid),
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
      flash: takeFlash(c),
      body: `<div class="card"><form method="post" action="/budgets/${b.id}">${csrfInput(c)}
<div class="grid grid-2">
  <div class="field"><label>名称</label><input name="name" value="${esc(b.name)}" required></div>
  <div class="field"><label>金额（元）</label><input name="amount" inputmode="decimal" value="${(b.amount_cents / 100).toFixed(2)}" required></div>
  <div class="field"><label>类型</label><select name="trigger_type"><option value="expense" ${b.trigger_type !== 'income' ? 'selected' : ''}>支出预算</option><option value="income" ${b.trigger_type === 'income' ? 'selected' : ''}>收入预算</option></select></div>
  <div class="field"><label>币种</label><input name="currency" value="${esc(b.currency || 'CNY')}" maxlength="8"></div>
  <div class="field"><label>范围</label><select name="scope"><option value="overall" ${b.scope === 'overall' ? 'selected' : ''}>总预算</option><option value="category" ${b.scope === 'category' ? 'selected' : ''}>按分类</option><option value="account" ${b.scope === 'account' ? 'selected' : ''}>按账户</option></select></div>
  <div class="field"><label>分类</label><select name="category_id"><option value="">—</option>${cats.map((cc) => `<option value="${cc.id}" ${Number(b.category_id) === Number(cc.id) ? 'selected' : ''}>${cc.kind === 'income' ? '[收] ' : ''}${esc(cc.name)}</option>`).join('')}</select></div>
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
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || '')) ? String(body.start_date) : '';
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || '')) ? String(body.end_date) : '';
  if (period === 'custom' && (!startDate || !endDate)) {
    setFlash(c, 'error', '自定义周期请填写起止日期');
    return c.redirect(`/budgets/${id}/edit`);
  }
  if (period === 'custom' && startDate > endDate) {
    setFlash(c, 'error', '开始日期不能晚于结束日期');
    return c.redirect(`/budgets/${id}/edit`);
  }
  const triggerType: 'expense' | 'income' =
    body.trigger_type !== undefined ? (body.trigger_type === 'income' ? 'income' : 'expense') : b.trigger_type === 'income' ? 'income' : 'expense';
  const currency =
    body.currency !== undefined
      ? String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'CNY'
      : b.currency || 'CNY';
  let effScope = ['overall', 'category', 'account'].includes(String(body.scope)) ? String(body.scope) : b.scope;
  if (effScope === 'category' && !body.category_id) effScope = 'overall';
  if (effScope === 'account' && !body.account_id) effScope = 'overall';
  const categoryId = effScope === 'category' && body.category_id ? Number(body.category_id) : null;
  const accountId = effScope === 'account' && body.account_id ? Number(body.account_id) : null;
  const lid = ledgerId(c);
  try {
    await txn.resolveRate(db, currency);
    if (categoryId !== null) {
      await assertCategoryInLedger(db, lid, categoryId, triggerType, {
        allowArchived: categoryId === Number(b.category_id),
      });
    }
    if (accountId !== null) {
      await assertAccountInLedger(db, lid, accountId, {
        allowArchived: accountId === Number(b.account_id),
      });
    }
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(`/budgets/${id}/edit`);
  }
  await db.run(
    `UPDATE budgets SET name=?, scope=?, category_id=?, account_id=?, period=?, amount_cents=?, currency=?, trigger_type=?, rollover=?, alert_pct=?, start_date=?, end_date=?, is_active=? WHERE id=? AND ledger_id=?`,
    String(body.name || b.name).slice(0, 30),
    effScope,
    categoryId,
    accountId,
    period,
    amount,
    currency,
    triggerType,
    body.rollover ? 1 : 0,
    Number(body.alert_pct) || Number(b.alert_pct),
    period === 'custom' ? startDate : null,
    period === 'custom' ? endDate : null,
    body.is_active ? 1 : 0,
    id,
    lid,
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
interface RecurringItemRow {
  type: string;
  amount_cents: number;
  category_id: number | null;
  account_id: number | null;
  note: string;
  currency?: string;
}

function parseRecurringPayload(raw: string): { items: RecurringItemRow[]; user_id?: number } {
  try {
    const p = JSON.parse(raw || '{}') as RecurringItemRow[] | { items?: RecurringItemRow[]; user_id?: number };
    if (Array.isArray(p)) return { items: p };
    if (Array.isArray(p.items)) return { items: p.items, user_id: p.user_id };
    return { items: [p as RecurringItemRow], user_id: (p as { user_id?: number }).user_id };
  } catch {
    return { items: [] };
  }
}

function readRecurringItems(body: Record<string, unknown>, fallbackNote: string): RecurringItemRow[] {
  const types = ([] as unknown[]).concat(body.item_type || []);
  const amounts = ([] as unknown[]).concat(body.item_amount || []);
  const cats = ([] as unknown[]).concat(body.item_category_id || []);
  const accs = ([] as unknown[]).concat(body.item_account_id || []);
  const notes = ([] as unknown[]).concat(body.item_note || []);
  const items: RecurringItemRow[] = [];
  types.forEach((t, i) => {
    const amt = Math.abs(u.parseAmountToCents(amounts[i]));
    if (!amt) return;
    items.push({
      type: t === 'income' ? 'income' : 'expense',
      amount_cents: amt,
      category_id: cats[i] ? Number(cats[i]) : null,
      account_id: accs[i] ? Number(accs[i]) : null,
      note: String(notes[i] || fallbackNote),
      currency: 'CNY',
    });
  });
  return items;
}

function renderRecurringItemRow(
  item: Partial<RecurringItemRow>,
  cats: Array<CategoryRow & { path: string }>,
  accounts: AccountRow[],
): string {
  return `<div class="grid grid-5 mb8 recurring-item-row">
  <select name="item_type"><option value="expense" ${item.type !== 'income' ? 'selected' : ''}>支出</option><option value="income" ${item.type === 'income' ? 'selected' : ''}>收入</option></select>
  <input name="item_amount" placeholder="金额（元）" inputmode="decimal" value="${item.amount_cents ? (Math.abs(Number(item.amount_cents)) / 100).toFixed(2) : ''}">
  <select name="item_category_id"><option value="">分类</option>${cats.map((cc) => `<option value="${cc.id}" ${Number(item.category_id) === Number(cc.id) ? 'selected' : ''}>${esc(cc.path)}</option>`).join('')}</select>
  <select name="item_account_id">${accountOptionsHtml(accounts, { selectedId: item.account_id, emptyLabel: '账户' })}</select>
  <div class="row"><input name="item_note" placeholder="备注" value="${esc(item.note || '')}"><button type="button" class="btn btn-sm btn-ghost del-rec-item" title="移除明细">✕</button></div>
</div>`;
}

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
        const items = parseRecurringPayload(x.payload).items;
        const total = items.reduce((s, i) => s + Math.abs(Number(i.amount_cents) || 0), 0);
        const anchorHint =
          x.frequency === 'monthly' && x.day_of_month && Number(x.next_run_at.slice(8, 10)) !== Number(x.day_of_month)
            ? ` <span class="tiny muted">（锚点 ${x.day_of_month} 日）</span>`
            : '';
        return `<tr><td><b>${esc(x.name)}</b></td><td class="num amount">${fmtAmount(total)}</td><td>${esc(x.frequency)}</td><td>${esc(x.next_run_at)}${anchorHint}</td><td><span class="chip">${x.is_active ? '启用' : '停用'}</span></td>
<td><div class="row wrap">
  <a class="btn btn-sm" href="/recurring/${x.id}/edit">编辑</a>
  <form method="post" action="/recurring/${x.id}/run" style="display:inline">${csrfInput(c)}<input type="hidden" name="next_run_at" value="${esc(x.next_run_at)}"><button class="btn btn-sm" type="submit">立即执行</button></form>
  <form method="post" action="/recurring/${x.id}/toggle" style="display:inline">${csrfInput(c)}<button class="btn btn-sm" type="submit">${x.is_active ? '停用' : '启用'}</button></form>
  <form method="post" action="/recurring/${x.id}/delete" style="display:inline" data-confirm="确认删除该周期账单？">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
</div></td></tr>`;
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
<form method="post" action="/recurring" data-recurring-form>${csrfInput(c)}
  <div class="grid grid-3">
    <input name="name" placeholder="名称，如：房租" required>
    <select name="frequency"><option value="monthly">每月</option><option value="weekly">每周</option><option value="daily">每天</option><option value="yearly">每年</option></select>
    <input name="interval_n" type="number" min="1" value="1">
    <input name="day_of_month" type="number" min="1" max="31" placeholder="每月几号（默认取下次执行日）">
    <input type="date" name="next_run_at" value="${todayStr()}">
  </div>
  <div class="mt12" data-rec-items>
    ${[0, 1].map(() => renderRecurringItemRow({}, cats, accounts)).join('')}
  </div>
  <div class="row mt12 wrap">
    <button class="btn btn-sm" type="button" data-add-rec-item>+ 添加明细</button>
    <label class="check"><input type="checkbox" name="auto_post" checked> 到期自动入账</label>
    <span class="spacer"></span>
    <button class="btn btn-primary" type="submit">创建</button>
  </div>
</form></div>`,
    }),
  );
});

planningRoutes.get('/recurring/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const rule = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, lid);
  if (!rule) return c.redirect('/recurring');
  const [accounts, cats] = await Promise.all([fd.accounts(db, lid), fd.flatCategories(db, lid)]);
  const parsed = parseRecurringPayload(rule.payload);
  const rows = [...parsed.items, {}];
  return c.html(
    layout({
      title: '编辑周期账单',
      activeNav: 'recurring',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card"><div class="card-head"><b>编辑周期账单：${esc(rule.name)}</b><a class="btn btn-sm" href="/recurring">← 返回列表</a></div>
<form method="post" action="/recurring/${rule.id}" data-recurring-form>${csrfInput(c)}
  <div class="grid grid-3">
    <div class="field"><label>名称</label><input name="name" value="${esc(rule.name)}" required></div>
    <div class="field"><label>频率</label><select name="frequency"><option value="monthly" ${rule.frequency === 'monthly' ? 'selected' : ''}>每月</option><option value="weekly" ${rule.frequency === 'weekly' ? 'selected' : ''}>每周</option><option value="daily" ${rule.frequency === 'daily' ? 'selected' : ''}>每天</option><option value="yearly" ${rule.frequency === 'yearly' ? 'selected' : ''}>每年</option></select></div>
    <div class="field"><label>间隔</label><input name="interval_n" type="number" min="1" value="${rule.interval_n || 1}"></div>
    <div class="field"><label>每月几号（1-31）</label><input name="day_of_month" type="number" min="1" max="31" value="${rule.day_of_month ?? ''}"></div>
    <div class="field"><label>下次执行日期</label><input type="date" name="next_run_at" value="${esc(rule.next_run_at)}"></div>
    <div class="field" style="justify-content:flex-end">
      <div class="row wrap">
        <label class="check"><input type="checkbox" name="auto_post" value="1" ${rule.auto_post ? 'checked' : ''}> 到期自动入账</label>
        <label class="check"><input type="checkbox" name="is_active" value="1" ${rule.is_active ? 'checked' : ''}> 启用</label>
      </div>
    </div>
  </div>
  <div class="mt12" data-rec-items>
    ${rows.map((item) => renderRecurringItemRow(item, cats, accounts)).join('')}
  </div>
  <div class="row mt12 wrap">
    <button class="btn btn-sm" type="button" data-add-rec-item>+ 添加明细</button>
    <span class="spacer"></span>
    <a class="btn" href="/recurring">取消</a>
    <button class="btn btn-primary" type="submit">保存修改</button>
  </div>
</form></div>`,
    }),
  );
});

async function validateRecurringItems(
  db: Parameters<typeof assertAccountInLedger>[0],
  lid: number,
  items: RecurringItemRow[],
  prevItems: RecurringItemRow[] = [],
): Promise<void> {
  const prevAcctIds = new Set(prevItems.map((x) => Number(x.account_id)).filter((n) => Number.isInteger(n) && n > 0));
  const prevCatIds = new Set(prevItems.map((x) => Number(x.category_id)).filter((n) => Number.isInteger(n) && n > 0));
  for (const it of items) {
    if (it.account_id !== null) {
      await assertAccountInLedger(db, lid, Number(it.account_id), { allowArchived: prevAcctIds.has(Number(it.account_id)) });
    }
    if (it.category_id !== null) {
      await assertCategoryInLedger(db, lid, Number(it.category_id), it.type === 'income' ? 'income' : 'expense', {
        allowArchived: prevCatIds.has(Number(it.category_id)),
      });
    }
  }
}

planningRoutes.post('/recurring', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const lid = ledgerId(c);
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (!name) {
    setFlash(c, 'error', '请填写名称');
    return c.redirect('/recurring');
  }
  const items = readRecurringItems(body, name);
  if (!items.length) {
    setFlash(c, 'error', '请至少填写一项金额');
    return c.redirect('/recurring');
  }
  try {
    await validateRecurringItems(db, lid, items);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
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

planningRoutes.post('/recurring/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const id = Number(c.req.param('id'));
  const lid = ledgerId(c);
  const old = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, lid);
  if (!old) return c.redirect('/recurring');
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (!name) {
    setFlash(c, 'error', '请填写周期账单名称');
    return c.redirect(`/recurring/${id}/edit`);
  }
  const items = readRecurringItems(body, name);
  if (!items.length) {
    setFlash(c, 'error', '请至少保留一项有效金额的明细');
    return c.redirect(`/recurring/${id}/edit`);
  }
  const prevPayload = parseRecurringPayload(old.payload);
  try {
    await validateRecurringItems(db, lid, items, prevPayload.items);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(`/recurring/${id}/edit`);
  }
  const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(String(body.frequency))
    ? String(body.frequency)
    : old.frequency;
  const intervalN = Math.max(1, Number(body.interval_n) || 1);
  const dayOfMonth = body.day_of_month ? Math.max(1, Math.min(31, Number(body.day_of_month))) : null;
  const rawNext = /^\d{4}-\d{2}-\d{2}$/.test(String(body.next_run_at || '')) ? String(body.next_run_at) : old.next_run_at;
  let next = rawNext;
  if (rawNext !== old.next_run_at) {
    let guard = 0;
    while (next < todayStr() && guard++ < 400) {
      next = advanceDate(next, { frequency, interval_n: intervalN, day_of_month: dayOfMonth });
    }
  }
  await db.run(
    'UPDATE recurring_rules SET name=?, payload=?, frequency=?, interval_n=?, day_of_month=?, next_run_at=?, auto_post=?, is_active=? WHERE id=? AND ledger_id=?',
    name.slice(0, 40),
    JSON.stringify({ items, user_id: prevPayload.user_id || old.created_by_user_id || ctx.user!.id }),
    frequency,
    intervalN,
    dayOfMonth || Number(next.slice(8, 10)),
    next,
    body.auto_post ? 1 : 0,
    body.is_active ? 1 : 0,
    id,
    lid,
  );
  setFlash(c, 'success', '周期账单已更新');
  return c.redirect('/recurring');
});

planningRoutes.post('/recurring/:id/run', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const body = await bodyOf(c);
  const lid = ledgerId(c);
  const rule = await db.get<RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', id, lid);
  if (!rule) return c.redirect('/recurring');
  try {
    const bad = await ruleBadAccount(db, rule);
    if (bad) {
      setFlash(c, 'error', `无法执行：${bad}`);
      return c.redirect('/recurring');
    }
    const { stmts, created } = await recurringPostStmts(db, rule, todayStr());
    const period = String(body.next_run_at || rule.next_run_at);
    const next = advanceDate(period, rule);
    const claim = await db.run(
      'UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND ledger_id = ? AND next_run_at = ?',
      next,
      id,
      lid,
      period,
    );
    if (claim.changes !== 1) {
      setFlash(c, 'error', '该期已执行，请勿重复提交');
      return c.redirect('/recurring');
    }
    try {
      stmts.push(['UPDATE recurring_rules SET last_run_at = ? WHERE id = ?', [nowStr(), id]]);
      await db.batch(stmts);
    } catch (e) {
      await db
        .run('UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ?', period, id, next)
        .catch(() => {});
      throw e;
    }
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
interface DebtRow {
  id: number;
  ledger_id: number;
  direction: string;
  counterparty: string;
  principal_cents: number;
  balance_cents: number;
  account_id: number | null;
  due_date: string | null;
  status: string;
  note: string | null;
}

planningRoutes.get('/debts', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, accounts] = await Promise.all([
    db.all<DebtRow>('SELECT * FROM debts WHERE ledger_id = ? ORDER BY status, id DESC', lid),
    fd.accounts(db, lid),
  ]);
  const bodyRows =
    rows
      .map((d) => {
        const isAuto = d.note === '系统自动汇总';
        return `<tr>
  <td><b>${esc(d.counterparty)}</b>${isAuto ? ' <span class="chip">自动汇总</span>' : ''}</td>
  <td><span class="chip ${d.direction === 'receivable' ? 'income' : 'expense'}">${d.direction === 'receivable' ? '借出/应收' : '借入/应付'}</span></td>
  <td class="num amount">${fmtAmount(d.principal_cents)}</td>
  <td class="num amount">${fmtAmount(d.balance_cents)}</td>
  <td>${esc(d.due_date || '—')}</td>
  <td>${d.status === 'open' ? '进行中' : '已结清'}</td>
  <td><div class="row wrap">
    ${
      d.status === 'open'
        ? `<form method="post" action="/debts/${d.id}/settle" class="row" style="display:inline-flex">${csrfInput(c)}<input name="amount" placeholder="金额" inputmode="decimal" style="width:90px"><select name="account_id" style="width:auto">${accounts.map((a) => `<option value="${a.id}" ${Number(d.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><button class="btn btn-sm btn-primary" type="submit">结清</button></form>`
        : ''
    }
    <a class="btn btn-sm" href="/debts/${d.id}/edit">${isAuto ? '设到期日' : '编辑'}</a>
    ${
      isAuto
        ? `<a class="btn btn-sm btn-ghost" href="/transactions?q=${encodeURIComponent(d.counterparty)}">关联流水</a>`
        : `<form method="post" action="/debts/${d.id}/delete" style="display:inline" data-confirm="确认删除该借贷台账？">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>`
    }
  </div></td>
</tr>`;
      })
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
    <select name="account_id">${accountOptionsHtml(accounts, { emptyLabel: '关联账户' })}</select>
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><label class="check"><input type="checkbox" name="create_txn" value="1" checked> 同时生成账户流水</label><button class="btn btn-primary" type="submit">创建</button></div>
</form></div>`,
    }),
  );
});

planningRoutes.get('/debts/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const d = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, lid);
  if (!d) return c.redirect('/debts');
  const accounts = await fd.accounts(db, lid);
  const isAuto = d.note === '系统自动汇总';

  return c.html(
    layout({
      title: isAuto ? '设置借贷到期日' : '编辑借贷台账',
      activeNav: 'debts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: isAuto
        ? `<div class="card"><div class="card-head"><b>自动汇总借贷：${esc(d.counterparty)}</b><a class="btn btn-sm" href="/debts">← 返回列表</a></div>
<div class="notice mb16">该借贷由「借出 / 借入」与「收款 / 还款」流水自动汇总生成，本金与余额不可直接修改。如需调整金额请前往修改对应流水；此处可设置或清空到期日（用于到期提醒并在重算时自动保留）。</div>
<div class="kpi-grid mb16">
  <div class="stat"><div class="label">方向</div><div class="value" style="font-size:18px">${d.direction === 'receivable' ? '借出（应收）' : '借入（应付）'}</div></div>
  <div class="stat"><div class="label">本金</div><div class="value amount">${fmtAmount(d.principal_cents)}</div></div>
  <div class="stat"><div class="label">待还/待收</div><div class="value amount">${fmtAmount(d.balance_cents)}</div></div>
  <div class="stat"><div class="label">状态</div><div class="value" style="font-size:18px">${d.status === 'open' ? '进行中' : '已结清'}</div></div>
</div>
<form method="post" action="/debts/${d.id}">${csrfInput(c)}
  <div class="field" style="max-width:260px"><label>到期日（留空则清除）</label><input type="date" name="due_date" value="${esc(d.due_date || '')}"></div>
  <div class="row mt12 wrap">
    <button class="btn btn-primary" type="submit">保存到期日</button>
    <a class="btn" href="/transactions?q=${encodeURIComponent(d.counterparty)}">查看关联流水 →</a>
    <a class="btn btn-ghost" href="/debts">取消</a>
  </div>
</form></div>`
        : `<div class="card"><div class="card-head"><b>编辑借贷台账：${esc(d.counterparty)}</b><a class="btn btn-sm" href="/debts">← 返回列表</a></div>
<form method="post" action="/debts/${d.id}">${csrfInput(c)}
  <div class="grid grid-2">
    <div class="field"><label>方向</label><select name="direction"><option value="receivable" ${d.direction === 'receivable' ? 'selected' : ''}>借出（应收）</option><option value="payable" ${d.direction === 'payable' ? 'selected' : ''}>借入（应付）</option></select></div>
    <div class="field"><label>对方姓名</label><input name="counterparty" value="${esc(d.counterparty)}" required></div>
    <div class="field"><label>本金（元）</label><input name="principal" inputmode="decimal" value="${(Number(d.principal_cents) / 100).toFixed(2)}" required></div>
    <div class="field"><label>待还 / 待收余额（元）</label><input name="balance" inputmode="decimal" value="${(Number(d.balance_cents) / 100).toFixed(2)}" required></div>
    <div class="field"><label>关联账户</label><select name="account_id">${accountOptionsHtml(accounts, { selectedId: d.account_id, emptyLabel: '无关联账户' })}</select></div>
    <div class="field"><label>到期日</label><input type="date" name="due_date" value="${esc(d.due_date || '')}"></div>
    <div class="field"><label>状态</label><select name="status"><option value="open" ${d.status === 'open' ? 'selected' : ''}>进行中</option><option value="closed" ${d.status === 'closed' ? 'selected' : ''}>已结清</option></select></div>
    <div class="field"><label>备注</label><input name="note" value="${esc(d.note || '')}"></div>
  </div>
  <div class="row mt12"><button class="btn btn-primary" type="submit">保存修改</button><a class="btn" href="/debts">取消</a></div>
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
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_date || '')) ? String(body.due_date) : null;
  const cleanName = counterparty.slice(0, 30);
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
      merchant: cleanName,
      note: String(body.note || (direction === 'receivable' ? '借出' : '借入')),
      source: 'manual',
    });
    if (dueDate) {
      await db.run(
        "UPDATE debts SET due_date = ? WHERE ledger_id = ? AND direction = ? AND counterparty = ? AND note = '系统自动汇总'",
        dueDate,
        ledgerId(c),
        direction,
        cleanName,
      );
    }
    setFlash(c, 'success', '已记一笔并同步到借贷台账');
    return c.redirect('/debts');
  }
  const rawNote = String(body.note || '').trim();
  if (rawNote === '系统自动汇总') {
    setFlash(c, 'error', '备注不能使用系统保留关键字「系统自动汇总」');
    return c.redirect('/debts');
  }
  await db.run(
    'INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, account_id, due_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId(c),
    direction,
    cleanName,
    amount,
    amount,
    body.account_id ? Number(body.account_id) : null,
    dueDate,
    'open',
    rawNote.slice(0, 200),
    nowStr(),
  );
  await txn.syncDebts(db, ledgerId(c));
  return c.redirect('/debts');
});

planningRoutes.post('/debts/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const d = await db.get<DebtRow>('SELECT * FROM debts WHERE id = ? AND ledger_id = ?', id, lid);
  if (!d) return c.redirect('/debts');
  const body = await bodyOf(c);
  const dueRaw = String(body.due_date || '').trim();
  if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
    setFlash(c, 'error', '到期日格式不正确');
    return c.redirect(`/debts/${id}/edit`);
  }
  const dueDate = dueRaw || null;

  if (d.note === '系统自动汇总') {
    await db.run('UPDATE debts SET due_date = ? WHERE id = ? AND ledger_id = ?', dueDate, id, lid);
    setFlash(c, 'success', '自动汇总借贷到期日已更新');
    return c.redirect('/debts');
  }

  const counterparty = String(body.counterparty || '').trim().slice(0, 30);
  const principal = Math.abs(u.parseAmountToCents(body.principal));
  const balance =
    body.balance !== undefined && String(body.balance).trim() !== ''
      ? Math.max(0, u.parseAmountToCents(body.balance))
      : Number(d.balance_cents);
  if (!counterparty || !principal) {
    setFlash(c, 'error', '请填写对方姓名与有效本金');
    return c.redirect(`/debts/${id}/edit`);
  }
  const note = String(body.note || '').trim().slice(0, 200);
  if (note === '系统自动汇总') {
    setFlash(c, 'error', '备注不能使用系统保留关键字「系统自动汇总」');
    return c.redirect(`/debts/${id}/edit`);
  }
  const direction = body.direction === 'payable' ? 'payable' : 'receivable';
  const status = balance === 0 || body.status === 'closed' ? 'closed' : 'open';
  await db.run(
    'UPDATE debts SET direction=?, counterparty=?, principal_cents=?, balance_cents=?, account_id=?, due_date=?, status=?, note=? WHERE id=? AND ledger_id=?',
    direction,
    counterparty,
    principal,
    balance,
    body.account_id ? Number(body.account_id) : null,
    dueDate,
    status,
    note,
    id,
    lid,
  );
  setFlash(c, 'success', '借贷记录已更新');
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
interface GoalRow {
  id: number;
  ledger_id: number;
  name: string;
  icon: string;
  target_cents: number;
  saved_cents: number;
  account_id: number | null;
  target_date: string | null;
  status: string;
  note: string | null;
  account_name?: string | null;
}

planningRoutes.get('/goals', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const [rows, accounts] = await Promise.all([
    db.all<GoalRow>(
      'SELECT g.*, a.name AS account_name FROM goals g LEFT JOIN accounts a ON a.id = g.account_id WHERE g.ledger_id = ? ORDER BY g.status, g.id DESC',
      lid,
    ),
    fd.accounts(db, lid),
  ]);
  const today = todayStr();
  const bodyRows =
    rows
      .map((g) => {
        const pct = g.target_cents > 0 ? Math.min(100, Math.round((g.saved_cents / g.target_cents) * 100)) : 0;
        let dateExtra = '';
        if (g.target_date && g.status !== 'completed') {
          const diffDays = Math.round(
            (Date.parse(`${g.target_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000,
          );
          const leftCents = Math.max(0, Number(g.target_cents) - Number(g.saved_cents));
          if (diffDays < 0) {
            dateExtra = `<div class="tiny" style="color:var(--expense)">已逾期 ${Math.abs(diffDays)} 天</div>`;
          } else if (diffDays === 0) {
            dateExtra = '<div class="tiny" style="color:var(--warn)">今日到期</div>';
          } else {
            const perMonth = leftCents > 0 ? Math.ceil(leftCents / Math.max(1, diffDays / 30)) : 0;
            dateExtra = `<div class="tiny muted">剩 ${diffDays} 天${perMonth > 0 ? ` · 约 ${fmtAmount(perMonth)}/月` : ''}</div>`;
          }
        }
        return `<tr>
  <td>${esc(g.icon)} <b>${esc(g.name)}</b></td>
  <td class="num amount">${fmtAmount(g.target_cents)}</td>
  <td class="num amount">${fmtAmount(g.saved_cents)}</td>
  <td style="min-width:140px">${progressBar(g.saved_cents, g.target_cents)} <span class="tiny muted">${pct}%</span></td>
  <td>${esc(g.target_date || '—')}${dateExtra}</td>
  <td><span class="chip ${g.status === 'completed' ? 'income' : ''}">${g.status === 'completed' ? '已完成' : '进行中'}</span></td>
  <td><div class="row wrap">
    <form method="post" action="/goals/${g.id}/deposit" class="row" style="display:inline-flex">${csrfInput(c)}<input name="amount" placeholder="存入（元）" inputmode="decimal" style="width:90px"><select name="account_id" style="width:auto"><option value="">账户</option>${accounts.map((a) => `<option value="${a.id}" ${Number(g.account_id) === Number(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><label class="check tiny"><input type="checkbox" name="create_txn" value="1" checked>记流水</label><button class="btn btn-sm btn-primary" type="submit">存入</button></form>
    <a class="btn btn-sm" href="/goals/${g.id}/edit">编辑</a>
    <form method="post" action="/goals/${g.id}/delete" style="display:inline" data-confirm="确认删除该储蓄目标？">${csrfInput(c)}<button class="btn btn-sm btn-danger" type="submit">删除</button></form>
  </div></td>
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
    <select name="account_id">${accountOptionsHtml(accounts, { emptyLabel: '关联账户（可选）' })}</select>
    <input name="note" placeholder="备注">
  </div>
  <div class="row mt12"><button class="btn btn-primary" type="submit">创建目标</button></div>
</form></div>`,
    }),
  );
});

planningRoutes.get('/goals/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const g = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, lid);
  if (!g) return c.redirect('/goals');
  const accounts = await fd.accounts(db, lid);
  return c.html(
    layout({
      title: '编辑储蓄目标',
      activeNav: 'goals',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card"><div class="card-head"><b>编辑储蓄目标：${esc(g.name)}</b><a class="btn btn-sm" href="/goals">← 返回列表</a></div>
<div class="notice mb16">此处修改「已存金额」仅直接更新目标进度，不会自动生成账户收支流水；如需记账请返回列表使用「存入」。</div>
<form method="post" action="/goals/${g.id}">${csrfInput(c)}
  <div class="grid grid-2">
    <div class="field"><label>目标名称</label><input name="name" value="${esc(g.name)}" required></div>
    <div class="field"><label>图标</label><input name="icon" value="${esc(g.icon || '🎯')}"></div>
    <div class="field"><label>目标金额（元）</label><input name="target" inputmode="decimal" value="${(Number(g.target_cents) / 100).toFixed(2)}" required></div>
    <div class="field"><label>已存金额（元）</label><input name="saved_amount" inputmode="decimal" value="${(Number(g.saved_cents) / 100).toFixed(2)}"></div>
    <div class="field"><label>关联账户</label><select name="account_id">${accountOptionsHtml(accounts, { selectedId: g.account_id, emptyLabel: '无关联账户' })}</select></div>
    <div class="field"><label>目标日期</label><input type="date" name="target_date" value="${esc(g.target_date || '')}"></div>
  </div>
  <div class="field"><label>备注</label><input name="note" value="${esc(g.note || '')}"></div>
  <div class="row mt12"><button class="btn btn-primary" type="submit">保存修改</button><a class="btn" href="/goals">取消</a></div>
</form></div>`,
    }),
  );
});

planningRoutes.post('/goals/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const lid = ledgerId(c);
  const id = Number(c.req.param('id'));
  const g = await db.get<GoalRow>('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', id, lid);
  if (!g) return c.redirect('/goals');
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 30);
  const target = Math.abs(u.parseAmountToCents(body.target));
  if (!name || !target) {
    setFlash(c, 'error', '请填写目标名称与大于 0 的目标金额');
    return c.redirect(`/goals/${id}/edit`);
  }
  const accountId = body.account_id ? Number(body.account_id) : null;
  if (accountId !== null) {
    try {
      await assertAccountInLedger(db, lid, accountId, { allowArchived: accountId === Number(g.account_id) });
    } catch (e) {
      setFlash(c, 'error', toPublicError(e));
      return c.redirect(`/goals/${id}/edit`);
    }
  }
  const saved = Math.max(0, u.parseAmountToCents(body.saved_amount));
  const status = saved >= target ? 'completed' : 'active';
  await db.run(
    'UPDATE goals SET name=?, icon=?, target_cents=?, saved_cents=?, account_id=?, target_date=?, status=?, note=? WHERE id=? AND ledger_id=?',
    name,
    String(body.icon || '🎯').slice(0, 8) || '🎯',
    target,
    saved,
    accountId,
    body.target_date || null,
    status,
    body.note ? String(body.note).slice(0, 200) : null,
    id,
    lid,
  );
  setFlash(c, 'success', '储蓄目标已更新');
  return c.redirect('/goals');
});

planningRoutes.post('/goals', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const lid = ledgerId(c);
  const body = await bodyOf(c);
  const target = Math.abs(u.parseAmountToCents(body.target));
  if (!target) {
    setFlash(c, 'error', '目标金额无效');
    return c.redirect('/goals');
  }
  const accountId = body.account_id ? Number(body.account_id) : null;
  if (accountId !== null) {
    try {
      await assertAccountInLedger(db, lid, accountId);
    } catch (e) {
      setFlash(c, 'error', toPublicError(e));
      return c.redirect('/goals');
    }
  }
  const saved = Math.max(0, u.parseAmountToCents(body.saved_amount));
  await db.run(
    'INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    lid,
    String(body.name || '').trim().slice(0, 30),
    String(body.icon || '🎯'),
    target,
    saved,
    accountId,
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
  const lid = ledgerId(c);
  const g = await db.get<{ id: number; name: string; target_cents: number; saved_cents: number; account_id: number | null; status: string }>(
    'SELECT * FROM goals WHERE id = ? AND ledger_id = ?',
    id,
    lid,
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
    try {
      await assertAccountInLedger(db, lid, accountId);
    } catch (e) {
      setFlash(c, 'error', toPublicError(e));
      return c.redirect('/goals');
    }
  }
  const prevSaved = Number(g.saved_cents);
  const saved = Math.max(0, prevSaved + amt);
  const done = Number(g.target_cents) > 0 && saved >= Number(g.target_cents);
  const claim = await db.run(
    'UPDATE goals SET saved_cents = ?, status = ? WHERE id = ? AND ledger_id = ? AND saved_cents = ?',
    saved,
    done ? 'completed' : 'active',
    id,
    lid,
    prevSaved,
  );
  if (Number(claim.changes || 0) !== 1) {
    setFlash(c, 'error', '储蓄目标刚被更新，请刷新重试');
    return c.redirect('/goals');
  }
  if (body.create_txn && accountId) {
    try {
      await txn.createTransaction(db, lid, ctx.user!.id, {
        type: amt > 0 ? 'expense' : 'income',
        amount_cents: Math.abs(amt),
        account_id: accountId,
        txn_date: todayStr(),
        note: `储蓄目标「${g.name}」${amt > 0 ? '存入' : '取出'}`,
        source: 'manual',
      });
    } catch (e) {
      await db
        .run(
          `UPDATE goals
           SET saved_cents = MAX(0, saved_cents - ?),
               status = CASE WHEN target_cents > 0 AND MAX(0, saved_cents - ?) >= target_cents THEN 'completed' ELSE 'active' END
           WHERE id = ? AND ledger_id = ?`,
          amt,
          amt,
          id,
          lid,
        )
        .catch(() => {});
      setFlash(c, 'error', toPublicError(e));
      return c.redirect('/goals');
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
