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
//     name lookup and the player filter dropdown.
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
// Silent-grant gap: the daily "I did it" / RSVP / attendance / streak
// grants currently bypass player_xp_events (see reference in the
// project spec). They won't show here until those writers route
// through a worker endpoint. Copy in the empty state and the summary
// caption acknowledges that so the log doesn't read as "broken" when
// a team is XP-on but hasn't taken a coach action yet.

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

const PAGE_SIZE = 200;
const SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

// Initials for the fallback avatar circle. Two letters max so it
// always fits without truncation.
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const CoachXpLog: React.FC = () => {
  const { selectedTeamId } = useTeam();
  return <CoachXpLogInner key={selectedTeamId || 'no-team'} />;
};

const CoachXpLogInner: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();

  // Hooks BEFORE any conditional return (per hooks-before-returns memory).
  const [rows, setRows] = useState<XpRow[] | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [lastCursor, setLastCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playerFilter, setPlayerFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [ruleDenied, setRuleDenied] = useState(false);

  // Live listener for the first page. Reset on team change (component
  // keyed on selectedTeamId in the wrapper).
  useEffect(() => {
    if (!selectedTeamId) {
      setRows([]);
      setReachedEnd(true);
      return;
    }
    setRows(null);
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
        setRows(next);
        setLastCursor(snap.docs.length ? snap.docs[snap.docs.length - 1] : null);
        if (snap.docs.length < PAGE_SIZE) setReachedEnd(true);
      },
      (err) => {
        console.warn('CoachXpLog listener failed', err);
        // Missing index or rule denial both land here. Show an empty
        // list rather than a spinner-forever state, and remember rule
        // denial for a targeted message.
        setRows([]);
        setReachedEnd(true);
        if (String(err?.code || '').includes('permission')) setRuleDenied(true);
      },
    );
    return () => unsub();
  }, [selectedTeamId]);

  // Roster load, one-shot. Powers the player filter dropdown and the
  // avatar lookup. Tolerant of read failures.
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
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      return true;
    });
  }, [rows, playerFilter, sourceFilter]);

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
  // dropdown only lists categories the coach has data for. Ordered by
  // the coach-log canonical order first, then any surprise sources
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
      setRows((prev) => (prev ? [...prev, ...more] : more));
      setLastCursor(snap.docs.length ? snap.docs[snap.docs.length - 1] : lastCursor);
      if (snap.docs.length < PAGE_SIZE) setReachedEnd(true);
    } catch (err) {
      console.warn('CoachXpLog loadMore failed', err);
      setReachedEnd(true);
    } finally {
      setLoadingMore(false);
    }
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
              value={summary.topName ? summary.topName.split(/\s+/)[0] : '—'}
              label={summary.topName ? `${summary.topXp.toLocaleString()} XP top earner` : 'top earner'}
              tone={summary.topName ? 'brand' : 'muted'}
            />
          </div>
          {rows && rows.length > 0 && (
            <p className="mt-3 text-[11px] text-ink-primary/50 leading-snug">
              Numbers pull from coach actions (recognitions, whispers, kudos) and milestone badges.
              Silent daily grants show up on player profiles today; they'll appear here as they get
              wired into the log.
            </p>
          )}
        </section>

        {/* Filters */}
        <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-3 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <FilterSelect
              label="Player"
              value={playerFilter}
              onChange={setPlayerFilter}
              options={[
                { value: 'all', label: 'All players' },
                ...roster.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <FilterSelect
              label="Source"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: 'all', label: 'All sources' },
                ...sourceOptions.map((s) => ({ value: s, label: coachSourceLabel(s) })),
              ]}
            />
          </div>
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
              {filteredRows.map((row) => (
                <LogRow key={row.id} row={row} roster={rosterById} />
              ))}
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

// ─── Row ─────────────────────────────────────────────────────────
const LogRow: React.FC<{ row: XpRow; roster: Map<string, RosterEntry> }> = ({ row, roster }) => {
  const player = roster.get(row.playerId);
  const photoUrl = player?.photoUrl || null;
  const displayName = player?.name || row.playerName;
  const sourceLabel = coachSourceLabel(row.source);
  const isCoachAction = ['coach_live', 'coach_whisper', 'coach_recognition', 'kudos_coach_convert'].includes(row.source);
  const showCoach = isCoachAction && !!row.awardedByName;

  return (
    <li className="px-4 sm:px-5 py-3 flex items-start gap-3">
      {/* Player avatar */}
      <div className="shrink-0">
        {photoUrl ? (
          <img
            src={photoUrl}
            alt=""
            className="w-10 h-10 rounded-full object-cover ring-1 ring-line-default/20"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-brand-primary/10 text-brand-primary ring-1 ring-line-default/20 flex items-center justify-center text-[12px] font-black">
            {initialsOf(displayName)}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* Line 1: name + XP chip + source + when */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="shrink-0 text-[14px] font-bold text-ink-primary truncate max-w-[10rem]">
            {displayName}
          </span>
          <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[11px] font-black tabular-nums">
            +{row.xp} XP
          </span>
          <span className="inline-flex items-center gap-1.5 min-w-0 text-[12px] text-ink-primary/70">
            <span
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClassForSource(row.source as any)}`}
              aria-hidden
            />
            <span className="truncate">{sourceLabel}</span>
            {row.backfilled && (
              <span className="ml-1 shrink-0 text-[10px] uppercase tracking-wider text-ink-primary/50 font-bold">
                retro
              </span>
            )}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-ink-primary/55 tabular-nums">
            {whenLabel(row.createdAtMs)}
          </span>
        </div>

        {/* Line 2: coach note (italic) */}
        {row.note && (
          <p className="mt-1 text-[12px] italic text-ink-primary/70 leading-snug whitespace-pre-wrap break-words">
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
