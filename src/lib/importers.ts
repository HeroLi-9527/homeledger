import { accountCentsFromBase, balanceDeltaStmts, baseExchangeRates, getSetting, nowStr, TXN_TYPES } from '../db.js';
import type { BatchStatement, Db, Env, TxnRow } from '../types.js';
import { classifyByKeywords, guessAccountName } from './ai.js';
import { activeLedgerGuard, kindOfType, syncDebts, validateAccounts } from './txn.js';
import { parseAmountToCents, toBase, uid } from './util.js';

export function decodeBuffer(buf: ArrayBuffer | Uint8Array): { text: string; encoding: string } {
  const tryDecode = (enc: string, fatal = false): string | null => {
    try {
      return new TextDecoder(enc, { fatal }).decode(buf);
    } catch {
      return null;
    }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 && !utf8.includes('\uFFFD')) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  const gbk = tryDecode('gbk') || tryDecode('gb18030');
  if (gbk === null) {
    throw new Error('当前运行环境不支持 GBK 解码，无法解析该账单文件（请确认文件为 UTF-8 编码后重试）');
  }
  if (gbk.includes('\uFFFD')) {
    throw new Error('账单文件解码失败：既不是有效的 UTF-8，也不是有效的 GBK，请确认文件编码后重试');
  }
  return { text: gbk.replace(/^\uFEFF/, ''), encoding: 'gbk' };
}

type CsvRow = string[] & { line?: number };

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: CsvRow = [];
  let cur = '';
  let quoted = false;
  let lineNo = 1;
  let rowLine = 1;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
        if (ch === '\n') lineNo++;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cur.trim());
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.length > 0 && row.join('').length > 0) {
        row.line = rowLine;
        rows.push(row);
      }
      row = [];
      lineNo++;
      rowLine = lineNo;
    } else {
      cur += ch;
    }
  }
  if (quoted) throw new Error('CSV 文件格式有误：存在未闭合的英文双引号，请检查文件后重试');
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.join('').length > 0) {
      row.line = rowLine;
      rows.push(row);
    }
  }
  return rows;
}

const HEADER_KEYS = [
  '交易时间',
  '交易分类',
  '交易类型',
  '金额',
  '收/支',
  '收/付款方式',
  '支付方式',
  '日期',
  '时间',
  'amount',
  'date',
];

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.join(',');
  return HEADER_KEYS.some((k) => joined.includes(k)) && cells.length >= 4;
}

function headerIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h && h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function detectSource(headerLine: string[], fullText: string): 'alipay' | 'wechat' | 'generic' {
  const h = headerLine.join(',');
  if (h.includes('交易分类') || /支付宝/.test(fullText.slice(0, 2000))) return 'alipay';
  if (h.includes('交易类型') || h.includes('当前状态') || /微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

export function normalizeDate(v: unknown): string | null {
  const s = String(v || '').trim();
  let m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return null;
}

export interface ParsedBillRecord {
  skip: boolean;
  neutral: boolean;
  type: string;
  amount_cents: number;
  txn_date: string | null;
  merchant: string | null;
  note: string | null;
  category_hint: string | null;
  text: string;
  account_hint: string | null;
  order_no: string | null;
  line: number | null;
  native?: {
    currency: string;
    baseCents: number;
    baseCurrency: string;
    rate: number | null;
    accountCurrency: string;
    accountCents: number | null;
    toName: string;
    toCurrency: string;
    toCents: number | null;
    status: string;
    tags: string[];
  };
}

function normalizeRow({
  date,
  direction,
  amountText,
  merchant,
  desc,
  categoryText,
  accountText,
  status,
  orderNo,
}: {
  date: string;
  direction: string;
  amountText: string;
  merchant: string;
  desc: string;
  categoryText: string;
  accountText: string;
  status: string;
  orderNo: string;
}): Omit<ParsedBillRecord, 'line'> {
  const amountCents = parseAmountToCents(amountText);
  const dir = String(direction || '').trim();
  let type: 'expense' | 'income' | 'transfer' = 'expense';
  let neutral = false;
  if (/不计/.test(dir)) {
    type = 'transfer';
    neutral = true;
  } else if (/收入|收/.test(dir)) {
    type = 'income';
  } else if (/支出|支/.test(dir)) {
    type = 'expense';
  }
  const text = `${categoryText || ''} ${desc || ''} ${merchant || ''}`;
  return {
    skip: false,
    neutral,
    type,
    amount_cents: amountCents,
    txn_date: normalizeDate(date),
    merchant: (merchant || desc || '').slice(0, 60) || null,
    note: [categoryText, desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
    category_hint: categoryText || null,
    text,
    account_hint: accountText || guessAccountName(text) || null,
    order_no: orderNo || null,
  };
}

export function parseBill(buffer: ArrayBuffer | Uint8Array) {
  const { text, encoding } = decodeBuffer(buffer);
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return {
      source: 'unknown' as const,
      encoding,
      header: [] as string[],
      records: [] as ParsedBillRecord[],
      neutralRecords: [] as ParsedBillRecord[],
      totalLines: rows.length,
      skipped: 0,
      skippedDates: 0,
      error: '未找到有效表头，请确认为支付宝/微信导出的 CSV 账单',
    };
  }
  const header = rows[headerIdx];
  if (EXPORT_HEADER.every((name, i) => header[i] === name)) {
    const records = rows.slice(headerIdx + 1).filter((r) => r.some(Boolean)).map(parseNativeRow);
    if (records.length > 20000) throw new Error('记录超过 20000 条，请拆分成多个文件导入');
    return { source: 'homeledger', encoding, header, records, neutralRecords: [], totalLines: rows.length, skipped: 0, skippedDates: 0 };
  }
  const source = detectSource(header, text);
  const body = rows.slice(headerIdx + 1).filter((r) => r.length > 2 && r.join('').replace(/[-,\s]/g, '').length > 0);

  const iDate = headerIndex(header, ['交易时间', '交易日期', '日期', '时间', 'date']);
  const iDir = headerIndex(header, ['收/支', '收支', '类型', '方向']);
  const iAmount = headerIndex(header, ['金额(元)', '金额', 'amount']);
  const iMerchant = headerIndex(header, ['交易对方', '对方', 'merchant', '商家']);
  const iDesc = headerIndex(header, ['商品说明', '商品', '备注', '描述', '说明', 'note', 'detail']);
  const iCategory = headerIndex(header, ['交易分类', '分类', 'category']);
  const iAccount = headerIndex(header, ['收/付款方式', '支付方式', '付款方式', '账户', 'account']);
  const iStatus = headerIndex(header, ['当前状态', '交易状态', '状态', 'status']);
  const iOrder = headerIndex(header, ['交易订单号', '交易单号', '订单号', 'order']);

  const records: ParsedBillRecord[] = [];
  const neutralRecords: ParsedBillRecord[] = [];
  let skipped = 0;
  let skippedDates = 0;
  for (const r of body) {
    const status = iStatus >= 0 ? r[iStatus] : '';
    if (status && SKIP_STATUS.test(status)) {
      skipped++;
      continue;
    }
    const normRow = normalizeRow({
      date: iDate >= 0 ? r[iDate] : '',
      direction: iDir >= 0 ? r[iDir] : '',
      amountText: iAmount >= 0 ? r[iAmount] : '',
      merchant: iMerchant >= 0 ? r[iMerchant] : '',
      desc: iDesc >= 0 ? r[iDesc] : '',
      categoryText: iCategory >= 0 ? r[iCategory] : '',
      accountText: iAccount >= 0 ? r[iAccount] : '',
      status,
      orderNo: iOrder >= 0 ? r[iOrder] : '',
    });
    const rec: ParsedBillRecord = { ...normRow, line: r.line || null };
    if (!rec.txn_date) {
      skipped++;
      skippedDates++;
      continue;
    }
    if (rec.skip || !rec.amount_cents) {
      skipped++;
      continue;
    }
    if (rec.neutral) neutralRecords.push(rec);
    else records.push(rec);
    if (records.length > 20000) throw new Error('记录超过 20000 条，请拆分成多个文件导入');
  }
  return { source, encoding, header, records, neutralRecords, totalLines: rows.length, skipped, skippedDates };
}

export const norm = (s: unknown): string => String(s || '').replace(/\s/g, '');

function makeCategoryResolver(rows: Array<{ id: number; name: string; kind: string; parent: string | null }>) {
  return (nameHint: string | null, kind: string): number | null => {
    if (!nameHint) return null;
    const list = rows.filter((r) => r.kind === kind);
    const target = norm(nameHint);
    for (const r of list) {
      const full = r.parent ? `${r.parent}/${r.name}` : r.name;
      if (norm(full) === target) return Number(r.id);
    }
    for (const r of list) if (norm(r.name) === target) return Number(r.id);
    const tail = target.includes('/') ? target.split('/').pop() || target : target;
    for (const r of list) if (norm(r.name) === norm(tail)) return Number(r.id);
    for (const r of list) {
      if (norm(r.name).includes(tail) || tail.includes(norm(r.name))) return Number(r.id);
      if (r.parent && (norm(r.parent).includes(tail) || tail.includes(norm(r.parent)))) return Number(r.id);
    }
    const kw = classifyByKeywords(nameHint);
    if (kw) {
      for (const r of list) if (norm(r.name) === norm(kw.category)) return Number(r.id);
      for (const r of list) if (r.parent && norm(r.parent) === norm(kw.category)) return Number(r.id);
    }
    return null;
  };
}

function makeAccountResolver(accounts: Array<{ id: number; name: string }>) {
  return (nameHint: string | null): number | null => {
    if (!nameHint) return null;
    const hint = String(nameHint).replace(/\s/g, '');
    for (const a of accounts) {
      const an = a.name.replace(/\s/g, '');
      if (hint.includes(an) || an.includes(hint)) return Number(a.id);
    }
    for (const a of accounts) {
      if ((hint.includes('支付宝') || hint.includes('花呗')) && /支付宝|花呗/.test(a.name)) return Number(a.id);
      if (hint.includes('微信') && /微信/.test(a.name)) return Number(a.id);
      if (hint.includes('现金') && /现金/.test(a.name)) return Number(a.id);
      if (hint.includes('信用') && /信用/.test(a.name)) return Number(a.id);
    }
    return null;
  };
}

function fingerprint(rec: ParsedBillRecord, source: string): string {
  const orderNo = String(rec.order_no || '').trim();
  if (orderNo) return `order:${source}:${orderNo}`;
  return `${rec.txn_date}|${rec.amount_cents}|${rec.merchant || ''}`;
}

async function loadDupSet(db: Db, ledgerId: number, source: string): Promise<Set<string>> {
  const set = new Set<string>();
  const rows = await db.all<{ txn_date: string; amount_base_cents: number; merchant: string | null; ai_json: string | null }>(
    'SELECT txn_date, amount_base_cents, merchant, ai_json FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND source = ?',
    ledgerId,
    'import',
  );
  for (const t of rows) {
    set.add(`${t.txn_date}|${t.amount_base_cents}|${t.merchant || ''}`);
    try {
      const orderNo = (JSON.parse(t.ai_json || '{}') as { order_no?: string })?.order_no;
      if (orderNo) set.add(`order:${source}:${orderNo}`);
    } catch {
      /* ignore */
    }
  }
  return set;
}

async function ensureAccount(
  db: Db,
  ledgerId: number,
  name: string | null,
  createdList: string[],
  accounts: Array<{ id: number; name: string; currency: string }>,
  resolveAccount: (h: string | null) => number | null,
  currency: string,
): Promise<number | null> {
  if (!name) return null;
  const id = resolveAccount(name);
  if (id) return id;
  const type = /信用|花呗|白条|分期/.test(name)
    ? 'credit'
    : /储值|充值|预付|会员卡|礼品卡/.test(name)
      ? 'prepaid'
      : /支付宝|微信|京东|云闪付/.test(name)
        ? 'virtual'
        : /银行|卡/.test(name)
          ? 'debit'
          : 'other';
  const icon = type === 'credit' ? '💳' : type === 'prepaid' ? '🎟️' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦' : '📦';
  const r = await db.run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     SELECT ?,?,?,?,?,0,0,999,?,? WHERE ${activeLedgerGuard}`,
    ledgerId,
    String(name).slice(0, 30),
    type,
    icon,
    currency,
    '由账单导入自动创建',
    nowStr(),
    ledgerId,
  );
  if (!r.changes) throw new Error('账本已归档，只能查阅和导出');
  const newId = r.lastInsertRowid;
  accounts.push({ id: newId, name: String(name).slice(0, 30), currency });
  createdList.push(name);
  return newId;
}

const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

export async function importRecords(
  db: Db,
  {
    ledgerId,
    userId,
    records,
    neutralRecords = [],
    includeNeutral = false,
    source,
    fileName,
    autoCreateAccount = true,
    defaultAccountId = null,
    env = null,
  }: {
    ledgerId: number;
    userId: number;
    records: ParsedBillRecord[];
    neutralRecords?: ParsedBillRecord[];
    includeNeutral?: boolean;
    source: string;
    fileName: string;
    autoCreateAccount?: boolean;
    defaultAccountId?: number | null;
    env?: Pick<Env, 'ATTACHMENTS'> | null;
  },
) {
  const createdAccounts: string[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ index: number; line: number | null; merchant: string; error: string }> = [];
  const failuresAll: Array<{ index: number; line: number | null; merchant: string; error: string }> = [];
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();

  const [catRows, accounts, initialDupSet, { code: baseCurrency, rates }] = await Promise.all([
    db.all<{ id: number; name: string; kind: string; parent: string | null }>(
      `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`,
      ledgerId,
    ),
    db.all<{ id: number; name: string; currency: string }>(
      'SELECT id, name, currency FROM accounts WHERE ledger_id = ? AND is_archived = 0', ledgerId,
    ),
    loadDupSet(db, ledgerId, source),
    baseExchangeRates(db),
  ]);
  const resolveCategory = makeCategoryResolver(catRows);
  const resolveAccount = makeAccountResolver(accounts);
  let dupSet = initialDupSet;
  const seenFp = new Set<string>();

  const accountAmount = (id: number, cents: number) => {
    const account = accounts.find((account) => Number(account.id) === id);
    if (!account) throw new Error('导入账户已失效，请重新选择账户');
    const currency = account.currency.toUpperCase();
    return accountCentsFromBase(cents, currency, baseCurrency, rates.get(currency));
  };
  const insertSql = `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at, account_amount_cents, to_account_amount_cents)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${activeLedgerGuard}`;

  const stmts: Array<{
    sql: string;
    params: unknown[];
    fp: string;
    effects: BatchStatement[];
    index: number;
    line: number | null;
    merchant: string;
  }> = [];

  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    try {
      const fp = fingerprint(rec, source);
      if (dupSet.has(fp) || seenFp.has(fp)) {
        skipped++;
        continue;
      }
      let categoryId: number | null = null;
      let toAccountId: number | null = null;
      const accountId = autoCreateAccount
        ? (await ensureAccount(db, ledgerId, rec.account_hint, createdAccounts, accounts, resolveAccount, baseCurrency)) ||
          defaultAccountId
        : resolveAccount(rec.account_hint) || defaultAccountId;
      if (!accountId) {
        throw new Error('无法确定账户（无账户信息且未设置默认账户，请先创建账户或在导入时选择默认账户）');
      }

      if (rec.neutral) {
        const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
        toAccountId = autoCreateAccount
          ? (await ensureAccount(db, ledgerId, cpName, createdAccounts, accounts, resolveAccount, baseCurrency)) ||
            (await ensureAccount(db, ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts, accounts, resolveAccount, baseCurrency))
          : resolveAccount(cpName) || null;
        if (!toAccountId) {
          throw new Error('无法确定对方账户（未开启自动创建账户，请先创建账户或开启自动创建）');
        }
      } else {
        const kind = rec.type === 'income' ? 'income' : 'expense';
        const kw = classifyByKeywords(rec.text);
        if (rec.category_hint) categoryId = resolveCategory(rec.category_hint, kind);
        if (!categoryId && kw) categoryId = resolveCategory(kw.category, kw.kind === 'income' ? 'income' : kind);
        if (!categoryId) categoryId = resolveCategory(kind === 'income' ? '其他收入' : '其他支出', kind);
      }

      const effect = {
        type: rec.type, amount_cents: rec.amount_cents, amount_base_cents: rec.amount_cents,
        currency: baseCurrency, account_id: accountId, to_account_id: toAccountId,
      };
      const amounts = {
        account_amount_cents: accountAmount(accountId, rec.amount_cents),
        to_account_amount_cents: toAccountId === null ? null : accountAmount(toAccountId, rec.amount_cents),
      };
      const now = nowStr();
      stmts.push({
        effects: balanceDeltaStmts([[{ ...effect, ...amounts }, 1]]).map(([sql, args = []]) =>
          [`${sql} AND ${activeLedgerGuard}`, [...args, ledgerId]]),
        sql: insertSql,
        params: [
          ledgerId,
          rec.type,
          rec.amount_cents,
          baseCurrency,
          1,
          rec.amount_cents,
          accountId,
          toAccountId,
          categoryId,
          userId,
          rec.txn_date,
          rec.note,
          rec.merchant,
          'cleared',
          'import',
          JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral }),
          now,
          now,
          amounts.account_amount_cents,
          amounts.to_account_amount_cents,
          ledgerId,
        ],
        fp,
        index: i,
        line: rec.line || null,
        merchant: rec.merchant || '',
      });
      seenFp.add(fp);
    } catch (e) {
      failed++;
      const f = { index: i, line: rec.line || null, merchant: rec.merchant || '', error: e instanceof Error ? e.message : String(e) };
      failuresAll.push(f);
      if (failures.length < 10) failures.push(f);
    }
  }

  const BATCH_SIZE = 200;
  for (let start = 0; start < stmts.length; start += BATCH_SIZE) {
    const chunk = stmts.slice(start, start + BATCH_SIZE);
    try {
      const results = await db.batch(chunk.flatMap((s): BatchStatement[] => [[s.sql, s.params], ...s.effects]));
      // The active-ledger guard has the same value for the entire D1 batch.
      for (const s of chunk) {
        if (results[0].meta.changes) {
          dupSet.add(s.fp);
          imported++;
        } else {
          failed++;
          const f = { index: s.index, line: s.line, merchant: s.merchant, error: '账本已归档，只能查阅和导出' };
          failuresAll.push(f);
          if (failures.length < 10) failures.push(f);
        }
      }
    } catch {
      dupSet = await loadDupSet(db, ledgerId, source);
      for (const s of chunk) {
        if (dupSet.has(s.fp)) {
          skipped++;
          continue;
        }
        try {
          const [inserted] = await db.batch([[s.sql, s.params], ...s.effects]);
          if (!inserted.meta.changes) throw new Error('账本已归档，只能查阅和导出');
          dupSet.add(s.fp);
          imported++;
        } catch (e2) {
          failed++;
          const f = {
            index: s.index,
            line: s.line || null,
            merchant: s.merchant || '',
            error: e2 instanceof Error ? e2.message : String(e2),
          };
          failuresAll.push(f);
          if (failures.length < 10) failures.push(f);
        }
      }
    }
  }

  const failLabel = (f: { index: number; line: number | null }) => (f.line ? `#${f.line}行` : `第${f.index + 1}条`);
  const msgs: string[] = [];
  if (createdAccounts.length) msgs.push(`自动创建账户：${createdAccounts.join('、')}`);
  if (failures.length) {
    msgs.push(`失败 ${failed} 笔：${failures.map((f) => `${failLabel(f)} ${f.merchant || ''} ${f.error}`.trim()).join('；')}`);
  }
  const job = await db.run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${activeLedgerGuard}`,
    ledgerId,
    userId,
    source,
    fileName,
    list.length,
    imported,
    skipped,
    failed,
    'done',
    msgs.length ? msgs.join('；') : null,
    nowStr(),
    ledgerId,
  );

  let failuresUrl: string | null = null;
  if (job.changes && failed > 10 && env?.ATTACHMENTS) {
    try {
      const key = `imports/failures-${job.lastInsertRowid}.json`;
      await env.ATTACHMENTS.put(
        key,
        JSON.stringify({ jobId: job.lastInsertRowid, fileName, source, failed, failures: failuresAll }, null, 2),
        { httpMetadata: { contentType: 'application/json' } },
      );
      const fullMsg = `${msgs.length ? `${msgs.join('；')}；` : ''}完整失败清单（共 ${failed} 条）：${key}`;
      await db.run(`UPDATE import_jobs SET message = ? WHERE id = ? AND ${activeLedgerGuard}`, fullMsg, job.lastInsertRowid, ledgerId);
      failuresUrl = key;
    } catch (e) {
      console.error('[import] 失败清单写入 R2 失败:', e);
    }
  }
  const failuresSaveFailed = failed > 10 && !failuresUrl;
  return {
    imported,
    skipped,
    failed,
    createdAccounts,
    jobId: job.lastInsertRowid,
    failures,
    failuresUrl,
    failuresSaveFailed,
    ...(failuresSaveFailed ? { failuresAll } : {}),
  };
}

export function csvEscape(v: unknown): string {
  const raw = v === null || v === undefined ? '' : String(v);
  const isPlainNegativeNumber = /^-\d+(\.\d+)?$/.test(raw);
  const needsNeutralize =
    /^[\t\r]/.test(raw) ||
    /^[\t\r ]*[=+@]/.test(raw) ||
    (/^[\t\r ]*-/.test(raw) && !isPlainNegativeNumber);
  const safe = needsNeutralize ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvLine(cells: unknown[]): string {
  return `${cells.map(csvEscape).join(',')}\r\n`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  let out = `\uFEFF${csvLine(header)}`;
  for (const r of rows) out += csvLine(r);
  return out;
}

export const EXPORT_HEADER = ['日期', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '商家', '备注', '标签', '来源', '状态'];
export const NATIVE_EXPORT_HEADER = [...EXPORT_HEADER, '本位币', '汇率', '账户币种', '账户原币金额', '转入账户币种', '转入账户原币金额'];

export function exportRows(_ledgerId: number, rows: TxnRow[], baseCurrency: string) {
  return rows.map((t) => [
    t.txn_date,
    t.type_label || t.type,
    (t.amount_cents / 100).toFixed(2),
    t.currency,
    (t.amount_base_cents / 100).toFixed(2),
    t.category_path || '',
    t.account_name || '',
    t.to_account_name || '',
    t.member_name || '',
    t.merchant || '',
    t.note || '',
    t.tag_names || '',
    t.source,
    t.status,
    baseCurrency,
    t.rate,
    t.account_currency || '',
    t.account_amount_cents == null ? '' : (t.account_amount_cents / 100).toFixed(2),
    t.to_account_currency || '',
    t.to_account_amount_cents == null ? '' : (t.to_account_amount_cents / 100).toFixed(2),
  ]);
}

function parseNativeRow(row: CsvRow): ParsedBillRecord {
  const [date, label, value, currency, base, category, account, toName, , merchant, note, tags, , status,
    baseCurrency, rate, accountCurrency, accountAmount, toCurrency, toAmount] = row;
  const invalid = (field: string): never => { throw new Error(`CSV 第 ${row.line} 行的${field}无效`); };
  const cents = (raw: string | undefined, field: string) => {
    if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(raw || '')) return invalid(field);
    return parseAmountToCents(raw);
  };
  const tx = TXN_TYPES.find((t) => t.key === label || t.label === label);
  if (!tx) return invalid('交易类型');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || normalizeDate(date) !== date) return invalid('交易日期');
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== date) return invalid('交易日期');
  if (!/^[A-Z0-9]{2,8}$/.test(currency || '')) return invalid('币种');
  if (!['cleared', 'pending'].includes(status)) return invalid('流水状态');
  const amount = cents(value, '金额');
  const baseCents = cents(base, '折算金额');
  if (!amount || (tx.key !== 'adjust' && amount < 0) || (baseCents && Math.sign(baseCents) !== Math.sign(amount))) return invalid('金额');
  if (rate && !(Number.isFinite(Number(rate)) && Number(rate) > 0)) return invalid('汇率');
  if (rate ? toBase(amount, Number(rate)) !== baseCents : !baseCents) return invalid('折算金额');
  const literal = (v: string | undefined) => v?.startsWith("'") && csvEscape(v.slice(1)) === v ? v.slice(1) : (v || '');
  return {
    amount_cents: amount, type: tx.key, txn_date: date, neutral: false, skip: false, line: row.line ?? null,
    merchant: literal(merchant) || null, note: literal(note) || null, text: '', order_no: null,
    category_hint: category && category !== '未分类' ? literal(category) : null, account_hint: literal(account) || null,
    native: {
      currency, baseCents, baseCurrency: baseCurrency || '', rate: rate ? Number(rate) : null,
      accountCurrency: accountCurrency || '', accountCents: accountAmount ? cents(accountAmount, '账户原币金额') : null,
      toName: literal(toName), toCurrency: toCurrency || '', toCents: toAmount ? cents(toAmount, '转入账户原币金额') : null,
      status, tags: literal(tags).split(/\s+/).filter(Boolean),
    },
  };
}

export async function mapNativeRecords(db: Db, ledgerId: number, records: ParsedBillRecord[]) {
  const [accounts, categories, baseCurrency] = await Promise.all([
    db.all<{ id: number; name: string; currency: string }>(
      'SELECT id, name, currency FROM accounts WHERE ledger_id = ? AND is_archived = 0', ledgerId,
    ),
    db.all<{ id: number; kind: string; path: string }>(
      `SELECT c.id, c.kind, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || '/' || c.name END AS path
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`, ledgerId,
    ),
    getSetting(db, 'site.currency', 'CNY'),
  ]);
  return records.map((rec) => {
    const data = rec.native!;
    const type = TXN_TYPES.find((t) => t.key === rec.type)!;
    const error = (message: string): never => { throw new Error(`CSV 第 ${rec.line} 行：${message}`); };
    if (data.baseCurrency && data.baseCurrency !== baseCurrency) error('导出与目标站点的本位币必须一致');
    if (data.currency === baseCurrency && data.baseCents !== rec.amount_cents) error('折算金额与本位币原金额不一致');
    const findAccount = (name: string, expected: string, cents: number | null) => {
      if (!name) return { id: null, amount: null };
      const matches = accounts.filter((a) => a.name === name);
      if (matches.length !== 1) return error(`账户「${name}」不存在或重名`);
      const account = matches[0];
      if (expected && expected !== account.currency) error(`账户「${name}」币种不匹配`);
      const amount = cents ?? (account.currency === data.currency ? rec.amount_cents : account.currency === baseCurrency ? data.baseCents : null);
      if (amount === null) error(`账户「${name}」缺少原币金额`);
      const roundsToZero = account.currency === baseCurrency && data.currency !== baseCurrency && data.baseCents === 0;
      if (amount !== null && !(amount === 0 && roundsToZero) && Math.sign(amount) !== Math.sign(rec.amount_cents)) {
        error(`账户「${name}」原币金额方向不一致`);
      }
      return { id: account.id, amount };
    };
    const account = findAccount(rec.account_hint || '', data.accountCurrency, data.accountCents);
    const to = findAccount(data.toName, data.toCurrency, data.toCents);
    try {
      validateAccounts(type.key, account.id, to.id);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
    }
    if (type.flow !== 'move' && to.id) error('该交易类型不能填写转入账户');
    const kind = kindOfType(type.key);
    const matches = rec.category_hint ? categories.filter((c) => (!kind || c.kind === kind) && c.path === rec.category_hint) : [];
    if (rec.category_hint && matches.length !== 1) error(`分类「${rec.category_hint}」不存在或重名`);
    return { rec, data, account, to, categoryId: matches[0]?.id ?? null };
  });
}

export async function importNativeRecords(
  db: Db, ledgerId: number, userId: number, records: ParsedBillRecord[], fileHash: string,
) {
  const mapped = await mapNativeRecords(db, ledgerId, records);
  let imported = 0;
  for (let start = 0; start < mapped.length; start += 50) {
    const statements: BatchStatement[] = [];
    const inserts: number[] = [];
    for (const { rec, data, account, to, categoryId } of mapped.slice(start, start + 50)) {
      const key = JSON.stringify({ homeledger_csv: fileHash, line: rec.line });
      const stamp = `${nowStr()} ${uid()}`;
      inserts.push(statements.length);
      statements.push([
        `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id,
          account_amount_cents, to_account_amount_cents, category_id, user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE ${activeLedgerGuard} AND NOT EXISTS (SELECT 1 FROM transactions WHERE ledger_id = ? AND source = 'homeledger_csv' AND ai_json = ?)`,
        [ledgerId, rec.type, rec.amount_cents, data.currency, data.rate ?? (data.baseCents / rec.amount_cents || 1), data.baseCents,
          account.id, to.id, account.amount, to.amount, categoryId, userId, rec.txn_date, rec.note, rec.merchant, data.status,
          'homeledger_csv', key, nowStr(), stamp, ledgerId, ledgerId, key],
      ]);
      const effects = balanceDeltaStmts([[{
        type: rec.type, amount_base_cents: data.baseCents, account_id: account.id, to_account_id: to.id,
        account_amount_cents: account.amount, to_account_amount_cents: to.amount,
      }, 1]]);
      for (const [sql, args = []] of effects) {
        statements.push([`${sql} AND EXISTS (SELECT 1 FROM transactions WHERE ledger_id = ? AND updated_at = ?)`, [...args, ledgerId, stamp]]);
      }
      for (const tag of new Set(data.tags)) {
        statements.push(
          [`INSERT OR IGNORE INTO tags (ledger_id, name, color)
            SELECT ?, ?, '#0F766E' WHERE EXISTS (SELECT 1 FROM transactions WHERE ledger_id = ? AND updated_at = ?)`, [ledgerId, tag, ledgerId, stamp]],
          [`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
            SELECT t.id, g.id FROM transactions t JOIN tags g ON g.ledger_id = t.ledger_id AND g.name = ?
            WHERE t.ledger_id = ? AND t.updated_at = ?`, [tag, ledgerId, stamp]],
        );
      }
    }
    const result = await db.batch(statements);
    imported += inserts.reduce((count, index) => count + Number(result[index]?.meta?.changes || 0), 0);
  }
  if (mapped.some(({ rec }) => ['lend', 'borrow', 'repay_receive', 'repay_pay'].includes(rec.type))) {
    await syncDebts(db, ledgerId);
  }
  return { imported, skipped: records.length - imported, failed: 0, failures: [], createdAccounts: [] };
}
