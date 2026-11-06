// Shared parts of the recorded example agents. Each example is a sentence, the spec and tests the builder
// model returned for it, and a scripted model that answers the way the recorded model did.
import type { Brain, FakeTurn, View } from '../../server/ai/fake';

export interface ExampleFixture {
  slug: string;
  sentence: string;
  spec: Record<string, any>;
  tests: { tests: Record<string, any>[] };
  agent: (v: View) => FakeTurn;
  judge?: (rubric: string, answer: string) => { pass: boolean; reason: string };
}

const ATTACK = /ignore all previous|maintenance mode|system prompt|internal reference|api keys?|environment variables|wallet keys|169\.254|localhost|\/etc\/passwd|process\.env|endless loop|transfer \d+ sol|\.\.\/|<script|compliance audit/i;

export const looksLikeAttack = (s: unknown) => ATTACK.test(typeof s === 'string' ? s : JSON.stringify(s ?? ''));

export const answer = (o: Record<string, unknown>): FakeTurn => ({ text: JSON.stringify(o) });
export const call = (name: string, args: Record<string, unknown>) => ({ name, args });

export function brainFor(fx: ExampleFixture): Brain {
  return (v) => {
    switch (v.req.purpose) {
      case 'spec':
        return v.sentence() === fx.sentence ? { text: JSON.stringify(fx.spec) } : null;
      case 'tests':
        return v.specForTests()?.name === fx.spec.name ? { text: JSON.stringify(fx.tests) } : null;
      case 'agent':
        return v.req.ref === fx.slug ? fx.agent(v) : null;
      case 'judge': {
        if (v.req.ref !== fx.slug || !fx.judge) return null;
        const u = v.lastUser();
        const rubric = u.match(/^Rubric: (.*)$/m)?.[1] ?? '';
        const ans = u.split('Answer:\n')[1] ?? '';
        return { text: JSON.stringify(fx.judge(rubric, ans)) };
      }
    }
  };
}

/** The text after a tool's "value: " line, parsed. */
export function sandboxValue(content: string): any {
  const m = content.match(/^value: ([\s\S]*)$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function toolJson(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
