// The picture pump.fun shows for an agent's coin: the agent's initials stamped on a Fabrica plate.
import fs from 'node:fs';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { engine } from '../../../lib/server';

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const a = globalThis.__fabrica ? engine().agent(slug) : null;
  if (!a) return new Response('Not found', { status: 404 });
  const initials = a.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const font = fs.readFileSync(path.join(process.cwd(), 'node_modules/@fontsource/big-shoulders-display/files/big-shoulders-display-latin-800-normal.woff'));
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#15171a', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 40, border: '4px solid #2b47f5', borderRadius: 48, display: 'flex' }} />
        <span style={{ fontFamily: 'Display', fontSize: 260, color: '#ebe8e1', letterSpacing: -4 }}>{initials}</span>
        <div style={{ position: 'absolute', right: 86, bottom: 86, width: 56, height: 56, borderRadius: 10, background: '#f2b705', display: 'flex' }} />
      </div>
    ),
    { width: 512, height: 512, fonts: [{ name: 'Display', data: font, weight: 800 }], headers: { 'cache-control': 'public, max-age=86400' } },
  );
}
