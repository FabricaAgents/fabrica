// A pretend Solana for tests and the headless end-to-end run (FABRICA_TEST_MODE=1, never on Railway).
// It verifies real ed25519 signatures on real serialized transactions and executes the few instructions a
// payment, a coin launch or a burn uses, keeping token balances, so the server's checks run against the same
// shapes the real chain returns.
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import { ATA_PROGRAM_ID, COMPUTE_BUDGET_ID, MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, usdcAccount } from '../../shared/pay';
import { PUMP_PROGRAM, TOKEN_2022_PROGRAM } from '../../shared/pump/constants';
import { ataAddress } from '../../shared/pump/pda';
import type { Rpc } from './rpc';
import { RpcError } from './rpc';

interface TokenAcct {
  owner: string;
  mint: string;
  amount: bigint;
}

export class FakeChain implements Rpc {
  readonly label = 'pretend chain';
  slot = 1000;
  accounts = new Map<string, TokenAcct>();
  mints = new Map<string, { decimals: number; supply: bigint; program: string; creator?: string }>();
  txs = new Map<string, any>();
  /** Signatures to report as failed on chain, for tests. */
  failNext = 0;
  /** Delay before a sent transaction is visible, for tests of the waiting loop. */
  visibleAfterMs = 0;
  private sentAt = new Map<string, number>();

  constructor(public usdcMint: string) {
    this.mints.set(usdcMint, { decimals: 6, supply: 0n, program: TOKEN_PROGRAM_ID.toBase58() });
  }

  /** Gives a wallet USDC, creating its account. */
  fundUsdc(owner: string, micros: number | bigint) {
    const acct = usdcAccount(new PublicKey(owner), new PublicKey(this.usdcMint)).toBase58();
    const cur = this.accounts.get(acct) ?? { owner, mint: this.usdcMint, amount: 0n };
    cur.amount += BigInt(micros);
    this.accounts.set(acct, cur);
    this.mints.get(this.usdcMint)!.supply += BigInt(micros);
  }

  /** Opens an empty USDC account, as a wallet that has held USDC before would have. */
  openUsdc(owner: string) {
    const acct = usdcAccount(new PublicKey(owner), new PublicKey(this.usdcMint)).toBase58();
    if (!this.accounts.has(acct)) this.accounts.set(acct, { owner, mint: this.usdcMint, amount: 0n });
  }

  usdcBalance(owner: string): bigint {
    return this.accounts.get(usdcAccount(new PublicKey(owner), new PublicKey(this.usdcMint)).toBase58())?.amount ?? 0n;
  }

  async call<T = any>(method: string, params: any[] = []): Promise<T> {
    return this.handle(method, params) as T;
  }

  private handle(method: string, p: any[]): unknown {
    switch (method) {
      case 'getLatestBlockhash':
        return { context: { slot: this.slot }, value: { blockhash: bs58.encode(Buffer.alloc(32, this.slot % 251)), lastValidBlockHeight: this.slot + 150 } };
      case 'getSlot':
        return this.slot;
      case 'sendTransaction':
        return this.send(String(p[0]));
      case 'getSignatureStatuses':
        return { context: { slot: this.slot }, value: (p[0] as string[]).map((s) => (this.visible(s) ? { slot: this.txs.get(s).slot, confirmations: null, err: this.txs.get(s).meta.err, confirmationStatus: 'confirmed' } : null)) };
      case 'getTransaction':
        return this.visible(String(p[0])) ? structuredClone(this.txs.get(String(p[0]))) : null;
      case 'getAccountInfo': {
        const a = String(p[0]);
        const t = this.accounts.get(a);
        if (t) return { context: { slot: this.slot }, value: { owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 2039280, executable: false, data: { program: 'spl-token', parsed: { type: 'account', info: { mint: t.mint, owner: t.owner, tokenAmount: { amount: String(t.amount) } } } } } };
        const m = this.mints.get(a);
        if (m) return { context: { slot: this.slot }, value: { owner: m.program, lamports: 1461600, executable: false, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: m.decimals, supply: String(m.supply), mintAuthority: null, freezeAuthority: null } } } } };
        return { context: { slot: this.slot }, value: null };
      }
      case 'getBalance':
        return { context: { slot: this.slot }, value: 1_000_000_000 };
      case 'getTokenAccountsByOwner': {
        const owner = String(p[0]);
        const mint = p[1]?.mint;
        const value = [...this.accounts.entries()]
          .filter(([, t]) => t.owner === owner && (!mint || t.mint === mint))
          .map(([pubkey, t]) => ({ pubkey, account: { data: { parsed: { info: { mint: t.mint, owner: t.owner, tokenAmount: { amount: String(t.amount), decimals: this.mints.get(t.mint)?.decimals ?? 6, uiAmountString: String(Number(t.amount) / 10 ** (this.mints.get(t.mint)?.decimals ?? 6)) } } } } } }));
        return { context: { slot: this.slot }, value };
      }
      case 'getTokenSupply': {
        const m = this.mints.get(String(p[0]));
        if (!m) throw new RpcError('Invalid param: not a Token mint', -32602);
        return { context: { slot: this.slot }, value: { amount: String(m.supply), decimals: m.decimals, uiAmountString: String(Number(m.supply) / 10 ** m.decimals) } };
      }
      case 'getSignaturesForAddress':
        return [];
      default:
        throw new RpcError(`the pretend chain does not answer ${method}`, -32601);
    }
  }

  private visible(sig: string): boolean {
    if (!this.txs.has(sig)) return false;
    return Date.now() - (this.sentAt.get(sig) ?? 0) >= this.visibleAfterMs;
  }

  private send(b64: string): string {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    const msg = tx.message;
    const keys = msg.staticAccountKeys;
    const bytes = msg.serialize();
    for (let i = 0; i < msg.header.numRequiredSignatures; i++) {
      if (!nacl.sign.detached.verify(bytes, tx.signatures[i], keys[i].toBytes())) throw new RpcError('Transaction signature verification failure', -32003);
    }
    const sig = bs58.encode(tx.signatures[0]);
    if (this.txs.has(sig)) return sig;
    const signer = (k: PublicKey) => keys.findIndex((x) => x.equals(k)) < msg.header.numRequiredSignatures;
    const before = new Map([...this.accounts].map(([k, v]) => [k, v.amount]));
    const parsedIxs: any[] = [];
    let err: unknown = null;
    const snapshot = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
    try {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error('custom program error: 0x1');
      }
      for (const ix of msg.compiledInstructions) {
        const program = keys[ix.programIdIndex];
        const acct = (i: number) => keys[ix.accountKeyIndexes[i]];
        const data = Buffer.from(ix.data);
        if (program.equals(COMPUTE_BUDGET_ID)) {
          parsedIxs.push({ programId: program.toBase58(), accounts: [], data: bs58.encode(data), stackHeight: null });
        } else if (program.equals(MEMO_PROGRAM_ID)) {
          parsedIxs.push({ program: 'spl-memo', programId: program.toBase58(), parsed: data.toString('utf8'), stackHeight: null });
        } else if (program.equals(ATA_PROGRAM_ID)) {
          const a = acct(1).toBase58();
          const tokenProgram = acct(5);
          if (!this.accounts.has(a)) this.accounts.set(a, { owner: acct(2).toBase58(), mint: acct(3).toBase58(), amount: 0n });
          parsedIxs.push({ program: 'spl-associated-token-account', programId: program.toBase58(), parsed: { type: 'createIdempotent', info: { account: a, mint: acct(3).toBase58(), source: acct(0).toBase58(), wallet: acct(2).toBase58(), tokenProgram: tokenProgram.toBase58() } }, stackHeight: null });
        } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM)) {
          if (data[0] === 12) {
            const src = this.accounts.get(acct(0).toBase58());
            const dst = this.accounts.get(acct(2).toBase58());
            const amount = data.readBigUInt64LE(1);
            if (!src || !dst) throw new Error('invalid account data for instruction');
            if (src.owner !== acct(3).toBase58() || !signer(acct(3))) throw new Error('owner does not match');
            if (src.mint !== acct(1).toBase58() || dst.mint !== src.mint) throw new Error('mint mismatch');
            if (src.amount < amount) throw new Error('insufficient funds');
            src.amount -= amount;
            dst.amount += amount;
            parsedIxs.push({ program: 'spl-token', programId: program.toBase58(), parsed: { type: 'transferChecked', info: { source: acct(0).toBase58(), mint: acct(1).toBase58(), destination: acct(2).toBase58(), authority: acct(3).toBase58(), tokenAmount: { amount: String(amount), decimals: data[9] } } }, stackHeight: null });
          } else if (data[0] === 15) {
            const a = this.accounts.get(acct(0).toBase58());
            const amount = data.readBigUInt64LE(1);
            if (!a || a.amount < amount || a.owner !== acct(2).toBase58()) throw new Error('burn failed');
            a.amount -= amount;
            const m = this.mints.get(acct(1).toBase58());
            if (m) m.supply -= amount;
            parsedIxs.push({ program: 'spl-token', programId: program.toBase58(), parsed: { type: 'burnChecked', info: { account: acct(0).toBase58(), mint: acct(1).toBase58(), authority: acct(2).toBase58(), tokenAmount: { amount: String(amount), decimals: data[9] } } }, stackHeight: null });
          } else throw new Error('the pretend chain only knows checked transfers and burns');
        } else if (program.equals(PUMP_PROGRAM)) {
          // create_v2: the mint is account 0, the creator account 5. The pretend curve gives the creator nothing.
          const mint = acct(0).toBase58();
          this.mints.set(mint, { decimals: 6, supply: 1_000_000_000_000_000n, program: TOKEN_2022_PROGRAM.toBase58(), creator: acct(5).toBase58() });
          const curveAta = ataAddress(acct(2), acct(0)).toBase58();
          this.accounts.set(curveAta, { owner: acct(2).toBase58(), mint, amount: 1_000_000_000_000_000n });
          parsedIxs.push({ programId: program.toBase58(), accounts: ix.accountKeyIndexes.map((i) => keys[i].toBase58()), data: bs58.encode(data), stackHeight: null });
        } else {
          parsedIxs.push({ programId: program.toBase58(), accounts: ix.accountKeyIndexes.map((i) => keys[i].toBase58()), data: bs58.encode(data), stackHeight: null });
        }
      }
    } catch (e) {
      err = { InstructionError: [0, { Custom: 1 }], message: String((e as Error).message) };
      this.accounts = snapshot;
    }
    this.slot += 1;
    const keyList = keys.map((k) => k.toBase58());
    const balances = (src: Map<string, bigint>) =>
      keyList
        .map((k, i) => ({ k, i }))
        .filter(({ k }) => src.has(k) || this.accounts.has(k))
        .map(({ k, i }) => {
          const t = this.accounts.get(k) ?? snapshot.get(k);
          return { accountIndex: i, mint: t!.mint, owner: t!.owner, uiTokenAmount: { amount: String(src.get(k) ?? 0n), decimals: this.mints.get(t!.mint)?.decimals ?? 6 } };
        });
    const after = new Map([...this.accounts].map(([k, v]) => [k, v.amount]));
    this.txs.set(sig, {
      slot: this.slot,
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err, fee: 5000, preTokenBalances: balances(before), postTokenBalances: balances(err ? before : after), logMessages: [] },
      transaction: {
        signatures: tx.signatures.map((s) => bs58.encode(s)),
        message: {
          accountKeys: keyList.map((k, i) => ({ pubkey: k, signer: i < msg.header.numRequiredSignatures, writable: msg.isAccountWritable(i), source: 'transaction' })),
          instructions: parsedIxs,
          recentBlockhash: msg.recentBlockhash,
        },
      },
      version: 'legacy',
    });
    this.sentAt.set(sig, Date.now());
    if (err && (err as any).message === 'insufficient funds') {
      // Real nodes refuse this at preflight; keep the record for getTransaction but report it too.
      throw new RpcError('Transaction simulation failed: Error processing Instruction 2: insufficient funds', -32002);
    }
    return sig;
  }
}
