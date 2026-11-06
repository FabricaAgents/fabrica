// House rules for every word the site can show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['app', 'components', 'fixtures', 'shared', 'server'];
const files: string[] = [];
const walk = (d: string) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css|mjs)$/.test(f)) files.push(p);
  }
};
roots.forEach(walk);

test('no em dashes, emojis or banned words anywhere in the source', () => {
  const bad: string[] = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    if (s.includes('—')) bad.push(`${f}: em dash`);
    if (/memecoin/i.test(s)) bad.push(`${f}: memecoin`);
    if (/\p{Extended_Pictographic}/u.test(s.replace(/[←-⇿✓✕]/g, ''))) bad.push(`${f}: emoji`);
    if (f.startsWith('app') || f.startsWith('components')) {
      if (/\bdemo\b/i.test(s)) bad.push(`${f}: the word demo`);
      if (/github/i.test(s)) bad.push(`${f}: GitHub`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the risk line is on the footer, the token page and the home band', () => {
  const footer = fs.readFileSync('components/Footer.tsx', 'utf8');
  assert.ok(footer.includes("RISK_LINE = 'Nothing here is advice.'"));
  for (const f of ['app/token/page.tsx', 'app/page.tsx', 'app/terms/page.tsx']) assert.ok(fs.readFileSync(f, 'utf8').includes('RISK_LINE'), f);
});

test('the logo picture is named in one place for the page and one for the icons', () => {
  const users = files.filter((f) => fs.readFileSync(f, 'utf8').includes('logo.png'));
  assert.deepEqual(users.sort(), ['components/Logo.tsx', 'components/logo-data.ts']);
});
