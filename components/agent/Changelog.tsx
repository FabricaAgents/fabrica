// The public changelog on an agent page: every version that went live, newest first, with the sentence that made
// it, what changed, its tests and its signed report, and every rollback as a line of its own. The instructions are
// private, so for them it only says how much changed.
import Link from 'next/link';
import type { ChangelogEntry, VersionPublic } from '../../shared/types';
import { changeLine, type VersionChange } from '../../shared/versions';
import { dateShort } from '../../shared/format';
import { IconArrow, IconSeal, IconUndo } from '../Icons';
import { RollbackButton } from './VersionActions';

const KIND_NOTE: Record<VersionPublic['kind'], string> = {
  build: 'Built from one sentence',
  remix: 'Remixed from one sentence',
  improve: 'Improved by its maker',
  edit: 'Edited by its maker',
  example: 'Built by Fabrica as an example',
  earlier: 'Recorded when versions began',
};

export function ChangeList({ changes }: { changes: VersionChange[] }) {
  if (!changes.length) return null;
  return (
    <ul className="vlog__changes">
      {changes.map((c) => (
        <li key={c.field}>
          <span className="vlog__k">{c.label}</span>
          {c.lines ? (
            <span className="vlog__lines">
              {c.lines.slice(0, 4).map((l, i) => (
                <span key={i} className={l.op === 'add' ? 'is-add' : 'is-del'}>
                  {l.op === 'add' ? '+ ' : '- '}
                  {l.text}
                </span>
              ))}
              {c.lines.length > 4 ? <span className="vlog__more">and {c.lines.length - 4} more</span> : null}
            </span>
          ) : (
            <span className="vlog__lines">
              <span>{changeLine(c).replace(`${c.label}: `, '')}, kept private</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Changelog({ slug, maker, versions, changelog, open }: { slug: string; maker: string | null; versions: VersionPublic[]; changelog: ChangelogEntry[]; open: boolean }) {
  const byNum = new Map(versions.map((v) => [v.version, v]));
  // Newest first: each version where it went live, each rollback where it happened.
  return (
    <ol className="vlog">
      {changelog.map((e, i) => {
        if (e.kind === 'rollback') {
          return (
            <li key={`r${i}`} className="vlog__event">
              <span className="vlog__eicon">
                <IconUndo />
              </span>
              <span>
                Rolled back to <b>v{e.version}</b> from v{e.fromVersion}
              </span>
              <span className="muted">{dateShort(e.at)}</span>
            </li>
          );
        }
        const v = byNum.get(e.version);
        if (!v) return null;
        const t = v.tests;
        return (
          <li key={`v${v.version}`} className={`vlog__item ${v.live ? 'is-live' : ''}`}>
            <div className="vlog__num">
              <span>v{v.version}</span>
            </div>
            <div className="vlog__body">
              <div className="vlog__meta">
                {v.live ? <span className="badge badge--live">Live</span> : <span className="badge badge--earlier">Earlier</span>}
                <span>{KIND_NOTE[v.kind]}</span>
                {v.baseVersion && v.baseVersion !== v.version - 1 ? <span>from v{v.baseVersion}</span> : null}
                <span>{dateShort(v.createdAt)}</span>
              </div>
              {v.sentence ? <blockquote className="vlog__sentence">{v.sentence}</blockquote> : null}
              {v.summary ? <p className="vlog__summary">{v.summary}</p> : null}
              <ChangeList changes={v.changes} />
            </div>
            <div className="vlog__side">
              {t ? (
                <div className="vlog__score">
                  <span>
                    <i>Tasks</i>
                    {t.taskPassed}/{t.taskTotal}
                  </span>
                  <span>
                    <i>Safety</i>
                    {t.safetyPassed}/{t.safetyTotal}
                  </span>
                  <span>
                    <i>Score</i>
                    {t.score}
                  </span>
                </div>
              ) : (
                <div className="vlog__score muted">Not tested</div>
              )}
              <div className="vlog__links">
                <Link className="link" href={`/agents/${slug}/v/${v.version}`}>
                  Open v{v.version} <IconArrow />
                </Link>
                {t ? (
                  <a className="link" href={`/api/agents/${slug}/versions/${v.version}/report`}>
                    <IconSeal /> Signed report
                  </a>
                ) : null}
              </div>
              {!v.live && maker && t?.publishable ? <RollbackButton slug={slug} maker={maker} version={v.version} open={open} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
