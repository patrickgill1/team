// Sideline Shouts — unified positive-moments wall for a player.
// See project_sideline_shouts memory for the naming + intent.
//
// Aggregates from six sources into one normalized stream:
//   1. Kudos (from /kudos — Circle members' notes)
//   2. Whispers (from /parent_whispers — coach's private notes)
//   3. XP notes (from /player_xp_events where source is coach* AND note is set)
//   4. Badges earned (from player.badges map — most-recent first)
//   5. POTM vote reasons (from the parent-loaded allPlayerVotings)
//   6. Level-ups (deferred to Ship 2b — needs per-crossing history to render right)
//
// All sources are already readable by Circle members via the whispers
// rule; no rule change needed.

import type { Player, PlayerXpEvent } from '../types';
import { badgeLabel, badgeImageSrc } from './badgeMeta';

export type SidelineShoutType =
  | 'kudos'
  | 'whisper'
  | 'xp_note'
  | 'badge'
  | 'potm_comment';

export interface SidelineShout {
  id: string; // stable per-item key for React
  type: SidelineShoutType;
  timestamp: Date;
  // "Who is speaking" — sender/coach/voter/system
  fromName: string;
  fromAvatarUrl?: string | null;
  // The main body of the shout
  body: string;
  // Optional per-type extras
  xpAmount?: number;
  badgeSlug?: string;
  badgeImage?: string;
}

// Coach-authored XP sources whose `note` we want to surface as shouts.
// Kudos already appears in its own stream — kudos_coach_convert is
// intentionally EXCLUDED here to avoid double-counting (the source
// kudos is already surfaced as type='kudos' with the sender name).
const XP_NOTE_SOURCES: Array<PlayerXpEvent['source']> = ['coach_live', 'coach_whisper'];

interface Args {
  player: Player;
  kudosList: Array<{ id: string; senderName: string; senderAvatarUrl?: string | null; note: string; createdAt: Date; xpAwarded?: number }>;
  whispers: Array<{ id: string; coachName: string; coachAvatarUrl?: string | null; message: string; createdAt: Date }>;
  xpEvents: Array<{ id: string; awardedByName?: string | null; awardedBy?: string; source: string; note?: string | null; xp: number; createdAt: Date }>;
  potmVotes: Array<{ voting: any; playerVotes: Array<{ voterName: string; reason?: string }> }>;
  /** When set, badges are filtered to only those earned inside this
   *  season (via `badges[slug].seasonId === activeSeasonId`). Legacy
   *  badges with no seasonId are dropped in season mode; they still
   *  show in career mode (activeSeasonId undefined). */
  activeSeasonId?: string;
}

/** Normalize every source into a flat SidelineShout list, sorted
 *  reverse-chronological. Client-side merge is fine at typical
 *  volumes (dozens of shouts per player per season). */
export function buildSidelineShouts(args: Args): SidelineShout[] {
  const shouts: SidelineShout[] = [];

  // Kudos
  for (const k of args.kudosList) {
    shouts.push({
      id: `kudos-${k.id}`,
      type: 'kudos',
      timestamp: k.createdAt,
      fromName: k.senderName || 'A Circle member',
      fromAvatarUrl: k.senderAvatarUrl || null,
      body: k.note,
      xpAmount: k.xpAwarded,
    });
  }

  // Whispers
  for (const w of args.whispers) {
    shouts.push({
      id: `whisper-${w.id}`,
      type: 'whisper',
      timestamp: w.createdAt,
      fromName: w.coachName || 'Coach',
      fromAvatarUrl: w.coachAvatarUrl || null,
      body: w.message,
    });
  }

  // XP notes (coach live grants + coach whisper XP if it has a note)
  for (const ev of args.xpEvents) {
    if (!ev.note) continue;
    if (!XP_NOTE_SOURCES.includes(ev.source as any)) continue;
    shouts.push({
      id: `xp-${ev.id}`,
      type: 'xp_note',
      timestamp: ev.createdAt,
      fromName: ev.awardedByName || 'Coach',
      body: ev.note,
      xpAmount: ev.xp,
    });
  }

  // Badges earned — walk player.badges. Each entry is
  // `{ earnedAt, seasonId?, context? }` keyed by slug. When
  // `activeSeasonId` is set, drop badges whose seasonId is present
  // AND doesn't match. Legacy badges written before the seasonId
  // field existed (or badges written by call sites that skipped
  // `seasonId` in makeBadge) fall through the grace clause so they
  // still surface in Season mode — matches the truthy-guard pattern
  // used everywhere else in RecognitionCenter (kudos/whispers/xp).
  const badges: Record<string, any> = ((args.player as any)?.badges) || {};
  for (const slug of Object.keys(badges)) {
    const b = badges[slug];
    if (args.activeSeasonId && b?.seasonId && b.seasonId !== args.activeSeasonId) continue;
    const at = b?.earnedAt?.toDate?.() || (b?.earnedAt instanceof Date ? b.earnedAt : null);
    if (!at) continue;
    shouts.push({
      id: `badge-${slug}`,
      type: 'badge',
      timestamp: at,
      fromName: badgeLabel(slug),
      body: b?.context ? `Earned in ${b.context}` : 'Earned',
      badgeSlug: slug,
      badgeImage: badgeImageSrc(slug, 64),
    });
  }

  // POTM vote comments — one shout per (voter, playerVote) pair when
  // the voter left a reason.
  //
  // Intentional per Patrick's 2026-07-17 parent-privacy decision: the
  // aggregation iterates EVERY playerVote's reason regardless of who
  // won or where the ballot ended up. Coaches lost the per-player
  // vote counts + bar chart from the public POTM page for parents,
  // but every warm reason a voter typed still lands on the honored
  // kid's shout feed — a "you played hard tonight" is emotional
  // payload, not scoreboard leakage. Do not narrow this loop to
  // winners-only.
  for (const pv of args.potmVotes) {
    const v: any = pv.voting;
    const votingId = String(v?.id || '');
    const closedAt: Date = v?.closedAt?.toDate?.() || (v?.closedAt instanceof Date ? v.closedAt : (v?.createdAt?.toDate?.() || new Date()));
    for (const pvote of pv.playerVotes) {
      const reason = (pvote.reason || '').trim();
      if (!reason) continue;
      shouts.push({
        id: `potm-${votingId}-${pvote.voterName}-${reason.slice(0, 24)}`.replace(/\s+/g, '_'),
        type: 'potm_comment',
        timestamp: closedAt,
        fromName: pvote.voterName || 'A voter',
        body: reason,
      });
    }
  }

  shouts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return shouts;
}

/** Human-readable label per type — matches the visual chips on
 *  the shout cards. Copy per feedback_copy_voice: warm, short. */
export const SHOUT_TYPE_LABEL: Record<SidelineShoutType, string> = {
  kudos: 'Kudos',
  whisper: 'Coach whisper',
  xp_note: 'From coach',
  badge: 'Badge earned',
  potm_comment: 'Player of the Match',
};

/** Border-left / accent color per type. Kudos + Whispers stay brand
 *  crimson (they're the two "letter" formats). XP notes get an amber
 *  accent (celebration). Badges get amber. POTM gets amber. */
export function shoutAccentClass(type: SidelineShoutType): string {
  switch (type) {
    case 'kudos':
    case 'whisper':
      return 'border-brand-primary/60';
    case 'xp_note':
    case 'badge':
    case 'potm_comment':
      return 'border-amber-500/70';
    default:
      return 'border-line-default/30';
  }
}
