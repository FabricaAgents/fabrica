// Downloads the newest database snapshot from the server to a folder on this machine, so a copy of the data (and
// of the receipt and report signing key inside it) lives off the server. Checks the SHA-256 the server sends.
//   npm run backup:pull -- ~/Backups/fabrica           the newest daily snapshot
//   npm run backup:pull -- ~/Backups/fabrica --fresh   takes one now first, then downloads it
// The admin token comes from FABRICA_ADMIN_TOKEN or is asked for (typed hidden). FABRICA_SITE_URL defaults to
// https://getfabrica.fun.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const fresh = args.includes('--fresh');
if (!folder) {
  console.error('Usage: npm run backup:pull -- <folder> [--fresh]');
  process.exit(1);
}
const base = (process.env.FABRICA_SITE_URL ?? 'https://getfabrica.fun').replace(/\/$/, '');

async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Set FABRICA_ADMIN_TOKEN: there is no terminal to ask in.');
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let out = '';
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(out.trim());
        }
        if (ch === '\u0003') return reject(new Error('cancelled'));
        if (ch === '\u007f') out = out.slice(0, -1);
        else out += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const token = process.env.FABRICA_ADMIN_TOKEN?.trim() || (await askHidden('Admin token: '));
const headers = { authorization: `Bearer ${token}` };

if (fresh) {
  const r = await fetch(`${base}/api/admin/backups`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  if (r.status !== 201) {
    console.error(`The server did not take a snapshot: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
}

const res = await fetch(`${base}/api/admin/backups/latest`, { headers });
if (res.status !== 200) {
  console.error(res.status === 401 ? 'The admin token was refused.' : `No snapshot to download: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const name = res.headers.get('x-backup-file') ?? 'fabrica-backup.db';
if (!/^fabrica-\d{8}-\d{6}\.db$/.test(name)) {
  console.error(`Unexpected file name from the server: ${name}`);
  process.exit(1);
}
const body = Buffer.from(await res.arrayBuffer());
const sha = createHash('sha256').update(body).digest('hex');
const want = res.headers.get('x-backup-sha256') ?? '';
if (body.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
  console.error('The download is not a SQLite database. Nothing was saved.');
  process.exit(1);
}
if (want && want !== sha) {
  console.error(`The download does not match the server's SHA-256 (${want}). Nothing was saved.`);
  process.exit(1);
}
const dir = path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, name);
fs.writeFileSync(`${dest}.part`, body, { mode: 0o600 });
fs.renameSync(`${dest}.part`, dest);
console.log(`Saved ${dest}`);
console.log(`${body.length} bytes, sha256 ${sha}${want ? ' (matches the server)' : ''}`);
console.log('It holds the signing key: keep it somewhere private.');
