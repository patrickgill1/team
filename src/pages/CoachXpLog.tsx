// CoachXpLog — /coach/xp-log
//
// Team-wide XP log for the head coach. Sibling to /coach/xp (the
// per-source toggle config). This is the accountability surface: every
// player_xp_events doc for the selected team, most recent first, so a
// coach glancing at the season leaderboard can answer "how did they
// earn this?" without opening each kid's profile one at a time.
//
// Data:
//   - Live via onSnapshot on player_xp_events where teamId ==
//     selectedTeamId, orderBy createdAt desc, limit PAGE_SIZE. Load
//     more pages another PAGE_SIZE via a startAfter cursor.
//   - Roster load (one-shot getDocs on players) drives the avatar +
//     name lookup, the player filter dropdown, AND the sum-vs-total
//     banner (compares log history sum to player.xp / team xp sum).
//
// Rules:
//   - firestore.rules already grants list on player_xp_events to any
//     uid on team.coachIds via callerCanReadWhisper (2026-07-09
//     hardening). No worker changes needed.
//
// Index:
//   - Requires composite (teamId ASC, createdAt DESC). If the query
//     errors with FAILED_PRECONDITION on first load, add that index
//     to firestore.indexes.json and re-deploy firestore rules+indexes.
//
// Row explosion — silent grants now write:
//   Once backfill + going-forward silent grants route through the
//   worker (dev_plan_log, practice_attendance, rsvp_going, streak,
//   first_*, etc.) the log volume is 10-20x what it was when this
//   surface was born as "coach actions only." Three affordances tame
//   the density:
//     1. Day-grouping — rows collapse under Denver day-key headers.
//        A coach-authored day (any row with source in coach_live /
//        coach_whisper / kudos_coach_convert / coach_recognition)
//        auto-expands; silent-only days stay collapsed until tapped.
//     2. Multi-select source chips (persisted per user) so a coach
//        can hide the noisy habit rows without losing the milestone
//        + coach-action rows.
//     3. Two-tier visual weight — coach-authored rows render bold
//        with colored source chip + coach avatar; silent/auto rows
//        render muted with a small grey chip and no avatar.
//
// Sum-vs-total banner: when the visible log sum is less than the
// selected player's totalled xp (or team total when unfiltered), we
// surface a one-line banner explaining the gap so a coach who tries
// to reconcile totals doesn't file it as a bug.

import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  collection,
  DocumentData,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  startAfter,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import type { Player } from '../types';
import { toMillis, relativeTime } from '../utils/timestamps';
import {
  coachSourceLabel,
  dotClassForSource,
  COACH_LOG_SOURCE_OPTIONS,
} from '../utils/xpSourceLabels';
import { denverKeyOfDate } from '../utils/devPlanActions';

const PAGE_SIZE = 200;
const SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Sources whose visual tier is "coach-authored" (bold, colored chip,
// coach avatar). Everything else is silent/auto and renders muted.
const COACH_AUTHORED_SOURCES = new Set([
  'coach_live',
  'coach_whisper',
  'coach_recognition',
  'kudos_coach_convert',
]);

interface XpRow {
  id: string;
  playerId: string;
  playerName: string;
  xp: number;
  source: string;
  note: string;
  awardedBy: string;
  awardedByName: string | null;
  awardedByAvatarUrl: string | null;
  awardedByRole: string;
  backfilled: boolean;
  createdAtMs: number;
}

interface RosterEntry {
  id: string;
  name: string;
  photoUrl: string | null;
  xp: number;
}

interface DayGroup {
  key: string;         // Denver day-key "YYYY-MM-DD"
  latestMs: number;    // most-recent row in the group (for header label + sort)
  rows: XpRow[];
  totalXp: number;
  hasCoachRow: boolean;
}

function rowFromDoc(d: QueryDocumentSnapshot<DocumentData>): XpRow {
  const data = d.data() as any;
  return {
    id: d.id,
    playerId: String(data.playerId || ''),
    playerName: String(data.playerName || 'Player'),
    xp: Number(data.xp) || 0,
    source: String(data.source || ''),
    // Backfill events store the reason on `reason` instead of `note`.
    // Read both so retro-credit rows don't render with a blank subtitle.
    note: String(data.note || data.reason || '').trim(),
    awardedBy: String(data.awardedBy || ''),
    awardedByName: typeof data.awardedByName === 'string' && data.awardedByName.trim()
      ? data.awardedByName.trim()
      : null,
    awardedByAvatarUrl: typeof data.awardedByAvatarUrl === 'string' && data.awardedByAvatarUrl
      ? data.awardedByAvatarUrl
      : null,
    awardedByRole: String(data.awardedByRole || 'system'),
    backfilled: data.backfilled === true,
    createdAtMs: toMillis(data.createdAt),
  };
}

// Short absolute timestamp for older rows: "Jul 20 at 4:15 PM" this
// year, "Jul 20, 2025 at 4:15 PM" if from a prior calendar year. Uses
// the viewer's locale for weekday/AM-PM conventions.
function absoluteWhen(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  return d.toLocaleString(undefined, opts).replace(', ', ' at ');
}

// "Yesterday at 4:15 PM" when the timestamp is on the previous local
// calendar day; falls back to relativeTime for anything more recent and
// absoluteWhen for anything older.
function whenLabel(ms: number): string {
  if (!ms) return '';
  const now = new Date();
  const then = new Date(ms);
  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      (24 * 60 * 60 * 1000),
  );
  if (dayDiff <= 0) return relativeTime(ms);
  if (dayDiff === 1) {
    return `Yesterday at ${then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return absoluteWhen(ms);
}

// Time-only label for a row inside an expanded day group (e.g. "4:15 PM").
// The parent day header carries the date, so per-row date noise is
// redundant.
function timeOnlyLabel(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Day-header label anchored to Denver time so a late-night practice
// bucketed by the worker on day X reads as day X here too. "Today" /
// "Yesterday" shorthand when the row lands there, otherwise a compact
// weekday-and-date like "Wed Jul 24" (or "Wed Jul 24, 2025" outside
// the current year).
function dayHeaderLabel(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const rowKey = denverKeyOfDate(d);
  const todayKey = denverKeyOfDate(now);
  const yesterdayKey = denverKeyOfDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  if (rowKey === todayKey) return 'Today';
  if (rowKey === yesterdayKey) return 'Yesterday';
  // The Denver year matters, not device-local year, but for the coach
  // (Mountain Time) they line up. Still pass timeZone so a coach on a
  // roadtrip in a different tz reads the same header the worker keyed.
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Denver',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// Short "Jul 10, 2026" for the sum-vs-total banner enabledAt reference.
function shortDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Denver',
  });
}

// Initials for the fallback avatar circle. Two letters max so it
// always fits without truncation.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Which visual "chip color family" does a source belong to on the log
// row? Coach-authored rows are amber (kudos, live grants) or brand
// primary (whispers, the private-to-parents flavor). Everything else
// is muted grey so the milestone / habit rows recede beneath coach
// moments in a mixed feed.
function chipToneForSource(source: string): 'amber' | 'brand' | 'muted' {
  if (source === 'coach_live' || source === 'kudos_coach_convert' || source === 'coach_recognition') return 'amber';
  if (source === 'coach_whisper') return 'brand';
  return 'muted';
}

const CoachXpLog: React.FC = () => {
  const { selectedTeamId } = useTeam();
  return <CoachXpLogInner key={selectedTeamId || 'no-team'} />;
};

const CoachXpLogInner: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();

  // Hooks BEFORE any conditional return (per hooks-before-returns memory).
  // Split first-page (live via onSnapshot) from Load-more pages (one-shot
  // getDocs appended). Prior single-array shape wiped every appended page
  // on the next snapshot tick — a coach who had scrolled to row 400 lost
  // 200+ rows the moment any teammate logged an XP event.
  const [firstPage, setFirstPage] = useState<XpRow[] | null>(null);
  const [extraPages, setExtraPages] = useState<XpRow[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [lastCursor, setLastCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);
  const rows = React.useMemo<XpRow[] | null>(() => {
    if (firstPage === null) return null;
    // Dedup on id in case a new event ticks into the first page while
    // an appended page happened to be sitting on the boundary.
    const seen = new Set(firstPage.map(r => r.id));
    const merged = [...firstPage];
    for (const r of extraPages) if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    return merged;
  }, [firstPage, extraPages]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playerFilter, setPlayerFilter] = useState<string>('all');
  // Multi-select source filter. Internal state is the DISABLED set, so
  // default (empty set) means "all sources on" and we don't have to
  // hydrate the full option list before we know what to select. Persisted
  // per-user in localStorage so a coach's chosen slice sticks across
  // sessions and devices sharing that browser profile.
  const [disabledSources, setDisabledSources] = useState<Set<string>>(new Set());
  const [ruleDenied, setRuleDenied] = useState(false);
  // Per-day expansion override. Absence in the map means "use the auto
  // default" (coach-authored days expand, silent-only days collapse).
  // A user tap flips just that day's override without touching auto
  // behavior for the rest of the feed.
  const [expandedOverride, setExpandedOverride] = useState<Map<string, boolean>>(new Map());

  // Hydrate persisted source filter on user resolve. Storing an array of
  // disabled source keys keeps the "default = all on" semantic clean:
  // no localStorage value → empty set → all sources visible.
  useEffect(() => {
    const uid = userData?.uid;
    if (!uid) return;
    try {
      const raw = localStorage.getItem(`coach-xp-log-disabled-${uid}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setDisabledSources(new Set(parsed.filter((x) => typeof x === 'string')));
      }
    } catch {
      // Corrupt storage entry: ignore and let default (all on) stand.
    }
  }, [userData?.uid]);

  // Persist source filter changes. Fire and forget; a full storage
  // quota failure is not worth interrupting the coach for.
  useEffect(() => {
    const uid = userData?.uid;
    if (!uid) return;
    try {
      localStorage.setItem(
        `coach-xp-log-disabled-${uid}`,
        JSON.stringify(Array.from(disabledSources)),
      );
    } catch {
      // localStorage full or blocked; the in-memory state still works
      // for the session.
    }
  }, [disabledSources, userData?.uid]);

  // Live listener for the first page. Reset on team change (component
  // keyed on selectedTeamId in the wrapper).
  useEffect(() => {
    if (!selectedTeamId) {
      setFirstPage([]);
      setExtraPages([]);
      setReachedEnd(true);
      return;
    }
    setFirstPage(null);
    setExtraPages([]);
    setReachedEnd(false);
    setLastCursor(null);
    setRuleDenied(false);
    const q = query(
      collection(db, 'player_xp_events'),
      where('teamId', '==', selectedTeamId),
      orderBy('createdAt', 'desc'),
      fsLimit(PAGE_SIZE),
    );
    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot<DocumentData>) => {
        const next = snap.docs.map(rowFromDoc);
        setFirstPage(next);
        setLastCursor(snap.docs.length ? snap.docs[snap.docs.length - 1] : null);
        // Reset reachedEnd cleanly on every snapshot — if the first
        // page now has PAGE_SIZE rows there might be more behind it,
        // if it has fewer we know we've seen everything. Prior shape
        // only ever SET reachedEnd true, never reset it, so a full
        // first-page after a partial one left the "End of the log"
        // marker up permanently.
        setReachedEnd(snap.docs.length < PAGE_SIZE);
      },
      (err) => {
        console.warn('CoachXpLog listener failed', err);
        // Missing index or rule denial both land here. Show an empty
        // list rather than a spinner-forever state, and remember rule
        // denial for a targeted message.
        setFirstPage([]);
        setExtraPages([]);
        setReachedEnd(true);
        if (String(err?.code || '').includes('permission')) setRuleDenied(true);
      },
    );
    return () => unsub();
  }, [selectedTeamId]);

  // Roster load, one-shot. Powers the player filter dropdown, the
  // avatar lookup, AND the sum-vs-total banner (player.xp is the source
  // of truth for a player's cumulative XP; the log's summed rows are a
  // subset of history). Tolerant of read failures.
  useEffect(() => {
    if (!selectedTeamId) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamId', '==', selectedTeamId));
        const snap = await getDocs(q);
        const rows: RosterEntry[] = snap.docs
          .map((d) => {
            const p = d.data() as Player & { profilePhotoUrl?: string | null };
            return {
              id: d.id,
              name: p.name || 'Player',
              photoUrl: (p as any).profilePhotoUrl || null,
              xp: Number((p as any).xp) || 0,
            };
          })
          .filter((p) => !!p.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setRoster(rows);
      } catch (err) {
        console.warn('CoachXpLog roster read failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  const rosterById = useMemo(() => {
    const m = new Map<string, RosterEntry>();
    roster.forEach((p) => m.set(p.id, p));
    return m;
  }, [roster]);

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (playerFilter !== 'all' && r.playerId !== playerFilter) return false;
      if (disabledSources.has(r.source)) return false;
      return true;
    });
  }, [rows, playerFilter, disabledSources]);

  // 7-day summary — always computed off the full loaded window (not
  // the filtered view) so a source filter doesn't visually change the
  // top card's numbers, which would read as broken.
  const summary = useMemo(() => {
    if (!rows) return { totalXp: 0, uniquePlayers: 0, topName: null as string | null, topXp: 0 };
    const cutoff = Date.now() - SUMMARY_WINDOW_MS;
    const recent = rows.filter((r) => r.createdAtMs >= cutoff);
    let totalXp = 0;
    const perPlayer = new Map<string, { name: string; xp: number }>();
    for (const r of recent) {
      totalXp += r.xp;
      const prev = perPlayer.get(r.playerId);
      if (prev) prev.xp += r.xp;
      else perPlayer.set(r.playerId, { name: r.playerName, xp: r.xp });
    }
    let topName: string | null = null;
    let topXp = 0;
    perPlayer.forEach((v) => {
      if (v.xp > topXp) {
        topXp = v.xp;
        topName = v.name;
      }
    });
    return { totalXp, uniquePlayers: perPlayer.size, topName, topXp };
  }, [rows]);

  // Sources that actually appear in the loaded window, so the source
  // filter chips only list categories the coach has data for. Ordered
  // by the coach-log canonical order first, then any surprise sources
  // trailing (alphabetical) so a new writer surfaces without a code
  // change here.
  const sourceOptions = useMemo(() => {
    if (!rows) return [] as string[];
    const seen = new Set<string>();
    rows.forEach((r) => { if (r.source) seen.add(r.source); });
    const canonical = COACH_LOG_SOURCE_OPTIONS.filter((s) => seen.has(s));
    const extras = Array.from(seen)
      .filter((s) => !canonical.includes(s))
      .sort();
    return [...canonical, ...extras];
  }, [rows]);

  // Fold filtered rows into Denver-day groups. Sort groups newest-first
  // by the group's most-recent row (not the day key alphabetically) so
  // the ordering matches "most recent activity" intuition regardless of
  // clock changes or roadtrip tz shifts.
  const dayGroups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const r of filteredRows) {
      const key = r.createdAtMs ? denverKeyOfDate(new Date(r.createdAtMs)) : 'unknown';
      let group = map.get(key);
      if (!group) {
        group = { key, latestMs: r.createdAtMs, rows: [], totalXp: 0, hasCoachRow: false };
        map.set(key, group);
      }
      group.rows.push(r);
      group.totalXp += r.xp;
      if (r.createdAtMs > group.latestMs) group.latestMs = r.createdAtMs;
      if (COACH_AUTHORED_SOURCES.has(r.source)) group.hasCoachRow = true;
    }
    return Array.from(map.values()).sort((a, b) => b.latestMs - a.latestMs);
  }, [filteredRows]);

  // Sum-vs-total reconciliation for the banner. Compares the sum of xp
  // across the currently-visible-and-filtered rows to the ground-truth
  // player.xp (or team-wide sum when unfiltered). We only surface a
  // banner when the log undershoots the truth — that's the "some
  // history isn't logged" story worth explaining. Overshoots would
  // signal a real bug (audit drift), not a UX explanation moment.
  const banner = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    if (roster.length === 0) return null;
    // Player-scoped subset that matches the currently-selected player
    // filter, ignoring the source filter (a source filter would create
    // an artificial gap we don't want to explain — that's the coach
    // knowingly hiding rows).
    const scoped = rows.filter((r) => playerFilter === 'all' || r.playerId === playerFilter);
    const logSum = scoped.reduce((n, r) => n + r.xp, 0);
    let truth = 0;
    if (playerFilter === 'all') {
      truth = roster.reduce((n, p) => n + (p.xp || 0), 0);
    } else {
      truth = rosterById.get(playerFilter)?.xp || 0;
    }
    if (truth <= 0) return null;
    if (logSum >= truth) return null;
    const enabledAtRaw = (selectedTeam as any)?.xpConfig?.enabledAt;
    const enabledAtMs = enabledAtRaw ? toMillis(enabledAtRaw) : 0;
    return { logSum, truth, enabledAtMs };
  }, [rows, roster, rosterById, playerFilter, selectedTeam]);

  const loadMore = async () => {
    if (loadingMore || reachedEnd || !selectedTeamId || !lastCursor) return;
    setLoadingMore(true);
    try {
      const q = query(
        collection(db, 'player_xp_events'),
        where('teamId', '==', selectedTeamId),
        orderBy('createdAt', 'desc'),
        startAfter(lastCursor),
        fsLimit(PAGE_SIZE),
      );
      const snap = await getDocs(q);
      const more = snap.docs.map(rowFromDoc);
      // Append to extraPages so a live snapshot tick doesn't wipe them.
      setExtraPages((prev) => [...prev, ...more]);
      setLastCursor(snap.docs.length ? snap.docs[snap.docs.length - 1] : lastCursor);
      if (snap.docs.length < PAGE_SIZE) setReachedEnd(true);
    } catch (err) {
      console.warn('CoachXpLog loadMore failed', err);
      setReachedEnd(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleSource = (source: string) => {
    setDisabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };

  const clearSourceFilter = () => setDisabledSources(new Set());

  const toggleDay = (key: string, currentlyExpanded: boolean) => {
    setExpandedOverride((prev) => {
      const next = new Map(prev);
      next.set(key, !currentlyExpanded);
      return next;
    });
  };

  const isDayExpanded = (day: DayGroup): boolean => {
    const override = expandedOverride.get(day.key);
    if (override !== undefined) return override;
    return day.hasCoachRow;
  };

  // Conditional returns AFTER hooks.
  if (!userData) return <Navigate to="/login" replace />;

  if (!selectedTeam) {
    return (
      <div className="min-h-screen bg-surface-base text-ink-primary">
        <Header title="XP log" />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
          <p className="text-sm text-ink-primary/70">
            Pick a team from the header to see the XP log.
          </p>
        </div>
      </div>
    );
  }

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);
  if (!coachOnThisTeam) {
    return (
      <div className="min-h-screen bg-surface-base text-ink-primary">
        <Header title="XP log" />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
            <p className="text-sm font-bold text-ink-primary">Coach access required</p>
            <p className="mt-1 text-sm text-ink-primary/70 leading-relaxed">
              This surface is for the coaches on this team. If you should be listed as a coach here,
              ask the head coach to add you from Staff.
            </p>
            <Link
              to="/coach"
              className="mt-3 inline-flex items-center min-h-[44px] px-4 rounded-full bg-brand-primary text-white text-sm font-bold"
            >
              Back to Coach
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      <Header title="XP log" subtitle="Every XP grant on this team, most recent first." />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">

        {/* Sum-vs-total banner — quiet, single line, explains the gap
            between what the log shows and player.xp when we're
            undershooting the total (usually because history predates
            the log or the coach filtered to a player who has activity
            beyond the loaded window). */}
        {banner && (
          <ReconciliationBanner
            logSum={banner.logSum}
            truth={banner.truth}
            enabledAtMs={banner.enabledAtMs}
            scoped={playerFilter !== 'all'}
          />
        )}

        {/* Summary card — last 7 days at a glance */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
          <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">
            Last 7 days
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <SummaryStat
              value={summary.totalXp.toLocaleString()}
              suffix="XP"
              label="awarded"
            />
            <SummaryStat
              value={String(summary.uniquePlayers)}
              label={summary.uniquePlayers === 1 ? 'player earning' : 'players earning'}
            />
            <SummaryStat
              value={summary.topName ? summary.topName.split(/\s+/)[0] : 'nobody yet'}
              label={summary.topName ? `${summary.topXp.toLocaleString()} XP top earner` : 'top earner'}
              tone={summary.topName ? 'brand' : 'muted'}
            />
          </div>
        </section>

        {/* Filters — player dropdown (single-select) + source chips
            (multi-select, persisted per-user). Coach XP volume is now
            large enough that a single-select source is a footgun: hide
            "practice tap" and you lose the whole habit column instead
            of just muting it. */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-3 sm:p-4 space-y-3">
          <FilterSelect
            label="Player"
            value={playerFilter}
            onChange={setPlayerFilter}
            options={[
              { value: 'all', label: 'All players' },
              ...roster.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {sourceOptions.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="block text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">
                  Sources
                </span>
                {disabledSources.size > 0 && (
                  <button
                    type="button"
                    onClick={clearSourceFilter}
                    className="text-[11px] font-semibold text-brand-primary min-h-[28px]"
                  >
                    Show all
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sourceOptions.map((s) => {
                  const enabled = !disabledSources.has(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleSource(s)}
                      aria-pressed={enabled}
                      className={
                        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold ring-1 transition min-h-[32px] ' +
                        (enabled
                          ? 'bg-brand-primary/10 text-brand-primary ring-brand-primary/30'
                          : 'bg-surface-base text-ink-primary/45 ring-line-default/20')
                      }
                    >
                      <span
                        className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClassForSource(s as any)} ${enabled ? '' : 'opacity-40'}`}
                        aria-hidden
                      />
                      {coachSourceLabel(s)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Feed */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 overflow-hidden">
          {rows === null ? (
            // Atomic-render pattern — no skeleton. Empty until the
            // snapshot resolves.
            <div className="h-24" aria-hidden />
          ) : ruleDenied ? (
            <div className="p-5 text-sm text-ink-primary/70">
              Couldn't load the log for this team. Ask the head coach to confirm you're listed
              on the team's coach roster.
            </div>
          ) : rows.length === 0 ? (
            <div className="p-5 text-sm text-ink-primary/70 leading-relaxed">
              No XP has been awarded on this team yet. It'll show up here as kids tap "I did it,"
              streak days land, and you send kudos or coach recognitions.
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="p-5 text-sm text-ink-primary/70 leading-relaxed">
              Nothing matches those filters yet. Try clearing one to widen the view.
            </div>
          ) : (
            <ul className="divide-y divide-line-default/15">
              {dayGroups.map((day) => {
                const expanded = isDayExpanded(day);
                return (
                  <li key={day.key}>
                    <DayHeader
                      day={day}
                      expanded={expanded}
                      onToggle={() => toggleDay(day.key, expanded)}
                    />
                    {expanded && (
                      <ul className="divide-y divide-line-default/10 border-t border-line-default/15 bg-surface-base/40">
                        {day.rows.map((row) => (
                          <LogRow key={row.id} row={row} roster={rosterById} />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {rows && rows.length > 0 && !reachedEnd && (
            <div className="border-t border-line-default/15 p-3">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full min-h-[44px] rounded-xl bg-brand-primary/10 text-brand-primary text-sm font-bold hover:bg-brand-primary/15 active:bg-brand-primary/20 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}

          {rows && rows.length > 0 && reachedEnd && (
            <p className="border-t border-line-default/15 py-3 text-center text-[11px] text-ink-primary/45">
              End of the log.
            </p>
          )}
        </section>

        <div className="pt-2">
          <Link
            to="/coach/xp"
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-primary min-h-[44px]"
          >
            Back to Player XP settings
          </Link>
        </div>
      </div>
    </div>
  );
};

// ─── Day header ─────────────────────────────────────────────────
const DayHeader: React.FC<{
  day: DayGroup;
  expanded: boolean;
  onToggle: () => void;
}> = ({ day, expanded, onToggle }) => {
  const eventLabel = day.rows.length === 1 ? '1 event' : `${day.rows.length} events`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full flex items-center gap-3 px-4 sm:px-5 py-3 text-left hover:bg-surface-base/60 active:bg-surface-base/80 transition min-h-[52px]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[14px] font-bold text-ink-primary truncate">
            {dayHeaderLabel(day.latestMs)}
          </span>
          {day.hasCoachRow && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[9px] font-black uppercase tracking-wider">
              Coach
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2 text-[12px] text-ink-primary/60">
          <span className="font-bold tabular-nums text-ink-primary/80">
            +{day.totalXp.toLocaleString()} XP
          </span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{eventLabel}</span>
        </div>
      </div>
      <svg
        className={`shrink-0 w-4 h-4 text-ink-primary/40 transition-transform ${expanded ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
};

// ─── Row ─────────────────────────────────────────────────────────
const LogRow: React.FC<{ row: XpRow; roster: Map<string, RosterEntry> }> = ({ row, roster }) => {
  const player = roster.get(row.playerId);
  const photoUrl = player?.photoUrl || null;
  const displayName = player?.name || row.playerName;
  const sourceLabel = coachSourceLabel(row.source);
  const isCoachAction = COACH_AUTHORED_SOURCES.has(row.source);
  const showCoach = isCoachAction && !!row.awardedByName;
  const chipTone = chipToneForSource(row.source);

  // Two-tier visual weight: coach-authored rows read bold with a colored
  // chip; silent/auto rows recede to muted secondary ink so the coach's
  // eye lands on the moments they actually authored inside a noisy day.
  const nameClass = isCoachAction
    ? 'text-[14px] font-bold text-ink-primary'
    : 'text-[13px] font-semibold text-ink-primary/75';
  const xpChipClass = isCoachAction
    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[11px] font-black'
    : 'bg-ink-secondary/10 text-ink-primary/60 text-[10px] font-bold';
  const sourceChipClass =
    chipTone === 'amber'
      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      : chipTone === 'brand'
        ? 'bg-brand-primary/12 text-brand-primary'
        : 'bg-ink-secondary/10 text-ink-primary/55';
  const noteClass = isCoachAction
    ? 'mt-1 text-[12px] italic text-ink-primary/75 leading-snug whitespace-pre-wrap break-words'
    : 'mt-1 text-[11px] text-ink-primary/55 leading-snug whitespace-pre-wrap break-words';

  return (
    <li className="px-4 sm:px-5 py-2.5 flex items-start gap-3">
      {/* Player avatar (always present so name-column alignment stays
          consistent across coach and silent rows). Silent rows tone
          down chrome elsewhere; the avatar helps a coach scan by kid. */}
      <div className="shrink-0">
        {photoUrl ? (
          <img
            src={photoUrl}
            alt=""
            className={`${isCoachAction ? 'w-9 h-9' : 'w-7 h-7'} rounded-full object-cover ring-1 ring-line-default/20`}
          />
        ) : (
          <div
            className={`${isCoachAction ? 'w-9 h-9 text-[12px]' : 'w-7 h-7 text-[10px]'} rounded-full bg-brand-primary/10 text-brand-primary ring-1 ring-line-default/20 flex items-center justify-center font-black`}
          >
            {initialsOf(displayName)}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* Line 1: name + XP chip + source chip + when */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`shrink-0 truncate max-w-[10rem] ${nameClass}`}>
            {displayName}
          </span>
          <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full tabular-nums ${xpChipClass}`}>
            +{row.xp} XP
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${sourceChipClass}`}
          >
            <span
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClassForSource(row.source as any)}`}
              aria-hidden
            />
            <span className="truncate">{sourceLabel}</span>
          </span>
          {row.backfilled && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-ink-secondary/10 text-ink-primary/55 text-[10px] uppercase tracking-wider font-bold">
              Retro
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-ink-primary/50 tabular-nums">
            {timeOnlyLabel(row.createdAtMs) || whenLabel(row.createdAtMs)}
          </span>
        </div>

        {/* Line 2: coach note (italic on coach rows, plain on silent) */}
        {row.note && (
          <p className={noteClass}>
            {row.note}
          </p>
        )}

        {/* Line 3: awarded-by attribution for coach actions */}
        {showCoach && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-primary/55">
            {row.awardedByAvatarUrl ? (
              <img
                src={row.awardedByAvatarUrl}
                alt=""
                className="w-4 h-4 rounded-full object-cover"
              />
            ) : (
              <span className="w-4 h-4 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center text-[8px] font-black">
                {initialsOf(row.awardedByName || 'Coach')}
              </span>
            )}
            <span className="truncate">from {row.awardedByName}</span>
          </div>
        )}
      </div>
    </li>
  );
};

// ─── Reconciliation banner ──────────────────────────────────────
const ReconciliationBanner: React.FC<{
  logSum: number;
  truth: number;
  enabledAtMs: number;
  scoped: boolean;
}> = ({ logSum, truth, enabledAtMs, scoped }) => {
  const totalLabel = scoped ? 'Player total' : 'Team total';
  const historyStart = enabledAtMs
    ? `History from before ${shortDate(enabledAtMs)} isn't logged.`
    : 'Older activity may pre-date the log.';
  return (
    <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 px-4 py-3">
      <p className="text-[12px] leading-snug text-ink-primary/70">
        <span className="font-semibold text-ink-primary/85">
          Log shows {logSum.toLocaleString()} XP of history.
        </span>{' '}
        {totalLabel} is {truth.toLocaleString()} XP. {historyStart}
      </p>
    </section>
  );
};

// ─── Small building blocks ───────────────────────────────────────
const SummaryStat: React.FC<{
  value: string;
  suffix?: string;
  label: string;
  tone?: 'default' | 'brand' | 'muted';
}> = ({ value, suffix, label, tone = 'default' }) => {
  const valueClass =
    tone === 'brand'
      ? 'text-brand-primary'
      : tone === 'muted'
        ? 'text-ink-primary/45'
        : 'text-ink-primary';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1">
        <span className={`text-xl sm:text-2xl font-black tabular-nums truncate ${valueClass}`}>
          {value}
        </span>
        {suffix && (
          <span className="text-[11px] font-bold text-ink-primary/55">{suffix}</span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-primary/55 leading-snug">{label}</p>
    </div>
  );
};

const FilterSelect: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ label, value, onChange, options }) => (
  <label className="block">
    <span className="block text-[10px] uppercase tracking-widest font-bold text-ink-primary/55 mb-1">
      {label}
    </span>
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[44px] appearance-none rounded-xl bg-surface-base ring-1 ring-line-default/20 pl-3 pr-9 text-sm font-semibold text-ink-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-primary/40 pointer-events-none"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  </label>
);

export default CoachXpLog;
