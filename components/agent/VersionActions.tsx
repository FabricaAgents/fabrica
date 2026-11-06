'use client';
// The maker's own buttons in the changelog: improve the agent, and make an earlier version live again. Nobody else
// sees them, and the server checks the wallet again on every request.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { loadSession, useWallet } from '../../lib/wallet';
import { IconUndo } from '../Icons';

function useIsMaker(maker: string) {
  const w = useWallet();
  useEffect(() => {
    if (!w.checked) void loadSession();
  }, [w.checked]);
  return w.session === maker;
}

export function ImproveButton({ slug, maker, open, version }: { slug: string; maker: string; open: boolean; version: number }) {
  const mine = useIsMaker(maker);
  if (!mine || !open) return null;
  return (
    <Link className="btn btn--primary btn--sm" href={`/improve/${slug}`}>
      Improve this agent: make v{version + 1}
    </Link>
  );
}

export function RollbackButton({ slug, maker, version, open }: { slug: string; maker: string; version: number; open: boolean }) {
  const mine = useIsMaker(maker);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!mine || !open) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/agents/${slug}/rollback`, { body: { version } });
      window.location.hash = 'versions';
      window.location.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="vlog__rollback">
      <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={go}>
        {busy ? <span className="spinner" /> : <IconUndo />}
        Make v{version} live again
      </button>
      {err ? <span className="error-text">{err}</span> : null}
    </div>
  );
}
