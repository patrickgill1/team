// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, getDoc, onSnapshot, setDoc, updateDoc, serverTimestamp, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam, isOwner, resolveSenderRole } from '../utils/helpers';
import GameRecapCard from '../components/gameday/GameRecapCard';
import PlayerRatingSheet from '../components/gameday/PlayerRatingSheet';
import FormationView from '../components/gameday/FormationView';
import { useTeamAudience } from '../hooks/useTeamAudience';
import {
  addWatchGameActionListener,
  clearWatchGameSession,
  drainWatchGameActions,
  publishWatchGameSession,
  WatchGameAction,
} from '../utils/watchGameBridge';

type StatKind = 'goal' | 'owngoal' | 'assist' | 'save' | 'yellow' | 'red' | 'sub' | 'note';

interface TimelineEntry {
  id: string;
  at: number;          // unix ms
  minute: number;      // game clock minute
  kind: StatKind;
  playerId?: string;
  playerName?: string;
  jerseyNumber?: number;
  note?: string;
  recordedBy?: string;
  recordedByName?: string;
  // Stat-dedup glue: 'live' (default) when a coach tapped it, 'clip' when a
  // parent's video upload created the entry. clipUrl/clipMediaId may also be
  // present on a 'live' entry once a matching clip is uploaded and attached.
  source?: 'live' | 'clip';
  clipUrl?: string;
  clipMediaId?: string;
}

interface LiveGameDoc {
  eventId: string;
  teamId: string;
  opponent: string;
  homeAway?: 'home' | 'away';
  /** Match format: 7v7 / 9v9 / 11v11. Drives formation field sizing
   *  + default position templates. Defaults to the team's format,
   *  fallback '7v7'. */
  format?: '7v7' | '9v9' | '11v11';
  ourScore: number;
  oppScore: number;
  status: 'scheduled' | 'live' | 'halftime' | 'final';
  clockSecondsAtStart?: number; // Date.now() when current period started
  clockOffsetSeconds?: number;  // accumulated seconds from previous periods
  period?: 1 | 2 | 'OT';
  timeline: TimelineEntry[];
  lineup?: LineupState;
  updatedAt?: any;
  startedBy?: string;
  startedByName?: string;
  /** When explicitly false, the game does not roll up into player
   *  season totals (players.stats.goals/assists/etc.) or write a
   *  game_stats row on Final. Timeline entries are still recorded so
   *  the coach can browse who did what during a scrimmage or a test
   *  game, but nothing sticks to the player card.
   *
   *  Undefined = counts (opt-out model). Demo teams (team.isDemo)
   *  force this to false regardless of the toggle.
   */
  countsToStats?: boolean;
}

interface OnFieldSlot {
  playerId: string;
  enteredAtSec: number; // game-clock seconds when this player came on
  /** Position on the formation field as % of width/height. Optional —
   *  falls back to the format's default template when unset. */
  x?: number;
  y?: number;
}

interface LineupState {
  onField: OnFieldSlot[];
  benchIds: string[];
  minutes: Record<string, number>; // accumulated seconds (does NOT include current shift)
  shiftSeconds: number;            // rotation bell interval
  lastBellAtSec?: number;          // game-clock seconds when bell last rang
  bellEnabled?: boolean;
}

const KIND_META: Record<StatKind, { label: string; emoji: string; color: string }> = {
  goal:    { label: 'Goal',     emoji: '⚽', color: 'bg-emerald-500' },
  owngoal: { label: 'Own Goal', emoji: '🥅', color: 'bg-rose-500' },
  assist:  { label: 'Assist',   emoji: '🅰️', color: 'bg-brand-primary' },
  save:    { label: 'Save',     emoji: '🧘', color: 'bg-brand-primary' },
  yellow:  { label: 'Yellow',   emoji: '🟨', color: 'bg-yellow-500' },
  red:     { label: 'Red',      emoji: '🟥', color: 'bg-red-600' },
  sub:     { label: 'Sub',      emoji: '🔄', color: 'bg-purple-500' },
  note:    { label: 'Note',     emoji: '📝', color: 'bg-gray-500' },
};

// Tap-to-record action icons. Monoline SVGs — replaces the
// previous emoji blocks (Patrick: "the game day looks very
// fisher price"). Uniform stroke weight, bone color, semantic
// accent only for the cards (yellow stroke on Yellow, red on
// Red). Wall/timeline shares KIND_META's emoji field for
// share-text consumption; this icon map is dashboard-only.
const TAP_ICONS: Record<StatKind, React.ReactNode> = {
  goal: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v6m0 6v6M3 12h6m6 0h6" />
      <path d="m7 7 4 3-1 5-5-2zM17 7l-4 3 1 5 5-2z" />
    </svg>
  ),
  owngoal: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="3" y="6" width="18" height="12" rx="1" />
      <path d="M7 6v12M11 6v12M15 6v12M19 6v12" />
      <path d="m4 20 16-12" />
    </svg>
  ),
  assist: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M5 19 12 5l7 14" />
      <path d="M8 14h8" />
    </svg>
  ),
  save: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M6 11V8a2 2 0 0 1 4 0v3M10 11V6a2 2 0 0 1 4 0v5M14 11V7a2 2 0 0 1 4 0v8a6 6 0 0 1-6 6h-2a4 4 0 0 1-4-4v-1l-2-3a1.5 1.5 0 0 1 2-2l2 2" />
    </svg>
  ),
  yellow: (
    <svg className="w-6 h-6 text-amber-400" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="7" y="3" width="11" height="16" rx="1.5" fillOpacity="0.85" />
    </svg>
  ),
  red: (
    <svg className="w-6 h-6 text-rose-500" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="7" y="3" width="11" height="16" rx="1.5" fillOpacity="0.85" />
    </svg>
  ),
  sub: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M4 9h13l-3-3M20 15H7l3 3" />
    </svg>
  ),
  note: (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9" />
      <path d="M18 3l3 3-9 9-3 1 1-3z" />
    </svg>
  ),
};

const formatClock = (totalSec: number) => {
  const m = Math.max(0, Math.floor(totalSec / 60));
  const s = Math.max(0, totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const GameDay: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  // Adult teams get the post-match rating flow attached to Recap.
  // Youth teams don't — coach-to-parent whispers are that audience's
  // equivalent private-feedback surface.
  const { isAdult: isAdultTeam } = useTeamAudience(selectedTeam);
  const [showRatings, setShowRatings] = useState(false);
  // Short team name used in push-notification bodies ("Eagles 2-1
  // Lightning"). Falls back to "Us" when the team doc hasn't loaded
  // yet so we never ship a wrong club's name in a push.
  const usLabel = selectedTeam?.name || 'Us';
  const { getDocument, getPlayersByTeam, addGameStat, updatePlayerStats, addChatMessage, getDocuments } = useFirestore();
  const isQuickGame = !!eventId && eventId.startsWith('quick_');
  const [event, setEvent] = useState<any | null>(null);
  const [game, setGame] = useState<LiveGameDoc | null>(null);
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerKind, setPickerKind] = useState<StatKind | null>(null);
  const [noteText, setNoteText] = useState('');
  const [now, setNow] = useState(Date.now());
  const handledWatchActionIds = useRef<Set<string>>(new Set());

  // Coach authority is per-team: presence in team.coachIds is the
  // source of truth (see reference_coach_role_model). Keep the
  // legacy global role check + isOwner as fallbacks so this fix
  // never TIGHTENS on any existing coach — only broadens for users
  // whose global role is club_admin / team_manager but who are
  // actually on this specific team's coach roster.
  const isUserCoach = !!(userData && (
    isCoachOfTeam(userData, selectedTeam)
    || isOwner(userData)
  ));

  // 1Hz tick for clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);


  // Load event + players, subscribe to live game
  useEffect(() => {
    if (!eventId) {
      setError('Missing event id');
      setLoading(false);
      return;
    }
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        let ev: any = null;
        if (isQuickGame) {
          // Quick game — no calendar event. Synthesize from selected team.
          if (!selectedTeamId) { setError('No team selected'); setLoading(false); return; }
          // Try to seed opponent from an existing live_games doc
          let opponent = 'Opponent';
          try {
            const existing = await getDoc(doc(db, 'live_games', eventId));
            if (existing.exists()) opponent = (existing.data() as any).opponent || opponent;
          } catch {}
          ev = {
            id: eventId,
            teamId: selectedTeamId,
            opponent,
            type: 'game',
            date: new Date(),
            title: `Quick game vs ${opponent}`,
          };
          setEvent(ev);
        } else {
          ev = await getDocument('events', eventId);
          if (!ev) { setError('Event not found'); setLoading(false); return; }
          setEvent(ev);
        }
        const teamPlayers = await getPlayersByTeam(ev.teamId);
        setPlayers(teamPlayers);
        unsub = onSnapshot(doc(db, 'live_games', eventId), snap => {
          if (snap.exists()) {
            setGame(snap.data() as LiveGameDoc);
          } else {
            setGame(null);
          }
          setLoading(false);
        }, err => {
          console.error('live_games snapshot err', err);
          setLoading(false);
        });
      } catch (err) {
        console.error(err);
        setError('Failed to load game.');
        setLoading(false);
      }
    })();
    return () => { if (unsub) unsub(); };
  }, [eventId, isQuickGame, selectedTeamId, getDocument, getPlayersByTeam]);

  // Derived clock
  const liveSeconds = useMemo(() => {
    if (!game) return 0;
    const offset = game.clockOffsetSeconds || 0;
    if (game.status === 'live' && game.clockSecondsAtStart) {
      return offset + Math.floor((now - game.clockSecondsAtStart) / 1000);
    }
    return offset;
  }, [game, now]);

  const minute = Math.floor(liveSeconds / 60) + 1;

  const ensureGameDoc = async (): Promise<LiveGameDoc> => {
    if (!eventId || !event) throw new Error('No event');
    if (game) return game;
    // Use { merge: true } so repeated calls (e.g. when patch() calls
    // ensureGameDoc again before the snapshot listener has populated
    // local `game` state) don't blow away any in-progress writes.
    // Pull the team's standard format if one is set on the team doc;
    // otherwise default to 7v7 (most common in youth soccer).
    let format: '7v7' | '9v9' | '11v11' = '7v7';
    try {
      const teamDoc = await getDoc(doc(db, 'teams', event.teamId));
      const f = (teamDoc.exists() && (teamDoc.data() as any).format) || '7v7';
      if (f === '7v7' || f === '9v9' || f === '11v11') format = f;
    } catch {}
    const initial: LiveGameDoc = {
      eventId,
      teamId: event.teamId,
      opponent: event.opponent || 'Opponent',
      homeAway: event.homeAway,
      format,
      ourScore: 0,
      oppScore: 0,
      status: 'scheduled',
      clockOffsetSeconds: 0,
      period: 1,
      timeline: [],
      startedBy: userData?.uid,
      startedByName: userData?.name || userData?.email || 'Coach',
    };
    await setDoc(
      doc(db, 'live_games', eventId),
      { ...initial, updatedAt: serverTimestamp() },
      { merge: true },
    );
    return initial;
  };

  const patch = async (updates: Partial<LiveGameDoc>) => {
    if (!eventId) return;
    await ensureGameDoc();
    await updateDoc(doc(db, 'live_games', eventId), { ...updates, updatedAt: serverTimestamp() } as any);
  };

  const startClock = async () => {
    const g = await ensureGameDoc();
    await patch({
      status: 'live',
      clockSecondsAtStart: Date.now(),
      clockOffsetSeconds: g.clockOffsetSeconds || 0,
    });
  };
  const pauseClock = async () => {
    if (!game) return;
    await patch({
      status: 'halftime',
      clockOffsetSeconds: liveSeconds,
      clockSecondsAtStart: 0,
    });
    const opp = event?.opponent || 'Opponent';
    void notifyGoingParents('Halftime', `${usLabel} ${game.ourScore || 0}-${game.oppScore || 0} ${opp}`);
  };
  const finalizeGame = async () => {
    if (!game) return;
    if (game.status === 'final') {
      alert('This game is already finalized. Season stats were written when it was finalized.');
      return;
    }
    // Copy adapts to the actual outcome so the coach isn't lied to.
    // Demo team → hard-off, no toggle. Toggle off → same effect,
    // different reason.
    const teamIsDemoConfirm = (selectedTeam as any)?.isDemo === true;
    const willCount = !teamIsDemoConfirm && (game?.countsToStats !== false);
    const confirmMsg = willCount
      ? 'End the game? This will mark it Final and write per-player stats to season totals.'
      : teamIsDemoConfirm
        ? 'End the game? Demo team — nothing will be written to season totals.'
        : 'End the game? STATS OFF for this game — nothing will be written to season totals. The timeline stays viewable.';
    if (!window.confirm(confirmMsg)) return;
    await patch({
      status: 'final',
      clockOffsetSeconds: liveSeconds,
      clockSecondsAtStart: 0,
    });
    const opp = event?.opponent || 'Opponent';
    const ours = game.ourScore || 0;
    const theirs = game.oppScore || 0;
    const result = ours > theirs ? 'Win' : ours < theirs ? 'Loss' : 'Draw';
    void notifyGoingParents(`Full time — ${result}`, `${usLabel} ${ours}-${theirs} ${opp}`);
    // Culture engine: auto-write the recap to the team Wall so
    // parents who missed the game get the story without scrolling
    // chat. Fire-and-forget; a Wall post failure never blocks the
    // finalization or the stats rollup that follows.
    if (event && userData) {
      const { autoPostGameRecapToWall, autoPostGoalOfTheMatchToWall } = await import('../utils/autoPostToWall');
      const actorForWall = { uid: userData.uid, name: userData.name || 'Coach', role: userData.role || 'coach' };
      const kits = selectedTeam
        ? { homeKitColor: (selectedTeam as any).homeKitColor, awayKitColor: (selectedTeam as any).awayKitColor }
        : undefined;
      // Recap first (headline), then Goal of the Match poll (below
      // it) so parents scrolling Team Wall hit the recap card
      // before the vote CTA. Both fire-and-forget.
      void autoPostGameRecapToWall(event as any, game, actorForWall, usLabel, kits);
      void autoPostGoalOfTheMatchToWall(event as any, game, actorForWall);
    }
    // Stats gate: skip season-aggregate writes when the coach turned
    // "counts to stats" off on this specific game (scrimmage, testing)
    // OR when the team is flagged as demo. Timeline is already written
    // and stays viewable — nothing rolls up to player cards.
    const teamIsDemo = (selectedTeam as any)?.isDemo === true;
    const gameCountsToStats = game.countsToStats !== false;
    if (!gameCountsToStats || teamIsDemo) {
      console.log(`[gameday] endGame: skipping stats rollup (countsToStats=${game.countsToStats}, teamIsDemo=${teamIsDemo})`);
      return;
    }
    // Write season-aggregate stats
    try {
      const counts: Record<string, { goals: number; assists: number; saves: number; yellow: number; red: number; name: string }> = {};
      (game.timeline || []).forEach(t => {
        if (!t.playerId) return;
        const c = counts[t.playerId] || (counts[t.playerId] = { goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, name: t.playerName || '' });
        if (t.kind === 'goal') c.goals++;
        if (t.kind === 'assist') c.assists++;
        if (t.kind === 'save') c.saves++;
        if (t.kind === 'yellow') c.yellow++;
        if (t.kind === 'red') c.red++;
      });
      // Accrue remaining on-field time BEFORE reading minutes. Prior
      // shape (audit 2026-07-10) iterated only lineup.minutes, which
      // is populated on sub-off — a keeper who plays 60/60 and is
      // never subbed had no entry, so cleanSheet never fired.
      // effectiveMinutes now includes the current shift for anyone
      // still on the field at final whistle.
      const persistedMinutes: Record<string, number> = { ...(game.lineup?.minutes || {}) };
      const effectiveMinutes: Record<string, number> = { ...persistedMinutes };
      for (const slot of (game.lineup?.onField || [])) {
        if (!slot?.playerId) continue;
        const extra = Math.max(0, liveSeconds - (slot.enteredAtSec || 0));
        effectiveMinutes[slot.playerId] = (effectiveMinutes[slot.playerId] || 0) + extra;
      }
      // Persist the accrued minutes back to the game doc so read-side
      // aggregations (MinutesPlayedCard, etc.) reflect actual playing
      // time, not just tracked sub-outs. Fire-and-forget.
      try {
        await patch({ 'lineup.minutes': effectiveMinutes } as any);
      } catch (err) {
        console.warn('[gameday] persist minutes accrual failed', err);
      }

      // Clean-sheet detection: GKs who logged any minutes in a shutout
      // get +1 clean sheet. isGoalkeeper checks primary/positions list.
      const { isGoalkeeper } = await import('../utils/helpers');
      const shutout = (game.oppScore || 0) === 0;
      const cleanSheetPids = new Set<string>();
      if (shutout) {
        for (const pid of Object.keys(effectiveMinutes)) {
          const secs = Number(effectiveMinutes[pid] || 0);
          if (secs <= 0) continue;
          const player = players.find(p => p.id === pid);
          if (player && isGoalkeeper(player as any)) cleanSheetPids.add(pid);
        }
      }
      const { maybeGrantFirstStatBadges } = await import('../utils/badgeGrants');
      const { doc: fsDoc, getDoc: fsGet } = await import('firebase/firestore');
      const { db: firestoreDb } = await import('../utils/firebase');
      const allPids = new Set<string>([...Object.keys(counts), ...cleanSheetPids]);
      for (const pid of allPids) {
        const c = counts[pid] || { goals: 0, assists: 0, saves: 0, yellow: 0, red: 0, name: '' };
        const player = players.find(p => p.id === pid);
        if (!player) continue;
        // Read fresh player doc RIGHT BEFORE the stat write. Prior
        // shape used the page's mount-time snapshot for prev.stats
        // and prev.badges — if a clip-credit or StatsTracker landed
        // in the meantime, the endGame write clobbered the intermediate
        // +1 (full-field overwrite of stats:) AND re-issued a first_X
        // badge with a fresh earnedAt. Audit 2026-07-10.
        let freshStats: any = player.stats;
        let freshBadges: any = (player as any).badges;
        try {
          const snap = await fsGet(fsDoc(firestoreDb, 'players', pid));
          if (snap.exists()) {
            const data: any = snap.data();
            freshStats = data.stats || freshStats;
            freshBadges = data.badges || freshBadges;
          }
        } catch (err) {
          console.warn('[gameday] fresh player read failed', pid, err);
        }
        const prev = freshStats || { goals: 0, assists: 0, saves: 0, yellowCards: 0, redCards: 0, gamesPlayed: 0, minutesPlayed: 0, cleanSheets: 0 } as any;
        const csDelta = cleanSheetPids.has(pid) ? 1 : 0;
        const nextStats = {
          ...prev,
          goals: (prev.goals || 0) + c.goals,
          assists: (prev.assists || 0) + c.assists,
          saves: (prev.saves || 0) + c.saves,
          yellowCards: (prev.yellowCards || 0) + c.yellow,
          redCards: (prev.redCards || 0) + c.red,
          gamesPlayed: (prev.gamesPlayed || 0) + 1,
          cleanSheets: ((prev as any).cleanSheets || 0) + csDelta,
        };
        await updatePlayerStats(pid, nextStats);
        // Fire first-stat badges on the 0→N crossing. Non-fatal —
        // stat write already committed so a badge failure doesn't
        // regress the game. Uses freshBadges so a same-game clip
        // credit doesn't get its first_goal re-clobbered here.
        void maybeGrantFirstStatBadges(
          pid,
          prev,
          nextStats,
          {
            existingBadges: freshBadges,
            context: event.title || 'Match',
            seasonId: (event as any).seasonId,
            xpEnabled: (selectedTeam as any)?.xpConfig?.enabled === true,
          },
        );
        // Write a per-game stat record for anyone who registered a
        // timeline event OR earned a clean sheet. GK-only entries land
        // with 0 across offensive stats + cleanSheets=1 so team-record
        // aggregations pick them up.
        const wroteTimeline = counts[pid] != null;
        if (!wroteTimeline && csDelta === 0) continue;
        const { withSeasonId } = await import('../utils/seasons');
        const gsPayload = await withSeasonId({
          playerId: pid,
          playerName: c.name || player.name || '',
          gameId: eventId!,
          gameDate: new Date(event.date?.toDate ? event.date.toDate() : event.date),
          opponent: event.opponent || 'Opponent',
          minutesPlayed: 0,
          goals: c.goals,
          assists: c.assists,
          yellowCards: c.yellow,
          redCards: c.red,
          saves: c.saves,
          cleanSheet: csDelta > 0 ? true : undefined,
          recordedBy: userData?.uid,
          recordedByName: userData?.name || 'Coach',
          teamId: event.teamId,
        });
        await addGameStat(gsPayload as any);
      }
    } catch (err) {
      console.error('Failed to write season stats:', err);
      alert('Game ended, but season totals failed to update. Check console.');
    }
  };

  const incScore = async (side: 'our' | 'opp', delta: number) => {
    await ensureGameDoc();
    if (!game && delta < 0) return;
    const cur = game ? (side === 'our' ? game.ourScore : game.oppScore) : 0;
    const next = Math.max(0, cur + delta);
    await patch({ [side === 'our' ? 'ourScore' : 'oppScore']: next } as any);
    // Opponent goal — push to everyone who RSVPd "going". Skip the
    // "our" side because the timeline-driven goal button (which adds
    // a player) already triggers a push and bumps the score there.
    if (side === 'opp' && delta > 0) {
      const ourScore = game?.ourScore || 0;
      const opp = event?.opponent || 'Opponent';
      const min = typeof minute === 'number' ? ` (${minute}')` : '';
      void notifyGoingParents('Goal against', `${opp} scored. ${usLabel} ${ourScore}-${next}${min}`);
    }
  };

  // Push fan-out for live-game events. Recipients = parents of any
  // player whose playerRsvps status is "going" on this event. Coach
  // (sender) is filtered out so they don't get their own push.
  // pushPrefKey 'events' lets users opt out via settings if they want;
  // default is on. Best-effort — never blocks the in-game write.
  const notifyGoingParents = async (title: string, body: string) => {
    if (!event?.id) return;
    try {
      const playerR = ((event as any).playerRsvps || {}) as Record<string, any>;
      const goingPlayerIds = Object.keys(playerR).filter(pid => playerR[pid]?.status === 'going');
      if (goingPlayerIds.length === 0) return;
      const { collection: fsColl, getDocs, query, where, documentId } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      const parentUids = new Set<string>();
      // Chunk by 30 to stay under Firestore's "in" cap.
      for (let i = 0; i < goingPlayerIds.length; i += 30) {
        const slice = goingPlayerIds.slice(i, i + 30);
        const snap = await getDocs(query(
          fsColl(db, 'players'),
          where(documentId(), 'in', slice),
        ));
        snap.docs.forEach(d => {
          const p: any = d.data();
          if (Array.isArray(p.parentIds)) p.parentIds.forEach((u: string) => u && parentUids.add(u));
          if (p.parentId) parentUids.add(p.parentId);
        });
      }
      if (userData?.uid) parentUids.delete(userData.uid);
      if (parentUids.size === 0) return;
      const { sendPushToUsers } = await import('../utils/notify');
      await sendPushToUsers(Array.from(parentUids), {
        title,
        body,
        url: `/events/${event.id}`,
      }, { pushPrefKey: 'events' });
    } catch (err) {
      console.warn('gameday push failed', err);
    }
  };

  const addTimelineEntry = async (kind: StatKind, opts: { player?: any; note?: string } = {}) => {
    await ensureGameDoc();
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      minute,
      kind,
      playerId: opts.player?.id,
      playerName: opts.player?.name,
      jerseyNumber: opts.player?.jerseyNumber,
      note: opts.note,
      recordedBy: userData?.uid,
      recordedByName: userData?.name || 'Coach',
    };
    const newTimeline = [...(game?.timeline || []), entry];
    const update: Partial<LiveGameDoc> = { timeline: newTimeline };
    if (kind === 'goal' || kind === 'owngoal') {
      update.ourScore = (game?.ourScore || 0) + 1;
    }
    await patch(update);

    // Mirror the game-day event into the event's discussion thread so
    // parents reading the event page see a live game log. Best-effort
    // — silent fail if the event doc isn't around or rules block.
    if (event?.id && event?.teamId && (kind === 'goal' || kind === 'owngoal' || kind === 'assist' || kind === 'yellow' || kind === 'red' || kind === 'save' || kind === 'sub')) {
      const meta = KIND_META[kind];
      const emoji = meta?.emoji || '⚡';
      const verb =
        kind === 'goal' ? 'GOAL'
        : kind === 'owngoal' ? 'Own goal'
        : kind === 'assist' ? 'Assist'
        : kind === 'yellow' ? 'Yellow card'
        : kind === 'red' ? 'Red card'
        : kind === 'save' ? 'Save'
        : 'Substitution';
      const who = entry.playerName ? ` — ${entry.playerName}` : '';
      const min = typeof minute === 'number' ? ` (${minute}')` : '';
      try {
        const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        await addDoc(collection(db, 'eventComments'), {
          eventId: event.id,
          teamId: event.teamId,
          authorId: 'system:gameday',
          authorName: 'Live Game',
          content: `${emoji} ${verb}${who}${min}`,
          createdAt: serverTimestamp(),
        });
      } catch { /* non-fatal */ }
    }

    // Push to RSVP'd parents for the events worth notifying. Subs
    // intentionally skipped — way too noisy. Saves also skipped (most
    // parents don't track GK stats live).
    if (kind === 'goal' || kind === 'owngoal' || kind === 'yellow' || kind === 'red') {
      const ourScore = (game?.ourScore || 0) + (kind === 'goal' || kind === 'owngoal' ? 1 : 0);
      const oppScore = game?.oppScore || 0;
      const opp = event?.opponent || 'Opponent';
      const min = typeof minute === 'number' ? ` (${minute}')` : '';
      const who = entry.playerName || '';
      if (kind === 'goal') {
        void notifyGoingParents('GOAL!', `${who ? `${who} scored. ` : ''}${usLabel} ${ourScore}-${oppScore} ${opp}${min}`);
      } else if (kind === 'owngoal') {
        void notifyGoingParents('Own goal — in our favor', `${usLabel} ${ourScore}-${oppScore} ${opp}${min}`);
      } else if (kind === 'yellow') {
        void notifyGoingParents('Yellow card', `${who}${min}`);
      } else if (kind === 'red') {
        void notifyGoingParents('Red card', `${who}${min}`);
      }
    }
  };

  const removeTimelineEntry = async (id: string, confirmFirst = true) => {
    if (!game) return;
    const target = game.timeline.find(t => t.id === id);
    if (!target) return;
    if (confirmFirst && !window.confirm('Remove this entry?')) return;
    const newTimeline = game.timeline.filter(t => t.id !== id);
    const update: Partial<LiveGameDoc> = { timeline: newTimeline };
    if ((target.kind === 'goal' || target.kind === 'owngoal') && (game.ourScore || 0) > 0) {
      update.ourScore = game.ourScore - 1;
    }
    await patch(update);
  };

  // Post the recap to a dedicated team-scoped thread. Each team gets
  // one "Game recaps" channel, so final results do not bury regular
  // team conversation.
  const postRecapToChat = async (text: string) => {
    if (!userData || !event?.teamId) return;
    try {
      const RECAP_TITLE = 'Game recaps';
      const recapThreadId = `gamerecaps_${event.teamId}`;
      const recapRef = doc(db, 'chat_threads', recapThreadId);
      const canonicalSnap = await getDoc(recapRef);
      let recapThread: any = canonicalSnap.exists() ? { id: recapThreadId, ...canonicalSnap.data() } : null;

      if (!recapThread) {
        const existing: any[] = await getDocuments('chat_threads', [
          where('teamId', '==', event.teamId),
          where('title', '==', RECAP_TITLE),
        ]).catch(() => []);
        recapThread = (existing || []).find((t: any) => (t.scope || 'team') === 'team') || null;
      }

      if (!recapThread) {
        await setDoc(recapRef, {
          id: recapThreadId,
          title: RECAP_TITLE,
          description: 'Auto-posted recaps after each finalized game.',
          teamId: event.teamId,
          scope: 'team',
          isOfficialGameRecapsThread: true,
          createdBy: userData.uid,
          createdByName: userData.name,
          createdAt: serverTimestamp(),
          lastActivity: serverTimestamp(),
          isPinned: true,
          isPrivate: false,
          messageCount: 0,
          participants: [userData.uid],
          tags: ['recap'],
        } as any, { merge: true });
        recapThread = { id: recapThreadId };
      } else {
        await updateDoc(doc(db, 'chat_threads', recapThread.id), {
          scope: 'team',
          teamId: event.teamId,
          isOfficialGameRecapsThread: true,
          tags: Array.from(new Set([...(Array.isArray(recapThread.tags) ? recapThread.tags : []), 'recap'])),
        }).catch(() => null);
      }
      await addChatMessage({
        threadId: recapThread.id,
        content: text,
        senderId: userData.uid,
        senderName: userData.name,
        senderPhotoUrl: (userData as any).photoURL || undefined,
        senderRole: resolveSenderRole(userData),
        timestamp: new Date(),
        teamId: event.teamId,
      } as any);
      alert('Recap posted to chat. (Look in the "Game recaps" thread.)');
    } catch (err) {
      console.error('Post recap to chat failed:', err);
      alert('Could not post the recap. Please try again.');
    }
  };

  // ─── LINEUP / SUBS ──────────────────────────────────────────────────────
  const lineup: LineupState = game?.lineup || {
    onField: [],
    benchIds: [],
    minutes: {},
    shiftSeconds: 300,
    bellEnabled: true,
  };
  const onFieldIds = new Set(lineup.onField.map(s => s.playerId));
  const minutesFor = (pid: string): number => {
    const base = lineup.minutes?.[pid] || 0;
    const slot = lineup.onField.find(s => s.playerId === pid);
    if (!slot) return base;
    if (game?.status !== 'live') return base;
    return base + Math.max(0, liveSeconds - slot.enteredAtSec);
  };

  const persistLineup = async (next: LineupState, syncTimeline?: TimelineEntry) => {
    await ensureGameDoc();
    const update: any = { lineup: next };
    if (syncTimeline) update.timeline = [...(game?.timeline || []), syncTimeline];
    await patch(update);
  };

  const initRosterToBench = async () => {
    if (lineup.onField.length || lineup.benchIds.length) return;
    const next: LineupState = {
      ...lineup,
      benchIds: players.map(p => p.id),
    };
    await persistLineup(next);
  };

  const subOn = async (playerId: string) => {
    if (onFieldIds.has(playerId)) return;
    const next: LineupState = {
      ...lineup,
      onField: [...lineup.onField, { playerId, enteredAtSec: liveSeconds }],
      benchIds: lineup.benchIds.filter(id => id !== playerId),
    };
    const p = players.find(x => x.id === playerId);
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), minute, kind: 'sub',
      playerId, playerName: p?.name, jerseyNumber: p?.jerseyNumber,
      note: 'on',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
    };
    await persistLineup(next, entry);
  };

  const subOff = async (playerId: string) => {
    const slot = lineup.onField.find(s => s.playerId === playerId);
    if (!slot) return;
    const accrued = game?.status === 'live' ? Math.max(0, liveSeconds - slot.enteredAtSec) : 0;
    const next: LineupState = {
      ...lineup,
      onField: lineup.onField.filter(s => s.playerId !== playerId),
      benchIds: [...lineup.benchIds, playerId],
      minutes: {
        ...(lineup.minutes || {}),
        [playerId]: (lineup.minutes?.[playerId] || 0) + accrued,
      },
    };
    const p = players.find(x => x.id === playerId);
    const entry: TimelineEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), minute, kind: 'sub',
      playerId, playerName: p?.name, jerseyNumber: p?.jerseyNumber,
      note: 'off',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
    };
    await persistLineup(next, entry);
  };

  const setShiftSeconds = async (sec: number) => {
    await persistLineup({ ...lineup, shiftSeconds: sec, lastBellAtSec: liveSeconds });
  };
  const toggleBell = async () => {
    await persistLineup({ ...lineup, bellEnabled: !lineup.bellEnabled, lastBellAtSec: liveSeconds });
  };
  const acknowledgeBell = async () => {
    await persistLineup({ ...lineup, lastBellAtSec: liveSeconds });
  };

  // Watch Quick Sub: swap `inPlayerId` off the bench for the
  // longest-on-field player. Atomic — one persistLineup call — so a
  // slow network can't leave us mid-swap. Snapshots the reverse
  // state into `pendingSubUndo` so the coach has 8 seconds to undo
  // if the Watch tap was wrong (fat-fingered a neighbor in the list).
  const [pendingSubUndo, setPendingSubUndo] = useState<{
    inId: string;
    outId: string;
    inName: string;
    outName: string;
    prevLineup: LineupState;
  } | null>(null);

  useEffect(() => {
    if (!pendingSubUndo) return;
    const id = window.setTimeout(() => setPendingSubUndo(null), 8000);
    return () => window.clearTimeout(id);
  }, [pendingSubUndo]);

  const watchQuickSub = useCallback(async (inPlayerId: string) => {
    if (!lineup.benchIds.includes(inPlayerId)) return;
    // Auto-pick sub-out: the on-field player with the longest current
    // shift (highest liveSeconds - enteredAtSec). Rotates the tired
    // player off without the coach having to pick.
    const outSlot = [...lineup.onField].sort(
      (a, b) => (liveSeconds - a.enteredAtSec) - (liveSeconds - b.enteredAtSec)
    ).pop();
    if (!outSlot) return; // empty field — nothing to swap out
    const outId = outSlot.playerId;
    const accrued = game?.status === 'live' ? Math.max(0, liveSeconds - outSlot.enteredAtSec) : 0;
    const prevLineup = lineup;
    const nextLineup: LineupState = {
      ...lineup,
      onField: [
        ...lineup.onField.filter(s => s.playerId !== outId),
        { playerId: inPlayerId, enteredAtSec: liveSeconds },
      ],
      benchIds: [...lineup.benchIds.filter(id => id !== inPlayerId), outId],
      minutes: {
        ...(lineup.minutes || {}),
        [outId]: (lineup.minutes?.[outId] || 0) + accrued,
      },
      lastBellAtSec: liveSeconds, // ack the bell too — Watch tap covers both
    };
    const inP = players.find(x => x.id === inPlayerId);
    const outP = players.find(x => x.id === outId);
    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 6);
    const entryIn: TimelineEntry = {
      id: `${now}_${rand()}`,
      at: now, minute, kind: 'sub',
      playerId: inPlayerId, playerName: inP?.name, jerseyNumber: inP?.jerseyNumber,
      note: 'on',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
      source: 'live',
    };
    const entryOut: TimelineEntry = {
      id: `${now + 1}_${rand()}`,
      at: now + 1, minute, kind: 'sub',
      playerId: outId, playerName: outP?.name, jerseyNumber: outP?.jerseyNumber,
      note: 'off',
      recordedBy: userData?.uid, recordedByName: userData?.name || 'Coach',
      source: 'live',
    };
    await persistLineup(nextLineup, entryIn);
    await persistLineup(nextLineup, entryOut);
    setPendingSubUndo({
      inId: inPlayerId,
      outId,
      inName: inP?.name || 'Player',
      outName: outP?.name || 'Player',
      prevLineup,
    });
  }, [lineup, liveSeconds, game?.status, players, minute, userData?.uid, userData?.name]);

  const undoQuickSub = useCallback(async () => {
    if (!pendingSubUndo) return;
    // Reverse: restore the pre-swap lineup and pop the two sub
    // timeline entries we wrote.
    await persistLineup(pendingSubUndo.prevLineup);
    const timeline = [...(game?.timeline || [])].sort((a, b) => b.at - a.at);
    const outEntry = timeline.find(t => t.kind === 'sub' && t.playerId === pendingSubUndo.outId && t.note === 'off');
    const inEntry = timeline.find(t => t.kind === 'sub' && t.playerId === pendingSubUndo.inId && t.note === 'on');
    if (outEntry) await removeTimelineEntry(outEntry.id, false);
    if (inEntry) await removeTimelineEntry(inEntry.id, false);
    setPendingSubUndo(null);
  }, [pendingSubUndo, game?.timeline]);

  // Bell trigger
  const bellAlerted = useRef<number>(0);
  useEffect(() => {
    if (!isUserCoach) return;
    if (game?.status !== 'live') return;
    if (!lineup.bellEnabled) return;
    const since = liveSeconds - (lineup.lastBellAtSec || 0);
    if (since >= lineup.shiftSeconds && bellAlerted.current !== Math.floor(liveSeconds / lineup.shiftSeconds)) {
      bellAlerted.current = Math.floor(liveSeconds / lineup.shiftSeconds);
      try { (navigator as any).vibrate && (navigator as any).vibrate([200, 80, 200, 80, 400]); } catch {}
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🔔 Time to rotate!', { body: `Shift complete (${lineup.shiftSeconds / 60} min)`, tag: 'gameday-bell' });
        }
      } catch {}
    }
  }, [liveSeconds, lineup.shiftSeconds, lineup.lastBellAtSec, lineup.bellEnabled, game?.status, isUserCoach]);

  useEffect(() => {
    if (!isUserCoach) return;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch {}
    }
  }, [isUserCoach]);

  // Suggested next sub: bench player with fewest minutes
  const suggestedNext = useMemo(() => {
    if (lineup.benchIds.length === 0) return null;
    const sorted = [...lineup.benchIds].sort((a, b) => minutesFor(a) - minutesFor(b));
    return sorted[0];
  }, [lineup.benchIds, lineup.minutes, lineup.onField, liveSeconds]);

  const ourScore = game?.ourScore ?? 0;
  const oppScore = game?.oppScore ?? 0;
  const status = game?.status || 'scheduled';
  const sortedTimeline = useMemo(() => [...(game?.timeline || [])].sort((a, b) => b.at - a.at), [game?.timeline]);
  const suggestedNextPlayer = suggestedNext ? players.find(p => p.id === suggestedNext) : null;

  useEffect(() => {
    if (!isUserCoach || !eventId || !event || !game) return;
    publishWatchGameSession({
      eventId,
      teamId: event.teamId || game.teamId,
      homeName: usLabel,
      opponentName: event.opponent || game.opponent || 'Opponent',
      ourScore,
      oppScore,
      status,
      period: game.period || 1,
      clockOffsetSeconds: game.clockOffsetSeconds || 0,
      clockStartedAtMs: game.status === 'live' ? (game.clockSecondsAtStart || null) : null,
      shiftSeconds: lineup.shiftSeconds || null,
      lastBellAtSec: lineup.lastBellAtSec || 0,
      bellEnabled: !!lineup.bellEnabled,
      suggestedNextPlayer: suggestedNextPlayer ? {
        id: suggestedNextPlayer.id,
        name: suggestedNextPlayer.name,
        jerseyNumber: suggestedNextPlayer.jerseyNumber ?? null,
      } : null,
      // Bench snapshot for the Watch player picker. Sorted
      // fewest-minutes-first so the top of the Digital-Crown scroll
      // is always the player who most needs time — one flick usually
      // gets the coach where they want to be.
      bench: [...lineup.benchIds]
        .sort((a, b) => minutesFor(a) - minutesFor(b))
        .map(id => {
          const p = players.find(x => x.id === id);
          if (!p) return null;
          return {
            id: p.id,
            name: p.name || 'Player',
            jerseyNumber: p.jerseyNumber ?? null,
          };
        })
        .filter((x): x is { id: string; name: string; jerseyNumber: number | null } => x !== null),
      // Full roster (on-field + bench) for the Watch STAT picker.
      // Sorted by jersey number ascending so the order is predictable
      // for coaches who've memorized numbers. Coaches who don't use
      // the sub tracker can still attribute stats to any team player
      // without artificially subbing anyone in.
      roster: [...players]
        .filter(p => p && p.id)
        .sort((a, b) => {
          const an = typeof a.jerseyNumber === 'number' ? a.jerseyNumber : Number.MAX_SAFE_INTEGER;
          const bn = typeof b.jerseyNumber === 'number' ? b.jerseyNumber : Number.MAX_SAFE_INTEGER;
          if (an !== bn) return an - bn;
          return (a.name || '').localeCompare(b.name || '');
        })
        .map(p => ({
          id: p.id,
          name: p.name || 'Player',
          jerseyNumber: p.jerseyNumber ?? null,
        })),
      updatedAt: Date.now(),
    });
  }, [
    isUserCoach,
    eventId,
    event,
    game,
    usLabel,
    ourScore,
    oppScore,
    status,
    lineup.shiftSeconds,
    lineup.lastBellAtSec,
    lineup.bellEnabled,
    lineup.benchIds,
    lineup.minutes,
    suggestedNextPlayer,
    players,
  ]);

  useEffect(() => {
    return () => { void clearWatchGameSession(); };
  }, []);

  const handleWatchGameAction = useCallback(async (action: WatchGameAction) => {
    if (!isUserCoach || !eventId) return;
    if (action.eventId && action.eventId !== eventId) return;
    const actionKey = action.id || `${action.eventId || eventId}:${action.action}:${action.receivedAt || ''}`;
    if (handledWatchActionIds.current.has(actionKey)) return;
    handledWatchActionIds.current.add(actionKey);
    if (handledWatchActionIds.current.size > 100) {
      const oldestActionKey = handledWatchActionIds.current.values().next().value;
      if (oldestActionKey) handledWatchActionIds.current.delete(oldestActionKey);
    }
    switch (action.action) {
      case 'ourGoal':
        await addTimelineEntry('goal', { note: 'Watch goal' });
        break;
      case 'oppGoal':
        await incScore('opp', 1);
        break;
      case 'ourGoalMinus': {
        // Watch minus button on our column — pop the most recent
        // goal off the timeline. Falls back to a raw score decrement
        // if there are no timeline entries (edge case where the score
        // was set manually).
        const ourGoals = [...(game?.timeline || [])]
          .filter(t => t.kind === 'goal')
          .sort((a, b) => b.at - a.at);
        if (ourGoals.length > 0) await removeTimelineEntry(ourGoals[0].id, false);
        else if ((game?.ourScore || 0) > 0) await incScore('our', -1);
        break;
      }
      case 'oppGoalMinus':
        if ((game?.oppScore || 0) > 0) await incScore('opp', -1);
        break;
      case 'undoLast': {
        const latest = [...(game?.timeline || [])].sort((a, b) => b.at - a.at)[0];
        if (latest) await removeTimelineEntry(latest.id, false);
        else if ((game?.oppScore || 0) > 0) await incScore('opp', -1);
        break;
      }
      case 'subMade':
        // If the Watch sent a specific playerId, run the auto-swap.
        // If not (e.g. pre-picker Watch app version, or the coach hit
        // the fallback "just reset timer" path), just ack the bell.
        if (action.playerId) await watchQuickSub(action.playerId);
        else await acknowledgeBell();
        break;
      case 'startClock':
        await startClock();
        break;
      case 'pauseClock':
        await pauseClock();
        break;
      case 'recordStat': {
        // Watch stat picker fired: attribute a goal/assist/save/
        // yellow/red to a specific player. Reuses addTimelineEntry
        // (same code path as tap-to-record on the phone) so scoring,
        // undo, and season rollup all work identically.
        const kind = action.stat as any;
        const validKinds = new Set(['goal', 'assist', 'save', 'yellow', 'red']);
        if (!action.playerId || !kind || !validKinds.has(kind)) break;
        await addTimelineEntry(kind, { playerId: action.playerId, note: 'Watch' });
        break;
      }
      case 'endPeriod':
        // Bump the period label. Handled via patch — same shape the
        // "End period" button in the header would use.
        if (game) {
          const cur = game.period;
          const next: LiveGameDoc['period'] =
            cur === 1 ? 2 :
            cur === 2 ? 'OT' :
            cur === 'OT' ? 'OT' : 1;
          await patch({
            period: next,
            clockOffsetSeconds: liveSeconds,
            clockSecondsAtStart: game.status === 'live' ? Date.now() : (game.clockSecondsAtStart || 0),
          } as any);
        }
        break;
      case 'toggleBell':
        await toggleBell();
        break;
    }
  }, [isUserCoach, eventId, game, watchQuickSub, liveSeconds]);

  useEffect(() => {
    if (!isUserCoach || !eventId) return;
    let removed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    void drainWatchGameActions().then(actions => {
      if (removed) return;
      actions.forEach(action => { void handleWatchGameAction(action); });
    });
    void addWatchGameActionListener(action => {
      void handleWatchGameAction(action);
      void drainWatchGameActions().then(actions => {
        actions.forEach(queuedAction => { void handleWatchGameAction(queuedAction); });
      });
    }).then(handle => {
      listener = handle;
      if (removed && listener) void listener.remove();
    });
    return () => {
      removed = true;
      if (listener) void listener.remove();
    };
  }, [isUserCoach, eventId, handleWatchGameAction]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft border-t-cyan-500" />
      </div>
    );
  }
  if (error || !event) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base flex items-center justify-center p-4 text-ink-primary">
        <div className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft flex items-center justify-center mb-3">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path fill="#0f172a" d="M12 6l2.5 2-.75 3h-3.5l-.75-3z" /></svg>
          </div>
          <p className="mb-4 text-sm text-ink-primary/80">{error || 'Event not found'}</p>
          <Link to="/calendar" className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-primary hover:bg-brand-primary rounded-lg text-sm font-bold">Back to Calendar</Link>
        </div>
      </div>
    );
  }
  const nextCoachAction =
    status === 'scheduled'
      ? { label: 'Start the clock', detail: 'Kickoff is ready when you are.' }
      : status === 'live' && suggestedNextPlayer
        ? { label: `Next sub: ${suggestedNextPlayer.name}`, detail: `${Math.floor(minutesFor(suggestedNextPlayer.id) / 60)} min logged so far.` }
        : status === 'live'
          ? { label: 'Record the next moment', detail: 'Goals, cards, saves, subs, and notes stay synced.' }
          : status === 'halftime'
            ? { label: 'Resume second half', detail: 'Clock, score, and timeline are paused.' }
            : { label: 'Share the recap', detail: 'Post the final summary back to team chat.' };

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-vignette-deep text-ink-primary pb-32">
      {/* Watch Quick Sub undo toast — 8-second window to reverse a
          Watch-triggered swap. Renders above the sticky header so it
          isn't hidden by the scoreboard. */}
      {pendingSubUndo && (
        <div className="sticky top-0 z-30 bg-emerald-600 text-white px-4 py-2 flex items-center justify-between gap-3 text-sm font-bold shadow-lg animate-slide-down">
          <span className="truncate">
            <span className="opacity-80 mr-1">Sub:</span>
            {pendingSubUndo.inName.split(' ')[0]} in for {pendingSubUndo.outName.split(' ')[0]}
          </span>
          <button
            type="button"
            onClick={undoQuickSub}
            className="text-[11px] tracking-widest uppercase font-black bg-white/20 rounded-full px-3 py-1 hover:bg-white/30 active:bg-white/40 transition-colors"
          >
            Undo
          </button>
        </div>
      )}
      {/* Header / Scoreboard */}
      <header className="sticky top-0 z-20 bg-surface-elevated/85 dark:bg-black/60 backdrop-blur-md border-b border-line-default/10">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <Link to="/calendar" className="text-xs text-ink-primary/65 hover:text-ink-primary">← Calendar</Link>
            <div className="flex items-center gap-2">
              {isUserCoach && (() => {
                // Stats toggle. Off = scrimmage / testing (timeline still
                // records but nothing rolls up to player cards on Final).
                // Demo teams force off and lock the toggle.
                const teamIsDemo = (selectedTeam as any)?.isDemo === true;
                const countsOn = !teamIsDemo && (game?.countsToStats !== false);
                const label = teamIsDemo ? 'DEMO · STATS OFF' : countsOn ? 'STATS ON' : 'STATS OFF';
                const tone = countsOn
                  ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/25'
                  : 'bg-amber-500/20 text-amber-300 ring-amber-500/40 hover:bg-amber-500/30';
                return (
                  <button
                    type="button"
                    disabled={teamIsDemo}
                    onClick={async () => {
                      await ensureGameDoc();
                      await patch({ countsToStats: !countsOn } as any);
                    }}
                    className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ring-1 transition-colors ${tone} ${
                      teamIsDemo ? 'cursor-not-allowed opacity-90' : ''
                    }`}
                    title={teamIsDemo
                      ? 'Demo team: games never count toward stats'
                      : countsOn
                        ? 'Tap to skip stats for this game (scrimmage / testing)'
                        : 'Tap to count this game toward season stats'}
                  >
                    {label}
                  </button>
                );
              })()}
              <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${
                status === 'live' ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40 animate-pulse' :
                status === 'halftime' ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40' :
                status === 'final' ? 'bg-gray-500/20 text-gray-300 ring-1 ring-gray-500/40' :
                'bg-brand-primary/20 text-brand-primary-soft ring-1 ring-brand-primary/40'
              }`}>
                {status === 'live' ? '● LIVE' : status === 'halftime' ? 'PAUSED' : status === 'final' ? 'FINAL' : 'SCHEDULED'}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 items-center text-center gap-2">
            <div>
              <div className="text-xs text-ink-primary/65 truncate">{usLabel}</div>
              <div className="text-5xl font-black tabular-nums">{ourScore}</div>
              {isUserCoach && (
                <div className="flex justify-center gap-1 mt-1">
                  <button onClick={() => incScore('our', -1)} className="w-7 h-7 rounded bg-line-default/10 hover:bg-line-default/20 text-sm font-bold">−</button>
                  <button onClick={() => incScore('our', 1)} className="w-7 h-7 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-bold">+</button>
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-ink-primary/65 mb-1">{event.homeAway === 'away' ? '@ Away' : event.homeAway === 'home' ? 'Home' : ''}</div>
              <div className="text-2xl font-mono tabular-nums">{formatClock(liveSeconds)}</div>
              <div className="text-[10px] text-ink-primary/45 mt-0.5">Min {minute}</div>
            </div>
            <div>
              <div className="text-xs text-ink-primary/65 truncate">{event.opponent || 'Opponent'}</div>
              <div className="text-5xl font-black tabular-nums">{oppScore}</div>
              {isUserCoach && (
                <div className="flex justify-center gap-1 mt-1">
                  <button onClick={() => incScore('opp', -1)} className="w-7 h-7 rounded bg-line-default/10 hover:bg-line-default/20 text-sm font-bold">−</button>
                  <button onClick={() => incScore('opp', 1)} className="w-7 h-7 rounded bg-rose-600 hover:bg-rose-500 text-sm font-bold">+</button>
                </div>
              )}
            </div>
          </div>
          {isUserCoach && status !== 'final' && (
            <div className="flex gap-2 mt-3">
              {status !== 'live' ? (
                <button onClick={startClock} className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-semibold">
                  ▶ {status === 'halftime' ? 'Resume' : 'Start'}
                </button>
              ) : (
                <button onClick={pauseClock} className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-semibold">
                  ⏸ Pause / Halftime
                </button>
              )}
              <button onClick={finalizeGame} className="flex-1 py-2 bg-rose-700 hover:bg-rose-600 rounded-lg text-sm font-semibold">
                🏁 End Game
              </button>
            </div>
          )}
        </div>
      </header>

      <section className="max-w-3xl mx-auto px-4 pt-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-2xl bg-surface-elevated/90 ring-1 ring-line-default/10 p-3 min-w-0">
            <p className="text-[9px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Next</p>
            <p className="text-[12px] font-black text-ink-primary leading-tight truncate">{nextCoachAction.label}</p>
            <p className="text-[10px] text-ink-primary/50 leading-snug mt-1 line-clamp-2">{nextCoachAction.detail}</p>
          </div>
          <div className="rounded-2xl bg-surface-elevated/90 ring-1 ring-line-default/10 p-3 min-w-0">
            <p className="text-[9px] font-extrabold tracking-widest uppercase text-amber-300 mb-1">Rotation</p>
            <p className="text-[12px] font-black text-ink-primary leading-tight truncate">
              {lineup.onField.length ? `${lineup.onField.length} on · ${lineup.benchIds.length} bench` : 'Lineup empty'}
            </p>
            <p className="text-[10px] text-ink-primary/50 leading-snug mt-1">
              {lineup.bellEnabled ? `${Math.round(lineup.shiftSeconds / 60)} min bell on` : 'Bell off'}
            </p>
          </div>
          <div className="rounded-2xl bg-surface-elevated/90 ring-1 ring-line-default/10 p-3 min-w-0">
            <p className="text-[9px] font-extrabold tracking-widest uppercase text-emerald-300 mb-1">Log</p>
            <p className="text-[12px] font-black text-ink-primary leading-tight truncate">{sortedTimeline.length} moments</p>
            <p className="text-[10px] text-ink-primary/50 leading-snug mt-1">
              {sortedTimeline[0] ? `${KIND_META[sortedTimeline[0].kind].label} at ${sortedTimeline[0].minute}'` : 'Nothing recorded yet'}
            </p>
          </div>
        </div>
      </section>

      <main className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
        {/* Recap card — only after the game is finalized. Auto-builds
            from the timeline + lineup minutes. Share via native share
            sheet or post directly to a team chat thread. */}
        {status === 'final' && game && (
          <GameRecapCard
            event={event}
            game={game}
            teamName={selectedTeam?.name || 'Our team'}
            players={players}
            onPostToChat={postRecapToChat}
          />
        )}

        {status === 'final' && isAdultTeam && isUserCoach && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setShowRatings(true)}
              className="px-4 py-2.5 rounded-full bg-brand-primary text-white text-xs font-extrabold uppercase tracking-widest hover:bg-brand-primary-soft hover:text-charcoal-950 transition"
            >
              {event?.playerRatings && Object.keys(event.playerRatings).length > 0 ? 'Edit player ratings' : 'Rate players'}
            </button>
          </div>
        )}

        {showRatings && event && (
          <PlayerRatingSheet
            event={event as any}
            players={players}
            onClose={() => setShowRatings(false)}
          />
        )}

        {/* Team split panel — surfaces the sides picked in EventDetail's
            Split Teams modal so both coaches and RSVPers can see who's
            on which team before kickoff. Only rendered when the coach
            actually generated a split for this event. Adjustments still
            happen back on EventDetail (which owns the modal + roster
            picker) so we don't fork the source of truth. */}
        {status !== 'final' && event?.teamSplit?.sides?.length > 0 && (
          <section className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 p-3 sm:p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs uppercase tracking-wider text-ink-primary/65 font-bold">Sides</h3>
                <p className="text-[10px] text-ink-primary/45 leading-snug mt-0.5">
                  {event.teamSplit.method === 'snake' ? 'Auto-balanced by skill' : 'Randomized'} · {event.teamSplit.sides.reduce((n: number, s: any) => n + (s.playerIds?.length || 0), 0)} players
                </p>
              </div>
              {isUserCoach && (
                <Link
                  to={`/event/${eventId}`}
                  className="text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-ink-primary"
                >
                  Adjust
                </Link>
              )}
            </div>
            <div className={`grid gap-2 ${event.teamSplit.sides.length >= 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
              {event.teamSplit.sides.map((side: any, idx: number) => {
                const roster = (side.playerIds || [])
                  .map((pid: string) => players.find(p => p.id === pid))
                  .filter(Boolean);
                return (
                  <div key={`${side.label}-${idx}`} className="rounded-xl bg-surface-input ring-1 ring-line-default/10 p-2.5">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary">{side.label || `Side ${idx + 1}`}</span>
                      <span className="text-[10px] text-ink-primary/50">{roster.length}</span>
                    </div>
                    <ul className="space-y-0.5">
                      {roster.map((p: any) => (
                        <li key={p.id} className="text-[12px] text-ink-primary/85 leading-snug truncate">
                          {p.jerseyNumber != null ? <span className="text-ink-primary/45 mr-1.5">#{p.jerseyNumber}</span> : null}
                          {p.name}
                        </li>
                      ))}
                      {roster.length === 0 && (
                        <li className="text-[11px] text-ink-primary/40 italic">No players yet</li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Formation visualization — players auto-place to a slot
            template based on the format (7v7 / 9v9 / 11v11). Coaches
            can drag any chip to override its position; changes persist
            on the lineup. */}
        {status !== 'final' && lineup.onField.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-ink-primary/45">Formation</h3>
              {isUserCoach && (
                <div className="inline-flex items-center bg-line-default/5 ring-1 ring-line-default/15 rounded-full p-0.5">
                  {(['7v7', '9v9', '11v11'] as const).map((f) => {
                    const active = (game?.format || '7v7') === f;
                    return (
                      <button
                        key={f}
                        onClick={() => patch({ format: f })}
                        className={`px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full transition ${
                          active ? 'bg-white text-charcoal-900 shadow' : 'text-ink-primary/70 hover:text-ink-primary'
                        }`}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <FormationView
              players={players}
              onFieldIds={lineup.onField.map(s => s.playerId)}
              positions={Object.fromEntries(
                lineup.onField
                  .filter(s => s.x != null && s.y != null)
                  .map(s => [s.playerId, { x: s.x as number, y: s.y as number }]),
              )}
              format={game?.format || '7v7'}
              onMove={async (playerId, x, y) => {
                if (!isUserCoach) return;
                const next: LineupState = {
                  ...lineup,
                  onField: lineup.onField.map(s =>
                    s.playerId === playerId ? { ...s, x, y } : s
                  ),
                };
                await persistLineup(next);
              }}
            />
          </section>
        )}

        {/* Quick action chips (coaches only) */}
        {isUserCoach && status !== 'final' && (
          <section>
            <h3 className="text-xs uppercase tracking-wider text-ink-primary/40 mb-2 font-extrabold">Tap to record</h3>
            <div className="grid grid-cols-4 gap-2">
              {(['goal', 'owngoal', 'assist', 'save', 'yellow', 'red', 'sub', 'note'] as StatKind[]).map(k => (
                <button
                  key={k}
                  onClick={async () => {
                    if (k === 'owngoal') {
                      if (!window.confirm('Mark Own Goal? +1 to us, no player credit. (You can still tap Assist for the kicker.)')) return;
                      await addTimelineEntry('owngoal', { note: 'Opponent own goal' });
                      return;
                    }
                    setPickerKind(k);
                    setNoteText('');
                  }}
                  className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-surface-input ring-1 ring-line-default/10 hover:ring-brand-primary-soft/50 hover:bg-surface-raised active:scale-95 transition"
                >
                  <span className="text-ink-primary/85">{TAP_ICONS[k]}</span>
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/75">{KIND_META[k].label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Lineup & Subs (coaches only) */}
        {isUserCoach && status !== 'final' && (
          <section className="rounded-2xl bg-line-default/5 ring-1 ring-line-default/10 p-3 sm:p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs uppercase tracking-wider text-ink-primary/65 font-bold">Lineup &amp; Subs</h3>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-ink-primary/45">Shift</span>
                <select
                  value={lineup.shiftSeconds}
                  onChange={e => setShiftSeconds(parseInt(e.target.value, 10))}
                  className="bg-line-default/10 ring-1 ring-line-default/20 rounded px-1.5 py-0.5 text-ink-primary text-[11px]"
                >
                  <option value={180}>3 min</option>
                  <option value={300}>5 min</option>
                  <option value={420}>7 min</option>
                  <option value={600}>10 min</option>
                </select>
                <button
                  onClick={toggleBell}
                  className={`px-2 py-0.5 rounded font-semibold ${lineup.bellEnabled ? 'bg-emerald-600/30 text-emerald-200 ring-1 ring-emerald-500/50' : 'bg-line-default/10 text-ink-primary/55 ring-1 ring-line-default/20'}`}
                  title="Toggle rotation bell"
                >🔔 {lineup.bellEnabled ? 'On' : 'Off'}</button>
              </div>
            </div>

            {/* Bell countdown */}
            {game?.status === 'live' && lineup.bellEnabled && (
              <div className="mb-3">
                {(() => {
                  const remaining = Math.max(0, lineup.shiftSeconds - (liveSeconds - (lineup.lastBellAtSec || 0)));
                  const pct = Math.min(100, ((lineup.shiftSeconds - remaining) / lineup.shiftSeconds) * 100);
                  return (
                    <div>
                      <div className="flex items-center justify-between text-[11px] text-ink-primary/65 mb-1">
                        <span>Next rotation in {formatClock(remaining)}</span>
                        <button onClick={acknowledgeBell} className="text-brand-primary-soft hover:text-ink-primary">Reset</button>
                      </div>
                      <div className="h-1.5 bg-line-default/10 rounded-full overflow-hidden">
                        <div className="h-full bg-brand-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Quick init */}
            {lineup.onField.length === 0 && lineup.benchIds.length === 0 && (
              <button
                onClick={initRosterToBench}
                className="w-full py-2 rounded-lg bg-brand-primary hover:bg-brand-primary font-semibold text-sm"
              >Load roster to bench</button>
            )}

            {(lineup.onField.length > 0 || lineup.benchIds.length > 0) && (
              <div className="grid grid-cols-2 gap-3">
                {/* On field */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold mb-1.5">On Field ({lineup.onField.length})</div>
                  <div className="space-y-1.5">
                    {lineup.onField.map(slot => {
                      const p = players.find(pp => pp.id === slot.playerId);
                      if (!p) return null;
                      const mins = Math.floor(minutesFor(slot.playerId) / 60);
                      return (
                        <button
                          key={slot.playerId}
                          onClick={() => subOff(slot.playerId)}
                          className="w-full flex items-center gap-2 p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 ring-1 ring-emerald-500/30 text-left"
                          title="Tap to sub OFF"
                        >
                          <span className="w-7 h-7 rounded-full bg-emerald-600 text-white text-[10px] font-black flex items-center justify-center flex-shrink-0">
                            {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-xs font-semibold truncate">{p.name}</span>
                            <span className="block text-[10px] text-emerald-300 tabular-nums">{mins} min</span>
                          </span>
                        </button>
                      );
                    })}
                    {lineup.onField.length === 0 && <div className="text-[11px] text-ink-primary/45 italic px-1">No one on the field.</div>}
                  </div>
                </div>

                {/* Bench (sorted by least minutes) */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-1.5">Bench ({lineup.benchIds.length})</div>
                  <div className="space-y-1.5">
                    {[...lineup.benchIds]
                      .sort((a, b) => minutesFor(a) - minutesFor(b))
                      .map(pid => {
                        const p = players.find(pp => pp.id === pid);
                        if (!p) return null;
                        const mins = Math.floor(minutesFor(pid) / 60);
                        const isNext = pid === suggestedNext;
                        return (
                          <button
                            key={pid}
                            onClick={() => subOn(pid)}
                            className={`w-full flex items-center gap-2 p-1.5 rounded-lg ring-1 text-left ${isNext ? 'bg-amber-500/15 ring-amber-500/50 hover:bg-amber-500/25' : 'bg-line-default/5 ring-line-default/10 hover:bg-line-default/10'}`}
                            title="Tap to sub ON"
                          >
                            <span className={`w-7 h-7 rounded-full text-white text-[10px] font-black flex items-center justify-center flex-shrink-0 ${isNext ? 'bg-amber-600' : 'bg-slate-600'}`}>
                              {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="text-xs font-semibold truncate flex items-center gap-1">
                                {p.name}
                                {isNext && <span className="text-[9px] bg-amber-600 px-1 rounded text-white">NEXT</span>}
                              </span>
                              <span className="block text-[10px] text-ink-primary/55 tabular-nums">{mins} min</span>
                            </span>
                          </button>
                        );
                      })}
                    {lineup.benchIds.length === 0 && <div className="text-[11px] text-ink-primary/45 italic px-1">Bench empty.</div>}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Timeline */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-ink-primary/45 mb-2">
            Timeline ({sortedTimeline.length})
          </h3>
          {sortedTimeline.length === 0 ? (
            <div className="text-center py-10 text-ink-primary/45 text-sm rounded-xl bg-line-default/5 ring-1 ring-line-default/10">
              No events yet. {isUserCoach ? 'Tap an action above.' : 'Coaches will record events live.'}
            </div>
          ) : (
            <ul className="space-y-2">
              {sortedTimeline.map(t => (
                <li key={t.id} className="flex items-center gap-3 p-3 rounded-xl bg-line-default/5 ring-1 ring-line-default/10">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${KIND_META[t.kind].color}/30`}>
                    {KIND_META[t.kind].emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">
                      <span className="font-bold">{KIND_META[t.kind].label}</span>
                      {t.playerName && (
                        <>
                          {' · '}
                          <span className="text-brand-primary-soft">
                            {t.jerseyNumber != null ? `#${t.jerseyNumber} ` : ''}{t.playerName}
                          </span>
                        </>
                      )}
                    </div>
                    {t.note && <div className="text-xs text-ink-primary/70 mt-0.5">{t.note}</div>}
                    {t.clipUrl && (
                      <a
                        href={t.clipUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 mt-1 text-[11px] text-brand-primary-soft hover:text-ink-primary"
                      >
                        🎬 {t.source === 'clip' ? 'Clip credit' : 'Watch clip'}
                      </a>
                    )}
                    <div className="text-[10px] text-ink-primary/45 mt-0.5">
                      Min {t.minute} · {new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {t.recordedByName ? ` · by ${t.recordedByName}` : ''}
                    </div>
                  </div>
                  {isUserCoach && (
                    <button
                      onClick={() => removeTimelineEntry(t.id)}
                      className="text-ink-primary/45 hover:text-red-400 text-sm"
                      title="Remove"
                    >✕</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Per-player live tally */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-ink-primary/45 mb-2">Live Stat Sheet</h3>
          <div className="rounded-xl bg-line-default/5 ring-1 ring-line-default/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-line-default/5 text-ink-primary/65 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2">Player</th>
                  <th className="px-2 py-2">⚽</th>
                  <th className="px-2 py-2">🅰️</th>
                  <th className="px-2 py-2">🧤</th>
                  <th className="px-2 py-2">🟨</th>
                  <th className="px-2 py-2">🟥</th>
                </tr>
              </thead>
              <tbody>
                {players.map(p => {
                  const tally = (game?.timeline || []).reduce((acc: any, t) => {
                    if (t.playerId !== p.id) return acc;
                    if (t.kind === 'goal') acc.goals++;
                    if (t.kind === 'assist') acc.assists++;
                    if (t.kind === 'save') acc.saves++;
                    if (t.kind === 'yellow') acc.yellow++;
                    if (t.kind === 'red') acc.red++;
                    return acc;
                  }, { goals: 0, assists: 0, saves: 0, yellow: 0, red: 0 });
                  const hasAny = tally.goals + tally.assists + tally.saves + tally.yellow + tally.red > 0;
                  return (
                    <tr key={p.id} className={`border-t border-line-default/5 ${hasAny ? 'text-ink-primary' : 'text-ink-primary/45'}`}>
                      <td className="px-3 py-2 truncate">
                        {p.jerseyNumber != null ? <span className="text-brand-primary-soft font-bold mr-1">#{p.jerseyNumber}</span> : null}
                        {p.name}
                      </td>
                      <td className="text-center tabular-nums">{tally.goals || ''}</td>
                      <td className="text-center tabular-nums">{tally.assists || ''}</td>
                      <td className="text-center tabular-nums">{tally.saves || ''}</td>
                      <td className="text-center tabular-nums">{tally.yellow || ''}</td>
                      <td className="text-center tabular-nums">{tally.red || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Player picker modal */}
      {pickerKind && (
        <div className="fixed inset-0 z-50 bg-surface-base/70 dark:bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setPickerKind(null)}>
          <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-line-default/10 flex items-center justify-between">
              <h3 className="font-bold flex items-center gap-2">
                <span>{KIND_META[pickerKind].emoji}</span>
                <span>{KIND_META[pickerKind].label}</span>
                <span className="text-xs text-ink-primary/45 font-normal">· Min {minute}</span>
              </h3>
              <button onClick={() => setPickerKind(null)} className="text-ink-primary/65 hover:text-ink-primary text-xl leading-none">✕</button>
            </div>
            {pickerKind === 'note' ? (
              <div className="p-4 space-y-3">
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="What happened? (e.g. great defensive stop, weather break)"
                  rows={4}
                  className="w-full px-3 py-2 bg-line-default/5 border border-line-default/10 rounded-lg text-sm text-ink-primary placeholder-ink-primary/35 focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  autoFocus
                />
                <button
                  onClick={async () => {
                    if (!noteText.trim()) return;
                    await addTimelineEntry('note', { note: noteText.trim() });
                    setPickerKind(null);
                    setNoteText('');
                  }}
                  className="w-full py-2.5 bg-brand-primary hover:bg-brand-primary rounded-lg font-semibold"
                >Save Note</button>
              </div>
            ) : (
              <div className="overflow-y-auto p-2 grid grid-cols-2 gap-2">
                {players.length === 0 ? (
                  <div className="col-span-2 p-6 text-center text-ink-primary/45 text-sm">Squad's empty.</div>
                ) : players.map(p => (
                  <button
                    key={p.id}
                    onClick={async () => {
                      await addTimelineEntry(pickerKind, { player: p });
                      setPickerKind(null);
                    }}
                    className="flex items-center gap-2 p-2 rounded-lg bg-line-default/5 hover:bg-line-default/10 ring-1 ring-line-default/10 text-left"
                  >
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint flex items-center justify-center text-white text-xs font-black flex-shrink-0">
                      {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{p.name}</div>
                      {p.position && <div className="text-[10px] text-ink-primary/45 truncate">{p.position}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default GameDay;
