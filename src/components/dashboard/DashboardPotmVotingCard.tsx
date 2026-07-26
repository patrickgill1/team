import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useDismissible } from '../../hooks/useDismissible';

// Dashboard-side companion to the Wall's PotmVotingCard. Renders a
// compact "Vote for Player of the Match" card near the top of the
// dashboard whenever a match_votings doc is open for the selected
// team AND the viewer is eligible to weigh in.
//
// Why on Dashboard too (per Patrick's 2026-07-17 parent-privacy pass):
// Wall alone was hiding the ballot from parents who never scroll the
// Wall. Adding it to the primary landing surface makes voting a first
// class nudge without duplicating any submit logic. Tap routes to
// /player-of-match?voting=<id>, the same ballot the Wall card opens.
//
// Coach viewers see the card too but with a "Manage vote" action
// instead of "Vote" — they cast their coach vote from the full
// screen where they can also close voting or edit eligibility.
//
// Dismissable via useDismissible with a per-voting key so parents
// can hide it once they've cast their ballot or aren't interested,
// and the entry auto-expires at closedAt (or a 7-day snooze if the
// voting doc doesn't carry a closedAt yet).

interface Props {
  teamId: string | null | undefined;
  /** Viewer UID. Used to detect "did I already vote" and to gate
   *  eligibility against linked kids. */
  currentUserId: string | undefined;
  /** IDs of the viewer's linked kids on this team. Empty array means
   *  "not a parent" — the card only renders for those users when the
   *  viewer is also a coach. */
  myPlayerIds: string[];
  /** True when the viewer is a coach on this team. Swaps the primary
   *  action from "Vote now" to "Manage vote". */
  isCoach: boolean;
  /** True on adult teams so we swap "Player of the Match" → "MVP".
   *  Same voting mechanic, just league-appropriate copy. */
  isAdultTeam?: boolean;
}

interface VotingSnapshot {
  id: string;
  gameTitle?: string;
  votes?: Array<{ voterId?: string; playerId?: string; playerName?: string }>;
  eligiblePlayerIds?: string[];
  closedAt?: any;
  isActive?: boolean;
}

const DashboardPotmVotingCard: React.FC<Props> = ({ teamId, currentUserId, myPlayerIds, isCoach, isAdultTeam = false }) => {
  const potmLabel = isAdultTeam ? 'MVP' : 'Player of the Match';
  const [voting, setVoting] = useState<VotingSnapshot | null>(null);

  // Live subscribe to the team's active voting. Query returns 0 or 1
  // rows in practice (one open ballot at a time); we take the first.
  // Kept as a live listener so the "you already voted" state ticks in
  // real time after the parent submits.
  useEffect(() => {
    if (!teamId) { setVoting(null); return; }
    const q = query(
      collection(db, 'match_votings'),
      where('teamId', '==', teamId),
      where('isActive', '==', true),
    );
    const unsub = onSnapshot(q, (snap) => {
      const doc = snap.docs[0];
      if (!doc) { setVoting(null); return; }
      setVoting({ id: doc.id, ...(doc.data() as any) });
    }, err => console.warn('[dashboard-potm] snapshot failed', err));
    return () => unsub();
  }, [teamId]);

  // Eligibility gate for non-coaches: viewer must have at least one
  // linked kid in eligiblePlayerIds. Coaches always see the card
  // (they might want to close it, edit eligibility, or vote as coach).
  const isEligibleParent = useMemo(() => {
    if (!voting) return false;
    const elig = Array.isArray(voting.eligiblePlayerIds) ? voting.eligiblePlayerIds : null;
    // No eligibility list on the voting = open to everyone (matches
    // the ballot page's own fallthrough). This keeps older votings
    // that predate eligible-list gating from silently disappearing.
    if (!elig || elig.length === 0) return myPlayerIds.length > 0;
    return myPlayerIds.some(pid => elig.includes(pid));
  }, [voting, myPlayerIds]);

  const closeAtMs = useMemo(() => {
    const raw = voting?.closedAt;
    if (!raw) return null;
    const d = raw?.toDate ? raw.toDate() : (raw instanceof Date ? raw : new Date(raw));
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    return d.getTime();
  }, [voting]);

  // Per-voting dismiss key. Snoozes until closeAt so parents who hide
  // it don't have to see it again for a ballot they already skipped.
  // Falls back to the hook's default 7-day snooze when closeAt isn't
  // set (some legacy votings never stamped one).
  const dismissKey = voting ? `potmVote:${voting.id}` : null;
  const { dismissed, dismiss } = useDismissible(dismissKey, {
    snoozeUntilEventDate: closeAtMs ? new Date(closeAtMs) : null,
  });

  // Hooks are all above — safe to short-circuit render below.
  if (!voting) return null;
  if (!isCoach && !isEligibleParent) return null;
  if (dismissed) return null;

  const votes = Array.isArray(voting.votes) ? voting.votes : [];
  const myVote = currentUserId ? votes.find(v => v.voterId === currentUserId) : null;
  const voteCount = votes.length;
  const gameTitle = voting.gameTitle || 'Latest match';

  const primaryHref = `/player-of-match?voting=${encodeURIComponent(voting.id)}`;
  const primaryLabel = isCoach ? 'Manage vote' : (myVote ? 'Change vote' : 'Vote now');

  return (
    <article className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-amber-400/25 shadow-sm">
      {/* Subtle amber accent so it reads as the "crown family" but
          doesn't upstage the winner card that lands on the wall
          after voting closes. */}
      <div className="absolute -top-12 -right-10 w-40 h-40 rounded-full bg-amber-300/10 blur-3xl pointer-events-none" aria-hidden />

      <div className="relative p-4 sm:p-5 flex items-start gap-3">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-amber-400/90 text-amber-950 shrink-0">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-amber-500">
            {potmLabel}
          </p>
          <h3 className="text-base sm:text-lg font-bold text-ink-primary leading-tight truncate">
            {gameTitle}
          </h3>
          <p className="text-sm text-ink-primary/65 mt-1">
            {isCoach
              ? (myVote
                  ? 'Ballot is open. Manage the vote or update your pick.'
                  : 'Ballot is open. Cast your pick before you close it.')
              : (myVote
                  ? `Your vote is in for ${myVote.playerName || 'your pick'}. Change it any time before it closes.`
                  : 'Pick the player who lifted the team.')}
          </p>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <Link
              to={primaryHref}
              className="inline-flex items-center justify-center px-4 py-2 rounded-full bg-amber-400 text-amber-950 text-[13px] font-black tracking-wider uppercase shadow-sm hover:bg-amber-300 transition"
            >
              {primaryLabel}
            </Link>
            <span className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/45">
              {voteCount} vote{voteCount === 1 ? '' : 's'} in
            </span>
            <button
              type="button"
              onClick={dismiss}
              className="ml-auto text-[11px] font-bold uppercase tracking-widest text-ink-primary/45 hover:text-ink-primary/70"
            >
              Hide
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};

export default DashboardPotmVotingCard;
