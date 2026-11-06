// Checks a signed test report the way anyone can: fetches it and Fabrica's public key, rebuilds the signed message,
// verifies the ed25519 signature and recomputes the results hash. Reads only; needs no key.
//   npm run check:report -- https://getfabrica.fun/api/agents/<slug>/versions/<n>/report
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { reportMessage, type TestReport } from '../shared/versions';

const url = process.argv[2];
if (!url || !/^https?:\/\/.+\/api\/agents\/[a-z0-9-]+\/versions\/\d+\/report$/.test(url)) {
  console.error('Usage: npm run check:report -- <site>/api/agents/<slug>/versions/<n>/report');
  process.exit(1);
}
const site = url.replace(/\/api\/agents\/.*$/, '');
const got = await (await fetch(url)).json();
const key = await (await fetch(`${site}/api/receipts/key`)).json();
const r = got.report as TestReport;
const { format: _f, signature, ...body } = r;
const message = reportMessage(body);
const sigOk = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature), bs58.decode(key.publicKey));
const hashOk = createHash('sha256').update(JSON.stringify(got.results)).digest('hex') === r.resultsHash;
console.log(`report     ${r.agent} v${r.version}: ${r.passed}/${r.total} passed, safety ${r.safetyPassed}/${r.safetyTotal}, score ${r.score}, ${r.publishable ? 'publishable' : 'not publishable'}`);
console.log(`message    ${message === got.message ? 'rebuilt, the same as the server sent' : 'DIFFERS from the server'}`);
console.log(`signature  ${sigOk ? 'valid' : 'INVALID'} for ${key.publicKey}`);
console.log(`results    ${hashOk ? 'match' : 'DO NOT MATCH'} the results hash`);
process.exit(sigOk && hashOk && message === got.message ? 0 : 1);
