import type { BatchStatement } from '../types.js';

export const BACKUP_TABLES = [
  'users',
  'settings',
  'ledgers',
  'ledger_members',
  'ledger_invites',
  'accounts',
  'categories',
  'tags',
  'transactions',
  'transaction_tags',
  'splits',
  'attachments',
  'session_cards',
  'session_card_logs',
  'budgets',
  'recurring_rules',
  'goals',
  'subscriptions',
  'debts',
  'notifications',
  'exchange_rates',
  'import_jobs',
  'api_tokens',
] as const;

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_SQL_PARAMS = 95;

export interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseSqlDefault(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (/^null$/i.test(s)) return null;
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function isMissingRequired(val: unknown, col: TableColumnInfo): boolean {
  if (val === undefined || val === null) return true;
  if (col.pk > 0 && col.type.toUpperCase().includes('TEXT') && String(val) === '') return true;
  return false;
}

export function validateAndBuildRestorePlan(
  parsed: unknown,
  schema: Map<string, TableColumnInfo[]>,
): { stmts: BatchStatement[]; counts: Record<string, number> } {
  if (!isPlainObject(parsed)) {
    throw new Error('备份文件格式无效：根节点必须为 JSON 对象');
  }
  if (parsed.app !== 'homeledger') {
    throw new Error('备份文件来源不匹配（app 字段必须为 homeledger）');
  }
  const version = Number(parsed.version);
  if (version !== 1 && version !== 2) {
    throw new Error(`不支持的备份版本：${String(parsed.version ?? '未知')}`);
  }
  if (!isPlainObject(parsed.tables)) {
    throw new Error('备份文件格式无效（缺少 tables 对象）');
  }

  const tables = parsed.tables;
  for (const tbl of BACKUP_TABLES) {
    if (tbl in tables && tables[tbl] !== undefined && !Array.isArray(tables[tbl])) {
      throw new Error(`表 ${tbl} 数据格式无效（必须为数组）`);
    }
  }

  const usersRows = Array.isArray(tables.users) ? tables.users : [];
  if (!usersRows.length) {
    throw new Error('备份数据缺少用户记录（users 不能为空）');
  }
  const hasActiveAdmin = usersRows.some(
    (u) =>
      isPlainObject(u) &&
      String(u.status ?? 'active') === 'active' &&
      Number(u.is_admin) === 1 &&
      typeof u.username === 'string' &&
      u.username.trim().length > 0 &&
      typeof u.password_hash === 'string' &&
      u.password_hash.trim().length > 0,
  );
  if (!hasActiveAdmin) {
    throw new Error('备份数据必须至少包含一名状态正常的站点管理员');
  }

  const categoryRows = Array.isArray(tables.categories) ? tables.categories : [];
  if (!categoryRows.length) {
    throw new Error('备份数据缺少分类记录（categories 不能为空）');
  }

  const insertStmts: BatchStatement[] = [];
  const counts: Record<string, number> = {};

  for (const tbl of BACKUP_TABLES) {
    const rawRows = Array.isArray(tables[tbl]) ? tables[tbl] : [];
    const colInfos = schema.get(tbl) || [];
    if (!rawRows.length) {
      counts[tbl] = 0;
      continue;
    }
    if (!colInfos.length) {
      throw new Error(`当前数据库缺少表结构：${tbl}`);
    }

    const colMap = new Map(colInfos.map((c) => [c.name, c]));
    const unionKeys = new Set<string>();
    const pkCols = colInfos.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const singleIntPk =
      pkCols.length === 1 && pkCols[0].type.toUpperCase().includes('INTEGER') ? pkCols[0].name : null;

    const pkSeen = new Set<string>();
    const usernameSeen = new Set<string>();
    const settingKeySeen = new Set<string>();
    const tokenHashSeen = new Set<string>();
    const inviteCodeSeen = new Set<string>();
    const memberSeen = new Set<string>();
    const tagSeen = new Set<string>();
    const rateSeen = new Set<string>();
    const dedupeSeen = new Set<string>();

    for (let idx = 0; idx < rawRows.length; idx++) {
      const row = rawRows[idx];
      if (!isPlainObject(row)) {
        throw new Error(`表 ${tbl} 第 ${idx + 1} 行格式无效`);
      }
      for (const k of Object.keys(row)) {
        if (colMap.has(k)) unionKeys.add(k);
      }

      for (const col of colInfos) {
        const val = row[col.name];
        const isTextPk = col.pk > 0 && !col.type.toUpperCase().includes('INTEGER');
        const isCompositePk = col.pk > 0 && pkCols.length > 1;
        const mustPresent = (col.notnull === 1 && col.dflt_value === null && col.pk === 0) || isTextPk || isCompositePk;
        if (mustPresent && isMissingRequired(val, col)) {
          throw new Error(`表 ${tbl} 第 ${idx + 1} 行缺少必填字段 ${col.name}`);
        }
        if (val === null && col.notnull === 1) {
          throw new Error(`表 ${tbl} 第 ${idx + 1} 行字段 ${col.name} 不可为空`);
        }
      }

      if (singleIntPk && row[singleIntPk] !== undefined && row[singleIntPk] !== null) {
        const idNum = Number(row[singleIntPk]);
        if (!Number.isInteger(idNum)) {
          throw new Error(`表 ${tbl} 第 ${idx + 1} 行主键 ${singleIntPk} 无效`);
        }
        const idKey = String(idNum);
        if (pkSeen.has(idKey)) throw new Error(`表 ${tbl} 存在重复主键 ${singleIntPk}=${idKey}`);
        pkSeen.add(idKey);
      }
      if (pkCols.length > 1) {
        const compKey = pkCols.map((c) => String(row[c.name])).join('\u0000');
        if (pkSeen.has(compKey)) throw new Error(`表 ${tbl} 存在重复联合主键`);
        pkSeen.add(compKey);
      }

      if (tbl === 'users') {
        const uname = String(row.username || '').trim();
        if (!uname) throw new Error(`表 users 第 ${idx + 1} 行缺少 username`);
        if (usernameSeen.has(uname)) throw new Error(`表 users 存在重复用户名：${uname}`);
        usernameSeen.add(uname);
        if (!String(row.password_hash || '').trim()) {
          throw new Error(`表 users 第 ${idx + 1} 行缺少 password_hash`);
        }
      } else if (tbl === 'settings') {
        const sk = String(row.key || '');
        if (!sk) throw new Error(`表 settings 第 ${idx + 1} 行 key 不能为空`);
        if (settingKeySeen.has(sk)) throw new Error(`表 settings 存在重复配置键：${sk}`);
        settingKeySeen.add(sk);
      } else if (tbl === 'api_tokens') {
        const th = String(row.token_hash || '');
        if (tokenHashSeen.has(th)) throw new Error(`表 api_tokens 存在重复令牌哈希`);
        tokenHashSeen.add(th);
      } else if (tbl === 'ledger_invites') {
        const code = String(row.code || '');
        if (inviteCodeSeen.has(code)) throw new Error(`表 ledger_invites 存在重复邀请码：${code}`);
        inviteCodeSeen.add(code);
      } else if (tbl === 'ledger_members') {
        const mk = `${row.ledger_id}\u0000${row.user_id}`;
        if (memberSeen.has(mk)) throw new Error(`表 ledger_members 存在重复成员关系`);
        memberSeen.add(mk);
      } else if (tbl === 'tags') {
        const tk = `${row.ledger_id}\u0000${row.name}`;
        if (tagSeen.has(tk)) throw new Error(`表 tags 存在重复标签：${String(row.name)}`);
        tagSeen.add(tk);
      } else if (tbl === 'exchange_rates') {
        const rk = `${row.base}\u0000${row.quote}`;
        if (rateSeen.has(rk)) throw new Error(`表 exchange_rates 存在重复汇率对`);
        rateSeen.add(rk);
      } else if (tbl === 'notifications' && row.dedupe_key != null) {
        const dk = `${row.user_id}\u0000${row.dedupe_key}`;
        if (dedupeSeen.has(dk)) throw new Error(`表 notifications 存在重复去重键`);
        dedupeSeen.add(dk);
      }
    }

    const cols = colInfos.map((c) => c.name).filter((name) => unionKeys.has(name));
    if (!cols.length) {
      throw new Error(`表 ${tbl} 不包含任何与当前 Schema 匹配的列`);
    }

    const rowsPerStmt = Math.max(1, Math.floor(MAX_SQL_PARAMS / cols.length));
    const tuplePlaceholder = `(${cols.map(() => '?').join(',')})`;
    const colList = cols.join(',');

    for (let i = 0; i < rawRows.length; i += rowsPerStmt) {
      const chunk = rawRows.slice(i, i + rowsPerStmt) as Record<string, unknown>[];
      const params: unknown[] = [];
      for (const row of chunk) {
        for (const colName of cols) {
          const v = row[colName];
          if (v !== undefined) {
            params.push(v);
          } else {
            const info = colMap.get(colName)!;
            params.push(info.dflt_value !== null ? parseSqlDefault(info.dflt_value) : null);
          }
        }
      }
      const valuesClause = chunk.map(() => tuplePlaceholder).join(',');
      insertStmts.push([`INSERT INTO ${tbl} (${colList}) VALUES ${valuesClause}`, params]);
    }
    counts[tbl] = rawRows.length;
  }

  const deleteStmts: BatchStatement[] = [...BACKUP_TABLES].reverse().map((tbl) => [`DELETE FROM ${tbl}`]);
  const stmts: BatchStatement[] = [
    ...deleteStmts,
    ...insertStmts,
    ['UPDATE users SET token_version = COALESCE(token_version, 1) + 1'],
  ];

  return { stmts, counts };
}
