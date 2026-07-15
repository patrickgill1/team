import React, { useMemo, useState } from 'react';

// Loose voting shape — matches what PlayerProfile hands us. We only
// touch closedAt / gameDate / id here, and playerVotes[i].reason /
// voterName. Kept local to avoid the type-refactor rabbit-hole
// (MatchVoting is redefined inline in PublicVote / PlayerOfMatch /
// PersonalRecords / PlayerProfile — 4 duplicate definitions).
type LooseVoting = {
  id?: string;
  closedAt?: any;
  gameDate?: any;
};

// FeaturedShoutCard — one rotating POTM comment quote surfaced on
// the profile above the fold. Patrick 2026-07-14: "i still want
// POTM comments to show a quote in the profile for other's to see."
//
// Scope: POTM comments only (not Kudos/Whispers). Whispers are
// coach→parent private; Kudos are Circle-scoped; POTM comments
// come from teammates' parents/players during voting and Patrick
// specifically wants THOSE to be publicly visible on the profile.
//
// Selection: random on mount. If there are multiple, a small
// refresh icon lets the viewer cycle. Hidden entirely when the
// player has no POTM comments yet.

interface Props {
  playerName?: string;
  votings: Array<{ voting: LooseVoting; playerVotes: Array<{ voterName: string; reason?: string }> }>;
  onOpenAll?: () => void;
}

interface Quote {
  voterName: string;
  reason: string;
  when: Date;
}

const FeaturedShoutCard: React.FC<Props> = ({ playerName, votings, onOpenAll }) => {
  const quotes: Quote[] = useMemo(() => {
    const out: Quote[] = [];
    for (const pv of votings) {
      const v: any = pv.voting;
      const when: Date = v?.closedAt?.toDate?.()
        || (v?.closedAt instanceof Date ? v.closedAt : null)
        || v?.gameDate?.toDate?.()
        || (v?.gameDate instanceof Date ? v.gameDate : new Date());
      for (const pvote of pv.playerVotes || []) {
        const reason = (pvote.reason || '').trim();
        if (!reason) continue;
        out.push({ voterName: pvote.voterName || 'A voter', reason, when });
      }
    }
    return out.sort((a, b) => b.when.getTime() - a.when.getTime());
  }, [votings]);

  // Random-on-mount start index so returning viewers don't always
  // see the same quote. Deterministic across a single render tree
  // to avoid remount flicker.
  const startIdx = useMemo(() => (quotes.length > 0 ? Math.floor(Math.random() * quotes.length) : 0), [quotes.length]);
  const [idx, setIdx] = useState(startIdx);

  if (quotes.length === 0) return null;
  const q = quotes[idx % quotes.length];
  const first = (playerName || '').split(' ')[0] || 'this player';

  return (
    // 2026-07-15 (Direction B): plain-shell treatment per the Card
    // Contract — gold tint is dropped so this reads as the same
    // system as every other Story card. Color lives only in the
    // trophy icon + eyebrow now.
    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5 flex flex-col gap-3">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-400/90 text-slate-950 shrink-0">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" />
            </svg>
          </span>
          <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55 truncate">
            Player of the Match: Featured shout
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {quotes.length > 1 && (
            <button
              type="button"
              onClick={() => setIdx(i => (i + 1) % quotes.length)}
              className="p-1.5 rounded-full text-ink-primary/50 hover:text-ink-primary hover:bg-line-default/[0.08] transition"
              aria-label="Show another quote"
              title="Show another quote"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          )}
          {onOpenAll && quotes.length > 1 && (
            <button
              type="button"
              onClick={onOpenAll}
              className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition px-2 py-1 rounded-md hover:bg-line-default/[0.06]"
            >
              All {quotes.length}
            </button>
          )}
        </div>
      </header>

      {/* The quote */}
      <blockquote className="text-[15px] sm:text-base leading-snug text-ink-primary font-medium">
        <span className="text-ink-primary/40 mr-0.5">&ldquo;</span>
        {q.reason}
        <span className="text-ink-primary/40 ml-0.5">&rdquo;</span>
      </blockquote>

      {/* Attribution */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-ink-primary/85 font-bold">{q.voterName}</span>
        <span className="text-ink-primary/25">·</span>
        <span className="text-ink-primary/50">on {first}</span>
      </div>
    </div>
  );
};

export default FeaturedShoutCard;
