import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../src/lib/auth.js';

export interface ResetPasswordOptions {
  username?: string;
  password?: string;
  remote: boolean;
  db: string;
  config?: string;
  dryRun: boolean;
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function generateRandomPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export async function buildResetPasswordSql(opts: { username?: string; password: string }): Promise<string> {
  if (opts.password.length < 8 || opts.password.length > 128) {
    throw new Error('密码长度必须在 8 到 128 位之间');
  }
  const hash = await hashPassword(opts.password);
  const whereUser = opts.username
    ? `username = ${sqlStr(opts.username)}`
    : 'id = (SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1)';

  return [
    '-- HomeLedger D1 管理员/用户密码重置脚本',
    `UPDATE users SET password_hash = ${sqlStr(hash)}, token_version = token_version + 1 WHERE ${whereUser};`,
    `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE ${whereUser});`,
    `SELECT id, username, is_admin, token_version FROM users WHERE ${whereUser};`,
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): ResetPasswordOptions {
  const opts: ResetPasswordOptions = {
    remote: false,
    db: 'DB',
    dryRun: false,
  };
  let sawLocal = false;
  let sawRemote = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      console.log(
        [
          '用法: npm run ops:reset-password -- [选项]',
          '',
          '选项:',
          '  --username <name>   指定要重置密码的用户名（默认重置最早的站点管理员）',
          '  --password <pass>   指定新密码（>= 8 位；省略时自动生成 16 位随机强密码）',
          '  --local             作用于本地 Wrangler D1（默认）',
          '  --remote            作用于线上 Cloudflare D1',
          '  --db <name>         Wrangler D1 绑定名或库名（默认 DB）',
          '  --config <path>     指定 Wrangler 配置文件（例如 wrangler.local.toml）',
          '  --dry-run           仅打印生成的 SQL 与密码，不执行 wrangler d1 execute',
        ].join('\n'),
      );
      process.exit(0);
    } else if (a === '--username') {
      opts.username = argv[++i];
      if (!opts.username) throw new Error('--username 缺少参数值');
    } else if (a === '--password') {
      opts.password = argv[++i];
      if (!opts.password) throw new Error('--password 缺少参数值');
    } else if (a === '--local') {
      sawLocal = true;
      opts.remote = false;
    } else if (a === '--remote') {
      sawRemote = true;
      opts.remote = true;
    } else if (a === '--db') {
      opts.db = argv[++i] ?? '';
      if (!opts.db) throw new Error('--db 缺少参数值');
    } else if (a === '--config') {
      opts.config = argv[++i];
      if (!opts.config) throw new Error('--config 缺少参数值');
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (sawLocal && sawRemote) {
    throw new Error('--local 与 --remote 不能同时指定');
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const generated = !opts.password;
  const password = opts.password ?? generateRandomPassword(16);
  const sql = await buildResetPasswordSql({ username: opts.username, password });

  if (opts.dryRun) {
    console.log(`-- Target: ${opts.username ?? 'earliest admin'} | Mode: ${opts.remote ? 'remote' : 'local'} | DB: ${opts.db}`);
    if (generated) console.log(`-- Generated password: ${password}`);
    process.stdout.write(sql);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'hl-reset-pw-'));
  const sqlFile = join(tmpDir, 'reset.sql');
  try {
    writeFileSync(sqlFile, sql, 'utf8');
    const args = ['wrangler', 'd1', 'execute', opts.db, opts.remote ? '--remote' : '--local'];
    if (opts.config) args.push('--config', opts.config);
    args.push('--file', sqlFile);
    execFileSync('npx', args, { stdio: 'inherit' });
    console.log(`\n✅ 密码已重置（${opts.username ?? '最早管理员'}），旧会话 Cookie 与 API Token 已全部失效。`);
    if (generated) {
      console.log(`🔑 新随机密码: ${password}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error('❌ 重置密码失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
