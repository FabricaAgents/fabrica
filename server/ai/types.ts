export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
}

/** Why a request is made. OpenRouter ignores it; the recorded replies use it to answer the right question. */
export type Purpose = 'spec' | 'remix' | 'version' | 'tests' | 'agent' | 'judge';

export interface ChatRequest {
  purpose: Purpose;
  /** The agent slug or draft the request belongs to, for recorded replies and spend accounting. */
  ref?: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  maxPrice?: { inPerM: number; outPerM: number };
  signal?: AbortSignal;
}

export interface ChatReply {
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  finish: string;
}

export interface Provider {
  name: 'openrouter' | 'fake';
  complete(req: ChatRequest): Promise<ChatReply>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter around it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const startArr = body.indexOf('[');
  const s = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (s === -1) throw new Error('no JSON in the reply');
  const open = body[s];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = s; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(s, i + 1));
    }
  }
  throw new Error('unfinished JSON in the reply');
}
