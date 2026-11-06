import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRpc } from '../../server/solana/rpc';

const FREE = 'https://free.example';
const BACKUP = 'https://backup.example';

function node(answers: Record<string, number>) {
  const hits: string[] = [];
  const f = (async (url: string) => {
    hits.push(url);
    const status = answers[url] ?? 200;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }), { status });
  }) as unknown as typeof fetch;
  return { f, hits };
}

test('the backup node is never asked while the free node answers', async () => {
  const { f, hits } = node({});
  const rpc = new HttpRpc([FREE], f, 1000, BACKUP);
  for (let i = 0; i < 20; i++) await rpc.call('getSlot');
  assert.equal(hits.filter((u) => u === BACKUP).length, 0);
});

test('the backup answers only a call the free node failed, and the free node stays first', async () => {
  const answers: Record<string, number> = { [FREE]: 429 };
  const { f, hits } = node(answers);
  const rpc = new HttpRpc([FREE], f, 1000, BACKUP);
  assert.equal(await rpc.call('getSlot'), 7);
  assert.deepEqual(hits, [FREE, BACKUP]);
  answers[FREE] = 200;
  hits.length = 0;
  await rpc.call('getSlot');
  assert.deepEqual(hits, [FREE]);
  assert.equal(rpc.stats[1].ok, 1);
});
