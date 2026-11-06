import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/800';
import '@fontsource/hanken-grotesk/400';
import '@fontsource/hanken-grotesk/500';
import '@fontsource/hanken-grotesk/600';
import '@fontsource/martian-mono/400';
import '@fontsource/martian-mono/500';
import './globals.css';
import '../styles/home.css';
import '../styles/agents.css';
import '../styles/build.css';
import '../styles/docs.css';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { Reveal } from '../components/Reveal';

function siteUrl() {
  return globalThis.__fabrica?.cfg.siteUrl ?? process.env.FABRICA_SITE_URL ?? 'http://localhost:3721';
}

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const title = 'Fabrica: the agent factory on Solana';
  const description = 'Describe an AI agent in one sentence. Fabrica builds it, tests it in public and opens it for paid calls in USDC, with a receipt for every call.';
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: title, template: '%s | Fabrica' },
    description,
    openGraph: { title, description, url: siteUrl(), siteName: 'Fabrica', type: 'website' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export const viewport: Viewport = {
  themeColor: '#ebe8e1',
  width: 'device-width',
  initialScale: 1,
};

const THEME = `try{var t=localStorage.getItem('fabrica-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const xUrl = globalThis.__fabrica?.cfg.xUrl ?? null;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
        <noscript>
          <style>{`.reveal{opacity:1;transform:none}`}</style>
        </noscript>
      </head>
      <body>
        <Header xUrl={xUrl} />
        <main>{children}</main>
        <Footer xUrl={xUrl} />
        <Reveal />
      </body>
    </html>
  );
}
