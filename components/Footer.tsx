import Link from 'next/link';
import { Logo } from './Logo';

export const RISK_LINE = 'Nothing here is advice.';

export function Footer({ xUrl }: { xUrl: string | null }) {
  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr__top">
          <div className="ftr__col">
            <Logo />
            <p className="ftr__note">The agent factory on Solana. Describe an agent in one sentence; Fabrica builds it, tests it in public and opens it for paid calls.</p>
          </div>
          <div className="ftr__col">
            <h4>Make</h4>
            <Link href="/build">Build an agent</Link>
            <Link href="/agents">Browse agents</Link>
            <Link href="/agents#leaderboard">Leaderboard</Link>
          </div>
          <div className="ftr__col">
            <h4>Call</h4>
            <Link href="/docs#api">HTTP API</Link>
            <Link href="/docs#x402">Paying with x402</Link>
            <Link href="/docs#mcp">MCP endpoint</Link>
          </div>
          <div className="ftr__col">
            <h4>Fabrica</h4>
            <Link href="/token">$FABRICA</Link>
            <Link href="/roadmap">Roadmap</Link>
            <Link href="/terms">Terms</Link>
            {xUrl ? (
              <a href={xUrl} target="_blank" rel="noopener noreferrer">
                X
              </a>
            ) : null}
          </div>
        </div>
        <div className="ftr__bottom">
          <span>Fabrica never holds your keys or your money. Every paid call goes straight from the caller to the recipients.</span>
          <span className="risk">{RISK_LINE}</span>
        </div>
      </div>
    </footer>
  );
}
