// OpenRouter, the one paid AI provider. Only reached when OPENROUTER_API_KEY is set; tests use the fake.
import type { ModelEntry } from '../../shared/models';
import { type ChatMessage, type ChatReply, type ChatRequest, type Provider, ProviderError } from './types';

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

export class OpenRouterProvider implements Provider {
  name = 'openrouter' as const;
  constructor(
    private key: string,
    private base: string,
    private siteUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: ChatRequest): Promise<ChatReply> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWire),
      max_tokens: req.maxTokens,
      usage: { include: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.maxPrice) body.provider = { max_price: { prompt: req.maxPrice.inPerM, completion: req.maxPrice.outPerM } };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.key}`,
            'content-type': 'application/json',
            'http-referer': this.siteUrl,
            'x-title': 'Fabrica',
          },
          body: JSON.stringify(body),
          signal: req.signal ?? AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ProviderError(`${res.status}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
        }
        const j: any = await res.json();
        if (j.error) throw new ProviderError(String(j.error.message ?? 'provider error'), Number(j.error.code) || null, true);
        const msg = j.choices?.[0]?.message ?? {};
        const cost = Number(j.usage?.cost);
        return {
          text: typeof msg.content === 'string' ? msg.content : '',
          toolCalls: (msg.tool_calls ?? []).map((c: any, i: number) => ({
            id: String(c.id ?? `call_${i}`),
            name: String(c.function?.name ?? ''),
            arguments: String(c.function?.arguments ?? '{}'),
          })),
          promptTokens: Number(j.usage?.prompt_tokens ?? 0),
          completionTokens: Number(j.usage?.completion_tokens ?? 0),
          costMicros: Number.isFinite(cost) ? Math.ceil(cost * 1e6) : 0,
          finish: String(j.choices?.[0]?.finish_reason ?? 'stop'),
        };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ProviderError) || !e.retryable || req.signal?.aborted) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    throw lastErr;
  }
}

/** Live prices from OpenRouter's public model list (no key needed). Prices only ever go into the table, never out. */
export async function refreshPrices(models: ModelEntry[], base: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${base}/models`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const j: any = await res.json();
  let changed = 0;
  for (const m of models) {
    const live = (j.data ?? []).find((d: any) => d.id === m.id);
    if (!live) continue;
    const inPerM = Number(live.pricing?.prompt) * 1e6;
    const outPerM = Number(live.pricing?.completion) * 1e6;
    if (Number.isFinite(inPerM) && inPerM > 0 && Number.isFinite(outPerM) && outPerM > 0) {
      m.inPerM = inPerM;
      m.outPerM = outPerM;
      changed++;
    }
  }
  return changed;
}
