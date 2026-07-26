import React, { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { WallPost } from '../../types';

// Interactive Vote-for-POTM card that renders inline on the Team
// Wall wherever a wall_posts doc has a structured potmVotingOpen
// payload. Replaces the pre-2026-07-14 "Cast your vote →" markdown
// link that punted parents to /vote/:votingId (public route now
// killed per Patrick's kill-public-share ask). Voting is app-only.
//
// Card shows: title + live vote count + a "Vote now" or "Your vote:
// [name]" state. Tapping "Vote now" opens the existing POTM page
// deep-linked to this voting via ?voting=<id>, where the full
// ballot UI already lives. Once the coach closes voting, this
// card auto-swaps to a "Voting closed" state and the winner card
// (PotmWinnerCard) shows up as a separate wall post.

interface Props {
  post: WallPost;
  currentUserId: string | undefined;
  timestamp: Date;
  /** When true, swaps "Player of the Match" → "MVP" in the header and
   *  action copy so adult teams read as league-appropriate. Defaults
   *  to youth wording when omitted (safer for legacy callers). */
  isAdultTeam?: boolean;
}

interface VotingSnapshot {
  status?: string;
  votes?: Array<{ voterId?: string; playerId?: string; playerName?: string }>;
  eligiblePlayerIds?: string[];
  closedAt?: any;
}

const PotmVotingCard: React.FC<Props> = ({ post, currentUserId, isAdultTeam = false }) => {
  // Adult teams use "MVP"; youth stays with the traditional "Player of
  // the Match" wording. Same underlying vote mechanic — copy swap only.
  const voteHeader = isAdultTeam ? 'Vote for MVP' : 'Vote for Player of the Match';
  const open = post.potmVotingOpen!;
  const [voting, setVoting] = useState<VotingSnapshot | null>(null);

  // Live subscribe so the "N votes in" number ticks up in real
  // time and the card can auto-transition to closed state without
  // a wall refresh. Cheap: one doc listener per open voting card
  // on the wall, and there's normally 0 or 1 of these at a time.
  useEffect(() => {
    if (!open.votingId) return;
    const unsub = onSnapshot(doc(db, 'match_votings', open.votingId), (snap) => {
      if (!snap.exists()) { setVoting(null); return; }
      setVoting(snap.data() as VotingSnapshot);
    }, err => console.warn('potm voting card snapshot failed', err));
    return () => unsub();
  }, [open.votingId]);

  const votes = Array.isArray(voting?.votes) ? voting!.votes! : [];
  const voteCount = votes.length;
  const myVote = currentUserId ? votes.find(v => v.voterId === currentUserId) : null;
  const isClosed = voting?.status === 'closed';

  return (
    <article className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500/[0.10] via-surface-elevated to-surface-elevated ring-1 ring-amber-500/25 shadow-lg shadow-amber-900/15">
      {/* Subtle amber bloom top-right so the card reads as "same
          crown family" as PotmWinnerCard without stealing its
          celebratory weight. */}
      <div className="absolute -top-16 -right-12 w-48 h-48 rounded-full bg-amber-300/15 blur-3xl pointer-events-none" aria-hidden />

      <header className="relative px-5 pt-4 pb-1 flex items-center gap-2">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-400 text-slate-950">
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
          </svg>
        </span>
        <span className="text-[10px] font-black tracking-widest uppercase text-amber-300/90">
          {isClosed ? 'Voting closed' : voteHeader}
        </span>
      </header>

      <div className="relative px-5 py-4">
        <h3 className="text-lg sm:text-xl font-black text-ink-primary leading-tight">
          {open.gameTitle || 'Match'}
        </h3>

        {isClosed ? (
          <p className="text-[13px] text-ink-primary/60 mt-2">
            Voting is closed. Winner card will land on the wall in a moment.
          </p>
        ) : myVote ? (
          <div className="mt-3">
            <p className="text-[11px] font-black tracking-widest uppercase text-ink-primary/50">
              Your vote
            </p>
            <p className="text-[15px] font-bold text-ink-primary mt-0.5">
              {myVote.playerName || '—'}
            </p>
            <p className="text-[11px] text-ink-primary/50 mt-1">
              Results show when voting closes.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <a
              href={`/player-of-match?voting=${encodeURIComponent(open.votingId)}`}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-full bg-amber-400 text-slate-950 text-[13px] font-black tracking-wider uppercase shadow-md shadow-amber-500/25 hover:bg-amber-300 transition"
            >
              Vote now
            </a>
            <span className="text-[11px] text-ink-primary/50">
              {open.eligibleCount ? `${open.eligibleCount} candidate${open.eligibleCount === 1 ? '' : 's'}` : 'Open the ballot in-app'}
            </span>
          </div>
        )}
      </div>

      <footer className="relative px-5 py-2.5 border-t border-amber-300/10 flex items-center justify-between text-[10px] font-black tracking-widest uppercase text-ink-primary/45">
        <span>{voteCount} vote{voteCount === 1 ? '' : 's'} in</span>
        {!isClosed && (
          <a
            href={`/player-of-match?voting=${encodeURIComponent(open.votingId)}`}
            className="text-amber-500 hover:text-amber-400"
          >
            {myVote ? 'Change vote' : 'Open ballot →'}
          </a>
        )}
      </footer>
    </article>
  );
};

export default PotmVotingCard;

// Kept as a named re-export placeholder so a future badge/dot
// indicator on the tab can `import { matchVotingsQuery }` without
// duplicating the collection reference. Not used yet.
export const matchVotingsQuery = (teamId: string) =>
  query(collection(db, 'match_votings'), where('teamId', '==', teamId));
