// Quotes and settlement. A quote fixes who gets how much; settlement proves the payer paid exactly that, straight
// to each recipient, and claims the quote once. Fabrica never receives or forwards anyone's money in between.
import { createHash, randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { MEMO_PROGRAM_ID, usdcAccount } from '../../shared/pay';
import type { PaymentRecipient, PaymentRequirements, PriceBreakdown } from '../../shared/types';
import type { Config } from '../config';
import type { DB } from '../db';
import { isSimulatedSignature, SIG_RE, type Rpc } from '../solana/rpc';
import { checkConfirmed, checkRawTransaction, decodeHeader, memoOf, PaymentError, type Expected } from './verify';
import { VersionedTransaction } from '@solana/web3.js';

export const QUOTE_TTL_MS = 10 * 60_000;
/** An unclaimed quote is honoured this long, so a payment that lands late is never lost. */
export const QUOTE_KEEP_MS = 24 * 3_600_000;

export interface QuoteRow {
  nonce: string;
  kind: 'call' | 'build';
  agent_id: string | null;
  maker: string | null;
  meta: string | null;
  input_hash: string | null;
  total: number;
  maker_amt: number;
  ai_amt: number;
  platform_amt: number;
  royalty_amt: number;
  recipients: string;
  created_at: number;
  expires_at: number;
  claimed_sig: string | null;
}

export interface QuoteInput {
  kind: 'call' | 'build';
  agentId?: string;
  maker?: string;
  meta?: unknown;
  inputHash?: string;
  price: PriceBreakdown;
  makerWallet?: string;
  /** The original's maker, for a call to a remix with a royalty. */
  royaltyWallet?: string | null;
  ip: string;
  resource: string;
  description: string;
  outputSchema?: unknown;
}

export interface Settled {
  quote: QuoteRow;
  payer: string;
  sig: string;
  slot: number;
}

export type Stage = 'verifying' | 'sending' | 'confirming' | 'confirmed';

export const hashInput = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

export class Payments {
  private ataCache = new Map<string, number>();
  constructor(
    private db: DB,
    private cfg: Config,
    private rpc: Rpc,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get open(): boolean {
    return Boolean(this.cfg.opsWallet && this.cfg.burnWallet);
  }

  /** Does this wallet already have a USDC account? Positive answers are cached for an hour. */
  async hasUsdcAccount(owner: string): Promise<boolean> {
    const hit = this.ataCache.get(owner);
    if (hit && Date.now() - hit < 3_600_000) return true;
    try {
      const acct = usdcAccount(new PublicKey(owner), new PublicKey(this.cfg.usdcMint)).toBase58();
      const r = await this.rpc.call('getAccountInfo', [acct, { encoding: 'base64', commitment: 'confirmed' }]);
      if (r?.value) {
        this.ataCache.set(owner, Date.now());
        return true;
      }
      return false;
    } catch {
      return true; // when the node cannot say, assume it exists rather than charge the payer for an account
    }
  }

  async recipients(q: QuoteInput): Promise<PaymentRecipient[]> {
    const parts: { role: PaymentRecipient['role']; address: string | null | undefined; amount: number }[] =
      q.kind === 'build'
        ? [{ role: 'build', address: this.cfg.opsWallet, amount: q.price.total }]
        : [
            { role: 'maker', address: q.makerWallet, amount: q.price.maker },
            ...(q.price.royalty > 0 ? [{ role: 'royalty' as const, address: q.royaltyWallet, amount: q.price.royalty }] : []),
            { role: 'ai', address: this.cfg.opsWallet, amount: q.price.ai },
            { role: 'platform', address: this.cfg.burnWallet, amount: q.price.platform },
          ];
    const merged = new Map<string, PaymentRecipient>();
    for (const p of parts) {
      if (!p.address) throw new PaymentError('closed', 'Paid calls are not open yet.', 503);
      if (p.amount <= 0) continue;
      const cur = merged.get(p.address);
      if (cur) cur.amount = String(Number(cur.amount) + p.amount);
      else merged.set(p.address, { role: p.role, address: p.address, amount: String(p.amount) });
    }
    const out = [...merged.values()];
    await Promise.all(out.map(async (r) => (r.createAccount = !(await this.hasUsdcAccount(r.address)) || undefined)));
    return out;
  }

  async makeQuote(q: QuoteInput): Promise<PaymentRequirements> {
    const recipients = await this.recipients(q);
    const nonce = randomBytes(12).toString('hex');
    const now = Date.now();
    const total = recipients.reduce((n, r) => n + Number(r.amount), 0);
    this.db
      .prepare('INSERT INTO quotes (nonce, kind, agent_id, maker, meta, input_hash, total, maker_amt, ai_amt, platform_amt, royalty_amt, recipients, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nonce, q.kind, q.agentId ?? null, q.maker ?? null, q.meta === undefined ? null : JSON.stringify(q.meta), q.inputHash ?? null, total, q.price.maker, q.price.ai, q.price.platform, q.price.royalty ?? 0, JSON.stringify(recipients), q.ip, now, now + QUOTE_TTL_MS);
    const payTo = recipients.find((r) => r.role === 'maker' || r.role === 'build')?.address ?? recipients[0].address;
    return {
      scheme: 'split',
      network: this.cfg.network,
      maxAmountRequired: String(total),
      resource: q.resource,
      description: q.description,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: QUOTE_TTL_MS / 1000,
      asset: this.cfg.usdcMint,
      outputSchema: q.outputSchema,
      extra: { name: 'USD Coin', decimals: 6, memo: `fabrica:${nonce}`, nonce, expiresAt: now + QUOTE_TTL_MS, recipients, computeUnitPrice: 20_000 },
    };
  }

  quote(nonce: string): QuoteRow | null {
    return (this.db.prepare('SELECT * FROM quotes WHERE nonce = ?').get(nonce) as QuoteRow | undefined) ?? null;
  }

  private expected(q: QuoteRow): Expected {
    const recipients = (JSON.parse(q.recipients) as PaymentRecipient[]).map((r) => ({ address: r.address, amount: Number(r.amount) }));
    return { memo: `fabrica:${q.nonce}`, usdcMint: this.cfg.usdcMint, recipients };
  }

  private quoteFromMemo(memo: string | null): QuoteRow {
    const nonce = memo?.match(/^fabrica:([0-9a-f]{24})$/)?.[1];
    if (!nonce) throw new PaymentError('memo', 'The payment carries no Fabrica quote.');
    const q = this.quote(nonce);
    if (!q) throw new PaymentError('unknown_quote', 'That quote does not exist.');
    if (q.claimed_sig) throw new PaymentError('used', 'That payment was already used.', 409);
    if (Date.now() > q.created_at + QUOTE_KEEP_MS) throw new PaymentError('expired', 'That quote is too old.');
    return q;
  }

  private async waitFor(sig: string, onStage?: (s: Stage) => void): Promise<any> {
    onStage?.('confirming');
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const st = await this.rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const s = st?.value?.[0];
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          for (let i = 0; i < 10; i++) {
            const tx = await this.rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
            if (tx) {
              onStage?.('confirmed');
              return tx;
            }
            await this.sleep(700);
          }
        }
        if (s?.err) break;
      } catch {
        /* a node hiccup: keep waiting until the deadline */
      }
      await this.sleep(800);
    }
    const tx = await this.rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
    if (tx) return tx;
    throw new PaymentError('not_confirmed', 'The payment did not confirm in time. If it lands later, send the same header again: it stays valid for 24 hours.', 402);
  }

  /**
   * Proves a payment and claims its quote. `accept` runs before the claim, so a payment for a different
   * agent or input is refused without being used up.
   */
  async settle(header: string | undefined, accept: (q: QuoteRow) => void, onStage?: (s: Stage) => void): Promise<Settled> {
    const h = decodeHeader(header);
    if (h.scheme !== 'split') throw new PaymentError('scheme', 'Fabrica takes the "split" scheme: one transaction that pays every recipient directly.', 400);
    if (h.network !== this.cfg.network) throw new PaymentError('network', `This server settles on ${this.cfg.network}.`, 400);
    onStage?.('verifying');
    let sig: string;
    let parsed: any;
    let q: QuoteRow;
    if (typeof h.payload.transaction === 'string') {
      let memo: string | null = null;
      try {
        const vt = VersionedTransaction.deserialize(Buffer.from(h.payload.transaction, 'base64'));
        const keys = vt.message.staticAccountKeys;
        for (const ix of vt.message.compiledInstructions) if (keys[ix.programIdIndex].equals(MEMO_PROGRAM_ID)) memo = Buffer.from(ix.data).toString('utf8');
      } catch {
        throw new PaymentError('malformed', 'The transaction could not be read.', 400);
      }
      q = this.quoteFromMemo(memo);
      const { tx } = checkRawTransaction(h.payload.transaction, this.expected(q));
      accept(q);
      sig = bs58.encode(tx.signatures[0]);
      if (!this.db.prepare('SELECT 1 FROM quotes WHERE claimed_sig = ?').get(sig)) {
        onStage?.('sending');
        try {
          await this.rpc.call('sendTransaction', [h.payload.transaction, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
        } catch (e) {
          const msg = String((e as Error).message);
          if (!/already been processed/i.test(msg)) throw new PaymentError('send_failed', `The network refused the payment: ${msg.slice(0, 160)}`);
        }
      }
      parsed = await this.waitFor(sig, onStage);
    } else if (typeof h.payload.signature === 'string') {
      sig = h.payload.signature.trim();
      if (!SIG_RE.test(sig) || isSimulatedSignature(sig)) throw new PaymentError('bad_signature', 'That is not a real transaction signature.', 400);
      if (this.db.prepare('SELECT 1 FROM quotes WHERE claimed_sig = ?').get(sig)) throw new PaymentError('used', 'That payment was already used.', 409);
      parsed = await this.waitFor(sig, onStage);
      q = this.quoteFromMemo(memoOf(parsed) ?? (parsed?.transaction?.message?.instructions ?? []).map((i: any) => (typeof i.parsed === 'string' ? i.parsed : null)).find(Boolean));
      accept(q);
    } else throw new PaymentError('malformed', 'The payload needs a transaction or a signature.', 400);
    const { payer, slot } = checkConfirmed(parsed, this.expected(q));
    const claimed = this.db.prepare('UPDATE quotes SET claimed_sig = ?, claimed_at = ? WHERE nonce = ? AND claimed_sig IS NULL').run(sig, Date.now(), q.nonce);
    if (claimed.changes !== 1) throw new PaymentError('used', 'That payment was already used.', 409);
    return { quote: { ...q, claimed_sig: sig }, payer, sig, slot };
  }

  sweep(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM quotes WHERE claimed_sig IS NULL AND created_at < ?').run(now - QUOTE_KEEP_MS).changes);
  }

  outstandingFor(ip: string, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM quotes WHERE ip = ? AND created_at > ? AND claimed_sig IS NULL').get(ip, since) as { n: number }).n;
  }
}
