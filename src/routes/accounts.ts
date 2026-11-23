import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import { esc, fmtAmount } from '../lib/util.js';
import type { AccountRow, CategoryRow, HonoEnv } from '../types.js';
import { accountsPage, categoriesPage, tagsPage } from '../views/accounts.js';
import { groupList, layout } from '../views/layout.js';
import { bodyOf, dbOf, requireLedger, requireLogin, requireWrite, setFlash, siteMeta, takeFlash } from './helpers.js';

export const accountsRoutes = new Hono<HonoEnv>();

accountsRoutes.get('/accounts', async (c) => {
  const r = requireLogin(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  if (!ctx.ledger) return c.redirect('/');
  const ledgerId = Number(ctx.ledger.id);
  const [rows, ov] = await Promise.all([
    db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? ORDER BY is_archived, sort_order, id', ledgerId),
    txn.accountOverview(db, ledgerId),
  ]);
  return c.html(
    layout({
      title: '账户管理',
      activeNav: 'accounts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: accountsPage({ accounts: rows, ov, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/accounts', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (!name) {
    setFlash(c, 'error', '请填写账户名称');
    return c.redirect('/accounts');
  }
  const opening = u.parseAmountToCents(body.balance);
  await db.run(
    'INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, include_in_net, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    Number(ctx.ledger!.id),
    name.slice(0, 30),
    String(body.type || 'cash'),
    String(body.icon || '💳'),
    String(body.currency || 'CNY'),
    opening,
    opening,
    body.include_in_net ? 1 : 0,
    nowStr(),
  );
  setFlash(c, 'success', '账户已创建');
  return c.redirect('/accounts');
});

accountsRoutes.post('/accounts/:id/archive', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const row = await db.get<{ is_archived: number }>('SELECT is_archived FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (row) await db.run('UPDATE accounts SET is_archived = ? WHERE id = ?', row.is_archived ? 0 : 1, id);
  return c.redirect('/accounts');
});

accountsRoutes.post('/accounts/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const used = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND (account_id = ? OR to_account_id = ?) AND deleted_at IS NULL',
        ledgerId,
        id,
        id,
      )
    )?.c || 0,
  );
  if (used) {
    setFlash(c, 'error', `该账户还有 ${used} 笔未删除记账，无法删除`);
    return c.redirect('/accounts');
  }
  await db.run('DELETE FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  setFlash(c, 'success', '账户已删除');
  return c.redirect('/accounts');
});

accountsRoutes.post('/accounts/:id/adjust', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  const id = Number(c.req.param('id'));
  const ledgerId = Number(ctx.ledger!.id);
  const raw = body.actual_balance ?? body.balance;
  const cleaned = String(raw ?? '').trim().replace(/[¥$€£,\s元块圆]/g, '');
  if (!/^-?\d{1,12}(\.\d{0,4})?$/.test(cleaned)) {
    setFlash(c, 'error', '金额格式不正确');
    return c.redirect('/accounts');
  }
  const target = u.parseAmountToCents(raw);
  const acc = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!acc || acc.is_archived) {
    setFlash(c, 'error', '账户不存在或已归档');
    return c.redirect('/accounts');
  }
  const diff = target - Number(acc.balance_cents);
  if (diff !== 0) {
    const claim = await db.run(
      'UPDATE accounts SET balance_cents = ? WHERE id = ? AND ledger_id = ? AND balance_cents = ?',
      target,
      id,
      ledgerId,
      Number(acc.balance_cents),
    );
    if (claim.changes !== 1) {
      setFlash(c, 'error', '余额已被修改，请刷新后重试');
      return c.redirect('/accounts');
    }
    try {
      await txn.createTransaction(db, ledgerId, ctx.user!.id, {
        type: 'adjust',
        amount_cents: diff,
        currency: acc.currency || 'CNY',
        rate: 1,
        account_id: id,
        txn_date: String(body.adjust_date || todayStr()),
        note: `余额校准：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(target)}`,
        source: 'manual',
        skipBalanceDelta: true,
      });
    } catch (e) {
      await db.run(
        'UPDATE accounts SET balance_cents = ? WHERE id = ? AND ledger_id = ? AND balance_cents = ?',
        Number(acc.balance_cents),
        id,
        ledgerId,
        target,
      );
      throw e;
    }
  }
  setFlash(c, 'success', diff === 0 ? '余额一致，无需调整' : `已调整 ${u.signedMoney(diff)}，余额已对齐`);
  return c.redirect(`/accounts/${id}`);
});

accountsRoutes.get('/accounts/:id', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const id = Number(c.req.param('id'));
  const acc = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, Number(ctx.ledger!.id));
  if (!acc) {
    return c.html(
      layout({
        title: '账户不存在',
        ctx,
        siteName: meta.siteName,
        csrf: c.get('csrf') || '',
        cspNonce: c.get('cspNonce'),
        body: '<div class="card">账户不存在。</div>',
      }),
      404,
    );
  }
  const result = await txn.listTransactions(db, Number(ctx.ledger!.id), { accountId: id, page: 1, pageSize: 30 });
  const groups = await txn.groupByDate(result.rows, db);
  return c.html(
    layout({
      title: acc.name,
      activeNav: 'accounts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: `<div class="card mb16">
  <div class="card-head"><b>${esc(acc.icon)} ${esc(acc.name)}</b><span class="amount bold">当前余额 ${fmtAmount(acc.balance_cents)}</span></div>
  <form method="post" action="/accounts/${id}/adjust" class="row wrap">
    <input type="hidden" name="_csrf" value="${esc(c.get('csrf') || '')}">
    <input name="actual_balance" inputmode="decimal" placeholder="校准到（元）" value="${(Number(acc.balance_cents) / 100).toFixed(2)}" style="max-width:200px">
    <button class="btn btn-primary" type="submit">校准余额</button>
  </form>
</div>
<div class="card">${groupList(groups)}</div>`,
    }),
  );
});

accountsRoutes.get('/categories', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<CategoryRow>(
    'SELECT * FROM categories WHERE ledger_id IS NULL OR ledger_id = ? ORDER BY kind, sort_order, id',
    Number(ctx.ledger!.id),
  );
  const tree = rows
    .filter((x) => !x.parent_id)
    .map((root) => ({ ...root, children: rows.filter((x) => Number(x.parent_id) === Number(root.id)) }));
  return c.html(
    layout({
      title: '分类管理',
      activeNav: 'categories',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: categoriesPage({ tree, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/categories', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (name) {
    await db.run(
      'INSERT INTO categories (ledger_id, parent_id, kind, name, icon, sort_order) VALUES (?,?,?,?,?,0)',
      Number(c.get('ctx').ledger!.id),
      body.parent_id ? Number(body.parent_id) : null,
      body.kind === 'income' ? 'income' : 'expense',
      name.slice(0, 20),
      String(body.icon || '🏷️'),
    );
    setFlash(c, 'success', '分类已添加');
  }
  return c.redirect('/categories');
});

accountsRoutes.post('/categories/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const used = Number(
    (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM transactions WHERE category_id = ? AND deleted_at IS NULL', id))
      ?.c || 0,
  );
  if (used) {
    setFlash(c, 'error', `该分类下还有 ${used} 笔记账，无法删除`);
    return c.redirect('/categories');
  }
  await db.run('DELETE FROM categories WHERE id = ? AND ledger_id = ?', id, Number(c.get('ctx').ledger!.id));
  return c.redirect('/categories');
});

accountsRoutes.get('/tags', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<{ id: number; name: string; cnt: number }>(
    'SELECT t.id, t.name, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt FROM tags t WHERE t.ledger_id = ? ORDER BY t.name',
    Number(ctx.ledger!.id),
  );
  return c.html(
    layout({
      title: '标签管理',
      activeNav: 'tags',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: tagsPage({ tags: rows, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/tags', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const name = String((await bodyOf(c)).name || '').trim();
  if (name) {
    await db.run(
      'INSERT OR IGNORE INTO tags (ledger_id, name, color) VALUES (?,?,?)',
      Number(c.get('ctx').ledger!.id),
      name.slice(0, 20),
      '#0F766E',
    );
  }
  return c.redirect('/tags');
});

accountsRoutes.post('/tags/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  await db.batch([
    ['DELETE FROM transaction_tags WHERE tag_id = ?', [id]],
    ['DELETE FROM tags WHERE id = ? AND ledger_id = ?', [id, Number(c.get('ctx').ledger!.id)]],
  ]);
  return c.redirect('/tags');
});
