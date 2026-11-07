// A receipt tree: the run the caller paid for at the top, every paid hire slot under the agent that could use it,
// who was paid how much for it, and the hired calls that ran on it with their own signed receipts.
import type { Receipt } from '../../shared/types';
import type { TreeNode } from '../../shared/networks';
import { shortAddr, usd } from '../../shared/format';
import { IconReceipt } from '../Icons';

export interface TreeData {
  root: Receipt;
  agent: { slug: string; name: string };
  plan: { total: number; budget: number; skipped: { parent: number; slug: string; reason: string }[] } | null;
  nodes: TreeNode[];
}

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Node({ n, all }: { n: TreeNode; all: TreeNode[] }) {
  const kids = all.filter((x) => x.parent === n.slot);
  const ok = n.calls.some((c) => c.status === 'ok');
  return (
    <li className="rtree__node">
      <div className={`rtree__card ${n.calls.length ? '' : 'is-unused'}`}>
        <div className="rtree__head">
          <a className="rtree__name" href={`/agents/${n.agent.slug}`}>
            {n.agent.name}
          </a>
          <span className="rtree__ver">v{n.version}</span>
          <span className={`rtree__state ${ok ? 'is-ok' : n.calls.length ? 'is-fail' : ''}`}>{ok ? 'Did its part' : n.calls.length ? 'Failed' : 'Paid, not called'}</span>
          <span className="rtree__amt mono">{usd(n.paid.total)}</span>
        </div>
        <ul className="rtree__paid">
          <li>
            <span>Maker</span>
            <b className="mono">{usd(n.paid.maker)}</b>
            <span className="muted">to {shortAddr(n.paid.makerTo)}</span>
          </li>
          {n.paid.royalty ? (
            <li>
              <span>Royalty</span>
              <b className="mono">{usd(n.paid.royalty)}</b>
              <span className="muted">to {n.paid.royaltyTo ? shortAddr(n.paid.royaltyTo) : 'the original maker'}</span>
            </li>
          ) : null}
          <li>
            <span>AI, at most</span>
            <b className="mono">{usd(n.paid.ai)}</b>
          </li>
          <li>
            <span>Platform</span>
            <b className="mono">{usd(n.paid.platform)}</b>
          </li>
          {n.paid.hires ? (
            <li>
              <span>Its own hires</span>
              <b className="mono">{usd(n.paid.hires)}</b>
            </li>
          ) : null}
        </ul>
        {n.calls.length ? (
          <ul className="rtree__calls">
            {n.calls.map((c) => (
              <li key={c.id}>
                <span className={`dot ${c.status === 'ok' ? 'pass' : 'fail'}`} />
                <a className="mono" href={`/api/receipts/${c.id}`}>
                  {c.id}
                </a>
                <span className="muted">{c.attempt > 1 ? `retry, ${secs(c.ms)}` : secs(c.ms)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {kids.length ? (
        <ol className="rtree__list">
          {kids.map((k) => (
            <Node key={k.slot} n={k} all={all} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function ReceiptTree({ tree, compact }: { tree: TreeData; compact?: boolean }) {
  const r = tree.root;
  const top = tree.nodes.filter((n) => n.parent === 0);
  const ran = tree.nodes.filter((n) => n.calls.length).length;
  return (
    <div className={`rtree ${compact ? 'rtree--compact' : ''}`}>
      <div className="rtree__root">
        <span className="rtree__seal">
          <IconReceipt />
        </span>
        <div className="rtree__rootbody">
          <div className="rtree__head">
            <b className="rtree__name">{tree.agent.name}</b>
            <span className="rtree__ver">v{r.version}</span>
            <span className={`rtree__state ${r.status === 'failed' ? 'is-fail' : 'is-ok'}`}>{r.status === 'failed' ? 'Failed' : r.status === 'retried' ? 'Done on retry' : 'Done'}</span>
            <span className="rtree__amt mono">{usd(r.total)}</span>
          </div>
          <p className="rtree__line">
            One payment from {shortAddr(r.payer)}: {usd(r.maker)} to its maker{r.royalty ? `, ${usd(r.royalty)} royalty` : ''}, AI up to {usd(r.ai)}, platform {usd(r.platform)}, and {usd(r.hires ?? 0)} for {tree.nodes.length} hire slot{tree.nodes.length === 1 ? '' : 's'}
            {tree.plan ? ` (cap ${usd(tree.plan.budget)})` : ''}. {ran} of {tree.nodes.length} ran.
          </p>
          <a className="mono rtree__id" href={`/api/receipts/${r.id}/tree`}>
            {r.id}
          </a>
        </div>
      </div>
      {top.length ? (
        <ol className="rtree__list rtree__list--top">
          {top.map((n) => (
            <Node key={n.slot} n={n} all={tree.nodes} />
          ))}
        </ol>
      ) : null}
      {tree.plan?.skipped.length ? <p className="hint rtree__skipped">Left out of the price: {tree.plan.skipped.map((s) => `${s.slug} (${s.reason})`).join(', ')}.</p> : null}
    </div>
  );
}
