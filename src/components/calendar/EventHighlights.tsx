// Per-game highlights list. Renders only for events with type='game'.
// Queries player_media where linkedGameId === event.id, groups by
// momentType, and shows a small tile grid with category chip filters.
// Tapping a clip deep-links into PlayerMediaPage's existing lightbox
// via /media?clip=<id>. Coach empty state suggests uploading from the
// Media tab (linkedGameId is picked in that flow).
//
// Kept out of EventDetail.tsx so the effect + state changes don't
// re-render the huge parent on every clip fetch.
//
// Patrick 2026-09-13: "I want to post highlights like defensive,
// offensive, shots, etc, but for a specific game."

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MomentType } from '../../types';

interface Clip {
  id: string;
  playerId?: string;
  playerName?: string;
  caption?: string;
  momentType?: MomentType;
  thumbnailUrl?: string;
  url?: string;
  source?: string;
  createdAt?: any;
  /** True when this clip is a curated team compilation reel (defense
   *  compilation, saves reel, etc) not attributed to a single player.
   *  Never affects stats — see PlayerMediaPage upload flow. */
  teamHighlight?: boolean;
}

interface Props {
  eventId: string;
  teamId: string;
  /** True when the viewer can upload/manage media on this team. Drives
   *  the empty-state CTA — parents see silence when there are no clips
   *  yet, coaches see an "Upload from this game" prompt. */
  canManageMedia: boolean;
}

const CATEGORY_ORDER: Array<{ key: MomentType | 'all'; label: string }> = [
  { key: 'all',     label: 'All' },
  { key: 'goal',    label: 'Goals' },
  { key: 'assist',  label: 'Assists' },
  { key: 'save',    label: 'Saves' },
  { key: 'defense', label: 'Defense' },
  { key: 'shot',    label: 'Shots' },
  { key: 'skill',   label: 'Skill' },
];

function shortLabel(k?: MomentType): string {
  switch (k) {
    case 'goal':     return 'Goal';
    case 'assist':   return 'Assist';
    case 'save':     return 'Save';
    case 'defense':  return 'Defense';
    case 'shot':     return 'Shot';
    case 'skill':    return 'Skill';
    case 'big_play': return 'Big play';
    default:         return 'Clip';
  }
}

const EventHighlights: React.FC<Props> = ({ eventId, teamId, canManageMedia }) => {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [selected, setSelected] = useState<MomentType | 'all'>('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../../utils/firebase');
        // Field name on the media doc is gameId (not linkedGameId —
        // that was my typo shipping 3.9.499). The stats collection
        // uses gameId too; keeping the names aligned makes the
        // "clips linked to this game" join implicit.
        const snap = await getDocs(query(
          collection(db, 'player_media'),
          where('teamId', '==', teamId),
          where('gameId', '==', eventId),
        ));
        if (cancelled) return;
        const list = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Clip[];
        // Newest first — createdAt is a Firestore Timestamp; toMillis
        // where present, fallback 0 so unstamped rows sink to bottom.
        list.sort((a, b) => {
          const am = (a.createdAt as any)?.toMillis?.() ?? 0;
          const bm = (b.createdAt as any)?.toMillis?.() ?? 0;
          return bm - am;
        });
        setClips(list);
      } catch (err) {
        console.warn('[event-highlights] load failed', err);
        if (!cancelled) setClips([]);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, teamId]);

  // Available categories = the ones with at least one clip. Keeps the
  // chip row honest (no "Saves (0)" chip). "All" always shows.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    (clips || []).forEach(clip => {
      c.all++;
      const k = clip.momentType || 'other';
      c[k] = (c[k] || 0) + 1;
    });
    return c;
  }, [clips]);

  const filtered = useMemo(() => {
    if (!clips) return [];
    if (selected === 'all') return clips;
    return clips.filter(c => c.momentType === selected);
  }, [clips, selected]);

  if (clips === null) {
    // Silent while the fetch is in flight — atomic-render pattern.
    return null;
  }

  if (clips.length === 0) {
    // Coach empty state: prompt to upload. Parent view: silent (no
    // "Nothing yet" copy — matches the wall/carpool empty behavior).
    if (!canManageMedia) return null;
    return (
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
        <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 mb-2 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M12 3l2.6 5.3 5.9.9-4.3 4.2 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.2 5.9-.9z" />
          </svg>
          Highlights
        </div>
        <p className="text-sm text-ink-primary/60 leading-snug mb-3">
          No clips linked to this game yet. Upload a moment from the Media tab and pick this game.
        </p>
        <Link
          to="/media"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-primary text-white text-xs font-bold hover:brightness-110 transition"
        >
          Open Media
        </Link>
      </section>
    );
  }

  return (
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M12 3l2.6 5.3 5.9.9-4.3 4.2 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.2 5.9-.9z" />
          </svg>
          Highlights
          <span className="text-[11px] text-ink-primary/45 font-bold ml-1">({clips.length})</span>
        </div>
      </div>

      {/* Category chips — only categories with clips get a chip, plus
          the always-present "All". Wraps rather than horizontal scroll
          per feedback_no_horizontal_pills. */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {CATEGORY_ORDER.filter(c => c.key === 'all' || (counts[c.key] || 0) > 0).map(c => {
          const active = selected === c.key;
          const count = counts[c.key] || 0;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setSelected(c.key)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-bold ring-1 transition ${
                active
                  ? 'bg-brand-primary text-white ring-brand-primary'
                  : 'bg-transparent text-ink-primary/75 ring-line-default/25 hover:bg-line-default/[0.06]'
              }`}
            >
              {c.label} <span className={active ? 'opacity-75' : 'opacity-55'}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Tile grid — 3-up on phone, 4-up on desktop. Cap at 12 with
          "See all" link so the section stays scannable on a long-game
          page with many clips. */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {filtered.slice(0, 12).map(clip => {
          const thumb = clip.thumbnailUrl || (clip.source === 'youtube' && (clip as any).youtubeId
            ? `https://i.ytimg.com/vi/${(clip as any).youtubeId}/hqdefault.jpg`
            : '');
          return (
            <Link
              key={clip.id}
              to={`/media?clip=${clip.id}`}
              className="group relative aspect-video rounded-lg overflow-hidden bg-surface-input ring-1 ring-line-default/15 hover:ring-brand-primary/40 transition"
            >
              {thumb ? (
                <img
                  src={thumb}
                  alt={clip.caption || clip.playerName || 'Highlight'}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-ink-primary/40">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                </div>
              )}
              {/* Play glyph */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-8 h-8 rounded-full bg-black/55 backdrop-blur-sm ring-1 ring-white/20 flex items-center justify-center group-hover:scale-105 transition theme-ok">
                  <svg className="w-3.5 h-3.5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                </div>
              </div>
              {/* Category chip bottom-left */}
              {clip.momentType && (
                <span className="absolute left-1 bottom-1 px-1.5 py-0.5 rounded-md bg-black/65 text-white text-[9px] font-black uppercase tracking-wide ring-1 ring-white/15 theme-ok">
                  {shortLabel(clip.momentType)}
                </span>
              )}
              {/* Team-highlight badge top-left — marks curated reels
                  (defense compilation, saves montage, etc) so parents
                  distinguish them from individual player clips at a
                  glance. Overlays the thumbnail bottom-right corner. */}
              {clip.teamHighlight && (
                <span className="absolute right-1 bottom-1 px-1.5 py-0.5 rounded-md bg-brand-primary text-white text-[9px] font-black uppercase tracking-wide ring-1 ring-white/25">
                  Team
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {filtered.length > 12 && (
        <div className="mt-3 text-right">
          <Link to="/media" className="text-[11px] font-bold text-brand-primary hover:underline">
            See all {filtered.length}
          </Link>
        </div>
      )}
    </section>
  );
};

export default EventHighlights;
