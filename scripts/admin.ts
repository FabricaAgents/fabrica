// Admin switches from a terminal. Usage:
//   FABRICA_ADMIN_TOKEN=... npm run admin -- state
//   npm run admin -- pause <slug> "reason" | resume <slug> | calls on|off | builds on|off | burn | record-burn <sig> | backups | backup
const base = (process.env.FABRICA_SITE_URL ?? 'http://localhost:3721').replace(/\/$/, '');
const token = process.env.FABRICA_ADMIN_TOKEN;
if (!token) {
  console.error('Set FABRICA_ADMIN_TOKEN.');
  process.exit(1);
}
const [cmd, a, b] = process.argv.slice(2);
const call = async (path: string, body?: unknown) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
};
if (cmd === 'state') await call('/api/admin/state');
else if (cmd === 'pause' && a) await call(`/api/admin/agents/${a}/pause`, { reason: b ?? 'Paused by Fabrica for review' });
else if (cmd === 'resume' && a) await call(`/api/admin/agents/${a}/resume`, {});
else if ((cmd === 'calls' || cmd === 'builds') && (a === 'on' || a === 'off')) await call('/api/admin/switch', { [cmd]: a === 'on' });
else if (cmd === 'burn') await call('/api/admin/burn', {});
else if (cmd === 'backups') await call('/api/admin/backups');
else if (cmd === 'backup') await call('/api/admin/backups', {});
else if (cmd === 'record-burn' && a) await call('/api/admin/record-burn', { signature: a });
else console.log('Commands: state | pause <slug> [reason] | resume <slug> | calls on|off | builds on|off | burn | record-burn <signature> | backups | backup');
export {};
