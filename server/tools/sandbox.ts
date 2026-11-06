// The code runner. Each run gets its own worker thread with an empty environment and V8 heap limits, and inside
// it its own QuickJS heap with a memory cap, a stack cap and a deadline. The host kills the worker if it overstays.
import { Worker } from 'node:worker_threads';
import { fetchPublicPage } from './web';

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  value: string | null;
  error: string | null;
  ms: number;
  fetches: number;
}

export interface SandboxOptions {
  timeMs?: number;
  memoryMb?: number;
  input?: unknown;
  /** Domains fetch_text may reach. Empty or absent means no network at all. */
  network?: string[];
  fetcher?: (url: string, allow: string[]) => Promise<string>;
}

export const SANDBOX_LIMITS = { maxTimeMs: 5000, maxMemoryMb: 64, maxParallel: 2, maxOutput: 16_000, maxFetches: 3 };

let running = 0;
const queue: (() => void)[] = [];

async function slot(): Promise<() => void> {
  if (running >= SANDBOX_LIMITS.maxParallel) await new Promise<void>((r) => queue.push(r));
  running += 1;
  return () => {
    running -= 1;
    queue.shift()?.();
  };
}

const defaultFetcher = async (url: string, allow: string[]) => (await fetchPublicPage(url, { allow, maxChars: 8000 })).text;

export async function runInSandbox(code: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
  const timeMs = Math.min(Math.max(opts.timeMs ?? 2000, 100), SANDBOX_LIMITS.maxTimeMs);
  const memoryMb = Math.min(Math.max(opts.memoryMb ?? 32, 8), SANDBOX_LIMITS.maxMemoryMb);
  const allow = opts.network ?? [];
  const network = allow.length > 0;
  if (typeof code !== 'string' || code.length > 20_000) {
    return { ok: false, stdout: '', value: null, error: 'Code must be text of at most 20000 characters.', ms: 0, fetches: 0 };
  }
  const release = await slot();
  try {
    return await new Promise<SandboxResult>((resolve) => {
      const worker = new Worker(new URL('./sandbox-worker.mjs', import.meta.url), {
        workerData: {
          code,
          input: opts.input ?? null,
          memoryBytes: memoryMb * 1024 * 1024,
          stackBytes: 256 * 1024,
          timeMs,
          maxOutput: SANDBOX_LIMITS.maxOutput,
          network,
          maxFetches: SANDBOX_LIMITS.maxFetches,
        },
        env: {},
        argv: [],
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let settled = false;
      const finish = (r: SandboxResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        void worker.terminate();
        resolve(r);
      };
      const dead = (error: string): SandboxResult => ({ ok: false, stdout: '', value: null, error, ms: timeMs, fetches: 0 });
      // Network waits count too: the whole run, fetches included, must end within the limit plus startup slack.
      const killer = setTimeout(() => finish(dead('Stopped: ran past the time limit.')), timeMs + (network ? 9000 : 2500));
      worker.on('message', (m: any) => {
        if (m?.type === 'done') finish(m.out);
        else if (m?.type === 'fetch' && network) {
          (opts.fetcher ?? defaultFetcher)(String(m.url), allow).then(
            (text) => worker.postMessage({ type: 'fetched', id: m.id, ok: true, text: text.slice(0, 8000) }),
            (e) => worker.postMessage({ type: 'fetched', id: m.id, ok: false, error: String((e as Error)?.message ?? e) }),
          );
        }
      });
      worker.once('error', (e) => finish(dead(/memory/i.test(e.message) ? 'Stopped: ran past the memory limit.' : `Stopped: ${e.message}`)));
      worker.once('exit', () => finish(dead('Stopped: the sandbox exited early.')));
    });
  } finally {
    release();
  }
}
