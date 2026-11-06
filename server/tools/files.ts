// The file_output tool's store: small text files on the volume, served as downloads in a sandboxed origin.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db';
import type { FileFormat } from '../../shared/types';

export const FILE_LIMITS = { maxBytes: 256 * 1024, maxPerRun: 3, keepDays: 30 };

export const MIME: Record<FileFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

export class FileStore {
  readonly dir: string;
  constructor(
    private db: DB,
    dataDir: string,
    private siteUrl: string,
  ) {
    this.dir = path.join(dataDir, 'files');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(ownerRef: string, rawName: string, format: FileFormat, content: string): { id: string; name: string; url: string; bytes: number } {
    const base = String(rawName || 'output')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'output';
    const name = `${base}.${format}`;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > FILE_LIMITS.maxBytes) throw new Error(`files are limited to ${FILE_LIMITS.maxBytes / 1024} KB`);
    if (format === 'json') JSON.parse(content);
    const id = randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(this.dir, `${id}.${format}`), content, { mode: 0o600 });
    this.db.prepare('INSERT INTO files (id, owner_ref, name, format, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, ownerRef, name, format, bytes, Date.now());
    return { id, name, url: `${this.siteUrl}/files/${id}/${encodeURIComponent(name)}`, bytes };
  }

  get(id: string): { name: string; format: FileFormat; body: Buffer } | null {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    const row = this.db.prepare('SELECT name, format FROM files WHERE id = ?').get(id) as { name: string; format: FileFormat } | undefined;
    if (!row) return null;
    const p = path.join(this.dir, `${id}.${row.format}`);
    if (!fs.existsSync(p)) return null;
    return { name: row.name, format: row.format, body: fs.readFileSync(p) };
  }

  sweep(now = Date.now()): number {
    const cutoff = now - FILE_LIMITS.keepDays * 86_400_000;
    const old = this.db.prepare("SELECT id, format FROM files WHERE created_at < ? AND owner_ref NOT LIKE 'x:%'").all(cutoff) as { id: string; format: string }[];
    for (const f of old) fs.rmSync(path.join(this.dir, `${f.id}.${f.format}`), { force: true });
    this.db.prepare("DELETE FROM files WHERE created_at < ? AND owner_ref NOT LIKE 'x:%'").run(cutoff);
    return old.length;
  }
}
