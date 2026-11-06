import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, checkUrl } from '../../server/tools/ssrf';
import { precheck, domainAllowed, fetchPublicPage, BlockedUrl } from '../../server/tools/web';

test('private and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.16.5.4', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '0.0.0.0']) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['93.184.215.14', '8.8.8.8', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']) assert.equal(isBlockedIp(ip), false, ip);
});

test('URLs are checked before any request', () => {
  for (const u of ['file:///etc/passwd', 'http://localhost/', 'http://169.254.169.254/latest', 'http://user:pw@example.com/', 'http://example.com:8080/', 'http://intranet/', 'gopher://x']) assert.throws(() => checkUrl(u), u);
  assert.equal(checkUrl('https://example.com/a').hostname, 'example.com');
});

test('the allowlist holds for subdomains only', () => {
  assert.equal(domainAllowed('docs.example.com', ['example.com']), true);
  assert.equal(domainAllowed('example.com.evil.test', ['example.com']), false);
  assert.throws(() => precheck('https://evil.test/', ['example.com']), BlockedUrl);
});

test('a public name that resolves to a private address is caught at connect time', async () => {
  await assert.rejects(fetchPublicPage('http://rebind.example.com/', { resolve: (_h, cb) => cb(null, '127.0.0.1', 4) }), BlockedUrl);
});
