// The models a maker can pick. Prices are dollars per million tokens and are refreshed from OpenRouter's public
// model list at boot when it answers; these numbers are the fallback and the ceiling the router may not exceed.

export interface ModelEntry {
  id: string;
  label: string;
  maker: 'openai' | 'google' | 'anthropic' | 'deepseek' | 'qwen' | 'mistral';
  inPerM: number;
  outPerM: number;
  note: string;
}

export const MODELS: ModelEntry[] = [
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', maker: 'openai', inPerM: 0.4, outPerM: 1.6, note: 'Steady tool use, cheap' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', maker: 'google', inPerM: 0.3, outPerM: 2.5, note: 'Fast, long inputs' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', maker: 'anthropic', inPerM: 1, outPerM: 5, note: 'Careful with instructions' },
  { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1', maker: 'deepseek', inPerM: 0.27, outPerM: 1.1, note: 'Strong at code' },
  { id: 'qwen/qwen3-235b-a22b-2507', label: 'Qwen3 235B', maker: 'qwen', inPerM: 0.15, outPerM: 0.6, note: 'Lowest cost per call' },
  { id: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2', maker: 'mistral', inPerM: 0.1, outPerM: 0.3, note: 'Short, structured tasks' },
];

export const DEFAULT_MODEL = 'openai/gpt-4.1-mini';
/** The model that writes specs, writes tests and grades rubric checks. */
export const BUILDER_MODEL = 'openai/gpt-4.1-mini';

/** Tokens of prompt one step may carry. The runtime trims tool output so a step never exceeds it. */
export const PROMPT_BUDGET_TOKENS = 8000;

export function modelById(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The most one call can spend on AI, in micro-USD. The price of a call always covers it. */
export function aiCeilingMicros(model: ModelEntry, maxSteps: number, maxOutputTokens: number): number {
  const perStep = PROMPT_BUDGET_TOKENS * model.inPerM + maxOutputTokens * model.outPerM; // micro-USD, since prices are per million
  return Math.ceil(maxSteps * perStep);
}
