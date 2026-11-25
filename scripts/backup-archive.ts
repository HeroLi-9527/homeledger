import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { backupObjectReferences, MAX_BACKUP_BYTES } from '../src/lib/backup.js';

const fileTypes: Record<string, string> = {
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const extension = (key: string) => key.slice(key.lastIndexOf('.') + 1).toLowerCase();

interface ArchiveObject {
  key: string;
  bytes: number;
  sha256: string;
}

interface ArchiveManifest {
  version: 1;
  snapshot_sha256: string;
  objects: ArchiveObject[];
}

async function verifyArchive(dir: string) {
  const raw = await readFile(join(dir, 'snapshot.json'));
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.objects) || manifest.snapshot_sha256 !== hash(raw)) {
    throw new Error('归档版本无效或数据库快照校验失败');
  }
  const snapshot: unknown = JSON.parse(raw.toString('utf8'));
  const refs = backupObjectReferences(snapshot);
  const keys = new Set(refs.map((ref) => ref.key));
  if (keys.size !== manifest.objects.length) throw new Error('对象清单与快照的引用数量不一致');
  for (const [index, entry] of manifest.objects.entries()) {
    if (!keys.delete(entry.key)) throw new Error('归档对象引用不匹配或重复');
    const bytes = await readFile(join(dir, 'objects', String(index)));
    if (entry.bytes !== bytes.length || entry.sha256 !== hash(bytes)) {
      throw new Error(`归档对象 #${index + 1} 校验失败`);
    }
  }
  return { snapshot, manifest, refs };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' }, bucket: { type: 'string' }, config: { type: 'string' },
      'persist-to': { type: 'string' }, remote: { type: 'boolean' }, local: { type: 'boolean' },
      'confirm-overwrite': { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const [action, directory] = positionals;
  if (values.help) {
    console.log([
      'npm run ops:backup -- create <新目录> --url <站点地址> --bucket <R2 桶> (--local|--remote)',
      'npm run ops:backup -- verify <归档目录>',
      'npm run ops:backup -- restore <归档目录> --url <目标站点> --bucket <目标 R2 桶> (--local|--remote) --confirm-overwrite',
      '在线操作从 HOMELEDGER_ARCHIVE_SESSION 读取管理员的 hl.sid Cookie 值。',
    ].join('\n'));
    return;
  }
  if (positionals.length !== 2 || !['create', 'verify', 'restore'].includes(action)) throw new Error('请指定操作与目录，参见 --help');
  const dir = resolve(directory);
  if (action === 'verify') {
    const { manifest } = await verifyArchive(dir);
    console.log(`数据库快照与 ${manifest.objects.length} 个 R2 对象校验通过。`);
    return;
  }
  if (!values.url || !values.bucket || !/^[a-z0-9][a-z0-9-]*$/.test(values.bucket) || Boolean(values.local) === Boolean(values.remote)) {
    throw new Error('在线操作需要站点 URL、R2 桶，并明确选择 --local 或 --remote');
  }
  if (action === 'restore' && !values['confirm-overwrite']) throw new Error('恢复会覆盖目标站点数据库，需要 --confirm-overwrite');
  if (values.remote && values['persist-to']) throw new Error('--persist-to 仅用于本地 R2');
  const url = new URL(values.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(values.local && loopback && url.protocol === 'http:'))) {
    throw new Error('站点必须使用 HTTPS，本地环回地址可以使用 HTTP');
  }
  const session = process.env.HOMELEDGER_ARCHIVE_SESSION;
  if (!session || !/^[A-Za-z0-9_.%-]+$/.test(session)) throw new Error('请设置管理员会话环境变量 HOMELEDGER_ARCHIVE_SESSION');

  const web = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', `hl.sid=${session}`);
    const result = await fetch(new URL(path, url), { ...init, headers, redirect: 'manual' });
    if (!result.ok) throw new Error(`站点操作 ${path} 失败（HTTP ${result.status}）`);
    return result;
  };
  const r2 = (op: 'get' | 'put', key: string, file: string) => {
    const args = ['wrangler', 'r2', 'object', op, `${values.bucket}/${key}`, values.remote ? '--remote' : '--local', '--file', file];
    if (values.config) args.push('--config', values.config);
    if (values['persist-to']) args.push('--persist-to', values['persist-to']);
    if (op === 'put') args.push('--content-type', fileTypes[extension(key)]);
    const { HOMELEDGER_ARCHIVE_SESSION: _session, ...wranglerEnv } = process.env;
    execFileSync('npx', args, { stdio: ['ignore', 'ignore', 'inherit'], env: wranglerEnv });
  };

  if (action === 'create') {
    const result = await web('/export/json', { headers: { Accept: 'application/json' } });
    const content = Buffer.from(await result.arrayBuffer());
    if (content.length > MAX_BACKUP_BYTES) throw new Error('数据库快照超过网页恢复的 20MB 上限');
    const refs = backupObjectReferences(JSON.parse(content.toString('utf8')));
    const keys = [...new Set(refs.map((ref) => ref.key))];
    await mkdir(dir, { mode: 0o700 });
    const manifest: ArchiveManifest = { version: 1, snapshot_sha256: hash(content), objects: [] };
    await mkdir(join(dir, 'objects'));
    for (const [index, key] of keys.entries()) {
      const file = join(dir, 'objects', String(index));
      r2('get', key, file);
      const data = await readFile(file);
      manifest.objects.push({ key, bytes: data.length, sha256: hash(data) });
    }
    await writeFile(join(dir, 'snapshot.json'), content, { mode: 0o600 });
    const pending = join(dir, 'manifest.json.pending');
    await writeFile(pending, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(pending, join(dir, 'manifest.json'));
    console.log(`归档完成，共 ${keys.length} 个 R2 对象。`);
    return;
  }

  const { snapshot, manifest, refs } = await verifyArchive(dir);
  const settings = await web('/settings');
  const csrf = /<meta name="csrf" content="([A-Za-z0-9_.%-]+)">/.exec(await settings.text())?.[1];
  if (!csrf) throw new Error('无法读取目标站点的会话校验令牌');
  const restoreId = randomUUID().replaceAll('-', '');
  const staged = new Map(manifest.objects.map((entry, index) => {
    const prefix = entry.key.startsWith('uploads/avatars/') ? 'uploads/avatars/' : 'uploads/';
    return [entry.key, `${prefix}restore-${restoreId}-${index}.${extension(entry.key)}`];
  }));
  for (const ref of refs) ref.replace(staged.get(ref.key)!);
  const backup = JSON.stringify(snapshot);
  if (Buffer.byteLength(backup, 'utf8') > MAX_BACKUP_BYTES) throw new Error('替换对象路径后的快照超过恢复上限');
  const scratch = await mkdtemp(join(tmpdir(), 'homeledger-archive-'));
  try {
    for (const [index, entry] of manifest.objects.entries()) {
      const key = staged.get(entry.key)!;
      const file = join(scratch, `upload-${index}`);
      const data = await readFile(join(dir, 'objects', String(index)));
      if (data.length !== entry.bytes || hash(data) !== entry.sha256) throw new Error('归档文件在校验后发生变化');
      await writeFile(file, data, { mode: 0o600 });
      r2('put', key, file);
      const check = join(scratch, `checked-${index}`);
      r2('get', key, check);
      if (hash(await readFile(check)) !== entry.sha256) throw new Error(`目标对象 #${index + 1} 校验失败`);
      await rm(file);
      await rm(check);
    }
    const restored = await web('/backup/restore', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ backup, archive: restoreId }),
    });
    const result = await restored.json() as { ok?: boolean };
    if (!result.ok) throw new Error('站点未确认恢复成功');
    console.log(`站点已恢复，共 ${staged.size} 个 R2 对象。请重新登录。`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
