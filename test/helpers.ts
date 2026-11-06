// Shared test rigs: an engine on an in-memory database with the pretend chain and recorded model replies.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { loadConfig } from '../server/config';
import { openMemoryDb } from '../server/db';
import { Engine } from '../server/engine';
import { FakeProvider, type Brain, type FakeOptions } from '../server/ai/fake';
import { FakeChain } from '../server/solana/fake-chain';
import { loadRecording, replayIO } from '../server/tools/replay';
import { createHandler } from '../server/http/handler';
import { buildPayment, paymentHeader } from '../shared/pay';
import type { AgentSpec, PaymentRequirements } from '../shared/types';
import { exampleBrains } from '../fixtures/examples/index';
import { standInSpec } from '../server/ai/fake';
import { normalizeSpec } from '../server/spec/schema';

export const OPS = Keypair.generate().publicKey.toBase58();
export const BURN = Keypair.generate().publicKey.toBase58();
export const USDC = Keypair.generate().publicKey.toBase58();

export function tmpDir(name = 'fab') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export function makeEngine(opts: { brains?: Brain[]; fake?: FakeOptions; env?: Record<string, string> } = {}) {
  const dataDir = tmpDir();
  const cfg = loadConfig({
    FABRICA_TEST_MODE: '1',
    FABRICA_DATA_DIR: dataDir,
    FABRICA_SITE_URL: 'http://localhost:3721',
    FABRICA_OPS_WALLET: OPS,
    FABRICA_BURN_WALLET: BURN,
    FABRICA_USDC_MINT: USDC,
    FABRICA_ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
    ...(opts.env ?? {}),
  });
  const chain = new FakeChain(USDC);
  chain.openUsdc(OPS);
  chain.openUsdc(BURN);
  const provider = new FakeProvider([...(opts.brains ?? []), ...exampleBrains()], opts.fake);
  const e = new Engine({ cfg, db: openMemoryDb(), rpc: chain, provider, io: { ...replayIO(loadRecording(cfg.fixturesDir)), rpc: chain }, quiet: true, log: () => {} });
  return { e, chain, provider, dataDir };
}

/** Puts a live agent straight into the database, as publishing would. */
export function addLiveAgent(e: Engine, maker: string, spec?: Partial<AgentSpec>) {
  const base = normalizeSpec({ ...standInSpec('Summarise any short text into three plain bullet points'), ...spec });
  const id = e.newId('a');
  const t = Date.now();
  e.db.prepare('INSERT INTO test_runs (id, spec_hash, model, status, total, passed, safety_total, safety_passed, task_total, task_passed, score, publishable, results, started_at, finished_at) VALUES (?, ?, ?, ?, 6, 6, 2, 2, 4, 4, 100, 1, ?, ?, ?)').run(`t_${id}`, 'h', base.model, 'done', '[]', t, t);
  e.db.prepare('INSERT INTO agents (id, slug, maker, status, example, spec, version, test_run_id, published_at, updated_at, sentence) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)').run(id, base.slug, maker, 'live', JSON.stringify(base), `t_${id}`, t, t, 'test');
  if (e.rpc instanceof FakeChain) e.rpc.openUsdc(maker);
  return e.agents.row(base.slug)!;
}

export function wallet() {
  const kp = Keypair.generate();
  return { kp, address: kp.publicKey.toBase58() };
}

export async function payHeader(e: Engine, req: PaymentRequirements, payer: Keypair, mode: 'transaction' | 'signature' = 'transaction', tamper?: (t: import('@solana/web3.js').Transaction) => void) {
  const bh = (await e.rpc.call('getLatestBlockhash', [])).value.blockhash;
  const tx = buildPayment(req, payer.publicKey, bh);
  tamper?.(tx);
  tx.sign(payer);
  const b64 = tx.serialize().toString('base64');
  if (mode === 'transaction') return paymentHeader(req, { transaction: b64 });
  const sig = await e.rpc.call('sendTransaction', [b64]);
  return paymentHeader(req, { signature: sig });
}

/** A real HTTP server around the API handler (no pages), on a free port. */
export async function serveApi(e: Engine) {
  const handle = createHandler(e);
  const server = http.createServer((req, res) => {
    handle(req, res).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
    async req(p: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) {
      const res = await fetch(base + p, {
        method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
        headers: { ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body, headers: res.headers };
    },
  };
}

export async function signInHttp(api: Awaited<ReturnType<typeof serveApi>>, kp: Keypair): Promise<string> {
  const wallet = kp.publicKey.toBase58();
  const n = await api.req('/api/auth/nonce', { body: { wallet } });
  const sig = nacl.sign.detached(new TextEncoder().encode(n.body.message), kp.secretKey);
  const v = await api.req('/api/auth/verify', { body: { wallet, nonce: n.body.nonce, message: n.body.message, signature: bs58.encode(sig) } });
  if (v.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(v.body)}`);
  return String(v.headers.get('set-cookie')).split(';')[0];
}

export const pk = (s: string) => new PublicKey(s);
