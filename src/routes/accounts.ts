import { Hono } from 'hono';
import { nowStr, todayStr } from '../db.js';
import { deleteAccountIfUnreferenced, normalizeAccountWrite } from '../lib/accounts.js';
import * as auth from '../lib/auth.js';
import * as fd from '../lib/formdata.js';
import * as sc from '../lib/session-cards.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { AccountRow, CategoryRow, HonoEnv } from '../types.js';
import { accountDetailPage, accountsPage, categoriesPage, tagsPage } from '../views/accounts.js';
import { layout } from '../views/layout.js';
import { archivedLedgerResponse, bodyOf, dbOf, requireLedger, requireWrite, setFlash, siteMeta, takeFlash, toPublicError } from './helpers.js';

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
      body: accountsPage({ writable: auth.canWriteLedger(ctx.ledger), accounts: rows, ov, sessionCards, expenseCats, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/accounts', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const body = await bodyOf(c);
  try {
    const data = normalizeAccountWrite(body, { mode: 'create', apiMode: false });
    const created = await db.run(
      `INSERT INTO accounts
       (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day, due_day,
        institution, card_no, note, include_in_net, sort_order, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
      ledgerId,
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
      ledgerId,
    );
    if (!created.changes) return archivedLedgerResponse(c);
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
  if (row) {
    const result = await db.run(`UPDATE accounts SET is_archived = 1 - is_archived WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
      id, ledgerId, ledgerId);
    if (!result.changes) return archivedLedgerResponse(c);
  }
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
    try {
      await txn.createTransaction(db, ledgerId, ctx.user!.id, {
        type: 'adjust',
        amount_cents: diff,
        currency: acc.currency,
        account_id: id,
        txn_date: String(body.adjust_date || todayStr()),
        note: `余额校准：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(target)}`,
        source: 'manual',
        expectedBalanceCents: Number(acc.balance_cents),
      });
    } catch (e) {
      setFlash(c, 'error', toPublicError(e));
      return c.redirect(`/accounts/${id}`);
    }
  }
  setFlash(c, 'success', diff === 0 ? '余额一致，无需调整' : `已调整 ${u.signedMoney(diff, acc.currency)}，余额已对齐`);
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
  const q = c.req.query();
  const validDay = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
  };
  let from = validDay(String(q.from || '').trim());
  let to = validDay(String(q.to || '').trim());
  if (from && to && from > to) [from, to] = [to, from];
  const page = Math.max(1, Number(q.page) || 1);
  const result = await txn.listTransactions(db, Number(ctx.ledger!.id), {
    accountId: id,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: 30,
  });
  const [groups, unresolved] = await Promise.all([
    txn.groupByDate(result.rows, db),
    db.all<{ id: number; txn_date: string }>(
      `SELECT id, txn_date FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL
       AND ((account_id = ? AND account_amount_cents IS NULL)
            OR (to_account_id = ? AND to_account_amount_cents IS NULL AND type IN ('transfer','invest_buy','invest_sell')))
       ORDER BY txn_date DESC, id DESC LIMIT 30`,
      Number(ctx.ledger!.id), id, id,
    ),
  ]);
  return c.html(
    layout({
      title: acc.name,
      activeNav: 'accounts',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: accountDetailPage({
        acc,
        groups,
        unresolved,
        result,
        from,
        to,
        writable: auth.canWriteLedger(ctx.ledger),
        csrf: c.get('csrf') || '',
      }),
    }),
  );
});

accountsRoutes.get('/accounts/:id/edit', async (c) => {
  const r = requireWrite(c);
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
       WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
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
      ledgerId,
    );
    setFlash(c, 'success', '账户信息已更新');
    return c.redirect(`/accounts/${id}`);
  } catch (e) {
    setFlash(c, 'error', toPublicError(e));
    return c.redirect(`/accounts/${id}#edit`);
  }
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const pickHexColor = (v: unknown): string | null => {
  const s = String(v || '').trim();
  return HEX_COLOR_RE.test(s) ? s.toLowerCase() : null;
};

accountsRoutes.get('/categories', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const ledgerId = Number(ctx.ledger!.id);
  const since = u.addDays(todayStr(), -365);
  const [rows, statsRows] = await Promise.all([
    db.all<CategoryRow>(
      'SELECT * FROM categories WHERE ledger_id IS NULL OR ledger_id = ? ORDER BY kind, sort_order, id',
      ledgerId,
    ),
    db.all<{ category_id: number; cnt: number; total: number }>(
      `SELECT category_id, COUNT(*) AS cnt, COALESCE(SUM(amount_base_cents), 0) AS total
       FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date >= ? AND category_id IS NOT NULL
       GROUP BY category_id`,
      ledgerId,
      since,
    ),
  ]);
  const statMap = new Map(statsRows.map((s) => [Number(s.category_id), { cnt: Number(s.cnt), total: Number(s.total) }]));
  const tree = rows
    .filter((x) => !x.parent_id)
    .map((root) => {
      const children = rows
        .filter((x) => Number(x.parent_id) === Number(root.id))
        .map((ch) => {
          const st = statMap.get(Number(ch.id)) || { cnt: 0, total: 0 };
          return { ...ch, year_cnt: st.cnt, year_total_cents: st.total };
        });
      const own = statMap.get(Number(root.id)) || { cnt: 0, total: 0 };
      const yearCnt = own.cnt + children.reduce((s, ch) => s + ch.year_cnt, 0);
      const yearTotal = own.total + children.reduce((s, ch) => s + ch.year_total_cents, 0);
      return { ...root, year_cnt: yearCnt, year_total_cents: yearTotal, children };
    });
  return c.html(
    layout({
      title: '分类管理',
      activeNav: 'categories',
      ctx,
      siteName: meta.siteName,
      csrf: c.get('csrf') || '',
      cspNonce: c.get('cspNonce'),
      flash: takeFlash(c),
      body: categoriesPage({ writable: auth.canWriteLedger(ctx.ledger), tree, csrf: c.get('csrf') || '' }),
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
  let color = pickHexColor(body.color) || u.colorFor(name);
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
    color = pickHexColor(body.color) || parent.color || color;
    parentId = Number(parent.id);
  }
  const created = await db.run(
    `INSERT INTO categories (ledger_id, parent_id, kind, name, icon, color, sort_order) SELECT ?,?,?,?,?,?,0 WHERE ${txn.activeLedgerGuard}`,
    ledgerId,
    parentId,
    kind,
    name.slice(0, 20),
    String(body.icon || '🏷️').slice(0, 8) || '🏷️',
    color,
    ledgerId,
  );
  if (!created.changes) return archivedLedgerResponse(c);
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
  const color = pickHexColor(body.color) || cat.color || u.colorFor(name);
  await db.run(
    `UPDATE categories SET name = ?, icon = ?, color = ? WHERE id = ? AND ledger_id = ? AND is_system = 0 AND ${txn.activeLedgerGuard}`,
    name,
    icon,
    color,
    id,
    ledgerId,
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
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND category_id = ?',
        ledgerId,
        id,
      )
    )?.c || 0,
  );
  if (used) {
    setFlash(c, 'error', `该分类下还有 ${used} 笔记账，无法删除`);
    return c.redirect('/categories');
  }
  await db.run(`DELETE FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0 AND ${txn.activeLedgerGuard}`, id, ledgerId, ledgerId);
  setFlash(c, 'success', '分类已删除');
  return c.redirect('/categories');
});

accountsRoutes.get('/tags', async (c) => {
  const r = requireLedger(c);
  if (r) return r;
  const db = dbOf(c);
  const ctx = c.get('ctx');
  const meta = await siteMeta(c);
  const rows = await db.all<{ id: number; name: string; color: string; cnt: number; total_cents: number }>(
    `SELECT t.id, t.name, t.color,
            COUNT(tx.id) AS cnt,
            COALESCE(SUM(tx.amount_base_cents), 0) AS total_cents
     FROM tags t
     LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
     LEFT JOIN transactions tx ON tx.id = tt.transaction_id AND tx.ledger_id = t.ledger_id AND tx.deleted_at IS NULL
     WHERE t.ledger_id = ?
     GROUP BY t.id
     ORDER BY t.name`,
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
      body: tagsPage({ writable: auth.canWriteLedger(ctx.ledger), tags: rows, csrf: c.get('csrf') || '' }),
    }),
  );
});

accountsRoutes.post('/tags', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 20);
  if (name) {
    const color = pickHexColor(body.color) || u.colorFor(name);
    const ledgerId = Number(c.get('ctx').ledger!.id);
    const result = await db.run(
      `INSERT OR IGNORE INTO tags (ledger_id, name, color) SELECT ?,?,? WHERE ${txn.activeLedgerGuard}`,
      ledgerId, name, color, ledgerId,
    );
    if (!result.changes && !(await db.get('SELECT id FROM ledgers WHERE id = ? AND is_archived = 0', ledgerId))) {
      return archivedLedgerResponse(c);
    }
  }
  return c.redirect('/tags');
});

accountsRoutes.post('/tags/:id', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const ledgerId = Number(c.get('ctx').ledger!.id);
  const id = Number(c.req.param('id'));
  const tag = await db.get<{ id: number; name: string; color: string }>(
    'SELECT id, name, color FROM tags WHERE id = ? AND ledger_id = ?',
    id,
    ledgerId,
  );
  if (!tag) {
    setFlash(c, 'error', '标签不存在');
    return c.redirect('/tags');
  }
  const body = await bodyOf(c);
  const name = String(body.name || '').trim().slice(0, 20);
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
  const color = pickHexColor(body.color) || tag.color || u.colorFor(name);
  await db.run(`UPDATE tags SET name = ?, color = ? WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, name, color, id, ledgerId, ledgerId);
  setFlash(c, 'success', '标签已更新');
  return c.redirect('/tags');
});

accountsRoutes.post('/tags/:id/delete', async (c) => {
  const r = requireWrite(c);
  if (r) return r;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const ledgerId = Number(c.get('ctx').ledger!.id);
  await db.batch([
    [`DELETE FROM transaction_tags WHERE tag_id = ? AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND ledger_id = ?) AND ${txn.activeLedgerGuard}`, [id, id, ledgerId, ledgerId]],
    [`DELETE FROM tags WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, [id, ledgerId, ledgerId]],
  ]);
  return c.redirect('/tags');
});
