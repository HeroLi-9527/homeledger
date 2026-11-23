import { nowStr, recalcBalances } from '../db.js';
import type { BatchStatement, Db, Env, TxnRow } from '../types.js';
import { classifyByKeywords, guessAccountName } from './ai.js';
import { parseAmountToCents } from './util.js';

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
  type: 'expense' | 'income' | 'transfer';
  amount_cents: number;
  txn_date: string | null;
  merchant: string | null;
  note: string | null;
  category_hint: string | null;
  text: string;
  account_hint: string | null;
  order_no: string | null;
  line: number | null;
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
  accounts: Array<{ id: number; name: string }>,
  resolveAccount: (h: string | null) => number | null,
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
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId,
    String(name).slice(0, 30),
    type,
    icon,
    'CNY',
    '由账单导入自动创建',
    nowStr(),
  );
  const newId = r.lastInsertRowid;
  accounts.push({ id: newId, name: String(name).slice(0, 30) });
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

  const [catRows, accounts, initialDupSet] = await Promise.all([
    db.all<{ id: number; name: string; kind: string; parent: string | null }>(
      `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`,
      ledgerId,
    ),
    db.all<{ id: number; name: string }>('SELECT id, name FROM accounts WHERE ledger_id = ? AND is_archived = 0', ledgerId),
    loadDupSet(db, ledgerId, source),
  ]);
  const resolveCategory = makeCategoryResolver(catRows);
  const resolveAccount = makeAccountResolver(accounts);
  let dupSet = initialDupSet;
  const seenFp = new Set<string>();

  const insertSql = `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  const stmts: Array<{
    sql: string;
    params: unknown[];
    fp: string;
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
        ? (await ensureAccount(db, ledgerId, rec.account_hint, createdAccounts, accounts, resolveAccount)) ||
          defaultAccountId
        : resolveAccount(rec.account_hint) || defaultAccountId;
      if (!accountId) {
        throw new Error('无法确定账户（无账户信息且未设置默认账户，请先创建账户或在导入时选择默认账户）');
      }

      if (rec.neutral) {
        const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
        toAccountId = autoCreateAccount
          ? (await ensureAccount(db, ledgerId, cpName, createdAccounts, accounts, resolveAccount)) ||
            (await ensureAccount(db, ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts, accounts, resolveAccount))
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

      const now = nowStr();
      stmts.push({
        sql: insertSql,
        params: [
          ledgerId,
          rec.type,
          rec.amount_cents,
          'CNY',
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
      await db.batch(chunk.map((s): BatchStatement => [s.sql, s.params]));
      for (const s of chunk) {
        dupSet.add(s.fp);
        imported++;
      }
    } catch {
      dupSet = await loadDupSet(db, ledgerId, source);
      for (const s of chunk) {
        if (dupSet.has(s.fp)) {
          skipped++;
          continue;
        }
        try {
          await db.run(s.sql, ...s.params);
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

  if (imported > 0) await recalcBalances(db, ledgerId);

  const failLabel = (f: { index: number; line: number | null }) => (f.line ? `#${f.line}行` : `第${f.index + 1}条`);
  const msgs: string[] = [];
  if (createdAccounts.length) msgs.push(`自动创建账户：${createdAccounts.join('、')}`);
  if (failures.length) {
    msgs.push(`失败 ${failed} 笔：${failures.map((f) => `${failLabel(f)} ${f.merchant || ''} ${f.error}`.trim()).join('；')}`);
  }
  const job = await db.run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
  );

  let failuresUrl: string | null = null;
  if (failed > 10 && env?.ATTACHMENTS) {
    try {
      const key = `imports/failures-${job.lastInsertRowid}.json`;
      await env.ATTACHMENTS.put(
        key,
        JSON.stringify({ jobId: job.lastInsertRowid, fileName, source, failed, failures: failuresAll }, null, 2),
        { httpMetadata: { contentType: 'application/json' } },
      );
      const fullMsg = `${msgs.length ? `${msgs.join('；')}；` : ''}完整失败清单（共 ${failed} 条）：${key}`;
      await db.run('UPDATE import_jobs SET message = ? WHERE id = ?', fullMsg, job.lastInsertRowid);
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
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export const EXPORT_HEADER = ['日期', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '商家', '备注', '标签', '来源', '状态'];

export function exportRows(_ledgerId: number, rows: TxnRow[]) {
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
  ]);
}
