import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where, limit } from 'firebase/firestore';
import { db } from '../utils/firebase';
import type { Player } from '../types';
import { getShareOrigin } from '../utils/origin';
import { getPlayerPositionsLabel } from '../utils/helpers';

// Public-facing player card. Gated by player.publicShare.enabled
// on the Firestore rule side AND a defensive check here. Anyone
// with the URL can open this page — no auth required, no PII shown.
//
// Visible: photo, name, jersey, team name, position, age band,
// season stats summary, public highlights, public awards (POTM
// count). Never visible: parent emails, phone, address, medical,
// chat, RSVPs.

interface PublicPlayer {
  id: string;
  name: string;
  jerseyNumber?: number | null;
  positions?: string[];
  position?: string;
  profilePhotoUrl?: string | null;
  teamId?: string;
}

const PublicPlayerCard: React.FC = () => {
  const { playerId } = useParams<{ playerId: string }>();
  const [player, setPlayer] = useState<PublicPlayer | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [potmCount, setPotmCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!playerId) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'players', playerId));
        if (!snap.exists()) { setError('Player card not found.'); return; }
        const data = snap.data() as Player;
        const sharing = (data as any).publicShare?.enabled === true;
        if (!sharing) { setError('This player card is private.'); return; }

        setPlayer({
          id: snap.id,
          name: data.name,
          jerseyNumber: data.jerseyNumber ?? null,
          positions: data.positions,
          position: data.position,
          profilePhotoUrl: data.profilePhotoUrl || null,
          teamId: data.teamId,
        });

        // Best-effort: resolve team name. Failures are non-fatal —
        // the card still renders without the team subtitle.
        if (data.teamId) {
          try {
            const tSnap = await getDoc(doc(db, 'teams', data.teamId));
            if (tSnap.exists()) setTeamName((tSnap.data() as any).name || null);
          } catch { /* non-fatal */ }
        }

        // Best-effort: count POTM wins as a single "awards" stat.
        // No per-vote details, just the count, so we don't leak
        // teammate identities or vote behavior.
        try {
          const votesSnap = await getDocs(query(
            collection(db, 'match_votings'),
            where('winnerPlayerId', '==', snap.id),
            limit(50),
          ));
          setPotmCount(votesSnap.size);
        } catch { /* non-fatal */ }
      } catch (err: any) {
        console.error('public player card load failed', err);
        setError(err?.message || 'Could not load the card.');
      } finally {
        setLoading(false);
      }
    })();
  }, [playerId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary/30 border-t-brand-primary" />
      </div>
    );
  }
  if (error || !player) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 flex items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-xl font-black text-bone mb-1">{error || 'Card unavailable'}</h1>
          <p className="text-sm text-bone/55">The link may have expired or sharing may have been turned off.</p>
          <Link to="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-extrabold tracking-widest uppercase">Open GoalKickr</Link>
        </div>
      </div>
    );
  }

  const positionLabel = getPlayerPositionsLabel(player) || (player as any).position || '';
  const initial = (player.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 text-bone">
      {/* Brand chrome — small kicker on dark band so the page reads
          as a real branded share, not a leak of the app shell. */}
      <header className="bg-charcoal-950/70 border-b border-white/5 px-4 sm:px-6 py-3 text-center">
        <p className="text-[10px] font-extrabold tracking-[0.3em] text-brand-primary-soft uppercase">GoalKickr · Player Card</p>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-brand-primary/10 blur-3xl" />
          <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-violet-500/10 blur-3xl" />
        </div>
        <div className="relative max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14 flex flex-col items-center text-center">
          <div className="relative">
            {player.profilePhotoUrl ? (
              <img
                src={player.profilePhotoUrl}
                alt={player.name}
                className="w-32 h-32 sm:w-40 sm:h-40 rounded-full object-cover ring-4 ring-brand-primary-soft/60 shadow-2xl shadow-brand-primary/30"
              />
            ) : (
              <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-charcoal-900 ring-4 ring-brand-primary-soft/60 shadow-2xl flex items-center justify-center">
                <span className="text-5xl font-black text-brand-primary">{initial}</span>
              </div>
            )}
            {typeof player.jerseyNumber === 'number' && (
              <span className="absolute -bottom-2 -right-2 inline-flex items-center justify-center min-w-[44px] h-10 px-3 rounded-full bg-brand-primary text-white text-sm font-black ring-4 ring-charcoal-950 shadow-xl">
                #{player.jerseyNumber}
              </span>
            )}
          </div>
          <h1 className="mt-5 text-3xl sm:text-5xl font-black tracking-tight uppercase">{player.name}</h1>
          <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
            {positionLabel && (
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 px-2 py-1 rounded">{positionLabel}</span>
            )}
            {teamName && (
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/80 bg-white/5 ring-1 ring-white/10 px-2 py-1 rounded">{teamName}</span>
            )}
          </div>
          <p className="mt-6 text-[11px] font-extrabold tracking-[0.3em] text-brand-primary-soft/70 uppercase">Every Player Deserves a Shot</p>
        </div>
      </section>

      {/* Stats strip — for now just shows POTM count if any.
          Full season stats integration is a follow-up; this baseline
          gives recruiters / family one visible signal of recognition
          without leaking per-game detail. */}
      {potmCount > 0 && (
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pb-10">
          <div className="grid grid-cols-1 gap-3">
            <div className="bg-charcoal-900 border border-white/10 rounded-2xl p-5 text-center">
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300 mb-1">Player of the Match</p>
              <p className="text-4xl font-black tabular-nums text-bone">{potmCount}</p>
              <p className="text-bone/55 text-xs mt-1">{potmCount === 1 ? 'time' : 'times'} this season</p>
            </div>
          </div>
        </section>
      )}

      <footer className="border-t border-white/5 px-4 sm:px-6 py-6 text-center">
        <p className="text-bone/45 text-xs">Shared from GoalKickr</p>
        <Link to="/" className="inline-block mt-3 text-brand-primary text-xs font-extrabold tracking-widest uppercase hover:text-brand-primary-soft">Open the app</Link>
      </footer>
    </div>
  );
};

export default PublicPlayerCard;

/** URL to share the public card. The parent must have flipped
 *  publicShare.enabled = true on the player doc first. */
export const publicPlayerCardUrl = (playerId: string) => `${getShareOrigin()}/p/${playerId}`;
