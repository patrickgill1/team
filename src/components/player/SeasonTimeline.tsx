// SeasonTimeline — chronological horizontal ribbon of every timestamped
// milestone a player earned in the active season. Merges two streams:
//
//   A) player.badges (already on the player doc) filtered to season.id
//   B) player_xp_events for this player + season, listened live via
//      onSnapshot and filtered to "timeline-worthy" sources
//
// The ribbon opens the Overview tab as the emotional hook: scroll right
// and watch the season unfold, oldest on the left. Respects the
// no-retroactive-credit rule: legacy teams that pre-date XP opt-in
// simply have no timeline, so the whole section stays hidden.

import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { debugWarn } from '../../utils/debug';
import { toMillis, shortDate } from '../../utils/timestamps';
import {
  SOURCE_LABEL,
  dotClassForSource,
  isTimelineSource,
} from '../../utils/xpSourceLabels';
import type { Player, Season, PlayerXpEvent } from '../../types';

interface Props {
  playerId: string;
  player: Player;
  teamId: string;
  season: Season | null;
  xpEnabled: boolean;
}

// Locked copy per product spec. Kids and parents read these labels
// literally, so any change wants a fresh review. Absent slugs fall
// back to a Title-Cased split of the slug itself.
const BADGE_LABEL: Record<string, string> = {
  first_goal: 'First goal',
  first_assist: 'First assist',
  first_save: 'First save',
  first_clean_sheet: 'Clean sheet',
  first_potm: 'First POTM',
  perfect_attendance: 'Perfect attendance',
  streak_5: '5-day streak',
  streak_10: '10-day streak',
  streak_25: '25-day streak',
  streak_50: '50-day streak',
  coach_pick: 'Coach recognition',
};

function labelForBadgeSlug(slug: string): string {
  const known = BADGE_LABEL[slug];
  if (known) return known;
  return slug
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Which badge slug supersedes which xp source when both land on the
// same calendar day. Badge wins because its `context` string ("vs
// Riverside") is richer than the xp event's `note`, and the label is
// milestone-flavored ("First goal") instead of the raw source ("Goal").
// coach_pick removed 2026-07-13: badge is now derived (crosses cumulative
// coach-XP threshold), so it may land the same day as a coach_live grant
// OR a coach_whisper. Rather than dedupe against every possible source,
// let both the badge AND the underlying grant/whisper appear — the
// badge reads as its own milestone moment, the event reads as the earn.
const BADGE_TO_XP_SOURCE: Record<string, PlayerXpEvent['source']> = {
  first_goal: 'goal',
  first_assist: 'assist',
  first_save: 'save',
  first_clean_sheet: 'clean_sheet',
  first_potm: 'potm',
  streak_5: 'streak_milestone',
  streak_10: 'streak_milestone',
  streak_25: 'streak_milestone',
  streak_50: 'streak_milestone',
};

// Round a millisecond timestamp to a local-day key so "same day" dedupe
// isn't fooled by a badge earned at 8pm and an xp event written at
// 8:00:00.123pm. Uses local zone (Mountain Time in practice) since both
// badges and xp events are stamped by the coach's device.
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

type BadgeEntry = {
  kind: 'badge';
  key: string;
  atMs: number;
  slug: string;
  label: string;
  context?: string;
};

type XpEntry = {
  kind: 'xp';
  key: string;
  atMs: number;
  source: PlayerXpEvent['source'];
  label: string;
  note?: string;
  xp: number;
};

type JoinedEntry = {
  kind: 'joined';
  key: string;
  atMs: number;
  label: string;
};

type TimelineEntry = BadgeEntry | XpEntry | JoinedEntry;

const SeasonTimeline: React.FC<Props> = ({
  playerId,
  player,
  season,
  xpEnabled,
}) => {
  const [xpRows, setXpRows] = useState<XpEntry[] | null>(null);

  // Effect always runs; it just no-ops when the section is hidden. Keeps
  // Hook order stable across renders where `season` or `xpEnabled` flip.
  useEffect(() => {
    if (!season || !xpEnabled || !playerId) {
      setXpRows([]);
      return;
    }
    setXpRows(null);
    const q = query(
      collection(db, 'player_xp_events'),
      where('playerId', '==', playerId),
      where('seasonId', '==', season.id),
      orderBy('createdAt', 'asc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: XpEntry[] = [];
        snap.forEach((docSnap) => {
          const data: any = docSnap.data();
          const source = data.source as PlayerXpEvent['source'];
          if (!isTimelineSource(source)) return;
          const atMs = toMillis(data.createdAt);
          if (!atMs) return;
          next.push({
            kind: 'xp',
            key: `xp:${docSnap.id}`,
            atMs,
            source,
            label: SOURCE_LABEL[source] || 'XP grant',
            note: typeof data.note === 'string' ? data.note.trim() || undefined : undefined,
            xp: Number(data.xp) || 0,
          });
        });
        setXpRows(next);
      },
      (err) => {
        const code = (err as any)?.code;
        if (code === 'permission-denied' || code === 'unauthenticated') {
          debugWarn('SeasonTimeline listener denied', err);
        } else {
          console.error('SeasonTimeline listener failed', err);
        }
        setXpRows([]);
      },
    );
    return () => unsub();
  }, [playerId, season, xpEnabled]);

  const badgeRows: BadgeEntry[] = useMemo(() => {
    if (!season) return [];
    const entries = Object.entries(player.badges || {});
    const rows: BadgeEntry[] = [];
    for (const [slug, b] of entries) {
      if (!b) continue;
      if (b.seasonId !== season.id) continue;
      const atMs = toMillis(b.earnedAt as any);
      if (!atMs) continue;
      rows.push({
        kind: 'badge',
        key: `badge:${slug}`,
        atMs,
        slug,
        label: labelForBadgeSlug(slug),
        context: b.context,
      });
    }
    return rows;
  }, [player.badges, season]);

  const joinedEntry: JoinedEntry | null = useMemo(() => {
    if (!season) return null;
    const raw = (player as any).joinedAt;
    const atMs = toMillis(raw);
    if (!atMs) return null;
    const startMs = toMillis(season.startDate as any);
    const endMs = toMillis(season.endDate as any);
    if (!startMs || !endMs) return null;
    if (atMs < startMs || atMs > endMs) return null;
    return {
      kind: 'joined',
      key: 'joined',
      atMs,
      label: 'Joined the Squad',
    };
  }, [player, season]);

  const merged: TimelineEntry[] = useMemo(() => {
    if (xpRows === null) return [];
    // Build a lookup of (source, dayKey) covered by badges so we can
    // drop the paired xp row. Badge wins because its label + context
    // are richer for the same event.
    const badgeCover = new Set<string>();
    for (const b of badgeRows) {
      const pairedSource = BADGE_TO_XP_SOURCE[b.slug];
      if (!pairedSource) continue;
      badgeCover.add(`${pairedSource}:${dayKey(b.atMs)}`);
    }
    const filteredXp = xpRows.filter(
      (x) => !badgeCover.has(`${x.source}:${dayKey(x.atMs)}`),
    );
    const combined: TimelineEntry[] = [
      ...badgeRows,
      ...filteredXp,
    ];
    combined.sort((a, b) => a.atMs - b.atMs);
    if (joinedEntry) return [joinedEntry, ...combined];
    return combined;
  }, [xpRows, badgeRows, joinedEntry]);

  // Guardrails after all hooks: hide if the feature isn't on for this
  // team, if there's no active season yet, or during the initial
  // snapshot load (atomic render — never a skeleton).
  if (!season || !xpEnabled) return null;
  if (xpRows === null) return null;
  if (merged.length === 0) return null;

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/20 shadow-lg animate-in fade-in duration-300">
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[10px] font-black tracking-[0.3em] uppercase text-ink-primary/60">
            SEASON TIMELINE
          </h3>
          <span className="text-[11px] font-semibold text-ink-primary/60 truncate">
            {season.name}
          </span>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 px-4 -mx-1">
        {merged.map((entry) => {
          const dotClass =
            entry.kind === 'xp'
              ? dotClassForSource(entry.source)
              : entry.kind === 'badge'
              ? 'bg-amber-500'
              : 'bg-brand-primary';
          const context =
            entry.kind === 'badge'
              ? entry.context
              : entry.kind === 'xp'
              ? entry.note
              : undefined;
          return (
            <div
              key={entry.key}
              className="snap-start shrink-0 w-52 rounded-2xl bg-surface-input ring-1 ring-line-default/20 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`shrink-0 w-2 h-2 rounded-full ${dotClass}`}
                  aria-hidden
                />
                <span className="text-[11px] text-ink-primary/50 tabular-nums">
                  {shortDate(entry.atMs)}
                </span>
              </div>
              <div className="mt-2 text-sm font-black text-ink-primary">
                {entry.label}
              </div>
              {context ? (
                <div className="mt-1 text-[12px] text-ink-primary/70 line-clamp-2">
                  {context}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default SeasonTimeline;
