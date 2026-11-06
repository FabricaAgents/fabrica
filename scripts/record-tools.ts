// Records the real chain and web reads the example agents make, into fixtures/recorded/tools.json.
// Free: public RPC and public pages only, no AI and no transactions. Run: npm run record
import fs from 'node:fs';
import path from 'node:path';
import { solanaRead } from '../server/tools/chain';
import { RecordingRpc, type Recording } from '../server/tools/replay';
import { fetchPublicPage } from '../server/tools/web';
import { HttpRpc } from '../server/solana/rpc';
import { SOLANA_METHODS } from '../server/spec/schema';
import { RECORD_PLAN } from '../fixtures/examples/plan';

const rec: Recording = { rpc: {}, web: {}, recordedAt: new Date().toISOString() };
const urls = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(Boolean) as string[];
const rpc = new RecordingRpc(new HttpRpc(urls), rec);

for (const r of RECORD_PLAN.chain) {
  try {
    await solanaRead(rpc, r.method, r.args, [...SOLANA_METHODS]);
    console.log('chain', r.method, JSON.stringify(r.args), 'ok');
  } catch (e) {
    console.log('chain', r.method, JSON.stringify(r.args), 'error:', (e as Error).message);
  }
  await new Promise((res) => setTimeout(res, 400));
}
for (const url of RECORD_PLAN.web) {
  try {
    rec.web[url] = { page: await fetchPublicPage(url) };
    console.log('web', url, rec.web[url].page!.status);
  } catch (e) {
    const msg = (e as Error).name === 'BlockedUrl' ? `blocked: ${(e as Error).message}` : (e as Error).message;
    rec.web[url] = { error: msg };
    console.log('web', url, 'error:', msg);
  }
}
const out = path.join(process.cwd(), 'fixtures', 'recorded', 'tools.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rec, null, 1));
console.log('wrote', out);
