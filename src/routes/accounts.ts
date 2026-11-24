import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { deleteAccountIfUnreferenced, normalizeAccountWrite } from '../lib/accounts.js';
import * as fd from '../lib/formdata.js';
import * as sc from '../lib/session-cards.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { AccountRow, CategoryRow, HonoEnv } from '../types.js';
import { accountDetailPage, accountsPage, categoriesPage, tagsPage } from '../views/accounts.js';
import { layout } from '../views/layout.js';
import { bodyOf, dbOf, requireLedger, requireWrite, setFlash, siteMeta, takeFlash, toPublicError } from './helpers.js';

export const accountsRoutes = new Hono<HonoEnv>();

accountsRoutes.get('/accounts', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const ledgerId = Number(ctx.ledger!.id);
  const [rows, ov, sessionCards, expenseCats] = await Promise.all([
    db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? ORDER BY is_archived, sort_order, id', ledgerId),
    txn.accountOverview(db, ledgerId),
    sc.listSessionCards(db, ledgerId),
    fd.flatCategories(db, ledgerId, 'expense'),
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
      body: accountsPage({ accounts: rows, ov, sessionCards, expenseCats, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/accounts', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const body = await bodyOf(c);
  try {
    const data = normalizeAccountWrite(body, { mode: 'create', apiMode: false });
    await db.run(
      `INSERT INTO accounts
       (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day, due_day,
        institution, card_no, note, include_in_net, sort_order, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      Number(ctx.ledger!.id),
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.initial_cents ?? 0,
      data.balance_cents ?? 0,
      data.credit_limit,
      data.bill_day,
      data.due_day,
      data.institution,
      data.card_no,
      data.note,
      data.include_in_net,
      data.sort_order,
      nowStr(),
    );
    setFlash(c, 'success', '账户已创建');
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
  }
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
  const del = await deleteAccountIfUnreferenced(db, ledgerId, id);
  if (!del.ok) {
    setFlash(c, 'error', del.error);
    return c.redirect('/accounts');
  }
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
      body: accountDetailPage({ acc, groups, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.get('/accounts/:id/edit', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  return c.redirect(`/accounts/${Number(c.req.param('id'))}#edit`);
});

accountsRoutes.post('/accounts/:id/edit', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!existing) {
    setFlash(c, 'error', '账户不存在');
    return c.redirect('/accounts');
  }
  const body = await bodyOf(c);
  try {
    const data = normalizeAccountWrite(body, { mode: 'edit', existing, apiMode: false });
    await db.run(
      `UPDATE accounts
       SET name = ?, type = ?, icon = ?, currency = ?, include_in_net = ?, sort_order = ?,
           institution = ?, card_no = ?, note = ?, credit_limit = ?, bill_day = ?, due_day = ?
       WHERE id = ? AND ledger_id = ?`,
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.include_in_net,
      data.sort_order,
      data.institution,
      data.card_no,
      data.note,
      data.credit_limit,
      data.bill_day,
      data.due_day,
      id,
      ledgerId,
    );
    setFlash(c, 'success', '账户信息已更新');
    return c.redirect(`/accounts/${id}`);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(`/accounts/${id}#edit`);
  }
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
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const body = await bodyOf(c);
  const name = String(body.name || '').trim();
  if (!name) {
    setFlash(c, 'error', '请填写分类名称');
    return c.redirect('/categories');
  }
  let parentId: number | null = body.parent_id ? Number(body.parent_id) : null;
  let kind: 'expense' | 'income' = body.kind === 'income' ? 'income' : 'expense';
  let color = '#8c8c8c';
  if (parentId) {
    const parent = await db.get<CategoryRow>(
      'SELECT id, kind, parent_id, color FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
      parentId,
      ledgerId,
    );
    if (!parent) {
      setFlash(c, 'error', '所属一级分类不存在');
      return c.redirect('/categories');
    }
    if (parent.parent_id != null) {
      setFlash(c, 'error', '仅支持二级分类，不能在二级分类下继续新建子分类');
      return c.redirect('/categories');
    }
    kind = parent.kind;
    color = parent.color || color;
    parentId = Number(parent.id);
  }
  await db.run(
    'INSERT INTO categories (ledger_id, parent_id, kind, name, icon, color, sort_order) VALUES (?,?,?,?,?,?,0)',
    ledgerId,
    parentId,
    kind,
    name.slice(0, 20),
    String(body.icon || '🏷️').slice(0, 8) || '🏷️',
    color,
  );
  setFlash(c, 'success', parentId ? '二级分类已添加' : '一级分类已添加');
  return c.redirect('/categories');
});

accountsRoutes.post('/categories/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const cat = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0',
    id,
    ledgerId,
  );
  if (!cat) {
    setFlash(c, 'error', '仅可编辑当前账本的自定义分类');
    return c.redirect('/categories');
  }
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 20);
  if (!name) {
    setFlash(c, 'error', '分类名称不能为空');
    return c.redirect('/categories');
  }
  const iconRaw = body.icon !== undefined ? String(body.icon || '').trim() : '';
  const icon = (iconRaw || cat.icon || '🏷️').slice(0, 8);
  await db.run(
    'UPDATE categories SET name = ?, icon = ? WHERE id = ? AND ledger_id = ? AND is_system = 0',
    name,
    icon,
    id,
    ledgerId,
  );
  setFlash(c, 'success', '分类已更新');
  return c.redirect('/categories');
});

accountsRoutes.post('/categories/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const cat = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0',
    id,
    ledgerId,
  );
  if (!cat) {
    setFlash(c, 'error', '仅可删除当前账本的自定义分类');
    return c.redirect('/categories');
  }
  const childCnt = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND ledger_id = ?',
        id,
        ledgerId,
      )
    )?.c || 0,
  );
  if (childCnt) {
    setFlash(c, 'error', `该分类下还有 ${childCnt} 个子分类，请先删除子分类`);
    return c.redirect('/categories');
  }
  const used = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND category_id = ? AND deleted_at IS NULL',
        ledgerId,
        id,
      )
    )?.c || 0,
  );
  if (used) {
    setFlash(c, 'error', `该分类下还有 ${used} 笔记账，无法删除`);
    return c.redirect('/categories');
  }
  await db.run('DELETE FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0', id, ledgerId);
  setFlash(c, 'success', '分类已删除');
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

accountsRoutes.post('/tags/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const tag = await db.get<{ id: number; name: string }>(
    'SELECT id, name FROM tags WHERE id = ? AND ledger_id = ?',
    id,
    ledgerId,
  );
  if (!tag) {
    setFlash(c, 'error', '标签不存在');
    return c.redirect('/tags');
  }
  const name = String((await bodyOf(c)).name || '').trim().slice(0, 20);
  if (!name) {
    setFlash(c, 'error', '标签名称不能为空');
    return c.redirect('/tags');
  }
  const dup = await db.get<{ id: number }>(
    'SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND id != ?',
    ledgerId,
    name,
    id,
  );
  if (dup) {
    setFlash(c, 'error', `标签「${name}」已存在`);
    return c.redirect('/tags');
  }
  await db.run('UPDATE tags SET name = ? WHERE id = ? AND ledger_id = ?', name, id, ledgerId);
  setFlash(c, 'success', '标签已更新');
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
