// Screenshots of the flows that need a signed-in maker and a paid call, taken in test mode (pretend chain,
// recorded replies). Every file is named testenv-*: these are test data, never real earnings.
// Usage (after npm run build): node --import tsx test/e2e/flow-shots.ts docs/shots
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Browser } from './cdp';
import { FAKE_PHANTOM, walletFor } from './rig';

const out = process.argv[2] ?? 'docs/shots';
const PORT = 3732;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-flow-'));
const server = spawn('nice', ['node', '--import', 'tsx', 'server/main.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), FABRICA_TEST_MODE: '1', FABRICA_AI_MODE: 'fake', FABRICA_DATA_DIR: dataDir, FABRICA_SITE_URL: BASE, FABRICA_OPS_WALLET: Keypair.generate().publicKey.toBase58(), FABRICA_BURN_WALLET: Keypair.generate().publicKey.toBase58(), FABRICA_USDC_MINT: Keypair.generate().publicKey.toBase58() },
  stdio: 'ignore',
});
const done = () => {
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', done);
for (let i = 0; i < 120; i++) {
  try {
    if ((await (await fetch(`${BASE}/api/health`)).json()).examples === 'built') break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 500));
}
const fund = (w: Keypair) => fetch(`${BASE}/api/__test/fund`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: w.publicKey.toBase58(), micros: 50_000_000 }) });
const maker = Keypair.generate();
const buyer = Keypair.generate();
const remixer = Keypair.generate();
await fund(maker);
await fund(buyer);
await fund(remixer);
const typeInto = (sel: string, text: string) => `(() => { const t = document.querySelector('${sel}'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const settle = () => new Promise((r) => setTimeout(r, 900));
const reveal = `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('is-in'))`;

const b = new Browser();
await b.start();
for (const phone of (process.env.FLOW_ONLY === 'phone' ? [true] : [false, true])) {
  const tag = phone ? 'phone' : 'desktop';
  const sentence = 'Summarise any pasted text into three short bullet points for busy readers';
  const p = await b.page(`${BASE}/build?s=${encodeURIComponent(sentence)}`, { phone, onNew: FAKE_PHANTOM(maker.publicKey.toBase58()), bindings: walletFor(maker) });
  // Each round starts signed out: the remix part below signs in another maker in the same browser.
  await p.waitFor('document.readyState === "complete"');
  await p.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
  await p.goto(`${BASE}/build?s=${encodeURIComponent(sentence)}`);
  await p.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("and build") && !b.disabled)');
  await p.eval('[...document.querySelectorAll("button")].find(b => b.textContent.includes("and build")).click()');
  await p.waitFor('!!document.querySelector("#sp-name")?.value', 30000);
  await p.eval(`document.querySelector('.build-block').scrollIntoView()`);
  await settle();
  await p.shot(path.join(out, `testenv-build-spec-${tag}.png`));
  await p.click('Write the tests');
  await p.waitFor('document.querySelectorAll(".tcase").length > 4', 30000);
  await p.click('Run the tests');
  await p.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish"))', 60000);
  await p.eval(`document.querySelector('.tests-ed').scrollIntoView()`);
  await settle();
  await p.shot(path.join(out, `testenv-build-tested-${tag}.png`));
  await p.click('Publish');
  await p.waitFor('location.pathname.startsWith("/agents/") && !!document.querySelector(".run")', 30000);
  const slug = (await p.eval('location.pathname')).split('/')[2];
  await p.close();

  const q = await b.page(`${BASE}/agents/${slug}`, { phone, onNew: FAKE_PHANTOM(buyer.publicKey.toBase58()), bindings: walletFor(buyer) });
  await q.waitFor('!!document.querySelector("#in-request")');
  await settle();
  await q.eval(`(() => { const t = document.querySelector('#in-request'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Fabrica turns one sentence into a tested agent that strangers can pay per call, with a receipt for each call.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await q.click('Pay $');
  await q.waitFor('!!document.querySelector(".receipt")', 30000);
  if (!(await q.eval('!!document.querySelector(".run__result")'))) throw new Error(`the paid run did not answer: ${await q.eval('document.querySelector(".run").textContent.slice(-400)')}`);
  await q.eval(`document.querySelector('.run__result').scrollIntoView({block: 'center'})`);
  await settle();
  await q.shot(path.join(out, `testenv-run-paid-${tag}.png`));
  await q.goto(`${BASE}/agents/${slug}`);
  await q.waitFor('document.readyState === "complete" && !!document.querySelector("#earnings")');
  await q.eval(`${reveal}; document.querySelector('#earnings').scrollIntoView()`);
  await settle();
  await q.shot(path.join(out, `testenv-agent-earnings-${tag}.png`));
  await q.goto(`${BASE}/agents#leaderboard`);
  await q.waitFor('document.readyState === "complete" && !!document.querySelector(".board")');
  await q.eval(`${reveal}; document.querySelector('#leaderboard').scrollIntoView()`);
  await settle();
  await q.shot(path.join(out, `testenv-leaderboard-${tag}.png`));
  await q.close();

  // Remix: another maker changes one sentence of the agent above.
  const r = await b.page(`${BASE}/agents/${slug}`, { phone, onNew: FAKE_PHANTOM(remixer.publicKey.toBase58()), bindings: walletFor(remixer) });
  await r.waitFor('document.readyState === "complete"');
  await r.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
  await r.goto(`${BASE}/agents/${slug}`);
  await r.waitFor('!!document.querySelector(".agent-head__remix a")');
  await settle();
  await r.shot(path.join(out, `testenv-remix-button-${tag}.png`));
  await r.goto(`${BASE}/remix/${slug}`);
  await r.waitFor('!!document.querySelector(".remix-orig")');
  await r.eval(typeInto('#sentence', 'Also return a one line headline for busy readers'));
  await settle();
  await r.shot(path.join(out, `testenv-remix-start-${tag}.png`));
  await r.click('Sign in and remix');
  await r.waitFor('document.querySelectorAll(".rdiff__row").length >= 2', 30000);
  await r.eval(`document.querySelector('#before-after').scrollIntoView()`);
  await settle();
  await r.shot(path.join(out, `testenv-remix-before-after-${tag}.png`));
  await r.click('Write the tests');
  await r.waitFor('document.querySelectorAll(".tcase").length > 4', 30000);
  await r.click('Run the tests');
  await r.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish"))', 60000);
  await r.eval(`document.querySelector('.tests-ed').scrollIntoView()`);
  await settle();
  await r.shot(path.join(out, `testenv-remix-tested-${tag}.png`));
  await r.click('Publish');
  await r.waitFor('location.pathname.startsWith("/agents/") && !!document.querySelector(".agent-head__lineage")', 30000);
  const remixSlug = (await r.eval('location.pathname')).split('/')[2];
  await settle();
  await r.shot(path.join(out, `testenv-remix-agent-${tag}.png`));
  await r.close();

  const c = await b.page(`${BASE}/agents/${remixSlug}`, { phone, onNew: FAKE_PHANTOM(buyer.publicKey.toBase58()), bindings: walletFor(buyer) });
  await c.waitFor('!!document.querySelector("#in-request")');
  await settle();
  await c.eval(typeInto('#in-request', 'Remixes pay the original maker a royalty inside the same payment, at the same price.'));
  await c.click('Pay $');
  await c.waitFor('!!document.querySelector(".receipt")', 30000);
  await c.eval(`document.querySelector('.receipt').scrollIntoView({block: 'center'})`);
  await settle();
  await c.shot(path.join(out, `testenv-remix-paid-${tag}.png`));
  await c.eval(`document.querySelector('.agent-main__side').scrollIntoView({block: 'start'})`);
  await settle();
  await c.shot(path.join(out, `testenv-remix-split-${tag}.png`));
  await c.goto(`${BASE}/agents/${slug}`);
  await c.waitFor('document.readyState === "complete" && !!document.querySelector("#remixes")');
  await c.eval(`${reveal}; document.querySelector('#remixes').scrollIntoView()`);
  await settle();
  await c.shot(path.join(out, `testenv-remix-list-${tag}.png`));
  await c.close();

  // Versions: the maker improves the agent with one sentence, publishes v2, then rolls back.
  const v = await b.page(`${BASE}/agents/${slug}`, { phone, onNew: FAKE_PHANTOM(maker.publicKey.toBase58()), bindings: walletFor(maker) });
  await v.waitFor('document.readyState === "complete"');
  await v.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
  await v.goto(`${BASE}/improve/${slug}`);
  await v.waitFor('!!document.querySelector("#sentence") && !!document.querySelector(".remix-orig")');
  await v.eval(typeInto('#sentence', 'Also return how many minutes the pasted text takes to read'));
  await settle();
  await v.shot(path.join(out, `testenv-versions-improve-${tag}.png`));
  await v.click('Sign in and improve');
  await v.waitFor('document.querySelectorAll(".rdiff__row").length >= 2 && !!document.querySelector("#sp-name")?.value', 30000);
  await v.eval(`document.querySelector('#before-after').scrollIntoView()`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-before-after-${tag}.png`));
  await v.click('Write the tests');
  await v.waitFor('document.querySelectorAll(".tcase").length > 4', 30000);
  await v.click('Run the tests');
  await v.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish v2"))', 60000);
  await v.eval(`document.querySelector('.build-next--pass').scrollIntoView({block: 'end'})`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-tested-${tag}.png`));
  await v.click('Publish v2');
  await v.waitFor('!!document.querySelector("#versions .vlog__item.is-live")', 30000);
  await v.eval(`${reveal}; window.scrollTo(0, document.querySelector('#versions').getBoundingClientRect().top + scrollY - 70)`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-changelog-${tag}.png`));
  await v.eval(`${reveal}; window.scrollTo(0, document.querySelector('#tests').getBoundingClientRect().top + scrollY - 70)`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-report-${tag}.png`));
  await v.eval(`window.scrollTo(0, 0)`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-agent-${tag}.png`));
  await v.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("Make v1 live again"))', 20000);
  await v.click('Make v1 live again');
  await v.waitFor('!!document.querySelector(".vlog__event")', 30000);
  await v.eval(`${reveal}; window.scrollTo(0, document.querySelector('#versions').getBoundingClientRect().top + scrollY - 70)`);
  await settle();
  await v.shot(path.join(out, `testenv-versions-rollback-${tag}.png`));
  await v.goto(`${BASE}/agents/${slug}/v/2`);
  await v.waitFor('document.readyState === "complete" && !!document.querySelector(".vpage")');
  await settle();
  await v.shot(path.join(out, `testenv-versions-page-${tag}.png`));
  await v.close();
}
await b.stop();
console.log('flow shots written to', out);
done();
process.exit(0);
