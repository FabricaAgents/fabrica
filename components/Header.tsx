'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Logo } from './Logo';
import { IconArrow, IconClose, IconMenu, IconMoon, IconSun, IconX } from './Icons';

const NAV = [
  { href: '/agents', label: 'Agents' },
  { href: '/build', label: 'Build' },
  { href: '/docs', label: 'Docs' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/token', label: '$FABRICA' },
];

export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('fabrica-theme', next);
    } catch {
      /* private mode */
    }
  };
  return (
    <button type="button" className="icon-btn theme-btn" onClick={toggle} aria-label="Switch light and dark">
      <span className="theme-btn__sun">
        <IconSun />
      </span>
      <span className="theme-btn__moon">
        <IconMoon />
      </span>
    </button>
  );
}

export function Header({ xUrl }: { xUrl: string | null }) {
  const path = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
  }, [open]);
  const current = (href: string) => (path === href || path.startsWith(`${href}/`) ? 'page' : undefined);
  return (
    <>
      <header className="hdr">
        <div className="wrap hdr__in">
          <Link href="/" aria-label="Fabrica home" onClick={() => setOpen(false)}>
            <Logo />
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="hdr__right">
            {xUrl ? (
              <a className="icon-btn" href={xUrl} target="_blank" rel="noopener noreferrer" aria-label="Fabrica on X">
                <IconX />
              </a>
            ) : null}
            <ThemeToggle />
            <Link className="btn btn--primary btn--sm hide-sm" href="/build">
              Build an agent
            </Link>
            <button type="button" className="icon-btn menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? <IconClose /> : <IconMenu />}
            </button>
          </div>
        </div>
      </header>
      <div className="mnav" data-open={open}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} onClick={() => setOpen(false)}>
            {n.label}
            <IconArrow className="" />
          </Link>
        ))}
        <Link className="btn btn--primary btn--lg btn--block" href="/build" onClick={() => setOpen(false)}>
          Build an agent
        </Link>
      </div>
    </>
  );
}
