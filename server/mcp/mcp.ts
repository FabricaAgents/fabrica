// The MCP endpoint (streamable HTTP, JSON responses). Every live agent is a tool. A call without payment returns
// the x402 requirements as a tool error; the client pays and calls again with the X-PAYMENT value in
// arguments.payment or in _meta["x402/payment"]. The paid path is the same one the HTTP API uses.
import type { Engine } from '../engine';
import { toJsonSchema } from '../spec/schema';

export const MCP_PROTOCOL = '2025-06-18';

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };

const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

export const toolName = (slug: string) => `run_${slug.replace(/-/g, '_')}`.slice(0, 64);

export async function handleMcp(e: Engine, msg: Rpc, ip: string, only?: string): Promise<unknown | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(null, -32600, 'Invalid request');
  const isNote = msg.id === undefined;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fabrica', version: '1.0.0' },
        instructions: 'Each tool is a tested agent that is paid per call in USDC on Solana. Call a tool once without payment to get its x402 requirements, pay them with one transaction, then call again with the payment. Some agents are remixes of others: their payment has one more recipient, the original maker\'s royalty, inside the same transaction and the same price.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list': {
      const agents = e.listAgents({}).filter((a) => a.status === 'live' && (!only || a.slug === only)).slice(0, 100);
      return ok(msg.id, {
        tools: agents.map((a) => ({
          name: toolName(a.slug),
          title: a.name,
          description: `${a.tagline} Price per call: ${(a.price.total / 1e6).toFixed(4)} USDC, paid with x402 on Solana. Tests passed: ${a.tests ? `${a.tests.passed}/${a.tests.total}` : 'none'}.${a.remixOf ? ` A remix of ${a.remixOf.name}, tested from scratch${a.price.royalty ? `; ${(a.price.royalty / 1e6).toFixed(4)} USDC of the price goes to its original maker as a royalty` : ''}.` : ''}${a.remixes.count ? ` Remixed ${a.remixes.count} time${a.remixes.count === 1 ? '' : 's'}.` : ''}`,
          inputSchema: { ...toJsonSchema(a.input), properties: { ...(toJsonSchema(a.input).properties as object), payment: { type: 'string', description: 'The X-PAYMENT value for this call (base64). Leave out to get the price.' } } },
          outputSchema: toJsonSchema(a.output),
          annotations: { readOnlyHint: true, openWorldHint: a.tools.includes('web_fetch') },
        })),
      });
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const agent = e.listAgents({}).find((a) => toolName(a.slug) === name && (!only || a.slug === only));
      if (!agent) return err(msg.id, -32602, `Unknown tool: ${name}`);
      const args = { ...(msg.params?.arguments ?? {}) };
      const payment = typeof args.payment === 'string' ? args.payment : typeof msg.params?._meta?.['x402/payment'] === 'string' ? msg.params._meta['x402/payment'] : undefined;
      delete args.payment;
      const r = await e.calls.handle(agent.slug, { input: args }, { payment }, ip);
      const body = r.body as any;
      if (r.status === 402) {
        return ok(msg.id, {
          isError: true,
          content: [{ type: 'text', text: `Payment required: ${(Number(body.accepts[0].maxAmountRequired) / 1e6).toFixed(4)} USDC. Pay the x402 requirements in structuredContent, then call again with the payment.` }],
          structuredContent: { x402Version: 1, accepts: body.accepts },
          _meta: { 'x402/payment-required': body },
        });
      }
      if (r.status !== 200) return ok(msg.id, { isError: true, content: [{ type: 'text', text: body.message ?? body.error ?? 'The call failed.' }], structuredContent: body });
      return ok(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(body.output) }],
        structuredContent: body.output,
        _meta: { 'x402/payment-response': r.headers?.['x-payment-response'] ?? null, receipt: body.receipt },
      });
    }
    default:
      return isNote ? null : err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
