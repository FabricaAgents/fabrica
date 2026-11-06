import fs from 'node:fs';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { logoDataUrl } from '../components/logo-data';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Fabrica: one sentence in, a working agent out';

const font = (pkg: string, file: string) => fs.readFileSync(path.join(process.cwd(), 'node_modules', '@fontsource', pkg, 'files', file));

export default function OG() {
  const grid = 'linear-gradient(rgba(21,23,26,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(21,23,26,0.06) 1px, transparent 1px)';
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: '#ebe8e1', backgroundImage: grid, backgroundSize: '40px 40px', color: '#15171a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <img src={logoDataUrl()} width={64} height={64} alt="" />
          <span style={{ fontFamily: 'Display', fontSize: 52 }}>Fabrica</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontFamily: 'Display', fontSize: 118, lineHeight: 0.92 }}>One sentence in.</span>
          <span style={{ fontFamily: 'Display', fontSize: 118, lineHeight: 0.92, color: '#2b47f5' }}>A working agent out.</span>
        </div>
        <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 22, letterSpacing: 2, color: '#464a51' }}>BUILT, TESTED IN PUBLIC, PAID PER CALL ON SOLANA</div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Display', data: font('big-shoulders-display', 'big-shoulders-display-latin-800-normal.woff'), weight: 800 },
        { name: 'Mono', data: font('martian-mono', 'martian-mono-latin-400-normal.woff'), weight: 400 },
      ],
    },
  );
}
