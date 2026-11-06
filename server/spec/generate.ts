// Describe, then build: one sentence becomes a full agent spec. The model drafts it; normalizeSpec decides.
import { BUILDER_MODEL, MODELS, modelById } from '../../shared/models';
import { CATEGORIES, type AgentSpec } from '../../shared/types';
import { extractJson, type Provider } from '../ai/types';
import { normalizeSpec, SOLANA_METHODS, SpecError } from './schema';

export const SENTENCE_MIN = 12;
export const SENTENCE_MAX = 400;

export function checkSentence(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < SENTENCE_MIN) throw new SpecError([`describe the agent in at least ${SENTENCE_MIN} characters`]);
  if (s.length > SENTENCE_MAX) throw new SpecError([`keep the description under ${SENTENCE_MAX} characters`]);
  return s;
}

export const SPEC_SYSTEM = `You design AI agents for an agent factory. A maker describes an agent in one sentence; you return the complete spec of a working agent that strangers will pay per call. Reply with one JSON object and nothing else.

Fields:
- name: 3 to 40 characters, plain and memorable, no hype words.
- tagline: at most 90 characters, what it does.
- brief: 40 to 600 characters for buyers: what it does, what it needs, what it returns, its limits.
- category: one of ${CATEGORIES.join(', ')}.
- systemPrompt: 400 to 3000 characters of instructions to the agent itself: its role, a step by step method, how and when to use each tool, the quality bar, how to handle bad or missing input, and when to refuse.
- model: one of ${MODELS.map((m) => `${m.id} (${m.note})`).join('; ')}.
- tools: an object with only the tools the job needs (least privilege):
  - web_fetch: {"allowDomains": []} for any public site, or a list of domains when the job only needs those.
  - code_run: {"network": false, "allowDomains": [], "timeMs": 2000, "memoryMb": 32}. JavaScript in a sandbox; set network true only with named domains.
  - solana_read: {"methods": [...]} from ${SOLANA_METHODS.join(', ')}. Read-only.
  - file_output: {"formats": [...]} from md, csv, json, txt, when the buyer should get a file.
- input: 1 to 6 fields. Each: {"name": snake_case, "type": string|text|number|integer|boolean|string[]|object, "description", "required", optional "enum", optional "maxLength"}.
- output: 1 to 10 fields in the same shape. Prefer fields a test can check (numbers, enums, short strings, lists) next to one readable summary field.
- limits: {"maxSteps": 1 to 8, "maxOutputTokens": 300 to 2000, "maxInputChars": 200 to 16000}. Use 1 step only when there are no tools.
- makerFee: what the maker earns per call, in micro-USDC (1 USDC = 1000000). Typical 5000 to 50000.
- examples: 1 to 3 realistic inputs, each {"title", "input": {...}} that match the input fields exactly.

Never design an agent that needs private keys, passwords, personal data about private people, or that signs or sends transactions. If the sentence asks for that, design the closest safe agent and say what it will not do in the brief.`;

export async function generateSpec(provider: Provider, sentence: string, ref: string): Promise<{ spec: AgentSpec; costMicros: number }> {
  const model = modelById(BUILDER_MODEL)!;
  let cost = 0;
  const messages = [
    { role: 'system' as const, content: SPEC_SYSTEM },
    { role: 'user' as const, content: `Sentence: ${sentence}` },
  ];
  let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await provider.complete({ purpose: 'spec', ref, model: model.id, messages, maxTokens: 3000, temperature: 0.4, jsonMode: true, maxPrice: { inPerM: model.inPerM, outPerM: model.outPerM } });
    cost += reply.costMicros || Math.ceil(reply.promptTokens * model.inPerM + reply.completionTokens * model.outPerM);
    try {
      return { spec: normalizeSpec(extractJson(reply.text)), costMicros: cost };
    } catch (e) {
      lastProblems = e instanceof SpecError ? e.problems : [(e as Error).message];
      messages.push({ role: 'assistant' as never, content: reply.text });
      messages.push({ role: 'user', content: `That spec has problems: ${lastProblems.join('; ')}. Reply with the corrected JSON object only.` });
    }
  }
  throw new SpecError(lastProblems.length ? lastProblems : ['the builder could not produce a valid spec']);
}
