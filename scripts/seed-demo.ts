import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nowStr, todayStr } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';

export interface SeedDemoOptions {
  username: string;
  password: string;
  ledgerName: string;
  today: string;
  remote: boolean;
  confirmRemote: boolean;
  db: string;
  config?: string;
  out?: string;
  dryRun: boolean;
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export async function buildSeedDemoSql(opts: {
  username: string;
  password: string;
  ledgerName: string;
  today: string;
}): Promise<string> {
  if (opts.password.length < 8 || opts.password.length > 128) {
    throw new Error('演示账号密码长度必须在 8 到 128 位之间');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) {
    throw new Error('--today 必须为 YYYY-MM-DD 格式');
  }
  const ym = opts.today.slice(0, 7);
  const ts = nowStr();
  const hash = await hashPassword(opts.password);

  const uCond = `u.username = ${sqlStr(opts.username)}`;
  const lCond = `l.owner_id = (SELECT id FROM users WHERE username = ${sqlStr(opts.username)} LIMIT 1) AND l.name = ${sqlStr(opts.ledgerName)}`;
  const lidExpr = `(SELECT l.id FROM ledgers l WHERE ${lCond} LIMIT 1)`;
  const uidExpr = `(SELECT id FROM users WHERE username = ${sqlStr(opts.username)} LIMIT 1)`;
  const accExpr = (name: string) => `(SELECT id FROM accounts WHERE ledger_id = ${lidExpr} AND name = ${sqlStr(name)} LIMIT 1)`;
  const catExpr = (kind: 'expense' | 'income', name: string) =>
    `COALESCE((SELECT id FROM categories WHERE kind = ${sqlStr(kind)} AND name = ${sqlStr(name)} LIMIT 1), (SELECT id FROM categories WHERE kind = ${sqlStr(kind)} LIMIT 1))`;

  return [
    '-- HomeLedger D1 示例数据初始化脚本（幂等，无显式事务语句以兼容 D1）',
    `INSERT OR IGNORE INTO users (username, email, password_hash, display_name, avatar_color, is_admin, status, token_version, created_at)`,
    `VALUES (${sqlStr(opts.username)}, ${sqlStr(`${opts.username}@example.com`)}, ${sqlStr(hash)}, '家庭演示用户', '#4f7cff', 0, 'active', 1, ${sqlStr(ts)});`,
    '',
    `INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at)`,
    `SELECT ${sqlStr(opts.ledgerName)}, 'family', 'CNY', '🏠', '#4f7cff', u.id, '用于功能演示的家庭样例账本', ${sqlStr(ts)}`,
    `FROM users u WHERE ${uCond} AND NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.owner_id = u.id AND l.name = ${sqlStr(opts.ledgerName)});`,
    '',
    `INSERT OR IGNORE INTO ledger_members (ledger_id, user_id, role, nickname, joined_at)`,
    `SELECT l.id, u.id, 'owner', '账本管理员', ${sqlStr(ts)} FROM ledgers l JOIN users u ON u.id = l.owner_id WHERE ${lCond};`,
    '',
    '-- 示例账户（余额与下方示例流水保持会计一致）',
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, include_in_net, sort_order, created_at)`,
    `SELECT ${lidExpr}, '现金', 'cash', '💵', 'CNY', 50000, 50000, 1, 1, ${sqlStr(ts)} WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = ${lidExpr} AND a.name = '现金');`,
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, include_in_net, sort_order, created_at)`,
    `SELECT ${lidExpr}, '招商银行', 'debit', '🏦', 'CNY', 2000000, 3100000, 1, 2, ${sqlStr(ts)} WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = ${lidExpr} AND a.name = '招商银行');`,
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, include_in_net, sort_order, created_at)`,
    `SELECT ${lidExpr}, '微信钱包', 'virtual', '📱', 'CNY', 50000, 142950, 1, 3, ${sqlStr(ts)} WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = ${lidExpr} AND a.name = '微信钱包');`,
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, credit_limit, bill_day, due_day, include_in_net, sort_order, created_at)`,
    `SELECT ${lidExpr}, '招商信用卡', 'credit', '💳', 'CNY', 0, -32800, 2000000, 5, 25, 1, 4, ${sqlStr(ts)} WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.ledger_id = ${lidExpr} AND a.name = '招商信用卡');`,
    '',
    '-- 示例标签',
    `INSERT OR IGNORE INTO tags (ledger_id, name, color) SELECT ${lidExpr}, '日常', '#0F766E' WHERE ${lidExpr} IS NOT NULL;`,
    '',
    '-- 示例流水',
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)`,
    `SELECT ${lidExpr}, 'income', 1200000, 'CNY', 1, 1200000, ${accExpr('招商银行')}, ${catExpr('income', '工资')}, ${uidExpr}, ${sqlStr(`${ym}-05`)}, '[演示] 月度工资发放', '公司薪酬', 'cleared', 'manual', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 月度工资发放');`,
    '',
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, user_id, txn_date, note, status, source, created_at, updated_at)`,
    `SELECT ${lidExpr}, 'transfer', 100000, 'CNY', 1, 100000, ${accExpr('招商银行')}, ${accExpr('微信钱包')}, ${uidExpr}, ${sqlStr(`${ym}-06`)}, '[演示] 银行卡转入微信零钱', 'cleared', 'manual', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 银行卡转入微信零钱');`,
    '',
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)`,
    `SELECT ${lidExpr}, 'expense', 4850, 'CNY', 1, 4850, ${accExpr('微信钱包')}, ${catExpr('expense', '餐饮')}, ${uidExpr}, ${sqlStr(opts.today)}, '[演示] 午餐简餐', '街头面馆', 'cleared', 'manual', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 午餐简餐');`,
    '',
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)`,
    `SELECT ${lidExpr}, 'expense', 2200, 'CNY', 1, 2200, ${accExpr('微信钱包')}, ${catExpr('expense', '交通')}, ${uidExpr}, ${sqlStr(opts.today)}, '[演示] 地铁通勤', '城市地铁', 'cleared', 'manual', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 地铁通勤');`,
    '',
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)`,
    `SELECT ${lidExpr}, 'expense', 32800, 'CNY', 1, 32800, ${accExpr('招商信用卡')}, ${catExpr('expense', '日用')}, ${uidExpr}, ${sqlStr(opts.today)}, '[演示] 超市采购日用品', '永辉超市', 'cleared', 'manual', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 超市采购日用品');`,
    '',
    `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)`,
    `SELECT t.id, tg.id FROM transactions t JOIN tags tg ON tg.ledger_id = t.ledger_id AND tg.name = '日常' WHERE t.ledger_id = ${lidExpr} AND t.note = '[演示] 午餐简餐';`,
    '',
    '-- 示例预算、订阅、目标、借贷与次卡',
    `INSERT INTO budgets (ledger_id, name, scope, period, amount_cents, currency, trigger_type, rollover, alert_pct, is_active, created_at)`,
    `SELECT ${lidExpr}, '月度家庭总预算', 'overall', 'monthly', 500000, 'CNY', 'expense', 0, 80, 1, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.ledger_id = ${lidExpr} AND b.name = '月度家庭总预算');`,
    '',
    `INSERT INTO subscriptions (ledger_id, name, icon, plan, amount_cents, currency, cycle, cycle_n, anchor_day, account_id, category_id, auto_renew, next_charge_at, reminder_days, status, created_by_user_id, created_at)`,
    `SELECT ${lidExpr}, 'iCloud+ 家庭存储', '☁️', '200GB 月付', 2100, 'CNY', 'monthly', 1, 15, ${accExpr('微信钱包')}, ${catExpr('expense', '通讯')}, 1, ${sqlStr(`${ym}-15`)}, 3, 'active', ${uidExpr}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.ledger_id = ${lidExpr} AND s.name = 'iCloud+ 家庭存储');`,
    '',
    `INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, status, note, created_at)`,
    `SELECT ${lidExpr}, '家庭应急备用金', '🛡️', 5000000, 1500000, ${accExpr('招商银行')}, 'active', '预留 6 个月家庭开支', ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.ledger_id = ${lidExpr} AND g.name = '家庭应急备用金');`,
    '',
    `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, currency, account_id, status, note, created_at)`,
    `SELECT ${lidExpr}, 'receivable', '同事小王', 50000, 50000, 'CNY', ${accExpr('微信钱包')}, 'open', '聚餐代垫待结算', ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM debts d WHERE d.ledger_id = ${lidExpr} AND d.counterparty = '同事小王');`,
    '',
    `INSERT INTO session_cards (ledger_id, name, icon, merchant, total_sessions, remaining_sessions, total_cost_cents, currency, purchase_date, is_archived, note, created_at, updated_at)`,
    `SELECT ${lidExpr}, '小区洗车次卡', '🚗', '亮洁汽车美容', 10, 8, 30000, 'CNY', ${sqlStr(opts.today)}, 0, '周末洗车使用', ${sqlStr(ts)}, ${sqlStr(ts)}`,
    `WHERE ${lidExpr} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_cards sc WHERE sc.ledger_id = ${lidExpr} AND sc.name = '小区洗车次卡');`,
    '',
  ].join('\n');
}

const DEFAULT_DEMO_PASSWORD = 'demo123456';

function parseArgs(argv: string[]): SeedDemoOptions {
  const opts: SeedDemoOptions = {
    username: 'demo',
    password: DEFAULT_DEMO_PASSWORD,
    ledgerName: '家庭示例账本',
    today: todayStr(),
    remote: false,
    confirmRemote: false,
    db: 'DB',
    dryRun: false,
  };
  let sawLocal = false;
  let sawRemote = false;
  let passwordProvided = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      console.log(
        [
          '用法: npm run ops:seed-demo -- [选项]',
          '',
          '选项:',
          '  --username <name>   演示用户名（默认 demo）',
          '  --password <pass>   演示用户密码（>= 8 位；--local 默认 demo123456，--remote 必须显式指定独立强密码）',
          '  --ledger <name>     演示账本名称（默认 家庭示例账本）',
          '  --today <YYYY-MM-DD> 基准日期（默认按 Asia/Shanghai 当天）',
          '  --local             写入本地 Wrangler D1（默认）',
          '  --remote            写入线上 Cloudflare D1（必须同时传 --confirm-remote 与独立 --password）',
          '  --confirm-remote    确认向远程 D1 注入示例数据',
          '  --db <name>         Wrangler D1 绑定名或库名（默认 DB）',
          '  --config <path>     指定 Wrangler 配置文件（例如 wrangler.local.toml）',
          '  --out <file>        将生成的 SQL 写入指定路径',
          '  --dry-run           仅打印/写出 SQL，不执行 wrangler d1 execute',
        ].join('\n'),
      );
      process.exit(0);
    } else if (a === '--username') {
      opts.username = argv[++i] ?? '';
      if (!opts.username) throw new Error('--username 缺少参数值');
    } else if (a === '--password') {
      opts.password = argv[++i] ?? '';
      if (!opts.password) throw new Error('--password 缺少参数值');
      passwordProvided = true;
    } else if (a === '--ledger') {
      opts.ledgerName = argv[++i] ?? '';
      if (!opts.ledgerName) throw new Error('--ledger 缺少参数值');
    } else if (a === '--today') {
      opts.today = argv[++i] ?? '';
      if (!opts.today) throw new Error('--today 缺少参数值');
    } else if (a === '--local') {
      sawLocal = true;
      opts.remote = false;
    } else if (a === '--remote') {
      sawRemote = true;
      opts.remote = true;
    } else if (a === '--confirm-remote') {
      opts.confirmRemote = true;
    } else if (a === '--db') {
      opts.db = argv[++i] ?? '';
      if (!opts.db) throw new Error('--db 缺少参数值');
    } else if (a === '--config') {
      opts.config = argv[++i];
      if (!opts.config) throw new Error('--config 缺少参数值');
    } else if (a === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Error('--out 缺少参数值');
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (sawLocal && sawRemote) {
    throw new Error('--local 与 --remote 不能同时指定');
  }
  if (opts.remote && (!passwordProvided || opts.password === DEFAULT_DEMO_PASSWORD)) {
    throw new Error('拒绝在远程 D1 使用公开默认密码：请通过 --password 显式指定至少 8 位的独立强密码');
  }
  if (opts.remote && !opts.dryRun && !opts.confirmRemote) {
    throw new Error('拒绝直接向远程 D1 注入演示数据：如确需执行请显式加上 --confirm-remote');
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sql = await buildSeedDemoSql({
    username: opts.username,
    password: opts.password,
    ledgerName: opts.ledgerName,
    today: opts.today,
  });

  if (opts.out) {
    writeFileSync(opts.out, sql, 'utf8');
  }
  if (opts.dryRun) {
    if (!opts.out) process.stdout.write(sql);
    else console.log(`✅ 已生成演示数据 SQL: ${opts.out}`);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'hl-seed-demo-'));
  const sqlFile = join(tmpDir, 'seed-demo.sql');
  try {
    writeFileSync(sqlFile, sql, 'utf8');
    const args = ['wrangler', 'd1', 'execute', opts.db, opts.remote ? '--remote' : '--local'];
    if (opts.config) args.push('--config', opts.config);
    args.push('--file', sqlFile);
    execFileSync('npx', args, { stdio: 'inherit' });
    console.log(`\n✅ 演示数据已写入（账号: ${opts.username} / 账本: ${opts.ledgerName}）。`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error('❌ 演示数据写入失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
