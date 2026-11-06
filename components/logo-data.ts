// The logo as a data URL, for images drawn on the server (tab icon, share card), where a path does not load.
import fs from 'node:fs';
import path from 'node:path';

export function logoDataUrl(): string {
  return `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), 'public', 'logo.png')).toString('base64')}`;
}
