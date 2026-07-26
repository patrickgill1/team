// NextMatchCountdownCard — prominent Dashboard card for ADULT teams
// only. Shows the next upcoming game/tournament within the next 14
// days with a live countdown ("Tonight at 7:00 PM", "In 3h 20m",
// "3d 5h"), opponent, home/away pill, kickoff formatted in America/
// Denver, a "N of X teammates going" social-proof line, and a big
// RSVP CTA (collapses to a "You're going" chip once the viewer has
// answered going).
//
// Silent when there's no qualifying event — parent never renders
// this card on youth teams (TodaysDevelopmentCard already fills the
// top slot on those). See Dashboard.tsx for the gate + placement
// (top of the parent-mode section, above MyPlayerCard / SiblingCarousel).

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarEvent } from '../../types';

interface Props {
  /** The next upcoming game or tournament event (already filtered by
   *  the parent to type === 'game' | 'tournament' and within the
   *  14-day window). */
  event: CalendarEvent;
  /** Squad size — denominator for the "N of X teammates going" line.
   *  Falsy / 0 hides the social-proof row so we don't render
   *  "0 of 0" during initial load. */
  teamPlayerCount: number;
  /** Viewer's own player id on this adult team (their linked player
   *  from Dashboard's myPlayers[0]). Used to check the "You're going"
   *  state; when undefined the RSVP button still renders but the
   *  going chip won't. */
  myPlayerId?: string;
  /** Same signature as Dashboard's rsvpForEvent — the kid-vs-self
   *  dispatch (adult: writes playerRsvps[myPlayerId]) is handled by
   *  the parent, so this component just fires the intent. */
  onRsvp: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
}

// Denver-anchored calendar-day key (YYYY-MM-DD). Used so an ET user
// at 11pm doesn't see "Tomorrow" for a Utah event that's still today
// in Denver. Matches the timezone anchor used by eventTiming.ts.
function denverDayKey(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Denver hour-of-day (0-23) — drives "Tonight" vs "Today" flavoring
// on same-day countdowns.
function denverHour(d: Date): number {
  try {
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit', hour12: false,
    }).format(d);
    return Number(raw) % 24;
  } catch {
    return d.getHours();
  }
}

// "Sat Aug 2 · 7:00 PM" — the concrete kickoff line under the
// countdown. Always in Denver so a coach's travel to another
// timezone doesn't flip the time on the family reading the app back
// home. Uses a middle dot (·), not an em dash (memory: no em
// dashes in user-facing copy).
function formatDenverKickoff(d: Date): string {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', weekday: 'short',
  }).format(d);
  const md = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', month: 'short', day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit',
  }).format(d);
  return `${wd} ${md} · ${time}`;
}

// Big countdown line. Buckets:
//   * <= 1 min  -> "Starting now"
//   * < 60 min  -> "In N min"
//   * < 6 h w/ leftover mins -> "In 2h 15m"
//   * < 12 h    -> "In N hours"
//   * same Denver day, evening -> "Tonight at 7:00 PM"
//   * same Denver day, earlier -> "Today at 3:00 PM"
//   * next Denver day          -> "Tomorrow at 7:00 PM"
//   * < 7 days                 -> "Saturday at 7:00 PM"
//   * >= 7 days                -> "9d 4h" / "12d"
function computeCountdown(start: Date, now: Date): string {
  const ms = start.getTime() - now.getTime();
  if (ms <= 60_000) return 'Starting now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `In ${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 6 && remMins > 0) return `In ${hours}h ${remMins}m`;
  if (hours < 12) return `In ${hours} hour${hours === 1 ? '' : 's'}`;
  const nowKey = denverDayKey(now);
  const startKey = denverDayKey(start);
  const timeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit',
  }).format(start);
  if (nowKey === startKey) {
    return denverHour(start) >= 17 ? `Tonight at ${timeStr}` : `Today at ${timeStr}`;
  }
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days === 1) return `Tomorrow at ${timeStr}`;
  if (days < 7) {
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', weekday: 'long',
    }).format(start);
    return `${wd} at ${timeStr}`;
  }
  const totalHours = Math.floor(ms / (60 * 60 * 1000));
  const dPart = Math.floor(totalHours / 24);
  const hPart = totalHours % 24;
  return hPart > 0 ? `${dPart}d ${hPart}h` : `${dPart}d`;
}

const HomeAwayPill: React.FC<{ homeAway?: 'home' | 'away' }> = ({ homeAway }) => {
  if (homeAway !== 'home' && homeAway !== 'away') return null;
  const isHome = homeAway === 'home';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-[0.18em] ring-1 ${
        isHome
          ? 'bg-emerald-500/12 ring-emerald-400/40 text-emerald-700 dark:text-emerald-300'
          : 'bg-sky-500/12 ring-sky-400/40 text-sky-700 dark:text-sky-300'
      }`}
    >
      {isHome ? 'Home' : 'Away'}
    </span>
  );
};

const PinIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="5 12 10 17 19 8" />
  </svg>
);

const NextMatchCountdownCard: React.FC<Props> = ({ event, teamPlayerCount, myPlayerId, onRsvp }) => {
  // Recompute countdown every 30s so "In 3 hours" trickles down to
  // "In 2h 45m" -> "In 2 hours" without the user having to refresh.
  // A 30s cadence is plenty tight for a card whose finest bucket is
  // 1 minute; keeps timer churn negligible in the background.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const start = useMemo(() => {
    const raw: any = (event as any).date;
    if (raw?.toDate) return raw.toDate() as Date;
    if (raw instanceof Date) return raw;
    return new Date(raw);
  }, [event]);

  const countdown = useMemo(() => computeCountdown(start, now), [start, now]);
  const kickoff = useMemo(() => formatDenverKickoff(start), [start]);

  const opponentLine = (event.opponent && event.opponent.trim())
    || (event.title && event.title.trim())
    || 'Next match';

  // "N of X teammates going" — counts entries in event.playerRsvps
  // with status === 'going'. Denominator is the passed-in squad size.
  // Hide the line entirely when we don't know the squad size yet
  // (initial load) to avoid a "0 of 0 teammates going" flash.
  const goingCount = useMemo(() => {
    const map = (event as any).playerRsvps as
      | Record<string, { status?: string }>
      | undefined;
    if (!map) return 0;
    let n = 0;
    for (const v of Object.values(map)) {
      if (v?.status === 'going') n++;
    }
    return n;
  }, [event]);

  // "You're going" state — driven by the viewer's own playerRsvps
  // entry. If the viewer doesn't have a linked player on this squad
  // (edge case: a coach who hasn't added themselves), the button
  // just stays as an RSVP prompt.
  const myStatus = useMemo(() => {
    if (!myPlayerId) return null;
    const map = (event as any).playerRsvps as
      | Record<string, { status?: string }>
      | undefined;
    return (map && map[myPlayerId]?.status) || null;
  }, [event, myPlayerId]);

  const [busy, setBusy] = useState<null | 'going' | 'maybe' | 'no'>(null);
  const handleGoing = async () => {
    if (busy) return;
    setBusy('going');
    try {
      await onRsvp(event.id, 'going');
    } finally {
      // Small delay so a fast optimistic response doesn't visibly
      // flash the busy state off before the parent re-renders.
      setTimeout(() => setBusy(null), 200);
    }
  };
  const handleMaybe = async () => {
    if (busy) return;
    setBusy('maybe');
    try {
      await onRsvp(event.id, 'maybe');
    } finally {
      setTimeout(() => setBusy(null), 200);
    }
  };
  const handleOut = async () => {
    if (busy) return;
    setBusy('no');
    try {
      await onRsvp(event.id, 'no');
    } finally {
      setTimeout(() => setBusy(null), 200);
    }
  };

  const location = (event.location || '').trim();

  return (
    <section
      className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-brand-primary/25 shadow-lg shadow-black/5"
      aria-label="Next match"
    >
      {/* Thin accent stripe at the top so the card reads as the
          highest-priority thing on the page without needing a full
          brand-tinted background (which would fight the RSVP CTA). */}
      <div className="absolute inset-x-0 top-0 h-1 bg-brand-primary/70" aria-hidden />

      <div className="relative px-4 pt-4 pb-4 sm:px-5 sm:pt-5 sm:pb-5">
        {/* Kicker */}
        <div className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.28em] text-brand-primary">
          <span>Next Match</span>
        </div>

        {/* Countdown — the biggest text on the card. Tabular nums so
            "In 2h 45m" doesn't jitter width when the minute rolls. */}
        <div className="mt-2 text-2xl sm:text-3xl font-black text-ink-primary tracking-tight tabular-nums">
          {countdown}
        </div>

        {/* Opponent + Home/Away pill row */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0 text-base sm:text-lg font-bold text-ink-primary truncate">
            {opponentLine}
          </div>
          <HomeAwayPill homeAway={event.homeAway} />
        </div>

        {/* Kickoff time + location */}
        <div className="mt-1.5 text-xs sm:text-sm text-ink-primary/65 font-medium">
          <span className="tabular-nums">{kickoff}</span>
          {location && (
            <>
              <span className="mx-1.5 text-ink-primary/30">{'·'}</span>
              <span className="inline-flex items-center gap-1 align-middle">
                <PinIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{location}</span>
              </span>
            </>
          )}
        </div>

        {/* Social proof — "N of X teammates going". Positive framing
            per the attendance-motivation ask. Silent when the squad
            size isn't known yet. */}
        {teamPlayerCount > 0 && (
          <div className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-primary/60">
            <span className="text-emerald-700 dark:text-emerald-300 tabular-nums">
              {goingCount}
            </span>
            <span className="text-ink-primary/50"> of </span>
            <span className="tabular-nums">{teamPlayerCount}</span>
            <span className="text-ink-primary/50"> teammates going</span>
          </div>
        )}

        {/* RSVP action row. Once the viewer is 'going', collapse the
            three-button row into a single confirmation chip so the
            card stops asking a question it already knows the answer
            to. Any other status (maybe / no / null) keeps the full
            tri-state so they can flip in one tap. */}
        {myStatus === 'going' ? (
          <div className="mt-4 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/12 ring-1 ring-emerald-400/40 text-emerald-700 dark:text-emerald-300 text-xs font-black uppercase tracking-[0.2em]">
            <CheckIcon className="w-4 h-4" />
            You&apos;re going
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={handleGoing}
              disabled={busy !== null}
              className="col-span-1 inline-flex items-center justify-center px-3 py-2.5 rounded-lg bg-brand-primary hover:brightness-110 text-white text-xs font-black uppercase tracking-[0.18em] shadow shadow-brand-primary/30 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy === 'going' ? 'Saving' : 'Going'}
            </button>
            <button
              type="button"
              onClick={handleMaybe}
              disabled={busy !== null}
              className={`col-span-1 inline-flex items-center justify-center px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-[0.18em] ring-1 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed ${
                myStatus === 'maybe'
                  ? 'bg-amber-500/15 ring-amber-400/50 text-amber-700 dark:text-amber-300'
                  : 'bg-surface-elevated ring-line-default/30 text-ink-primary/80 hover:bg-surface-elevated/70'
              }`}
            >
              {busy === 'maybe' ? 'Saving' : 'Maybe'}
            </button>
            <button
              type="button"
              onClick={handleOut}
              disabled={busy !== null}
              className={`col-span-1 inline-flex items-center justify-center px-3 py-2.5 rounded-lg text-xs font-black uppercase tracking-[0.18em] ring-1 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed ${
                myStatus === 'no'
                  ? 'bg-rose-500/12 ring-rose-400/40 text-rose-700 dark:text-rose-300'
                  : 'bg-surface-elevated ring-line-default/30 text-ink-primary/80 hover:bg-surface-elevated/70'
              }`}
            >
              {busy === 'no' ? 'Saving' : 'Out'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
};

export default NextMatchCountdownCard;
