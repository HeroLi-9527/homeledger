import { getSetting, txnEffects, TXN_TYPE_MAP } from '../db.js';
import type { BatchStatement, Db, TxnRow } from '../types.js';
import { MAX_SQL_PARAMS, type TableColumnInfo } from './backup.js';
import { uid } from './util.js';

type Cell = string | number | null;
type Row = Record<string, Cell>;

const ledgerTables = [
  'accounts', 'categories', 'tags', 'budgets', 'recurring_rules', 'subscriptions',
  'debts', 'goals', 'session_cards', 'transactions', 'session_card_logs', 'transaction_tags', 'splits',
] as const;
type Table = 'ledgers' | (typeof ledgerTables)[number];

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function sourceId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}无效`);
  return value;
}

function readRows(value: unknown, table: Table, optional = false): Row[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`账本文件缺少 ${table} 数据`);
  return value.map((item) => {
    const row = object(item, table);
    for (const value of Object.values(row)) {
      if (!(typeof value === 'boolean' || value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) {
        throw new Error(`${table} 存在无法写入的字段`);
      }
    }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value])) as Row;
  });
}

function appendRows(stmts: BatchStatement[], table: Table, rows: Row[], schema: TableColumnInfo[]) {
  const groups = new Map<string, { cols: string[]; rows: Row[] }>();
  for (const row of rows) {
    const cols = schema.filter((col) => Object.hasOwn(row, col.name)).map((col) => col.name);
    for (const col of schema) {
      if (col.notnull && col.dflt_value == null && row[col.name] == null) {
        throw new Error(`${table} 缺少必填字段 ${col.name}`);
      }
    }
    if (!cols.length) throw new Error(`找不到 ${table} 表结构`);
    const key = cols.join(',');
    if (!groups.has(key)) groups.set(key, { cols, rows: [] });
    groups.get(key)!.rows.push(row);
  }
  for (const [columns, group] of groups) {
    const size = Math.floor(MAX_SQL_PARAMS / group.cols.length);
    const tuple = `(${group.cols.map(() => '?').join(',')})`;
    for (let i = 0; i < group.rows.length; i += size) {
      const chunk = group.rows.slice(i, i + size);
      stmts.push([
        `INSERT INTO ${table} (${columns}) VALUES ${chunk.map(() => tuple).join(',')}`,
        chunk.flatMap((row) => group.cols.map((name) => row[name])),
      ]);
    }
  }
}

export async function importLedger(db: Db, userId: number, value: unknown, copyName: string) {
  const file = object(value, '账本文件');
  if (file.app !== 'homeledger' || file.scope !== 'ledger' || (file.version !== undefined && file.version !== 1)) {
    throw new Error('请选择 HomeLedger 单账本 JSON 文件');
  }
  if (Object.values(object(file.filter ?? {}, '流水筛选条件')).some(Boolean)) throw new Error('请选择未筛选的全量账本 JSON');
  const base = String(await getSetting(db, 'site.currency', 'CNY'));
  if ((file.base_currency ?? 'CNY') !== base) throw new Error('原账本导出时的站点本位币与本站不同');
  const ledger = readRows([file.ledger], 'ledgers')[0];
  const oldLedgerId = sourceId(ledger.id, '原账本编号');
  if (typeof ledger.name !== 'string' || !ledger.name.trim()) throw new Error('账本名称无效');

  const rows = new Map<Table, Row[]>([['ledgers', [ledger]]]);
  for (const table of ledgerTables) {
    const data = table === 'transactions' && file.transaction_rows !== undefined ? file.transaction_rows : file[table];
    const imported = readRows(data, table, file.version === undefined && (table === 'splits' || table === 'transaction_tags'));
    for (const row of imported) {
      if (row.ledger_id !== oldLedgerId && !(table === 'categories' && row.ledger_id === null) && table !== 'transaction_tags') {
        throw new Error(`${table} 存在不属于原账本的记录`);
      }
    }
    rows.set(table, imported);
  }

  const tables = [...rows.keys()];
  const [schema, sequence, builtin] = await Promise.all([
    db.batch(tables.map((t) => [`PRAGMA table_info(${t})`])),
    db.all<{ name: string; seq: number }>('SELECT name, seq FROM sqlite_sequence'),
    db.all<Row>('SELECT id, name, kind, parent_id FROM categories WHERE ledger_id IS NULL'),
  ]);
  const nextId = new Map(sequence.map(({ name, seq }) => [name, Number(seq)]));
  const ids = new Map<Table, Map<number, number>>();
  const builtinRows = rows.get('categories')!.filter((r) => r.ledger_id === null);
  const builtinIds = new Map<number, number>();
  for (const row of [...builtinRows.filter((r) => r.parent_id == null), ...builtinRows.filter((r) => r.parent_id != null)]) {
    const id = sourceId(row.id, '系统分类编号');
    const parent = row.parent_id == null ? null : builtinIds.get(sourceId(row.parent_id, '系统父分类编号'));
    const match = builtin.find((c) => c.name === row.name && c.kind === row.kind && c.parent_id === parent);
    if (!match || builtinIds.has(id)) throw new Error(`无法匹配系统分类 ${row.name}`);
    builtinIds.set(id, Number(match.id));
  }
  rows.set('categories', rows.get('categories')!.filter((r) => r.ledger_id !== null));
  for (const [table, items] of rows) {
    if (table === 'transaction_tags') continue;
    const map = table === 'categories' ? builtinIds : new Map<number, number>();
    let seq = nextId.get(table) ?? 0;
    for (const row of items) {
      const old = sourceId(row.id, `${table} 原记录编号`);
      if (map.has(old)) throw new Error(`${table} 含重复编号 ${old}`);
      map.set(old, ++seq);
    }
    ids.set(table, map);
  }
  const ref = (table: Table, source: Cell | undefined, optional = false) => {
    if (source == null && optional) return null;
    const id = sourceId(source, `${table} 引用`);
    const target = ids.get(table)?.get(id);
    if (target === undefined) throw new Error(`账本文件缺少关联记录 ${table} #${id}`);
    return target;
  };
  const ledgerId = ref('ledgers', oldLedgerId)!;
  const accountCurrencies = new Map(rows.get('accounts')!.map((a) => [Number(a.id), String(a.currency).toUpperCase()]));
  const balanceDelta = new Map<number, number>();
  const groupPrefix = uid();
  const originalUser = (value: Cell | undefined) => value == null ? null : userId;
  const remap = (row: Row) => {
    if ('account_id' in row) row.account_id = ref('accounts', row.account_id, true);
    if ('to_account_id' in row) row.to_account_id = ref('accounts', row.to_account_id, true);
    if ('category_id' in row) row.category_id = ref('categories', row.category_id, true);
    if ('user_id' in row) row.user_id = originalUser(row.user_id);
  };

  for (const table of ledgerTables) {
    for (const row of rows.get(table)!) {
      if (table === 'transactions') {
        if (typeof row.type !== 'string' || !TXN_TYPE_MAP[row.type] || !Number.isSafeInteger(row.amount_cents) ||
            !Number.isSafeInteger(row.amount_base_cents) || !(Number(row.rate) > 0)) throw new Error('流水金额、汇率或类型无效');
        const nativeAmount = (accountId: Cell, saved: Cell | undefined) => {
          if (saved !== undefined) {
            if (saved !== null && (typeof saved !== 'number' || !Number.isSafeInteger(saved) ||
                (saved !== 0 && Math.sign(saved) !== Math.sign(Number(row.amount_cents))))) {
              throw new Error('流水账户原币金额无效');
            }
            return saved;
          }
          const currency = accountCurrencies.get(Number(accountId));
          return currency === String(row.currency).toUpperCase() ? row.amount_cents
            : currency === base.toUpperCase() ? row.amount_base_cents : null;
        };
        row.account_amount_cents = nativeAmount(row.account_id, row.account_amount_cents);
        row.to_account_amount_cents = nativeAmount(row.to_account_id, row.to_account_amount_cents);
        // Deleting a subscription deliberately leaves its historical charges in the ledger.
        row.subscription_id = ids.get('subscriptions')?.get(Number(row.subscription_id)) ?? null;
        row.related_id = ref('transactions', row.related_id, true);
        if (row.group_id) row.group_id = `${groupPrefix}_${row.group_id}`;
        if (row.purge_started) row.purge_started = 0;
      }
      if (table === 'categories') {
        row.parent_id = ref('categories', row.parent_id, true);
        row.is_system = 0;
      }
      if (table === 'recurring_rules') {
        const payload = JSON.parse(String(row.payload)) as unknown;
        const items = Array.isArray(payload) ? payload : (object(payload, '周期账单明细').items ?? [payload]);
        if (!Array.isArray(items)) throw new Error('周期账单明细必须是数组');
        for (const item of items) remap(object(item, '周期账单条目') as Row);
        row.payload = JSON.stringify({ items, user_id: userId });
        row.auto_post = 0;
      }
      if (table === 'subscriptions') row.auto_renew = 0;
      if (table === 'splits') {
        row.group_id = `${groupPrefix}_${row.group_id}`;
        row.user_id = null;
        row.transaction_id = ref('transactions', row.transaction_id, true);
      }
      if (table === 'session_card_logs') {
        row.card_id = ref('session_cards', row.card_id);
        row.txn_id = ref('transactions', row.txn_id, true);
      }
      if (table === 'session_cards') {
        // Legacy purges may have left a dangling reference to the purchase.
        row.purchase_txn_id = ids.get('transactions')?.get(Number(row.purchase_txn_id)) ?? null;
      }
      if (table === 'transaction_tags') {
        row.transaction_id = ref('transactions', row.transaction_id);
        row.tag_id = ref('tags', row.tag_id);
      } else {
        row.id = ref(table, row.id);
        row.ledger_id = ledgerId;
      }
      if ('created_by_user_id' in row) row.created_by_user_id = originalUser(row.created_by_user_id);
      remap(row);
      if (table === 'transactions' && row.deleted_at == null) {
        for (const { accountId, delta } of txnEffects(row as unknown as TxnRow)) {
          balanceDelta.set(accountId, (balanceDelta.get(accountId) ?? 0) + delta);
        }
      }
    }
  }
  for (const row of rows.get('accounts')!) {
    if (row.initial_cents !== undefined && !Number.isSafeInteger(row.initial_cents)) throw new Error('账户期初余额无效');
    row.balance_cents = Number(row.initial_cents ?? 0) + (balanceDelta.get(Number(row.id)) ?? 0);
  }
  ledger.id = ledgerId;
  ledger.name = copyName || `${ledger.name}（导入）`.slice(0, 40);
  ledger.owner_id = userId;
  ledger.is_archived = 0;
  const statements: BatchStatement[] = [];
  for (const [index, table] of tables.entries()) {
    appendRows(statements, table, rows.get(table)!, (schema[index].results || []) as unknown as TableColumnInfo[]);
  }
  statements.push([
    "INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?, ?, 'owner', datetime('now'))",
    [ledgerId, userId],
  ]);
  await db.batch(statements);
  return { id: ledgerId, name: ledger.name };
}
