import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where, limit } from 'firebase/firestore';
import { db } from '../utils/firebase';
import type { Player, PlayerMedia, PlayerStats } from '../types';
import { getShareOrigin } from '../utils/origin';
import { getPlayerPositionsLabel } from '../utils/helpers';
import { getPlayerLifetimeStats } from '../utils/seasons';
import { streamIframeUrl } from '../utils/streamUpload';

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
  stats?: PlayerStats;
}

// Subset of PlayerMedia we render on the public card. Strip ALL
// identifying fields (uploadedBy/uploadedByName, taggedPlayerIds,
// etc.) so the public view never leaks who tagged what.
interface PublicHighlight {
  id: string;
  url: string;
  source?: string;
  embedUrl?: string;
  streamUid?: string;
  thumbnailUrl?: string;
  posterTimeSeconds?: number;
  type: 'photo' | 'video';
  caption?: string;
}

const PublicPlayerCard: React.FC = () => {
  const { playerId } = useParams<{ playerId: string }>();
  const [player, setPlayer] = useState<PublicPlayer | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [potmCount, setPotmCount] = useState<number>(0);
  const [highlights, setHighlights] = useState<PublicHighlight[]>([]);
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

        // Lifetime stats summary — sums every season bucket on the
        // player doc, so even archived seasons count toward the
        // public "this is what this kid has done" picture.
        const stats = getPlayerLifetimeStats(data as any);

        setPlayer({
          id: snap.id,
          name: data.name,
          jerseyNumber: data.jerseyNumber ?? null,
          positions: data.positions,
          position: data.position,
          profilePhotoUrl: data.profilePhotoUrl || null,
          teamId: data.teamId,
          stats,
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

        // Highlights — pull player_media tagged to this player. Cap
        // at 6 so the public card stays loadable even for kids with
        // dozens of clips. Sanitize each row down to the rendering
        // fields only (no uploadedBy, no tags, no fileName) so the
        // public view never leaks who uploaded what.
        try {
          const mediaSnap = await getDocs(query(
            collection(db, 'player_media'),
            where('playerId', '==', snap.id),
            limit(20),
          ));
          const rows: PublicHighlight[] = mediaSnap.docs
            .map((d) => ({ id: d.id, ...(d.data() as PlayerMedia) }))
            .filter((m) => m.type === 'video' || m.type === 'photo')
            // Keep only items that have a renderable source. Stream
            // uploads need streamReady so we don't show a half-
            // transcoded placeholder.
            .filter((m) => (m.streamUid && m.streamReady !== false) || m.embedUrl || m.url)
            .slice(0, 6)
            .map((m) => ({
              id: m.id,
              url: m.url,
              source: m.source,
              embedUrl: m.embedUrl,
              streamUid: m.streamUid,
              thumbnailUrl: m.thumbnailUrl,
              posterTimeSeconds: m.posterTimeSeconds,
              type: m.type,
              caption: m.caption,
            }));
          setHighlights(rows);
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
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary/30 border-t-brand-primary" />
      </div>
    );
  }
  if (error || !player) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base flex items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-xl font-black text-ink-primary mb-1">{error || 'Card unavailable'}</h1>
          <p className="text-sm text-ink-primary/55">The link may have expired or sharing may have been turned off.</p>
          <Link to="/" className="inline-block mt-6 px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-extrabold tracking-widest uppercase">Open GoalKickr</Link>
        </div>
      </div>
    );
  }

  const positionLabel = getPlayerPositionsLabel(player) || (player as any).position || '';
  const initial = (player.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base text-ink-primary">
      {/* Brand chrome — small kicker on dark band so the page reads
          as a real branded share, not a leak of the app shell. */}
      <header className="bg-surface-base/70 border-b border-line-default/5 px-4 sm:px-6 py-3 text-center">
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
              <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-surface-elevated ring-4 ring-brand-primary-soft/60 shadow-2xl flex items-center justify-center">
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
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/80 bg-line-default/5 ring-1 ring-line-default/10 px-2 py-1 rounded">{teamName}</span>
            )}
          </div>
          <p className="mt-6 text-[11px] font-extrabold tracking-[0.3em] text-brand-primary-soft/70 uppercase">Every Player Deserves a Shot</p>
        </div>
      </section>

      {/* Stats strip — lifetime totals from the player doc. Hidden
          when every value is zero (a kid with no recorded stats
          shouldn't get an empty card; better to skip the section
          entirely). */}
      {player.stats && (player.stats.gamesPlayed > 0 || player.stats.goals > 0 || player.stats.assists > 0 || player.stats.minutesPlayed > 0) && (
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pb-6">
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-2">Career stats</p>
          <div className="grid grid-cols-4 gap-2">
            <StatTile label="Games" value={player.stats.gamesPlayed} />
            <StatTile label="Goals" value={player.stats.goals} />
            <StatTile label="Assists" value={player.stats.assists} />
            <StatTile label="Minutes" value={player.stats.minutesPlayed} />
          </div>
        </section>
      )}

      {/* Player of the Match award count — single-stat hero block
          since this is the headline brag. Hidden when zero. */}
      {potmCount > 0 && (
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pb-6">
          <div className="bg-gradient-to-br from-amber-500/20 to-surface-elevated border border-amber-400/30 rounded-2xl p-5 text-center">
            <p className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300 mb-1">Player of the Match</p>
            <p className="text-4xl font-black tabular-nums text-ink-primary">{potmCount}</p>
            <p className="text-ink-primary/55 text-xs mt-1">{potmCount === 1 ? 'time' : 'times'}</p>
          </div>
        </section>
      )}

      {/* Highlights — up to 6 photos / video clips. Stream uses an
          iframe embed (adaptive HLS), YouTube uses its embed,
          everything else falls back to a thumbnail link out to the
          source URL so the recruiter can still see SOMETHING. */}
      {highlights.length > 0 && (
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pb-10">
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-2">Highlights</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {highlights.map((h) => (
              <HighlightTile key={h.id} h={h} />
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-line-default/5 px-4 sm:px-6 py-6 text-center">
        <p className="text-ink-primary/45 text-xs">Shared from GoalKickr</p>
        <Link to="/" className="inline-block mt-3 text-brand-primary text-xs font-extrabold tracking-widest uppercase hover:text-brand-primary-soft">Open the app</Link>
      </footer>
    </div>
  );
};

// Small numeric tile for the career-stats row. Uses tabular-nums
// so the four columns align even when values are different widths.
const StatTile: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-surface-elevated border border-line-default/10 rounded-xl px-3 py-3 text-center">
    <p className="text-2xl font-black tabular-nums text-ink-primary leading-none">{value}</p>
    <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mt-1.5">{label}</p>
  </div>
);

// One highlight clip / photo. Stream → iframe embed, YouTube →
// iframe embed, photos → img, anything else → thumbnail link out
// to the source. Caption (if set) shown underneath in small text.
const HighlightTile: React.FC<{ h: PublicHighlight }> = ({ h }) => {
  const renderMedia = () => {
    if (h.type === 'photo') {
      return (
        <img
          src={h.url}
          alt={h.caption || ''}
          loading="lazy"
          className="w-full aspect-video object-cover bg-surface-base"
        />
      );
    }
    if (h.streamUid) {
      return (
        <div className="aspect-video bg-surface-base">
          <iframe
            src={streamIframeUrl(h.streamUid)}
            allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
            allowFullScreen
            title={h.caption || 'Highlight'}
            className="w-full h-full"
            loading="lazy"
          />
        </div>
      );
    }
    if (h.source === 'youtube' && h.embedUrl) {
      return (
        <div className="aspect-video bg-surface-base">
          <iframe
            src={h.embedUrl}
            allow="accelerometer; encrypted-media; picture-in-picture"
            allowFullScreen
            title={h.caption || 'Highlight'}
            className="w-full h-full"
            loading="lazy"
          />
        </div>
      );
    }
    // Generic fallback — link the recruiter out so they at least
    // see SOMETHING rather than a broken tile.
    return (
      <a href={h.url} target="_blank" rel="noopener noreferrer" className="block">
        {h.thumbnailUrl ? (
          <img src={h.thumbnailUrl} alt={h.caption || 'Highlight'} loading="lazy" className="w-full aspect-video object-cover bg-surface-base" />
        ) : (
          <div className="aspect-video bg-surface-base flex items-center justify-center text-ink-primary/55 text-xs font-bold">Open clip</div>
        )}
      </a>
    );
  };

  return (
    <div className="rounded-xl overflow-hidden bg-surface-elevated border border-line-default/10">
      {renderMedia()}
      {h.caption && (
        <p className="px-3 py-2 text-xs text-ink-primary/75 line-clamp-2">{h.caption}</p>
      )}
    </div>
  );
};

export default PublicPlayerCard;

/** URL to share the public card. The parent must have flipped
 *  publicShare.enabled = true on the player doc first. */
export const publicPlayerCardUrl = (playerId: string) => `${getShareOrigin()}/p/${playerId}`;
