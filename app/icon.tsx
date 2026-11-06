import { ImageResponse } from 'next/og';
import { logoDataUrl } from '../components/logo-data';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  // eslint-disable-next-line @next/next/no-img-element
  return new ImageResponse(<img src={logoDataUrl()} width={64} height={64} alt="" />, size);
}
