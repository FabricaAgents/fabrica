import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="page-head grid-bg" style={{ minHeight: '60vh', display: 'grid', alignContent: 'center' }}>
      <div className="wrap">
        <span className="kicker">Error 404</span>
        <h1 className="display h1" style={{ marginTop: 18 }}>
          Nothing on this line.
        </h1>
        <p className="lede">The page you asked for is not here. It may have been moved or never existed.</p>
        <div className="hero__ctas">
          <Link className="btn btn--primary" href="/agents">
            Browse agents
          </Link>
          <Link className="btn btn--ghost" href="/">
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}
