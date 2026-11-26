import { registerRolloverOpenApi } from './ledger-rollover.js';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { accountGroupOf, isCreditGroupType, nowStr, todayStr, TXN_TYPE_MAP } from '../db.js';
import {
  creditMetrics,
  deleteAccountIfUnreferenced,
  groupAccountsSummary,
  normalizeAccountWrite,
} from '../lib/accounts.js';
import { analyzeBill } from '../lib/ai.js';
import * as attach from '../lib/attachments.js';
import * as auth from '../lib/auth.js';
import { BACKUP_TABLES } from '../lib/backup.js';
import * as fd from '../lib/formdata.js';
import {
  budgetAmountInBaseCents,
  budgetPeriodRange,
  budgetUsedInRange,
  effectiveBudget,
  tzRefDate,
  type BudgetRow,
  type RecurringRuleRow,
} from '../lib/scheduler.js';
import * as sc from '../lib/session-cards.js';
import { overview as subsOverview } from '../lib/subscriptions.js';
import * as txn from '../lib/txn.js';
import * as u from '../lib/util.js';
import type { AccountRow, CategoryRow, Db, HonoEnv, Role } from '../types.js';
import {
  buildAiJson,
  cleanupSavedAiImages,
  extractRawImages,
  findDuplicateAiTxn,
  MAX_AI_TEXT_LEN,
  saveAiImagesBestEffort,
  validateRawImages,
  type SavedAiImage,
} from './ai.js';
import { dbOf, envOf, toPublicError } from './helpers.js';
import {
  parseAmountField,
  parseBoolFlag,
  parseOptionalDate,
  parseOptionalRefId,
  parsePositiveIntId,
  readJsonObject,
  requireWriteApi,
} from './openapi-helpers.js';
import { registerPlanningOpenApi } from './openapi-planning.js';
import { parseReportRange } from './reports.js';

export const openapiRoutes = new Hono<HonoEnv>();

const TXN_TYPE_ALIASES: Record<string, string> = {
  支出: 'expense',
  收入: 'income',
  转账: 'transfer',
  借出: 'lend',
  借入: 'borrow',
  收款: 'repay_receive',
  收回借款: 'repay_receive',
  还款: 'repay_pay',
  偿还借款: 'repay_pay',
  报销: 'reimburse',
  报销入账: 'reimburse',
  退款: 'refund',
  手续费: 'fee',
  利息: 'interest',
  利息收入: 'interest',
  买入: 'invest_buy',
  投资买入: 'invest_buy',
  卖出: 'invest_sell',
  投资卖出: 'invest_sell',
  校准: 'adjust',
  余额调整: 'adjust',
};

function normName(s: string): string {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

async function resolveCategoryIdByName(
  db: Db,
  ledgerId: number,
  nameHint: string,
  txnType: string,
): Promise<number | null> {
  const hint = normName(nameHint);
  if (!hint) return null;
  const kind = (txn.INCOME_TYPES as readonly string[]).includes(txnType)
    ? 'income'
    : (txn.EXPENSE_TYPES as readonly string[]).includes(txnType)
      ? 'expense'
      : null;
  const rows = await fd.flatCategories(db, ledgerId, kind);
  for (const c of rows) {
    if (normName(c.path) === hint || normName(c.name) === hint) return Number(c.id);
  }
  const tail = hint.includes('/') ? hint.split('/').pop() || hint : hint;
  for (const c of rows) {
    if (normName(c.name) === tail) return Number(c.id);
  }
  return null;
}

async function lookupAccountIdByName(db: Db, ledgerId: number, nameHint: string): Promise<number | null> {
  const cleanName = nameHint.trim().slice(0, 30);
  if (!cleanName) return null;
  const target = normName(cleanName);
  const accounts = await db.all<AccountRow>(
    'SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id',
    ledgerId,
  );
  for (const a of accounts) {
    if (normName(a.name) === target) return Number(a.id);
  }
  return null;
}

async function createAutoAccount(
  db: Db,
  ledgerId: number,
  cleanName: string,
  createdAccounts: string[],
): Promise<number> {
  const type = /信用|花呗|白条|分期/.test(cleanName)
    ? 'credit'
    : /储值|充值|预付|会员卡|礼品卡/.test(cleanName)
      ? 'prepaid'
      : /支付宝|微信|京东|云闪付/.test(cleanName)
        ? 'virtual'
        : /银行|卡/.test(cleanName)
          ? 'debit'
          : 'other';
  const icon = type === 'credit' ? '💳' : type === 'prepaid' ? '🎟️' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const res = await db.run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     SELECT ?,?,?,?,?,0,0,999,?,? WHERE ${txn.activeLedgerGuard}`,
    ledgerId,
    cleanName,
    type,
    icon,
    'CNY',
    '由开放 API 自动创建',
    nowStr(),
    ledgerId,
  );
  if (!res.changes) throw new Error('账本已归档，只能查阅和导出');
  createdAccounts.push(cleanName);
  return Number(res.lastInsertRowid);
}

function extractBearer(c: Context<HonoEnv>): string | null {
  const authz = c.req.header('authorization') || '';
  if (/^Bearer\s+/i.test(authz)) return authz.replace(/^Bearer\s+/i, '').trim();
  const key = c.req.header('x-api-key');
  return key ? key.trim() : null;
}

openapiRoutes.use('*', async (c, next) => {
  const raw = extractBearer(c);
  if (!raw) return c.json({ ok: false, error: '缺少 Bearer Token' }, 401);

  const db = dbOf(c);
  const hash = await auth.sha256Hex(raw);
  // 按 D1 红线约定：Bearer 鉴权保持纯只读，严禁更新 api_tokens.last_used_at
  const row = await db.get<{
    token_id: number;
    user_id: number;
    ledger_id: number | null;
    token_name: string;
    expires_at: string | null;
    username: string;
    display_name: string;
    status: string;
    is_admin: number;
  }>(
    `SELECT t.id AS token_id, t.user_id, t.ledger_id, t.name AS token_name, t.expires_at,
            u.username, u.display_name, u.status, u.is_admin
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    hash,
  );

  if (!row || row.status !== 'active') {
    return c.json({ ok: false, error: '无效或已吊销的 API 令牌' }, 401);
  }
  if (row.expires_at && row.expires_at < nowStr()) {
    return c.json({ ok: false, error: 'API 令牌已过期' }, 401);
  }

  const requestedLedger = Number(c.req.query('ledger_id') || c.req.header('x-ledger-id') || row.ledger_id || 0);
  const member = await db.get<{ ledger_id: number; role: Role; is_archived: number }>(
    `SELECT m.ledger_id, m.role, l.is_archived
     FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
     WHERE m.user_id = ? AND ${requestedLedger ? 'l.id = ?' : 'l.is_archived = 0'} ORDER BY m.id LIMIT 1`,
    ...(requestedLedger ? [row.user_id, requestedLedger] : [row.user_id]),
  );
  if (!member) {
    return c.json({ ok: false, error: '无权访问目标账本' }, 403);
  }

  c.set('openAuth', {
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    ledgerId: Number(member.ledger_id),
    archived: Boolean(member.is_archived),
    role: member.role as NonNullable<HonoEnv['Variables']['openAuth']>['role'],
    tokenId: Number(row.token_id),
    tokenName: row.token_name,
  });

  await next();
});

openapiRoutes.get('/ping', (c) => {
  const oa = c.get('openAuth')!;
  return c.json({
    ok: true,
    app: 'homeledger',
    today: todayStr(),
    user: { id: oa.userId, username: oa.username, display_name: oa.displayName, is_admin: oa.isAdmin },
    ledger_id: oa.ledgerId,
    role: oa.role,
    token: { id: oa.tokenId, name: oa.tokenName },
    time: nowStr(),
  });
});

openapiRoutes.get('/transactions/recent', async (c) => {
  const oa = c.get('openAuth')!;
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') || 15)));
  const db = dbOf(c);
  const res = await txn.listTransactions(db, oa.ledgerId, { page: 1, pageSize: limit });
  const imgMap = await attach.listByTxnIds(
    db,
    res.rows.map((r) => Number(r.id)),
  );
  const rowsWithImages = res.rows.map((row) => ({
    ...row,
    images: (imgMap.get(Number(row.id)) || []).map((img) => ({
      id: img.id,
      url: img.url || attach.webUrl(img.rel_path),
      path: img.rel_path,
      api_url: `/api/open/attachments/${img.id}`,
      file_name: img.file_name,
      mime: img.mime,
      size: img.size,
      txn_id: img.txn_id,
    })),
  }));
  return c.json({
    ok: true,
    ledger_id: oa.ledgerId,
    items: rowsWithImages,
    transactions: rowsWithImages,
    total: res.total,
    count: rowsWithImages.length,
  });
});

openapiRoutes.get('/transactions', async (c) => {
  const oa = c.get('openAuth')!;
  const q = c.req.query();
  const res = await txn.listTransactions(dbOf(c), oa.ledgerId, {
    type: q.type || undefined,
    kind: q.kind === 'expense' || q.kind === 'income' ? q.kind : undefined,
    month: q.month || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    keyword: q.q || undefined,
    categoryId: q.category_id ? Number(q.category_id) : undefined,
    accountId: q.account_id ? Number(q.account_id) : undefined,
    page: Math.max(1, Number(q.page || 1)),
    pageSize: Math.max(1, Math.min(200, Number(q.page_size || 40))),
  });
  return c.json({ ok: true, ledger_id: oa.ledgerId, ...res });
});

openapiRoutes.get('/transactions/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const row = await txn.getTransaction(dbOf(c), Number(c.req.param('id')), oa.ledgerId);
  if (!row) return c.json({ ok: false, error: '记录不存在' }, 404);
  return c.json({ ok: true, transaction: row });
});

openapiRoutes.post('/transactions', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const rawType = String(body.type || 'expense').trim();
    const type = TXN_TYPE_ALIASES[rawType] || rawType;
    if (!TXN_TYPE_MAP[type]) {
      return c.json({ ok: false, error: `无效的交易类型（${rawType}）` }, 400);
    }
    const rawCents = body.amount_cents != null ? Math.round(Number(body.amount_cents)) : u.parseAmountToCents(body.amount);
    const amountCents = type === 'adjust' ? rawCents : Math.abs(rawCents);
    if (!Number.isFinite(amountCents) || !amountCents) {
      return c.json({ ok: false, error: '金额必须大于 0' }, 400);
    }

    const currency = String(body.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
    await txn.resolveRate(db, currency, (body.rate as string | number | null) ?? null);

    let toAccountId: string | number | null = (body.to_account_id as string | number | null) ?? null;
    let pendingAutoToAccName: string | null = null;
    if (!toAccountId) {
      const toAccName = String(body.to_account ?? body.to_account_name ?? '').trim().slice(0, 30);
      if (toAccName) {
        const foundTo = await lookupAccountIdByName(db, oa.ledgerId, toAccName);
        if (foundTo) {
          toAccountId = foundTo;
        } else {
          if (body.auto_create_account === false) throw new Error(`账户「${toAccName}」不存在`);
          pendingAutoToAccName = toAccName;
        }
      }
    }

    let accountId: string | number | null = (body.account_id as string | number | null) ?? null;
    let pendingAutoAccName: string | null = null;
    if (!accountId) {
      const accName = String(body.account ?? body.account_name ?? '').trim().slice(0, 30);
      if (accName) {
        const foundAcc = await lookupAccountIdByName(db, oa.ledgerId, accName);
        if (foundAcc) {
          accountId = foundAcc;
        } else {
          if (body.auto_create_account === false) throw new Error(`账户「${accName}」不存在`);
          pendingAutoAccName = accName;
        }
      }
    }

    if ((type === 'transfer' || type === 'invest_buy' || type === 'invest_sell') && !toAccountId && !pendingAutoToAccName) {
      throw new Error(type === 'transfer' ? '转账需要选择转出与转入账户' : '投资交易需要选择资金账户与投资账户');
    }
    if ((type === 'transfer' || type === 'invest_buy' || type === 'invest_sell')) {
      if (accountId && toAccountId && Number(accountId) === Number(toAccountId)) {
        throw new Error(type === 'transfer' ? '转出与转入账户不能相同' : '资金账户与投资账户不能相同');
      }
      if (pendingAutoAccName && pendingAutoToAccName && normName(pendingAutoAccName) === normName(pendingAutoToAccName)) {
        throw new Error(type === 'transfer' ? '转出与转入账户不能相同' : '资金账户与投资账户不能相同');
      }
    }

    let categoryId: string | number | null = (body.category_id as string | number | null) ?? null;
    if (!categoryId) {
      const catName = String(body.category ?? body.category_name ?? '').trim();
      if (catName) {
        categoryId = await resolveCategoryIdByName(db, oa.ledgerId, catName, type);
      }
    }

    const txnDate = String(body.txn_date ?? body.date ?? todayStr()).trim() || todayStr();

    const createdAccounts: string[] = [];
    const autoCreatedAccountIds: number[] = [];
    let id: number;
    try {
      if (!accountId && pendingAutoAccName) {
        const newAccId = await createAutoAccount(db, oa.ledgerId, pendingAutoAccName, createdAccounts);
        autoCreatedAccountIds.push(newAccId);
        accountId = newAccId;
      }
      if (!toAccountId && pendingAutoToAccName) {
        if (pendingAutoAccName && normName(pendingAutoAccName) === normName(pendingAutoToAccName) && autoCreatedAccountIds[0]) {
          toAccountId = autoCreatedAccountIds[0];
        } else {
          const newToAccId = await createAutoAccount(db, oa.ledgerId, pendingAutoToAccName, createdAccounts);
          autoCreatedAccountIds.push(newToAccId);
          toAccountId = newToAccId;
        }
      }
      id = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
        type,
        amount_cents: amountCents,
        currency,
        rate: (body.rate as string | number | null) ?? null,
        account_id: accountId,
        to_account_id: toAccountId,
        account_amount_cents: body.account_amount_cents == null ? undefined : Number(body.account_amount_cents),
        to_account_amount_cents: body.to_account_amount_cents == null ? undefined : Number(body.to_account_amount_cents),
        category_id: categoryId,
        txn_date: txnDate,
        note: body.note != null ? String(body.note) : null,
        merchant: body.merchant != null ? String(body.merchant) : null,
        status: String(body.status || 'cleared'),
        is_reimbursable: body.is_reimbursable ? 1 : 0,
        tags: String(body.tags || ''),
        source: String(body.source || 'openapi').slice(0, 30),
      });
    } catch (err) {
      for (const accId of autoCreatedAccountIds) {
        await db.run(`DELETE FROM accounts WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, accId, oa.ledgerId, oa.ledgerId).catch(() => {});
      }
      createdAccounts.length = 0;
      throw err;
    }
    const created = await txn.getTransaction(db, id, oa.ledgerId);
    return c.json(
      {
        ok: true,
        id,
        transaction: created,
        accounts_created: createdAccounts,
        category_resolved: created?.category_id
          ? {
              id: Number(created.category_id),
              name: created.category_name || null,
              path: created.category_path || null,
            }
          : null,
        ...(createdAccounts.length ? { created_accounts: createdAccounts } : {}),
      },
      201,
    );
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleApiTxnUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const existing = await txn.getTransaction(db, id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '记录不存在' }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    const amountCents =
      body.amount_cents != null
        ? Math.round(Number(body.amount_cents))
        : body.amount != null
          ? u.parseAmountToCents(body.amount)
          : existing.amount_cents;
    await txn.updateTransaction(db, id, oa.ledgerId, oa.userId, {
      type: body.type !== undefined ? String(body.type) : existing.type,
      amount_cents: amountCents,
      currency: body.currency !== undefined ? String(body.currency) : existing.currency,
      rate: body.rate !== undefined ? (body.rate as string | number | null) : existing.rate,
      account_id: body.account_id !== undefined ? (body.account_id as string | number | null) : existing.account_id,
      to_account_id:
        body.to_account_id !== undefined ? (body.to_account_id as string | number | null) : existing.to_account_id,
      account_amount_cents: body.account_amount_cents == null ? undefined : Number(body.account_amount_cents),
      to_account_amount_cents: body.to_account_amount_cents == null ? undefined : Number(body.to_account_amount_cents),
      category_id:
        body.category_id !== undefined ? (body.category_id as string | number | null) : existing.category_id,
      txn_date: body.txn_date !== undefined ? String(body.txn_date) : existing.txn_date,
      note: body.note !== undefined ? (body.note == null ? null : String(body.note)) : existing.note,
      merchant: body.merchant !== undefined ? (body.merchant == null ? null : String(body.merchant)) : existing.merchant,
      status: body.status !== undefined ? String(body.status) : existing.status,
      tags: body.tags === undefined ? undefined : String(body.tags || ''),
      is_reimbursable:
        body.is_reimbursable !== undefined ? (body.is_reimbursable ? 1 : 0) : existing.is_reimbursable,
      updated_at: body.updated_at ? String(body.updated_at) : existing.updated_at,
    });
    const updated = await txn.getTransaction(db, id, oa.ledgerId);
    return c.json({ ok: true, id, transaction: updated });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/transactions/:id', handleApiTxnUpdate);
openapiRoutes.patch('/transactions/:id', handleApiTxnUpdate);

openapiRoutes.delete('/transactions/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  try {
    const ok = await txn.softDelete(dbOf(c), Number(c.req.param('id')), oa.ledgerId);
    if (!ok) return c.json({ ok: false, error: '记录不存在' }, 404);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/ai/bill', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const env = envOf(c);
  let savedImages: SavedAiImage[] = [];
  const createdIds: number[] = [];
  const createdAccounts: string[] = [];
  let autoCreatedDefaultAccId: number | null = null;
  const cleanupAutoDefaultAcc = async () => {
    if (autoCreatedDefaultAccId) {
      await db.run(`DELETE FROM accounts WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, autoCreatedDefaultAccId, oa.ledgerId, oa.ledgerId).catch(() => {});
      autoCreatedDefaultAccId = null;
      createdAccounts.length = 0;
    }
  };
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const rawImages = extractRawImages(body);
    const text = String(body.text || '').trim();
    if (!rawImages.length && !text) {
      return c.json({ ok: false, error: '请提供 text 或 images' }, 400);
    }
    if (text.length > MAX_AI_TEXT_LEN) {
      return c.json({ ok: false, error: `输入文字不能超过 ${MAX_AI_TEXT_LEN} 字` }, 400);
    }

    const validImages = validateRawImages(rawImages);
    const shouldSave =
      (body.confirm === undefined || parseBoolFlag(body.confirm, 1) === 1) &&
      (body.auto_save === undefined || parseBoolFlag(body.auto_save, 1) === 1);
    const saveImages = parseBoolFlag(body.save_images, 1) === 1;

    let defaultAccountId = parseOptionalRefId(body.default_account_id ?? body.account_id, null, '默认账户 ID');
    const defaultAccName = String(body.default_account ?? body.default_account_name ?? '').trim().slice(0, 30);
    let pendingAutoDefaultAccName: string | null = null;
    if (!defaultAccountId && defaultAccName) {
      const foundDefault = await lookupAccountIdByName(db, oa.ledgerId, defaultAccName);
      if (foundDefault) {
        defaultAccountId = foundDefault;
      } else {
        if (body.auto_create_account === false) {
          return c.json({ ok: false, error: `账户「${defaultAccName}」不存在` }, 400);
        }
        pendingAutoDefaultAccName = defaultAccName;
      }
    }

    if (shouldSave && pendingAutoDefaultAccName) {
      autoCreatedDefaultAccId = await createAutoAccount(db, oa.ledgerId, pendingAutoDefaultAccName, createdAccounts);
      defaultAccountId = autoCreatedDefaultAccId;
    }

    const res = await analyzeBill(db, {
      images: validImages,
      text,
      ledgerId: oa.ledgerId,
      defaultAccountId,
      skipDefaultAccountFallback: !shouldSave && Boolean(pendingAutoDefaultAccName),
    });

    const warnings = [...res.warnings];
    const items =
      !shouldSave && pendingAutoDefaultAccName
        ? res.items.map((it) =>
            it.account_id == null ? { ...it, account_name: it.account_name || pendingAutoDefaultAccName } : it,
          )
        : res.items;
    if (!shouldSave && pendingAutoDefaultAccName && items.some((it) => it.account_id == null)) {
      warnings.push(`默认账户「${pendingAutoDefaultAccName}」将在确认入库时自动创建`);
    }

    let imageSaveFailed = false;
    if (shouldSave && saveImages && items.length > 0 && validImages.length > 0) {
      const saved = await saveAiImagesBestEffort(db, env, {
        ledgerId: oa.ledgerId,
        userId: oa.userId,
        rawImages: validImages,
        aiStatus: 'pending',
      });
      savedImages = saved.saved;
      imageSaveFailed = saved.failed;
      if (imageSaveFailed) warnings.push('部分凭证图片保存失败');
    }

    const source = String(body.source || (validImages.length ? 'ai_screenshot' : 'openapi')).slice(0, 30);
    let duplicates = 0;
    const errors: string[] = [];
    const linkedMap = new Map<number, number>();

    if (shouldSave && items.length) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!(it.amount_cents > 0)) continue;
        const currency = String(it.currency || 'CNY').trim().toUpperCase().slice(0, 8) || 'CNY';
        const dupId = await findDuplicateAiTxn(
          db,
          oa.ledgerId,
          {
            draft_id: it.draft_id,
            type: it.type,
            txn_date: it.txn_date,
            amount_cents: it.amount_cents,
            currency,
            account_id: it.account_id,
            merchant: it.merchant,
          },
          source,
          { allowNaturalKey: true, excludeIds: createdIds, windowSeconds: 120 },
        );
        if (dupId) {
          duplicates++;
          continue;
        }
        try {
          const id = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
            type: it.type,
            amount_cents: it.amount_cents,
            currency,
            account_id: it.account_id,
            category_id: it.category_id,
            txn_date: it.txn_date,
            note: it.note,
            merchant: it.merchant,
            source,
            ai_json: buildAiJson(it.draft_id, { engine: res.engine, ...(res.model ? { model: res.model } : {}) }),
          });
          createdIds.push(id);
        } catch (e) {
          errors.push(`第 ${i + 1} 笔（${toPublicError(e)}）`);
        }
      }
      if (createdIds.length && savedImages.length) {
        const pairs = await attach.linkImagesToTxns(db, {
          ledgerId: oa.ledgerId,
          imageIds: savedImages.map((s) => s.id),
          txnIds: createdIds,
          aiStatus: 'linked',
        });
        for (const p of pairs) linkedMap.set(p.image_id, p.txn_id);
      } else if (!createdIds.length && savedImages.length) {
        await cleanupSavedAiImages(db, env, oa.ledgerId, savedImages);
        savedImages = [];
      }
      if (!createdIds.length) {
        await cleanupAutoDefaultAcc();
      }
      if (!createdIds.length && errors.length && duplicates === 0) {
        return c.json({ ok: false, error: errors[0], errors }, 400);
      }
    } else if (shouldSave && !items.length) {
      await cleanupAutoDefaultAcc();
    }

    const imagesOut = savedImages.map((img) => {
      const txnId = linkedMap.get(img.id) ?? img.txn_id ?? null;
      return {
        ...img,
        path: img.rel,
        api_url: `/api/open/attachments/${img.id}`,
        txn_id: txnId,
      };
    });

    return c.json({
      ok: true,
      confirmed: shouldSave,
      engine: res.engine,
      model: res.model,
      items,
      drafts: items,
      created: createdIds.length,
      duplicates,
      ids: createdIds,
      warnings,
      images: imagesOut,
      accounts_created: createdAccounts,
      ...(createdAccounts.length ? { created_accounts: createdAccounts } : {}),
      ...(errors.length ? { errors } : {}),
      ...(imageSaveFailed ? { imageSaveFailed: true } : {}),
    });
  } catch (e) {
    if (!createdIds.length) {
      await cleanupAutoDefaultAcc();
      if (savedImages.length) await cleanupSavedAiImages(db, env, oa.ledgerId, savedImages);
    }
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.get('/attachments/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const found = await attach.resolveObject(envOf(c), oa.ledgerId, dbOf(c), Number(c.req.param('id')));
  if (!found) return c.json({ ok: false, error: '附件不存在' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', found.row.mime || 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', 'sandbox');
  headers.set('Cache-Control', 'no-store');
  return new Response(found.obj.body, { headers });
});

function enrichAccount(a: AccountRow) {
  return {
    ...a,
    group: accountGroupOf(a.type),
    credit: isCreditGroupType(a.type) ? creditMetrics(a) : null,
  };
}

openapiRoutes.get('/accounts', async (c) => {
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
  const [accounts, ov] = await Promise.all([
    includeArchived
      ? db.all<AccountRow>('SELECT * FROM accounts WHERE ledger_id = ? ORDER BY is_archived, sort_order, id', oa.ledgerId)
      : fd.accounts(db, oa.ledgerId),
    txn.accountOverview(db, oa.ledgerId),
  ]);
  const summary = groupAccountsSummary(accounts, ov.rates);
  return c.json({
    ok: true,
    accounts: accounts.map(enrichAccount),
    assets: ov.assets,
    liabilities: ov.liabilities,
    net: ov.net,
    base_currency: ov.baseCurrency,
    missing_exchange_rates: ov.missingCurrencies,
    groups: {
      funds_total_cents: summary.fundsTotalCents,
      prepaid_total_cents: summary.prepaidTotalCents,
      credit_debt_cents: summary.creditDebtCents,
      credit_limit_cents: summary.creditLimitCents,
      credit_available_cents: summary.creditAvailableCents,
    },
  });
});

openapiRoutes.get('/accounts/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const acc = await dbOf(c).get<AccountRow>(
    'SELECT * FROM accounts WHERE id = ? AND ledger_id = ?',
    id,
    oa.ledgerId,
  );
  if (!acc) return c.json({ ok: false, error: '账户不存在' }, 404);
  return c.json({ ok: true, account: enrichAccount(acc) });
});

openapiRoutes.post('/accounts', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const data = normalizeAccountWrite(body, { mode: 'create', apiMode: true });
    const res = await db.run(
      `INSERT INTO accounts
       (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day, due_day,
        institution, card_no, note, include_in_net, sort_order, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${txn.activeLedgerGuard}`,
      oa.ledgerId,
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
      oa.ledgerId,
    );
    if (!res.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
    const created = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', res.lastInsertRowid, oa.ledgerId);
    return c.json({ ok: true, id: res.lastInsertRowid, account: created ? enrichAccount(created) : null }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleApiAccountUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  try {
    const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
    const body = await readJsonObject(c);
    const data = normalizeAccountWrite(body, { mode: 'edit', existing, apiMode: true });
    const isArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : Number(existing.is_archived);
    await db.run(
      `UPDATE accounts
       SET name = ?, type = ?, icon = ?, currency = ?, include_in_net = ?, is_archived = ?, sort_order = ?,
           institution = ?, card_no = ?, note = ?, credit_limit = ?, bill_day = ?, due_day = ?
       WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`,
      data.name,
      data.type,
      data.icon,
      data.currency,
      data.include_in_net,
      isArchived,
      data.sort_order,
      data.institution,
      data.card_no,
      data.note,
      data.credit_limit,
      data.bill_day,
      data.due_day,
      id,
      oa.ledgerId,
      oa.ledgerId,
    );
    const updated = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, account: updated ? enrichAccount(updated) : null });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/accounts/:id', handleApiAccountUpdate);
openapiRoutes.patch('/accounts/:id', handleApiAccountUpdate);

openapiRoutes.post('/accounts/:id/archive', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const existing = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
  try {
    const body = await readJsonObject(c, { optional: true });
    const nextArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : existing.is_archived
          ? 0
          : 1;
    await db.run(`UPDATE accounts SET is_archived = ? WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, nextArchived, id, oa.ledgerId, oa.ledgerId);
    const updated = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
    return c.json({ ok: true, id, account: updated ? enrichAccount(updated) : null });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/accounts/:id/adjust', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const acc = await db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!acc) return c.json({ ok: false, error: '账户不存在' }, 404);
  if (acc.is_archived) {
    return c.json({ ok: false, error: '已归档账户不可校准余额，请先取消归档' }, 400);
  }
  try {
    const body = await readJsonObject(c);
    const target = parseAmountField(
      body,
      ['actual_balance_cents', 'balance_cents'],
      ['actual_balance', 'balance'],
      { allowZero: true, allowNegative: true, label: '目标余额' },
    );
    if (target === undefined) {
      return c.json({ ok: false, error: '请填写目标余额' }, 400);
    }
    const adjustDate = parseOptionalDate(body.adjust_date ?? body.txn_date, todayStr(), '校准日期') || todayStr();
    const diff = target - Number(acc.balance_cents);
    if (diff === 0) {
      return c.json({ ok: true, adjusted: false, diff_cents: 0, account: enrichAccount(acc), transaction: null });
    }
    const note = body.note != null && String(body.note).trim()
      ? String(body.note).trim().slice(0, 300)
      : `余额校准：${u.fmtAmount(acc.balance_cents)} → ${u.fmtAmount(target)}`;
    const txnId = await txn.createTransaction(db, oa.ledgerId, oa.userId, {
      type: 'adjust',
      amount_cents: diff,
      currency: acc.currency,
      account_id: id,
      txn_date: adjustDate,
      note,
      source: 'openapi',
      expectedBalanceCents: Number(acc.balance_cents),
    });
    const [updated, createdTxn] = await Promise.all([
      db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId),
      txn.getTransaction(db, txnId, oa.ledgerId),
    ]);
    return c.json({
      ok: true,
      adjusted: true,
      diff_cents: diff,
      account: updated ? enrichAccount(updated) : null,
      transaction: createdTxn || null,
    });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.delete('/accounts/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '账户不存在' }, 404);
  const existing = await db.get<AccountRow>('SELECT id FROM accounts WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '账户不存在' }, 404);
  const del = await deleteAccountIfUnreferenced(db, oa.ledgerId, id);
  if (!del.ok) {
    return c.json({ ok: false, error: del.error }, 400);
  }
  return c.json({ ok: true });
});

openapiRoutes.get('/session-cards', async (c) => {
  const oa = c.get('openAuth')!;
  const includeArchived = c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true';
  const res = await sc.listSessionCards(dbOf(c), oa.ledgerId);
  return c.json({
    ok: true,
    active_count: res.activeCount,
    total_remaining: res.totalRemaining,
    cards: includeArchived ? res.all : res.active,
  });
});

openapiRoutes.get('/session-cards/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  const card = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!card) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const logs = await sc.listCardLogs(db, id, oa.ledgerId);
  return c.json({ ok: true, card, logs });
});

openapiRoutes.post('/session-cards', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const totalCostCents = sc.parseCardCostCents(body, 'total_cost_cents', 'total_cost');
    const recordExpense =
      body.record_expense !== undefined
        ? Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false')
        : Boolean(body.account_id);
    const id = await sc.createSessionCard(db, oa.ledgerId, oa.userId, {
      name: String(body.name || ''),
      icon: body.icon ? String(body.icon) : '🎟️',
      merchant: body.merchant != null ? String(body.merchant) : null,
      total_sessions: Number(body.total_sessions),
      remaining_sessions: body.remaining_sessions != null ? Number(body.remaining_sessions) : null,
      total_cost_cents: totalCostCents,
      currency: body.currency ? String(body.currency) : 'CNY',
      purchase_date: body.purchase_date ? String(body.purchase_date) : undefined,
      expires_at: body.expires_at != null ? String(body.expires_at) : null,
      note: body.note != null ? String(body.note) : null,
      record_expense: recordExpense,
      account_id: body.account_id != null ? Number(body.account_id) : null,
      category_id: body.category_id != null ? Number(body.category_id) : null,
    });
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/use', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const count = body.count != null ? Number(body.count) : 1;
    const res = await sc.useSessionCard(db, id, oa.ledgerId, oa.userId, {
      count,
      used_at: body.used_at ? String(body.used_at) : undefined,
      note: body.note != null ? String(body.note) : null,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/topup', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = Number(c.req.param('id'));
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const addCostCents = sc.parseCardCostCents(body, 'add_cost_cents', 'add_cost');
    const recordExpense =
      body.record_expense !== undefined
        ? Boolean(body.record_expense && body.record_expense !== '0' && body.record_expense !== 'false')
        : Boolean(body.account_id);
    const card = await sc.topUpSessionCard(db, id, oa.ledgerId, oa.userId, {
      add_sessions: Number(body.add_sessions),
      add_cost_cents: addCostCents,
      topup_date: body.topup_date ? String(body.topup_date) : undefined,
      expires_at: body.expires_at !== undefined ? (body.expires_at == null ? null : String(body.expires_at)) : undefined,
      note: body.note != null ? String(body.note) : null,
      record_expense: recordExpense,
      account_id: body.account_id != null ? Number(body.account_id) : null,
      category_id: body.category_id != null ? Number(body.category_id) : null,
    });
    return c.json({ ok: true, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.post('/session-cards/:id/logs/:logId/undo', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const res = await sc.undoSessionCardLog(db, Number(c.req.param('id')), Number(c.req.param('logId')), oa.ledgerId);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleSessionCardUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const existing = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '次卡不存在' }, 404);
  try {
    const body = await readJsonObject(c);
    const totalCostCents = parseAmountField(body, ['total_cost_cents'], ['total_cost'], {
      allowZero: true,
      label: '购卡金额',
    });
    const expiresAt =
      body.expires_at !== undefined
        ? parseOptionalDate(body.expires_at, existing.expires_at, '有效期')
        : undefined;
    await sc.updateSessionCard(db, id, oa.ledgerId, {
      name: body.name !== undefined ? String(body.name || '') : existing.name,
      icon: body.icon !== undefined ? String(body.icon || '') : existing.icon,
      merchant: body.merchant !== undefined ? (body.merchant == null ? null : String(body.merchant)) : undefined,
      total_cost_cents: totalCostCents,
      expires_at: expiresAt,
      note: body.note !== undefined ? (body.note == null ? null : String(body.note)) : undefined,
      is_archived: body.is_archived === undefined ? undefined : parseBoolFlag(body.is_archived, Number(existing.is_archived)),
    });
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/session-cards/:id', handleSessionCardUpdate);
openapiRoutes.patch('/session-cards/:id', handleSessionCardUpdate);

openapiRoutes.post('/session-cards/:id/archive', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const existing = await sc.getSessionCard(db, id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '次卡不存在' }, 404);
  try {
    const body = await readJsonObject(c, { optional: true });
    const nextArchived =
      body.is_archived !== undefined
        ? parseBoolFlag(body.is_archived, Number(existing.is_archived))
        : existing.is_archived
          ? 0
          : 1;
    if (!(await sc.toggleArchiveSessionCard(db, id, oa.ledgerId, nextArchived))) {
      return c.json({ ok: false, error: '次卡不存在或账本已归档' }, 409);
    }
    const card = await sc.getSessionCard(db, id, oa.ledgerId);
    return c.json({ ok: true, id, card });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

openapiRoutes.delete('/session-cards/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '次卡不存在' }, 404);
  const deleted = await sc.deleteSessionCard(dbOf(c), id, oa.ledgerId);
  if (!deleted) return c.json({ ok: false, error: '次卡不存在' }, 404);
  return c.json({ ok: true });
});

async function getCategoryWithPath(db: ReturnType<typeof dbOf>, id: number, ledgerId: number) {
  const cat = await db.get<CategoryRow>(
    `SELECT c.*, p.name AS parent_name
     FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.id = ? AND (c.ledger_id IS NULL OR c.ledger_id = ?)`,
    id,
    ledgerId,
  );
  if (!cat) return undefined;
  return { ...cat, path: cat.parent_name ? `${cat.parent_name}/${cat.name}` : cat.name };
}

openapiRoutes.get('/categories', async (c) => {
  const oa = c.get('openAuth')!;
  const kind = c.req.query('kind');
  const k = kind === 'expense' || kind === 'income' ? kind : null;
  const categories = await fd.flatCategories(dbOf(c), oa.ledgerId, k);
  return c.json({ ok: true, categories });
});

openapiRoutes.get('/categories/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const category = await getCategoryWithPath(dbOf(c), id, oa.ledgerId);
  if (!category) return c.json({ ok: false, error: '分类不存在' }, 404);
  return c.json({ ok: true, category });
});

openapiRoutes.post('/categories', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return c.json({ ok: false, error: '请填写分类名称' }, 400);

    let parentId = parseOptionalRefId(body.parent_id, null, '父分类 ID');
    let kind: 'expense' | 'income' = 'expense';
    let color = body.color ? String(body.color).trim().slice(0, 20) || '#8c8c8c' : '#8c8c8c';

    if (parentId !== null) {
      const parent = await db.get<CategoryRow>(
        'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
        parentId,
        oa.ledgerId,
      );
      if (!parent) return c.json({ ok: false, error: '所属一级分类不存在' }, 400);
      if (parent.parent_id != null) {
        return c.json({ ok: false, error: '仅支持二级分类，不能在二级分类下继续新建子分类' }, 400);
      }
      kind = parent.kind;
      if (body.kind !== undefined && String(body.kind) !== parent.kind) {
        return c.json({ ok: false, error: '二级分类类型必须与一级分类一致' }, 400);
      }
      if (!body.color) color = parent.color || color;
      parentId = Number(parent.id);
    } else {
      if (body.kind !== undefined && body.kind !== 'expense' && body.kind !== 'income') {
        return c.json({ ok: false, error: '分类类型仅支持 expense 或 income' }, 400);
      }
      kind = body.kind === 'income' ? 'income' : 'expense';
    }

    const icon = String(body.icon || '🏷️').trim().slice(0, 8) || '🏷️';
    const sortOrder =
      body.sort_order !== undefined && String(body.sort_order).trim() !== ''
        ? Math.round(Number(body.sort_order) || 0)
        : 0;

    const ins = await db.run(
      `INSERT INTO categories (ledger_id, parent_id, kind, name, icon, color, is_system, is_archived, sort_order) SELECT ?,?,?,?,?,?,0,0,? WHERE ${txn.activeLedgerGuard}`,
      oa.ledgerId,
      parentId,
      kind,
      name,
      icon,
      color,
      sortOrder,
      oa.ledgerId,
    );
    if (!ins.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
    const id = Number(ins.lastInsertRowid);
    const category = await getCategoryWithPath(db, id, oa.ledgerId);
    return c.json({ ok: true, id, category }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleCategoryUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const existing = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '分类不存在' }, 404);
  if (existing.is_system || Number(existing.ledger_id) !== oa.ledgerId) {
    return c.json({ ok: false, error: '内置系统分类不可修改' }, 400);
  }
  try {
    const body = await readJsonObject(c);
    if (body.kind !== undefined && String(body.kind) !== existing.kind) {
      return c.json({ ok: false, error: '分类创建后不允许修改收支类型（kind）' }, 400);
    }
    if (body.parent_id !== undefined) {
      const reqParentId = parseOptionalRefId(body.parent_id, null, '父分类 ID');
      const curParentId = existing.parent_id != null ? Number(existing.parent_id) : null;
      if ((reqParentId ?? null) !== curParentId) {
        return c.json({ ok: false, error: '分类创建后不允许调整父级关系（parent_id）' }, 400);
      }
    }
    const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 20);
    if (!name) return c.json({ ok: false, error: '分类名称不能为空' }, 400);
    const icon = body.icon !== undefined ? String(body.icon || '').trim().slice(0, 8) || '🏷️' : existing.icon;
    const color =
      body.color !== undefined ? String(body.color || '').trim().slice(0, 20) || existing.color : existing.color;
    const sortOrder =
      body.sort_order !== undefined && String(body.sort_order).trim() !== ''
        ? Math.round(Number(body.sort_order) || 0)
        : Number(existing.sort_order);
    const isArchived = parseBoolFlag(body.is_archived, Number(existing.is_archived));

    await db.run(
      `UPDATE categories SET name = ?, icon = ?, color = ?, sort_order = ?, is_archived = ? WHERE id = ? AND ledger_id = ? AND is_system = 0 AND ${txn.activeLedgerGuard}`,
      name,
      icon,
      color,
      sortOrder,
      isArchived,
      id,
      oa.ledgerId,
      oa.ledgerId,
    );
    const category = await getCategoryWithPath(db, id, oa.ledgerId);
    return c.json({ ok: true, id, category });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/categories/:id', handleCategoryUpdate);
openapiRoutes.patch('/categories/:id', handleCategoryUpdate);

openapiRoutes.delete('/categories/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '分类不存在' }, 404);
  const existing = await db.get<CategoryRow>(
    'SELECT * FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '分类不存在' }, 404);
  if (existing.is_system || Number(existing.ledger_id) !== oa.ledgerId) {
    return c.json({ ok: false, error: '仅可删除当前账本的自定义分类' }, 400);
  }
  const childCnt = Number(
    (await db.get<{ c: number }>('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND ledger_id = ?', id, oa.ledgerId))
      ?.c || 0,
  );
  if (childCnt > 0) {
    return c.json({ ok: false, error: `该分类下还有 ${childCnt} 个子分类，请先删除子分类` }, 400);
  }
  const used = Number(
    (
      await db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ? AND category_id = ?',
        oa.ledgerId,
        id,
      )
    )?.c || 0,
  );
  if (used > 0) {
    return c.json({ ok: false, error: `该分类下还有 ${used} 笔记账，无法删除` }, 400);
  }
  await db.run(`DELETE FROM categories WHERE id = ? AND ledger_id = ? AND is_system = 0 AND ${txn.activeLedgerGuard}`, id, oa.ledgerId, oa.ledgerId);
  return c.json({ ok: true });
});

const TAG_SELECT =
  'SELECT t.*, (SELECT COUNT(*) FROM transaction_tags tt WHERE tt.tag_id = t.id) AS cnt FROM tags t WHERE t.id = ? AND t.ledger_id = ?';

openapiRoutes.get('/tags', async (c) => {
  const oa = c.get('openAuth')!;
  return c.json({ ok: true, tags: await fd.tags(dbOf(c), oa.ledgerId) });
});

openapiRoutes.get('/tags/:id', async (c) => {
  const oa = c.get('openAuth')!;
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const tag = await dbOf(c).get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
  if (!tag) return c.json({ ok: false, error: '标签不存在' }, 404);
  return c.json({ ok: true, tag });
});

openapiRoutes.post('/tags', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  try {
    const body = await readJsonObject(c);
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return c.json({ ok: false, error: '请填写标签名称' }, 400);
    const dup = await db.get<{ id: number }>('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', oa.ledgerId, name);
    if (dup) return c.json({ ok: false, error: '标签名称已存在' }, 409);
    const color = body.color ? String(body.color).trim().slice(0, 20) || '#0F766E' : '#0F766E';
    const ins = await db.run(`INSERT INTO tags (ledger_id, name, color) SELECT ?,?,? WHERE ${txn.activeLedgerGuard}`, oa.ledgerId, name, color, oa.ledgerId);
    if (!ins.changes) return c.json({ ok: false, error: '账本已归档，只能查阅和导出' }, 403);
    const id = Number(ins.lastInsertRowid);
    const tag = await db.get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
    return c.json({ ok: true, id, tag }, 201);
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
});

async function handleTagUpdate(c: Context<HonoEnv>) {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const existing = await db.get<{ id: number; ledger_id: number; name: string; color: string }>(
    'SELECT * FROM tags WHERE id = ? AND ledger_id = ?',
    id,
    oa.ledgerId,
  );
  if (!existing) return c.json({ ok: false, error: '标签不存在' }, 404);
  try {
    const body = await readJsonObject(c);
    const name = (body.name !== undefined ? String(body.name || '').trim() : existing.name).slice(0, 20);
    if (!name) return c.json({ ok: false, error: '标签名称不能为空' }, 400);
    if (name !== existing.name) {
      const dup = await db.get<{ id: number }>(
        'SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND id != ?',
        oa.ledgerId,
        name,
        id,
      );
      if (dup) return c.json({ ok: false, error: '标签名称已存在' }, 409);
    }
    const color =
      body.color !== undefined ? String(body.color || '').trim().slice(0, 20) || existing.color : existing.color;
    await db.run(`UPDATE tags SET name = ?, color = ? WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, name, color, id, oa.ledgerId, oa.ledgerId);
    const tag = await db.get<fd.TagWithCount>(TAG_SELECT, id, oa.ledgerId);
    return c.json({ ok: true, id, tag });
  } catch (e) {
    return c.json({ ok: false, error: toPublicError(e) }, 400);
  }
}

openapiRoutes.put('/tags/:id', handleTagUpdate);
openapiRoutes.patch('/tags/:id', handleTagUpdate);

openapiRoutes.delete('/tags/:id', async (c) => {
  const w = requireWriteApi(c);
  if (w) return w;
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  const id = parsePositiveIntId(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: '标签不存在' }, 404);
  const existing = await db.get<{ id: number }>('SELECT id FROM tags WHERE id = ? AND ledger_id = ?', id, oa.ledgerId);
  if (!existing) return c.json({ ok: false, error: '标签不存在' }, 404);
  const [, deleted] = await db.batch([
    [`DELETE FROM transaction_tags WHERE tag_id = ? AND ${txn.activeLedgerGuard}`, [id, oa.ledgerId]],
    [`DELETE FROM tags WHERE id = ? AND ledger_id = ? AND ${txn.activeLedgerGuard}`, [id, oa.ledgerId, oa.ledgerId]],
  ]);
  if (!deleted.meta.changes) return c.json({ ok: false, error: '标签不存在或账本已归档' }, 409);
  return c.json({ ok: true });
});

openapiRoutes.get('/summary', async (c) => {
  const oa = c.get('openAuth')!;
  const month = /^\d{4}-\d{2}$/.test(String(c.req.query('month') || ''))
    ? String(c.req.query('month'))
    : todayStr().slice(0, 7);
  const start = String(c.req.query('from') || `${month}-01`);
  const end = String(c.req.query('to') || u.monthEnd(month));
  const [summary, overview] = await Promise.all([
    txn.summary(dbOf(c), oa.ledgerId, start, end),
    txn.accountOverview(dbOf(c), oa.ledgerId),
  ]);
  return c.json({
    ok: true,
    start,
    end,
    summary,
    overview: { net: overview.net, assets: overview.assets, liabilities: overview.liabilities },
  });
});

openapiRoutes.get('/overview', async (c) => {
  const oa = c.get('openAuth')!;
  const qMonth = c.req.query('month');
  const month = /^\d{4}-\d{2}$/.test(String(qMonth || '')) ? String(qMonth) : todayStr().slice(0, 7);
  const prevMonth = u.addMonths(month, -1);
  const db = dbOf(c);
  const [
    summary,
    previous,
    overview,
    recent,
    subs,
    trend,
    expenseCategories,
    incomeCategories,
    budgetsRaw,
    debts,
    goals,
    recurringRaw,
    pendingReimburse,
  ] = await Promise.all([
    txn.summary(db, oa.ledgerId, `${month}-01`, u.monthEnd(month)),
    txn.summary(db, oa.ledgerId, `${prevMonth}-01`, u.monthEnd(prevMonth)),
    txn.accountOverview(db, oa.ledgerId),
    txn.listTransactions(db, oa.ledgerId, { page: 1, pageSize: 10 }),
    subsOverview(db, oa.ledgerId),
    txn.monthlyTrend(db, oa.ledgerId, 6),
    txn.categoryBreakdown(db, oa.ledgerId, `${month}-01`, u.monthEnd(month), 'expense'),
    txn.categoryBreakdown(db, oa.ledgerId, `${month}-01`, u.monthEnd(month), 'income'),
    db.all<BudgetRow>('SELECT * FROM budgets WHERE ledger_id = ? AND is_active = 1 ORDER BY id', oa.ledgerId),
    db.all<{ direction: string; cnt: number; total: number }>(
      "SELECT direction, COUNT(*) AS cnt, COALESCE(SUM(balance_cents),0) AS total FROM debts WHERE ledger_id = ? AND status = 'open' GROUP BY direction",
      oa.ledgerId,
    ),
    db.all<{ id: number; name: string; icon: string; saved_cents: number; target_cents: number; target_date: string | null; status: string }>(
      "SELECT id, name, icon, saved_cents, target_cents, target_date, status FROM goals WHERE ledger_id = ? AND status = 'active' ORDER BY id LIMIT 10",
      oa.ledgerId,
    ),
    db.all<RecurringRuleRow>(
      'SELECT * FROM recurring_rules WHERE ledger_id = ? AND is_active = 1 ORDER BY next_run_at LIMIT 5',
      oa.ledgerId,
    ),
    db.get<{ count: number; sum: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(amount_base_cents),0) AS sum FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND is_reimbursable = 1 AND reimbursed_at IS NULL',
      oa.ledgerId,
    ),
  ]);

  const refDate = tzRefDate();
  const budgets = await Promise.all(
    budgetsRaw.map(async (b) => {
      const r2 = budgetPeriodRange(b, refDate);
      const isUnset = b.period === 'custom' && (!b.start_date || !b.end_date);
      const [used, eff] = await Promise.all([
        isUnset ? Promise.resolve(null) : budgetUsedInRange(db, b, r2.start, r2.end),
        isUnset ? budgetAmountInBaseCents(db, b).then((amount) => ({ amount, rollover: 0 })) : effectiveBudget(db, b, refDate),
      ]);
      return {
        ...b,
        range: r2,
        used_cents: used,
        effective_cents: eff.amount,
        rollover_cents: eff.rollover,
      };
    }),
  );

  return c.json({
    ok: true,
    month,
    summary,
    previous,
    overview: { net: overview.net, assets: overview.assets, liabilities: overview.liabilities },
    recent: recent.rows,
    trend,
    expense_categories: expenseCategories,
    income_categories: incomeCategories,
    accounts: overview.accounts.map(enrichAccount),
    budgets,
    debts,
    goals,
    upcoming_recurring: recurringRaw.map((r) => {
      let amountCents = 0;
      try {
        const p = JSON.parse(r.payload || '{}') as unknown;
        const items = Array.isArray(p)
          ? p
          : p && typeof p === 'object' && Array.isArray((p as { items?: unknown[] }).items)
            ? (p as { items: unknown[] }).items
            : [p];
        for (const it of items) {
          if (it && typeof it === 'object') amountCents += Math.abs(Number((it as { amount_cents?: number }).amount_cents) || 0);
        }
      } catch {
        amountCents = 0;
      }
      return { id: r.id, name: r.name, frequency: r.frequency, next_run_at: r.next_run_at, auto_post: r.auto_post, amount_cents: amountCents };
    }),
    pending_reimburse: {
      count: Number(pendingReimburse?.count || 0),
      sum: Number(pendingReimburse?.sum || 0),
    },
    subscriptions: {
      active_count: subs.active.length,
      monthly_cents: subs.monthlyTotal,
      annual_cents: subs.annualTotal,
    },
  });
});

openapiRoutes.get('/reports', async (c) => {
  const oa = c.get('openAuth')!;
  const q = c.req.query();
  const range = parseReportRange(q);
  const kind: 'expense' | 'income' = q.kind === 'income' ? 'income' : 'expense';
  const selectedCat = q.cat ? String(q.cat).trim() : null;
  const heatmapMonth = range.month || todayStr().slice(0, 7);
  const prevM = u.addMonths(heatmapMonth, -1);
  const lastYearM = u.addMonths(heatmapMonth, -12);
  const db = dbOf(c);

  const [
    summary,
    expense_categories,
    income_categories,
    subcategories,
    trend,
    daily,
    weekday_expense,
    members,
    net_worth,
    expRow,
    prevSum,
    lastYearSum,
  ] = await Promise.all([
    txn.summary(db, oa.ledgerId, range.start, range.end),
    txn.categoryBreakdown(db, oa.ledgerId, range.start, range.end, 'expense'),
    txn.categoryBreakdown(db, oa.ledgerId, range.start, range.end, 'income'),
    txn.subcategoryBreakdown(db, oa.ledgerId, range.start, range.end, kind, selectedCat),
    txn.monthlyTrend(db, oa.ledgerId, 12),
    txn.dailyBreakdown(db, oa.ledgerId, `${heatmapMonth}-01`, u.monthEnd(heatmapMonth)),
    txn.weekdayExpenseBreakdown(db, oa.ledgerId, range.start, range.end),
    txn.memberBreakdown(db, oa.ledgerId, range.start, range.end),
    txn.netWorthTrend(db, oa.ledgerId, 12),
    db.get<{ c: number; avg: number }>(
      `SELECT COUNT(*) AS c, COALESCE(AVG(amount_base_cents),0) AS avg
       FROM transactions
       WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? AND type IN ('expense','fee')`,
      oa.ledgerId,
      range.start,
      range.end,
    ),
    range.preset === 'month' ? txn.summary(db, oa.ledgerId, `${prevM}-01`, u.monthEnd(prevM)) : Promise.resolve(null),
    range.preset === 'month' ? txn.summary(db, oa.ledgerId, `${lastYearM}-01`, u.monthEnd(lastYearM)) : Promise.resolve(null),
  ]);

  const compare =
    range.preset === 'month' && prevSum && lastYearSum
      ? {
          prevMonth: { label: prevM, income: prevSum.income, expense: prevSum.expense },
          lastYear: { label: lastYearM, income: lastYearSum.income, expense: lastYearSum.expense },
        }
      : null;

  return c.json({
    ok: true,
    month: heatmapMonth,
    range,
    kind,
    summary,
    compare,
    expense_categories,
    income_categories,
    subcategories,
    trend,
    daily,
    weekday_expense,
    expense_stats: {
      count: Number(expRow?.c || 0),
      avg_cents: Math.round(Number(expRow?.avg || 0)),
    },
    members,
    net_worth,
  });
});

registerPlanningOpenApi(openapiRoutes);
registerRolloverOpenApi(openapiRoutes);

openapiRoutes.get('/export', async (c) => {
  const oa = c.get('openAuth')!;
  const db = dbOf(c);
  if (c.req.query('scope') === 'full') {
    if (!oa.isAdmin) {
      return c.json({ ok: false, error: '仅站点管理员可导出全库备份' }, 403);
    }
    const tables: Record<string, unknown[]> = {};
    for (const tbl of BACKUP_TABLES) {
      tables[tbl] = await db.all(`SELECT * FROM ${tbl}`);
    }
    tables.users = (tables.users || []).map((row) => {
      const { password_hash: _ph, ...rest } = row as Record<string, unknown>;
      return rest;
    });
    tables.api_tokens = (tables.api_tokens || []).map((row) => {
      const { token_hash: _th, ...rest } = row as Record<string, unknown>;
      return rest;
    });
    tables.settings = (tables.settings || []).filter((row) => (row as { key?: unknown }).key !== 'ai.api_key');
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, app: 'homeledger', version: 2, exported_at: nowStr(), tables });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(`{"ok":true,"ledger_id":${oa.ledgerId},"transactions":[`));
        let total = 0;
        let first = true;
        for await (const batch of txn.iterateAllForExport(db, oa.ledgerId)) {
          let chunk = '';
          for (const row of batch) {
            chunk += `${first ? '' : ','}${JSON.stringify(row)}`;
            first = false;
            total++;
          }
          if (chunk) controller.enqueue(enc.encode(chunk));
        }
        controller.enqueue(enc.encode(`],"total":${total}}`));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
});
