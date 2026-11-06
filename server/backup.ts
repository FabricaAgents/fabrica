// Daily snapshots of the database, which holds the receipt and report signing key, every agent, version and receipt.
// SQLite's VACUUM INTO writes a consistent copy while the site keeps running; the last seven stay on the volume and
// the admin can download the newest, so a copy can live off the server (npm run backup:pull).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { kvGet, kvSet, type DB } from './db';

export const BACKUP_KEEP = 7;
export const BACKUP_EVERY_MS = 24 * 3_600_000;
const NAME = /^fabrica-(\d{8}-\d{6})\.db$/;

export interface BackupInfo {
  file: string;
  bytes: number;
  sha256: string;
  at: number;
}

export class Backups {
  readonly dir: string;
  constructor(
    private db: DB,
    dataDir: string,
    private log: (m: string) => void = () => {},
  ) {
    this.dir = path.join(dataDir, 'backups');
  }

  last(): BackupInfo | null {
    const v = kvGet(this.db, 'backup_last');
    return v ? (JSON.parse(v) as BackupInfo) : null;
  }

  /** The snapshots on disk, newest first. */
  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    const known = new Map((JSON.parse(kvGet(this.db, 'backup_hashes') ?? '[]') as BackupInfo[]).map((b) => [b.file, b]));
    return fs
      .readdirSync(this.dir)
      .filter((f) => NAME.test(f))
      .sort()
      .reverse()
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return known.get(f) ?? { file: f, bytes: st.size, sha256: '', at: st.mtimeMs };
      });
  }

  path(file: string): string | null {
    if (!NAME.test(file)) return null;
    const p = path.join(this.dir, file);
    return fs.existsSync(p) ? p : null;
  }

  /** Takes one snapshot now and keeps the newest BACKUP_KEEP. */
  run(now = Date.now()): BackupInfo {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = `fabrica-${stamp}.db`;
    const final = path.join(this.dir, file);
    const tmp = `${final}.part`;
    fs.rmSync(tmp, { force: true });
    // VACUUM INTO takes a string literal; the path is ours (data dir plus a timestamp), quotes are doubled anyway.
    this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, final);
    const body = fs.readFileSync(final);
    const info: BackupInfo = { file, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), at: now };
    const files = fs.readdirSync(this.dir).filter((f) => NAME.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fs.rmSync(path.join(this.dir, f), { force: true });
    const kept = new Set(files.slice(-BACKUP_KEEP));
    const hashes = (JSON.parse(kvGet(this.db, 'backup_hashes') ?? '[]') as BackupInfo[]).filter((b) => kept.has(b.file) && b.file !== file);
    kvSet(this.db, 'backup_hashes', JSON.stringify([...hashes, info]));
    kvSet(this.db, 'backup_last', JSON.stringify(info));
    this.log(`backup ${file}: ${info.bytes} bytes`);
    return info;
  }

  /** Runs a snapshot when the last one is a day old or missing. Called hourly. */
  due(now = Date.now()): BackupInfo | null {
    const l = this.last();
    if (l && now - l.at < BACKUP_EVERY_MS && this.path(l.file)) return null;
    return this.run(now);
  }

  health(now = Date.now()) {
    const l = this.last();
    return l ? { last: new Date(l.at).toISOString(), ageHours: Math.round(((now - l.at) / 3_600_000) * 10) / 10, kept: this.list().length } : { last: null, ageHours: null, kept: 0 };
  }
}
