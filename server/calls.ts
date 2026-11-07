// A paid call, end to end: price and quote (HTTP 402), proof of payment, the run, the receipt.
// The same path serves the run-it page, the HTTP API and the MCP endpoint.
import { randomBytes } from 'node:crypto';
import { Buffer } from 'buffer';
import type { AgentSpec, PaymentRecipient, PaymentRequirements } from '../shared/types';
import { audit, tx } from './db';
import type { Engine } from './engine';
import type { AgentRow } from './agents';
import { hashInput, type QuoteRow, type Stage } from './pay/payments';
import { priceFor } from './pay/price';
import { hashOutput, hashPlan, newReceiptId, newRetryToken, signReceipt, toReceipt, type ReceiptRow } from './pay/receipts';
import { HireSession, NetworkError, planParts, type HireCallRecord } from './networks';
import type { Provider } from './ai/types';
import type { HirePlan } from '../shared/networks';
import { NETWORK_LIMITS } from '../shared/networks';
import { PaymentError } from './pay/verify';
import { runAgent, type RunEvent } from './runtime/run';
import { inputChars, toJsonSchema, validateInput } from './spec/schema';
import { readSwitches } from './safety/limits';

export interface CallReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Progress {
  stage: Stage | 'queued' | 'running' | 'done' | 'failed';
  events: RunEvent[];
  at: number;
}

const OUTPUT_KEEP = 64 * 1024;

/** What the 402 body shows of a paid plan: every slot with its price, the hire total and the maker's budget. */
export function networkSummary(plan: HirePlan) {
  return {
    hiresTotal: plan.total,
    budget: plan.budget,
    slots: plan.slots.map((s) => ({ slot: s.slot, parent: s.parent, depth: s.depth, agent: s.slug, name: s.name, version: s.version, total: s.price.total + s.hires, maker: s.price.maker, makerTo: s.maker, royalty: s.price.royalty, royaltyTo: s.royaltyTo, ai: s.price.ai, platform: s.price.platform })),
    leftOut: plan.skipped,
  };
}

export class Calls {
  private progress = new Map<string, Progress>();
  private inflight = new Set<Promise<unknown>>();
  constructor(private e: Engine) {}

  progressOf(nonce: string): Progress | null {
    return this.progress.get(nonce) ?? null;
  }

  private setProgress(nonce: string, p: Partial<Progress>) {
    const cur = this.progress.get(nonce) ?? { stage: 'verifying', events: [], at: Date.now() };
    Object.assign(cur, p, { at: Date.now() });
    this.progress.set(nonce, cur);
    if (this.progress.size > 5000) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, v] of this.progress) if (v.at < cutoff) this.progress.delete(k);
    }
  }

  /** Why an agent cannot take a call right now, or null. Checked before any quote so nobody pays for a refusal. */
  private refusal(row: AgentRow, spec: AgentSpec): CallReply | null {
    if (row.example) return { status: 409, body: { error: 'examples_not_for_sale', message: 'This is an example agent. It shows the build and test process and takes no paid calls.' } };
    if (row.status === 'paused') return { status: 409, body: { error: 'paused', message: `This agent is paused: ${row.pause_reason ?? 'by its maker'}.` } };
    if (row.status !== 'live') return { status: 404, body: { error: 'not_found', message: 'No such agent.' } };
    if (readSwitches(this.e.db).callsPaused) return { status: 503, body: { error: 'paused', message: 'Paid calls are paused for a short while. Nothing was charged.' } };
    if (!this.e.payments.open) return { status: 503, body: { error: 'closed', message: 'Paid calls are not open yet.' } };
    if (!this.e.provider) return { status: 503, body: { error: 'offline', message: 'The AI provider is offline. Nothing was charged.' } };
    const price = priceFor(spec, this.e.cfg, this.e.tierFor(row.maker), this.e.agents.royalty(row).bps);
    const room = this.e.ledger.room(row.id, price.ai);
    if (!room.ok) return { status: 503, body: { error: 'spend_cap', message: room.reason } };
    if (spec.tools.hire_agent) {
      if (!this.e.cfg.networksOpen) return { status: 503, body: { error: 'closed', message: 'Agents that hire other agents are paused for now. Nothing was charged.' } };
      let plan: HirePlan;
      try {
        plan = this.e.networks.plan(row.slug, spec);
      } catch (err) {
        if (err instanceof NetworkError) return { status: err.status, body: { error: err.code, message: err.message } };
        throw err;
      }
      // Every hired agent's AI ceiling must fit its own daily cap, and the whole job the overall cap, before anyone pays.
      const perAgent = new Map<string, number>();
      for (const sl of plan.slots) perAgent.set(sl.agentId, (perAgent.get(sl.agentId) ?? 0) + sl.price.ai);
      for (const [id, ai] of perAgent) {
        const r = this.e.ledger.room(id, ai);
        if (!r.ok) return { status: 503, body: { error: 'spend_cap', message: `An agent this one hires has reached its AI spending limit for today. Nothing was charged.` } };
      }
      const all = this.e.ledger.room(row.id, price.ai + plan.slots.reduce((n, x) => n + x.price.ai, 0));
      if (!all.ok) return { status: 503, body: { error: 'spend_cap', message: all.reason } };
    }
    return null;
  }

  async quote(row: AgentRow, input: Record<string, unknown>, ip: string, resource: string): Promise<PaymentRequirements> {
    return (await this.quoteWithPlan(row, input, ip, resource)).req;
  }

  /**
   * The quote. For an agent that hires, the price is one call of it plus every slot of the paid plan, and each hired
   * maker is one more recipient of the same transaction (docs/NETWORKS.md).
   */
  async quoteWithPlan(row: AgentRow, input: Record<string, unknown>, ip: string, resource: string): Promise<{ req: PaymentRequirements; plan: HirePlan | null }> {
    const spec = this.e.agents.spec(row);
    // A remix's royalty is one more recipient in the same transaction, to the original's maker.
    const royalty = this.e.agents.royalty(row);
    const price = priceFor(spec, this.e.cfg, this.e.tierFor(row.maker), royalty.bps);
    const plan = spec.tools.hire_agent ? this.e.networks.plan(row.slug, spec) : null;
    const parts = plan ? planParts(plan) : null;
    if (plan) {
      price.hires = plan.total;
      price.total += plan.total;
    }
    const req = await this.e.payments.makeQuote({
      kind: 'call',
      agentId: row.id,
      inputHash: hashInput(input),
      price,
      makerWallet: row.maker ?? undefined,
      royaltyWallet: royalty.wallet,
      version: row.version,
      network: plan && parts ? { plan, recipients: parts.recipients, ai: parts.ai, platform: parts.platform } : undefined,
      ip,
      resource,
      description: plan ? `${spec.name}: ${spec.tagline} Includes up to ${plan.slots.length} hired call${plan.slots.length === 1 ? '' : 's'}, already priced in.` : `${spec.name}: ${spec.tagline}`,
      outputSchema: { input: toJsonSchema(spec.input), output: toJsonSchema(spec.output) },
    });
    return { req, plan };
  }

  /**
   * The whole call. Without a payment header it answers 402 with a fresh quote; with one it settles, runs and
   * returns the output with a receipt. A retry token from a failed run buys one more run of the same input.
   */
  async handle(slug: string, body: any, headers: { payment?: string; retry?: string }, ip: string): Promise<CallReply> {
    const row = this.e.agents.row(slug);
    if (!row || row.status === 'retired') return { status: 404, body: { error: 'not_found', message: 'No such agent.' } };
    const live = this.e.agents.spec(row);
    const input = body && typeof body === 'object' && body.input && typeof body.input === 'object' ? body.input : null;
    if (!input) return { status: 400, body: { error: 'bad_input', message: 'Send JSON: {"input": {...}}' } };
    const inputProblems = (spec: AgentSpec) => {
      const errs = validateInput(spec.input, input);
      if (inputChars(input) > spec.limits.maxInputChars) errs.push(`the input is longer than ${spec.limits.maxInputChars} characters`);
      return errs;
    };

    if (headers.retry) return this.retry(row, input, headers.retry);

    if (!headers.payment) {
      const errs = inputProblems(live);
      if (errs.length) return { status: 400, body: { error: 'bad_input', message: errs.join('; '), fields: toJsonSchema(live.input) } };
      const no = this.refusal(row, live);
      if (no) return no;
      if (!this.e.limiter.take(`quote:${ip}`, 60, 60_000) || this.e.payments.outstandingFor(ip, Date.now() - 3_600_000) > 300) {
        return { status: 429, body: { error: 'rate_limited', message: 'Too many quotes from this address. Wait a minute.' }, headers: { 'retry-after': '60' } };
      }
      let quoted: Awaited<ReturnType<Calls['quoteWithPlan']>>;
      try {
        quoted = await this.quoteWithPlan(row, input, ip, `${this.e.cfg.siteUrl}/api/agents/${row.slug}/run`);
      } catch (err) {
        if (err instanceof NetworkError || err instanceof PaymentError) return { status: err.status, body: { error: err.code, message: err.message } };
        throw err;
      }
      const { req, plan } = quoted;
      return { status: 402, body: { x402Version: 1, error: 'Payment required', accepts: [req], ...(plan ? { network: networkSummary(plan) } : {}) } };
    }

    // A paid call runs the version it was quoted on, even if the maker published or rolled back since, so the
    // caller gets what was priced and the input contract it was checked against.
    let nonce = '';
    let spec = live;
    let version = row.version;
    try {
      const settled = await this.e.payments.settle(
        headers.payment,
        (q) => {
          nonce = q.nonce;
          this.setProgress(q.nonce, { stage: 'verifying' });
          if (q.kind !== 'call' || q.agent_id !== row.id) throw new PaymentError('wrong_agent', 'That payment is for a different agent.', 409);
          if (q.input_hash !== hashInput(input)) throw new PaymentError('input_changed', 'That payment was quoted for a different input. Send the input you were quoted for.', 409);
          version = q.version || row.version;
          spec = this.specOf(row, version);
          const errs = inputProblems(spec);
          if (errs.length) throw new PaymentError('bad_input', errs.join('; '), 400);
        },
        (stage) => nonce && this.setProgress(nonce, { stage }),
      );
      return await this.track(this.runPaid(row, spec, version, input, settled));
    } catch (e) {
      if (nonce) this.setProgress(nonce, { stage: 'failed' });
      if (e instanceof PaymentError) return { status: e.status, body: { error: e.code, message: e.message } };
      this.e.log(`paid call failed before running: ${(e as Error).message}`);
      return { status: 502, body: { error: 'settle_failed', message: 'The payment could not be checked right now. If it went through, send the same header again; it stays valid for 24 hours.' } };
    }
  }

  /** The spec a version ran with: the live one, or an earlier version from its record. */
  private specOf(row: AgentRow, version: number): AgentSpec {
    if (!version || version === row.version) return this.e.agents.spec(row);
    return this.e.versions.spec(row.id, version) ?? this.e.agents.spec(row);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  async drain(ms: number) {
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, ms))]);
  }

  private async waitGate(agentId: string, ms = 60_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.e.gates.tryEnter(agentId)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  private async execute(row: AgentRow, spec: AgentSpec, input: Record<string, unknown>, budget: number, nonce: string, ref: string, session?: HireSession) {
    this.setProgress(nonce, { stage: 'queued' });
    const entered = await this.waitGate(row.id);
    if (!entered) return { ok: false, output: null, error: 'Fabrica was too busy to start this call. Use the retry token to run it again.', ms: 0, aiCostMicros: 0, files: [] as any[] };
    try {
      this.setProgress(nonce, { stage: 'running' });
      const events: RunEvent[] = [];
      const push = (ev: RunEvent) => {
        events.push(ev);
        this.setProgress(nonce, { events: [...events] });
      };
      if (session) session.onEvent = push;
      return await runAgent({
        spec,
        input,
        provider: this.e.requireProvider(),
        io: this.e.io,
        files: this.e.files,
        ownerRef: ref,
        budgetMicros: budget,
        onEvent: push,
        onSpend: (m) => this.e.ledger.add(row.id, m),
        hire: session?.handle(0, ref, [row.slug], spec),
      });
    } catch (err) {
      return { ok: false, output: null, error: `The run failed: ${(err as Error).message}`, ms: 0, aiCostMicros: 0, files: [] as any[] };
    } finally {
      this.e.gates.leave(row.id);
    }
  }

  /** The guard over a paid plan: hired calls run the version they were quoted on, and each gets a signed receipt. */
  private session(plan: HirePlan, rootId: string, payer: string, txSig: string, attempt: number): HireSession {
    return new HireSession(
      plan,
      {
        // A missing provider surfaces inside the hire as an error result, never as a lost payment.
        provider: this.e.provider as Provider,
        io: this.e.io,
        files: this.e.files,
        target: (slot) => this.e.networks.slotTarget(slot),
        onSpend: (agentId, m) => this.e.ledger.add(agentId, m),
        gate: { enter: (id) => this.waitGate(id, NETWORK_LIMITS.waitMs), leave: (id) => this.e.gates.leave(id) },
        record: (r) => this.recordHire(r, payer, txSig),
      },
      { rootId, attempt },
    );
  }

  /** Signs and keeps a hired call's receipt: its slot's amounts, its place in the tree, its outcome. */
  private recordHire(r: HireCallRecord, payer: string, txSig: string) {
    const createdAt = Date.now();
    const sl = r.slot;
    const base = {
      id: r.id,
      agentSlug: sl.slug,
      payer,
      txSig,
      total: sl.price.total + sl.hires,
      maker: sl.price.maker,
      royalty: sl.price.royalty,
      royaltyTo: sl.royaltyTo,
      ai: sl.price.ai,
      platform: sl.price.platform,
      status: (r.ok ? 'ok' : 'failed') as 'ok' | 'failed',
      inputHash: hashInput(r.input),
      outputHash: r.ok ? hashOutput(r.output) : null,
      ms: r.ms,
      aiCostMicros: r.aiCost,
      createdAt,
      version: sl.version,
      depth: sl.depth,
      parentId: r.parentId,
      rootId: r.rootId,
      hires: sl.hires,
      planHash: '',
    };
    const serverSig = signReceipt(this.e.receiptKeys, base);
    const out = r.output ? JSON.stringify(r.output) : null;
    this.e.db
      .prepare('INSERT INTO hires (id, root_id, parent_id, slot, attempt, depth, agent_id, version, payer, tx_sig, total, maker_amt, royalty_amt, royalty_to, ai_amt, platform_amt, hires_amt, status, input_hash, output_hash, output, error, ms, ai_cost, server_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.rootId, r.parentId, sl.slot, r.attempt, sl.depth, sl.agentId, sl.version, payer, txSig, base.total, base.maker, base.royalty, base.royaltyTo, base.ai, base.platform, base.hires, base.status, base.inputHash, base.outputHash, out && out.length <= OUTPUT_KEEP ? out : null, r.error, r.ms, r.aiCost, serverSig, createdAt);
  }

  private async runPaid(row: AgentRow, spec: AgentSpec, version: number, input: Record<string, unknown>, s: { quote: QuoteRow; payer: string; sig: string; slot: number }): Promise<CallReply> {
    const q = s.quote;
    const id = newReceiptId();
    // A quote with a plan paid for its hire slots; the run may use those and nothing else.
    const plan: HirePlan | null = q.plan ? JSON.parse(q.plan) : null;
    const session = plan ? this.session(plan, id, s.payer, s.sig, 1) : undefined;
    const result = await this.execute(row, spec, input, q.ai_amt, q.nonce, id, session);
    const ok = result.ok;
    const output = ok ? { ...result.output, ...(result.files?.length ? { _files: result.files.map((f: any) => ({ name: f.name, url: f.url })) } : {}) } : null;
    const retryToken = ok ? null : newRetryToken();
    const createdAt = Date.now();
    const royaltyTo = q.royalty_amt > 0 ? ((JSON.parse(q.recipients) as PaymentRecipient[]).find((r) => r.role === 'royalty')?.address ?? null) : null;
    const base = {
      id,
      agentSlug: row.slug,
      payer: s.payer,
      txSig: s.sig,
      total: q.total,
      maker: q.maker_amt,
      royalty: q.royalty_amt,
      royaltyTo,
      ai: q.ai_amt,
      platform: q.platform_amt,
      status: (ok ? 'ok' : 'failed') as 'ok' | 'failed',
      inputHash: q.input_hash ?? '',
      outputHash: ok ? hashOutput(output) : null,
      ms: result.ms,
      aiCostMicros: result.aiCostMicros,
      createdAt,
      version,
      // The top of a receipt tree signs v4: its place, the hire part of the total and the hash of the paid plan.
      ...(plan ? { depth: 1, parentId: null, rootId: id, hires: q.hires_amt, planHash: hashPlan(q.plan!) } : {}),
    };
    const serverSig = signReceipt(this.e.receiptKeys, base);
    const outText = output ? JSON.stringify(output) : null;
    tx(this.e.db, () => {
      this.e.db
        .prepare('INSERT INTO receipts (id, agent_id, quote_nonce, tx_sig, payer, total, maker_amt, royalty_amt, royalty_to, ai_amt, platform_amt, status, input_hash, output_hash, output, error, retry_token, ms, ai_cost, slot, server_sig, buyback_bps, created_at, version, hires_amt, plan, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, row.id, q.nonce, s.sig, s.payer, q.total, q.maker_amt, q.royalty_amt, royaltyTo, q.ai_amt, q.platform_amt, base.status, q.input_hash, base.outputHash, outText && outText.length <= OUTPUT_KEEP ? outText : null, result.error, retryToken, result.ms, result.aiCostMicros, s.slot, serverSig, row.coin_mint ? row.buyback_bps : 0, createdAt, version, plan ? q.hires_amt : 0, plan ? q.plan : null, plan ? 1 : 0);
      // Who was paid for every slot, in the same write as the receipt that signs the plan's hash.
      for (const sl of plan?.slots ?? []) {
        this.e.db
          .prepare('INSERT INTO hire_slots (root_id, slot, parent_slot, depth, agent_id, version, payer, maker_to, maker_amt, royalty_to, royalty_amt, ai_amt, platform_amt, hires_amt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, sl.slot, sl.parent, sl.depth, sl.agentId, sl.version, s.payer, sl.maker, sl.price.maker, sl.royaltyTo, sl.price.royalty, sl.price.ai, sl.price.platform, sl.hires, createdAt);
      }
    });
    this.setProgress(q.nonce, { stage: ok ? 'done' : 'failed' });
    const receipt = { ...base, serverSig };
    const paymentResponse = Buffer.from(JSON.stringify({ success: true, transaction: s.sig, network: this.e.cfg.network, payer: s.payer })).toString('base64');
    const tree = plan ? { tree: `${this.e.cfg.siteUrl}/api/receipts/${id}/tree` } : {};
    if (ok) return { status: 200, body: { output, receipt, ...tree }, headers: { 'x-payment-response': paymentResponse } };
    return {
      status: 502,
      body: { error: 'run_failed', message: result.error, receipt, ...tree, retryToken, retry: 'Send the same input again with the header X-Fabrica-Retry set to this token, within 24 hours, for one more run at no charge.' },
      headers: { 'x-payment-response': paymentResponse },
    };
  }

  private async retry(row: AgentRow, input: Record<string, unknown>, token: string): Promise<CallReply> {
    const r = this.e.db.prepare('SELECT * FROM receipts WHERE retry_token = ? AND agent_id = ?').get(token, row.id) as ReceiptRow | undefined;
    if (!r || r.retry_used || r.status !== 'failed') return { status: 404, body: { error: 'no_retry', message: 'That retry token is unknown or already used.' } };
    // The retry runs the version that was paid for.
    const spec = this.specOf(row, r.version || row.version);
    if (Date.now() - r.created_at > 24 * 3_600_000) return { status: 410, body: { error: 'retry_expired', message: 'Retry tokens last 24 hours.' } };
    if (r.input_hash !== hashInput(input)) return { status: 409, body: { error: 'input_changed', message: 'A retry runs the same input that was paid for.' } };
    // Claim the retry before running, so two parallel retries cannot both run.
    const claim = this.e.db.prepare('UPDATE receipts SET retry_used = 1 WHERE id = ? AND retry_used = 0').run(r.id);
    if (claim.changes !== 1) return { status: 409, body: { error: 'no_retry', message: 'That retry token was already used.' } };
    const nonce = `retry-${randomBytes(6).toString('hex')}`;
    // A retry of a job that hires runs the whole job again on the same paid plan, hires included.
    const plan: HirePlan | null = r.plan ? JSON.parse(r.plan) : null;
    const session = plan ? this.session(plan, r.id, r.payer, r.tx_sig, 2) : undefined;
    const result = await this.track(this.execute(row, spec, input, r.ai_amt, nonce, r.id, session));
    if (!result.ok) return { status: 502, body: { error: 'run_failed', message: result.error, receipt: toReceipt(r, row.slug) } };
    const output = { ...result.output, ...(result.files?.length ? { _files: result.files.map((f: any) => ({ name: f.name, url: f.url })) } : {}) };
    const updated = { ...toReceipt(r, row.slug), status: 'retried' as const, outputHash: hashOutput(output), ms: result.ms, aiCostMicros: r.ai_cost + result.aiCostMicros };
    const { serverSig: _old, ...unsigned } = updated;
    const serverSig = signReceipt(this.e.receiptKeys, unsigned);
    tx(this.e.db, () => {
      this.e.db.prepare('UPDATE receipts SET status = ?, output_hash = ?, output = ?, ms = ?, ai_cost = ?, server_sig = ? WHERE id = ?').run('retried', updated.outputHash, JSON.stringify(output).slice(0, OUTPUT_KEEP), result.ms, updated.aiCostMicros, serverSig, r.id);
      audit(this.e.db, 'caller', 'retry', { receipt: r.id });
    });
    return { status: 200, body: { output, receipt: { ...updated, serverSig } } };
  }
}
