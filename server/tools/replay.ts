// Recorded tool answers. The example agents run against reads that were made for real once and saved
// (scripts/record-tools.ts), so building them needs no network and gives the same result every time.
// The sandbox is never replayed: code always runs for real.
import fs from 'node:fs';
import path from 'node:path';
import type { Rpc } from '../solana/rpc';
import { RpcError } from '../solana/rpc';
import { runInSandbox } from './sandbox';
import { BlockedUrl, precheck, type FetchedPage } from './web';
import type { ToolIO } from './index';

export interface Recording {
  rpc: Record<string, { result?: unknown; error?: string }>;
  web: Record<string, { page?: FetchedPage; error?: string }>;
  recordedAt: string;
}

export const rpcKey = (method: string, params: unknown[]) => `${method} ${JSON.stringify(params)}`;

export function loadRecording(dir: string): Recording {
  const p = path.join(dir, 'recorded', 'tools.json');
  if (!fs.existsSync(p)) return { rpc: {}, web: {}, recordedAt: '' };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export class ReplayRpc implements Rpc {
  readonly label = 'recorded';
  constructor(private rec: Recording) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const hit = this.rec.rpc[rpcKey(method, params)];
    if (!hit) throw new RpcError(`no recorded answer for ${method}`, null);
    if (hit.error) throw new RpcError(hit.error, null);
    return hit.result as T;
  }
}

export function replayIO(rec: Recording): ToolIO {
  return {
    rpc: new ReplayRpc(rec),
    web: async (url: string, allow: string[]) => {
      precheck(url, allow); // the same guard as live, before any lookup
      const hit = rec.web[url];
      if (!hit) throw new Error('no recorded page for that address');
      if (hit.error) throw hit.error.startsWith('blocked:') ? new BlockedUrl(hit.error.slice(8).trim()) : new Error(hit.error);
      return hit.page!;
    },
    sandbox: runInSandbox,
  };
}

/** Wraps a live RPC and writes down every answer, for the recorder script. */
export class RecordingRpc implements Rpc {
  readonly label = 'recording';
  constructor(
    private inner: Rpc,
    private rec: Recording,
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      const r = await this.inner.call<T>(method, params);
      this.rec.rpc[rpcKey(method, params)] = { result: r };
      return r;
    } catch (e) {
      this.rec.rpc[rpcKey(method, params)] = { error: String((e as Error).message) };
      throw e;
    }
  }
}
