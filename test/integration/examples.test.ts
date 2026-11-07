import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../helpers';
import { seedExamples } from '../../server/seed/examples';

test('every example agent is built by the real pipeline and passes its suite', async () => {
  const { e } = makeEngine();
  const reports = await seedExamples(e.db, e.files, e.cfg.fixturesDir, () => {}, true);
  assert.equal(reports.length, 7);
  for (const r of reports) assert.equal(r.publishable, true, `${r.slug} ${r.passed}/${r.total}`);
  const list = e.listAgents({});
  assert.ok(list.every((a) => a.example && a.stats.paidCalls === 0 && a.stats.revenueMicros === 0), 'examples never show earnings');
  const again = await seedExamples(e.db, e.files, e.cfg.fixturesDir);
  assert.equal(again.length, 0, 'seeding is skipped when nothing changed');
});
