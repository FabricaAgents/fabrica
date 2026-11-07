// Screenshots of agent networks, taken in test mode (pretend chain, recorded replies): the hire editor in the build
// flow, an agent that hires with its price and receipt trees, a paid run's tree, the agent it hires, the example that
// hires, and the roadmap. Every file is named testenv-*: test data, never real earnings.
// Usage (after npm run build): node --import tsx test/e2e/network-shots.ts docs/shots
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Browser, type Page } from './cdp';
import { FAKE_PHANTOM, walletFor } from './rig';

const out = process.argv[2] ?? 'docs/shots';
fs.mkdirSync(out, { recursive: true });
const PORT = 3733;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-net-'));
const server = spawn('nice', ['node', '--import', 'tsx', 'server/main.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), FABRICA_TEST_MODE: '1', FABRICA_AI_MODE: 'fake', FABRICA_DATA_DIR: dataDir, FABRICA_SITE_URL: BASE, FABRICA_OPS_WALLET: Keypair.generate().publicKey.toBase58(), FABRICA_BURN_WALLET: Keypair.generate().publicKey.toBase58(), FABRICA_USDC_MINT: Keypair.generate().publicKey.toBase58() },
  stdio: 'ignore',
});
const b = new Browser();
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
const settle = () => new Promise((r) => setTimeout(r, 900));
const typeInto = (sel: string, text: string) => `(() => { const t = document.querySelector('${sel}'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const overflow = async (p: Page, what: string) => {
  const wide = await p.eval(`(() => { const cw = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > cw + 1).slice(0, 6).map(e => e.tagName + '.' + String(e.className).split(' ').join('.') + ' ' + Math.round(e.getBoundingClientRect().right)); })()`);
  if (wide.length) console.log(`overflow on ${what}: ${wide.join(', ')}`);
};

await b.start();
try {
  /** One maker builds a plain agent through the build flow and publishes it. */
  const build = async (maker: Keypair, sentence: string, hire?: { slugs: string[]; shot?: string; phone?: boolean }) => {
    await fund(maker);
    const p = await b.page(`${BASE}/build?s=${encodeURIComponent(sentence)}`, { phone: hire?.phone, onNew: FAKE_PHANTOM(maker.publicKey.toBase58()), bindings: walletFor(maker) });
    await p.waitFor('document.readyState === "complete"');
    await p.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
    await p.goto(`${BASE}/build?s=${encodeURIComponent(sentence)}`);
    await p.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("and build") && !b.disabled)');
    await p.eval('[...document.querySelectorAll("button")].find(b => b.textContent.includes("and build")).click()');
    await p.waitFor('!!document.querySelector("#sp-name")?.value', 30000);
    if (hire) {
      await p.eval(`(() => { const box = [...document.querySelectorAll('.tool-ed')].find(t => t.textContent.includes('Hires agents')).querySelector('input[type=checkbox]'); box.click(); })()`);
      await p.waitFor(`document.querySelectorAll(".hire-ed__add option").length >= ${hire.slugs.length + 1}`, 20000);
      for (const slug of hire.slugs) {
        await p.eval(`(() => { const s = document.querySelector('.hire-ed__add select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(slug)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await p.waitFor('!document.querySelector(".hire-ed__add .btn").disabled', 5000);
        await p.eval('document.querySelector(".hire-ed__add .btn").click()');
      }
      await p.eval(`(() => { const i = document.querySelector('#sp-hire-budget'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '0.08'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await p.click('Save changes');
      await p.waitFor('/hired call/.test(document.querySelector(".spec__price")?.textContent ?? "")', 20000);
      if (hire.shot) {
        await p.eval(`document.querySelector('.hire-ed').closest('.tool-ed').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90)`);
        await settle();
        await overflow(p, 'the hire editor');
        await p.shot(path.join(out, hire.shot));
      }
    }
    await p.click('Write the tests');
    await p.waitFor('document.querySelectorAll(".tcase").length > 4', 30000);
    await p.click('Run the tests');
    await p.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish"))', 90000);
    await p.click('Publish');
    await p.waitFor('location.pathname.startsWith("/agents/") && !!document.querySelector(".run")', 30000);
    const slug = (await p.eval('location.pathname')).split('/')[2];
    await p.close();
    return slug;
  };
  const [a, c, net, buyer] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  await fund(buyer);
  const summary = await build(a, 'Summarise pasted meeting notes into the decisions that were made, with who agreed');
  const actions = await build(c, 'Lists every action item in pasted meeting notes with its owner and due date');
  const top = await build(net, 'Checks pasted meeting notes by hiring a summary agent and an action item agent, then lists the open questions', { slugs: [summary, actions], shot: 'testenv-networks-build-hires-desktop.png' });
  // The same editor on a phone, on a draft that is not published.
  {
    const other = Keypair.generate();
    await fund(other);
    const p = await b.page(`${BASE}/build?s=${encodeURIComponent('Reviews pasted meeting notes by hiring a summary agent first')}`, { phone: true, onNew: FAKE_PHANTOM(other.publicKey.toBase58()), bindings: walletFor(other) });
    await p.waitFor('document.readyState === "complete"');
    await p.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
    await p.goto(`${BASE}/build?s=${encodeURIComponent('Reviews pasted meeting notes by hiring a summary agent first')}`);
    await p.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("and build") && !b.disabled)');
    await p.eval('[...document.querySelectorAll("button")].find(b => b.textContent.includes("and build")).click()');
    await p.waitFor('!!document.querySelector("#sp-name")?.value', 30000);
    await p.eval(`(() => { const box = [...document.querySelectorAll('.tool-ed')].find(t => t.textContent.includes('Hires agents')).querySelector('input[type=checkbox]'); box.click(); })()`);
    await p.waitFor('document.querySelectorAll(".hire-ed__add option").length >= 3', 20000);
    for (const slug of [summary, actions]) {
      await p.eval(`(() => { const s = document.querySelector('.hire-ed__add select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(slug)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await p.waitFor('!document.querySelector(".hire-ed__add .btn").disabled', 5000);
      await p.eval('document.querySelector(".hire-ed__add .btn").click()');
    }
    await p.click('Save changes');
    await p.waitFor('/hired call/.test(document.querySelector(".spec__price")?.textContent ?? "")', 20000);
    await p.eval(`document.querySelector('.hire-ed').closest('.tool-ed').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80)`);
    await settle();
    await overflow(p, 'the hire editor on a phone');
    await p.shot(path.join(out, 'testenv-networks-build-hires-phone.png'));
    await p.close();
  }

  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    // A paid run: the price before you run, the payment, the receipt tree in the run panel.
    const q = await b.page(`${BASE}/agents/${top}`, { phone, onNew: FAKE_PHANTOM(buyer.publicKey.toBase58()), bindings: walletFor(buyer) });
    await q.waitFor('!!document.querySelector("#in-request")');
    await settle();
    await q.eval(`document.querySelector('.run').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90)`);
    await settle();
    await q.shot(path.join(out, `testenv-networks-price-${tag}.png`));
    await q.eval(typeInto('#in-request', 'Notes: we ship on Friday, Sam agreed. Mia writes the docs by Thursday. Open: who tells support?'));
    await q.click('Pay $');
    await q.waitFor('document.querySelectorAll(".run__tree .rtree__node").length === 2', 40000);
    await q.eval(`document.querySelector('.run__tree').scrollIntoView({ block: 'center' })`);
    await settle();
    await overflow(q, `the run panel tree ${tag}`);
    await q.shot(path.join(out, `testenv-networks-run-tree-${tag}.png`));
    await q.close();
    // The agent page: head, the split, the hires and the latest trees.
    const r = await b.page(`${BASE}/agents/${top}`, { phone });
    await r.waitFor('!!document.querySelector("#hires .rtree")', 20000);
    await settle();
    await overflow(r, `the agent page ${tag}`);
    await r.shot(path.join(out, `testenv-networks-agent-${tag}.png`));
    await r.eval(`document.querySelector('.agent-main__side').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90)`);
    await settle();
    await r.shot(path.join(out, `testenv-networks-split-${tag}.png`));
    await r.eval(`document.querySelector('#hires').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70)`);
    await settle();
    await r.shot(path.join(out, `testenv-networks-hires-${tag}.png`));
    await r.eval(`document.querySelector('#hires .rtree').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70)`);
    await settle();
    await r.shot(path.join(out, `testenv-networks-tree-${tag}.png`));
    await r.close();
    // The agent it hires: who hires it, and what being hired earned.
    const h = await b.page(`${BASE}/agents/${summary}#hires`, { phone });
    await h.waitFor('!!document.querySelector("#hires")', 20000);
    await h.eval(`document.querySelector('#hires').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70)`);
    await settle();
    await overflow(h, `the hired agent ${tag}`);
    await h.shot(path.join(out, `testenv-networks-hired-${tag}.png`));
    await h.close();
    for (const [p, name, sel] of [
      ['/agents/invoice-check', 'example', null],
      ['/agents/invoice-check', 'example-hires', '#hires'],
      ['/roadmap', 'roadmap', '.rm__phase--next'],
      ['/docs', 'docs', '#networks'],
      ['/docs', 'docs-trees', '#receipt-trees'],
    ] as const) {
      const v = await b.page(BASE + p, { phone });
      await v.waitFor('document.readyState === "complete" && !!document.querySelector("footer")', 20000);
      if (sel) await v.eval(`document.querySelector('${sel}').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80)`);
      await settle();
      await overflow(v, `${p} ${tag}`);
      await v.shot(path.join(out, `networks-${name}-${tag}.png`));
      await v.close();
    }
  }
  console.log(`shots in ${out}`);
} finally {
  await b.stop();
  done();
  process.exit(0);
}
