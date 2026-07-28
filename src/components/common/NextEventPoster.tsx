// The dashboard's anchor card. Replaces the old DashboardHero
// (which used the time-of-day photo as ambient wallpaper). The
// photo is now the bg of THIS card and only this card, with the
// next-event info layered on top and inline RSVP buttons. The
// chrome above is allowed to be flat charcoal — no photo bleed
// gymnastics, no hard-line problem. Patrick: "if we can find a
// way to utilize the photo, I would love that. I love the rsvp
// thing, that's been hard."

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { WeatherSummary } from '../../utils/weather';
import WeatherIcon from './WeatherIcon';

type RsvpStatus = 'going' | 'maybe' | 'no';

interface Props {
  greeting: string;
  firstName: string;
  nextEvent: CalendarEvent | null;
  whenText: string;
  weather: WeatherSummary | null;
  goingCount: number;
  pendingCount: number;
  /** Roster size or other empty-state context. */
  playerCount: number;
  isCoach: boolean;
  /** Current user's RSVP for the event, if any. For coaches and
   *  parents-with-no-linked-kids this is their own status. For
   *  parents with linked kids it's the GROUP status (only set when
   *  all linked kids share a status, otherwise null). */
  currentStatus: RsvpStatus | null;
  /** Label to show ON the Going button when not active — varies
   *  with kid-mode ("Hunter going" / "All going" / "I'm going"). */
  goingLabel: string;
  /** Same for Can't. ("Can't go" / "None going") */
  noLabel: string;
  onRsvp: (status: RsvpStatus) => void | Promise<void>;
  hourOverride?: number;
  /** Optional busy-parent digest: total count of unread/pending
   *  signals across chat/wall/events/RSVPs/kid-highlights. Renders
   *  as a slim strip under the greeting when > 0. Null/zero =
   *  hero looks exactly like today. Tap fires onOpenDigest. */
  digestTotal?: number;
  onOpenDigest?: () => void;
  /** Parent's linked players on this event's team. When length ≥ 2,
   *  the poster renders a "Different for one kid?" split affordance
   *  below the main RSVP row so mom can set Alice=going + Bob=no
   *  independently instead of the one-tap all-or-nothing default.
   *  Silent when 0-1 kids or when onPlayerRsvp isn't wired. */
  linkedPlayers?: Array<{ id: string; name: string }>;
  /** Per-kid RSVP status map, keyed by playerId. Only meaningful
   *  when linkedPlayers is set. Drives the active-highlight state on
   *  the per-kid mini pills so mom sees at a glance what she's set. */
  playerStatuses?: Record<string, RsvpStatus | null>;
  /** Per-kid RSVP write. Fires when a per-kid mini pill is tapped
   *  inside the expanded split. Dashboard implements the single-
   *  entry event.playerRsvps write path. */
  onPlayerRsvp?: (playerId: string, playerName: string, status: RsvpStatus) => void | Promise<void>;
}

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

type Scene = { phase: string; bgImage: string };
function sceneFor(hour: number): Scene {
  if (hour < 5.5) return { phase: 'night',   bgImage: '/images/hero/night.webp' };
  if (hour < 7)   return { phase: 'predawn', bgImage: '/images/hero/night.webp' };
  if (hour < 10)  return { phase: 'morning', bgImage: '/images/hero/morning.webp' };
  if (hour < 16)  return { phase: 'midday',  bgImage: '/images/hero/noon.webp' };
  if (hour < 19)  return { phase: 'sunset',  bgImage: '/images/hero/sunset.webp' };
  if (hour < 22)  return { phase: 'dusk',    bgImage: '/images/hero/night.webp' };
  return            { phase: 'night',   bgImage: '/images/hero/night.webp' };
}

const NextEventPoster: React.FC<Props> = ({
  greeting,
  firstName,
  nextEvent,
  whenText,
  weather,
  goingCount,
  pendingCount,
  playerCount,
  isCoach,
  currentStatus,
  goingLabel,
  noLabel,
  onRsvp,
  hourOverride,
  digestTotal = 0,
  onOpenDigest,
  linkedPlayers,
  playerStatuses,
  onPlayerRsvp,
}) => {
  const [now, setNow] = useState(() => new Date());
  // Split-by-kid disclosure. Only relevant when 2+ linked kids on
  // this team + a per-kid write handler is wired. Collapsed by
  // default so the one-tap "All going" path (the 95% case) stays
  // instant; expanded when mom needs to say "Alice yes, Bob sick".
  const [splitOpen, setSplitOpen] = useState(false);
  useEffect(() => {
    if (hourOverride !== undefined) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hourOverride]);

  const hour = hourOverride !== undefined ? hourOverride : now.getHours() + now.getMinutes() / 60;
  const scene = sceneFor(hour);

  const eventDate = nextEvent ? new Date(nextEvent.date) : null;
  const eventMonth = eventDate ? MONTHS_SHORT[eventDate.getMonth()] : '';
  const eventDay   = eventDate ? eventDate.getDate() : 0;
  const eventDow   = eventDate ? DOWS_SHORT[eventDate.getDay()] : '';
  const location: string = (nextEvent as any)?.location || '';
  // Development focus is a training concept — only surface on
  // practice events. On games/tournaments/social events the
  // "practice focus" pill reads as noise (and confuses players
  // scanning for kickoff details).
  const developmentFocus: string = (nextEvent as any)?.type === 'practice'
    ? ((nextEvent as any)?.developmentFocus || '').trim()
    : '';
  // Pill label prefix for the development focus. Was hardcoded
  // "Today: <focus>", which read wrong when the practice was
  // tomorrow / later this week. Compare event date to today in the
  // viewer's local tz so it always reads accurately.
  const focusPrefix = (() => {
    if (!eventDate) return 'Focus';
    const today = new Date();
    const sameDay = eventDate.getFullYear() === today.getFullYear()
      && eventDate.getMonth() === today.getMonth()
      && eventDate.getDate() === today.getDate();
    if (sameDay) return 'Today';
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const isTomorrow = eventDate.getFullYear() === tomorrow.getFullYear()
      && eventDate.getMonth() === tomorrow.getMonth()
      && eventDate.getDate() === tomorrow.getDate();
    if (isTomorrow) return 'Tomorrow';
    // Same week (next 6 days) — day-of-week is clearer than a date.
    const daysAhead = Math.floor((eventDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    if (daysAhead >= 0 && daysAhead < 7) {
      return DOWS_SHORT[eventDate.getDay()];
    }
    return 'Focus';
  })();

  // Empty state — no events on the calendar yet. Patrick: "can it
  // still show the field picture at the top during the process? I
  // think that really gives it from flare." A brand-new coach feels
  // the app's presence most when the hero photo greets them; the
  // small compact card we used to render here read as "nothing
  // happening." Now we render the SAME time-of-day photo + same
  // overlay treatment as the event card, just without the event-
  // specific bits and with a "Schedule your first event" CTA.
  if (!nextEvent || !eventDate) {
    return (
      <section className="px-3 sm:px-4 pt-3">
        <article
          className="next-event-poster relative overflow-hidden rounded-2xl ring-1 ring-line-default/10 shadow-2xl shadow-black/40 min-h-[300px] sm:min-h-[340px] flex flex-col"
        >
          <img
            src={scene.bgImage}
            alt=""
            aria-hidden
            loading="eager"
            className="absolute inset-0 w-full h-full object-cover brightness-125 saturate-110"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/20 to-black/65 pointer-events-none"
          />
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black/80 via-black/50 to-transparent pointer-events-none"
          />

          {/* Header row: kicker + greeting */}
          <div className="relative px-5 pt-5 sm:pt-6">
            <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-brand-primary-soft">
              {isCoach ? 'Welcome' : 'Hi'}
            </p>
            <p className="mt-1 text-sm text-white/80 drop-shadow">{greeting}, {firstName}</p>
            <DigestStrip total={digestTotal} onOpen={onOpenDigest} />
          </div>

          <div className="flex-1" />

          {/* Body: copy + roster chip + CTA */}
          <div className="relative px-5 pb-5 sm:pb-6 space-y-3">
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight leading-tight [text-shadow:0_2px_8px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                {isCoach ? "Let's get your team going." : 'No upcoming events yet.'}
              </h1>
              <p className="mt-1 text-sm font-medium text-white/90 [text-shadow:0_1px_5px_rgba(0,0,0,0.9)]">
                {isCoach
                  ? 'Add players, schedule a practice, invite parents. Then your dashboard fills in.'
                  : 'Check back soon for your next game or practice.'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Link
                to="/people"
                aria-label={`${playerCount} ${playerCount === 1 ? 'player' : 'players'} on roster`}
                className="shrink-0 flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-black/40 ring-1 ring-line-default/15 backdrop-blur-sm"
              >
                <span className="text-xl font-extrabold text-white leading-none tabular-nums">{playerCount}</span>
                <span className="text-[9px] font-bold tracking-widest text-white/70 mt-1">ROSTER</span>
              </Link>
              {isCoach && (
                <Link
                  to="/calendar"
                  className="inline-flex items-center justify-center px-4 py-2.5 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20 transition"
                >
                  Schedule your first event
                </Link>
              )}
            </div>
          </div>
        </article>
      </section>
    );
  }

  return (
    <section className="px-3 sm:px-4 pt-3">
      <article
        className="next-event-poster relative overflow-hidden rounded-2xl ring-1 ring-line-default/10 shadow-2xl shadow-black/40 min-h-[440px] sm:min-h-[480px] flex flex-col"
        aria-label={`Next up: ${nextEvent.title} on ${eventMonth} ${eventDay}`}
      >
        {/* Time-of-day photo as the poster bg. Object-cover so the
            scene fills the card; the overlay below ensures all
            content reads cleanly on any time of day. */}
        <img
          src={scene.bgImage}
          alt=""
          aria-hidden
          loading="eager"
          className="absolute inset-0 w-full h-full object-cover brightness-125 saturate-110"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* Cinematic overlay: dim middle, deeper bottom so the
            event title + RSVP zone sits on guaranteed dark
            surface regardless of photo content. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/20 to-black/65 pointer-events-none"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none"
        />

        {/* Header row: greeting (left) + weather chip (right) */}
        <div className="relative flex items-start justify-between px-5 pt-5 sm:pt-6">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-brand-primary-soft">Next Up</p>
            <p className="mt-1 text-sm text-white/80 drop-shadow">{greeting}, {firstName}</p>
            <DigestStrip total={digestTotal} onOpen={onOpenDigest} />
          </div>
          {weather && (
            <div className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-black/40 ring-1 ring-line-default/10 px-2.5 py-1 backdrop-blur-sm">
              <WeatherIcon iconName={weather.iconName} className="w-3.5 h-3.5 text-white" />
              <span className="text-[12px] font-bold text-white tabular-nums drop-shadow">{weather.tempMaxF}°/{weather.tempMinF}°</span>
            </div>
          )}
        </div>

        {/* Spacer pushes the body to the bottom of the poster */}
        <div className="flex-1" />

        {/* Body: date badge + title + when + location, then RSVP */}
        <div className="relative px-5 pb-5 sm:pb-6">
          <div className="flex items-end gap-4">
            <Link
              to={`/events/${nextEvent.id}`}
              aria-label={`${nextEvent.title} on ${eventMonth} ${eventDay} ${eventDow}`}
              className="shrink-0 flex flex-col items-center justify-center w-[68px] h-[68px] sm:w-[76px] sm:h-[76px] rounded-2xl bg-black/50 ring-1 ring-line-default/15 backdrop-blur-md"
            >
              <span className="text-[10px] font-extrabold tracking-widest text-brand-primary-soft">{eventMonth}</span>
              <span className="text-3xl sm:text-[34px] font-black text-white leading-none [text-shadow:0_2px_7px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">{eventDay}</span>
              <span className="text-[9px] font-bold tracking-widest text-white/70 mt-0.5">{eventDow}</span>
            </Link>
            <div className="min-w-0 flex-1">
              <Link to={`/events/${nextEvent.id}`} className="block">
                <h2 className="text-2xl sm:text-3xl font-black text-white leading-tight truncate [text-shadow:0_3px_10px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                  {nextEvent.title}
                </h2>
                <p className="mt-1 text-sm sm:text-base font-semibold text-white/90 truncate [text-shadow:0_2px_7px_rgba(0,0,0,0.9)]">{whenText}</p>
                {location && (
                  <p className="mt-0.5 text-xs sm:text-sm font-semibold text-white/90 truncate [text-shadow:0_2px_7px_rgba(0,0,0,0.95),0_0_1px_rgba(0,0,0,0.9)]">
                    <span aria-hidden className="mr-1">·</span>{location}
                  </p>
                )}
                {developmentFocus && (
                  <p className="mt-1 inline-flex max-w-full items-center rounded-full bg-black/50 ring-1 ring-white/10 px-2 py-1 text-[10px] sm:text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft truncate backdrop-blur-sm [text-shadow:0_2px_6px_rgba(0,0,0,0.85)]">
                    {focusPrefix}: {developmentFocus}
                  </p>
                )}
              </Link>
            </div>
          </div>

          {/* RSVP row — single tap, no nav. The whole point. */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            <RsvpButton
              tone="going"
              active={currentStatus === 'going'}
              label={currentStatus === 'going' ? 'Going' : goingLabel}
              onClick={() => onRsvp('going')}
            />
            <RsvpButton
              tone="maybe"
              active={currentStatus === 'maybe'}
              label="Maybe"
              onClick={() => onRsvp('maybe')}
            />
            <RsvpButton
              tone="no"
              active={currentStatus === 'no'}
              label={noLabel}
              onClick={() => onRsvp('no')}
            />
          </div>

          {/* Coach attendance toggle removed from the hero
              (Patrick 2026-06-21: 'i want to clean up the
              header'). Now lives on the EventDetail page in a
              dedicated 'Coach attendance' card visible to coaches
              with linked kids. Hero stays focused on the kid RSVP
              path, which is what 95% of users actually tap. */}

          {/* Split-by-kid affordance — silent unless the parent has
              2+ kids on this team AND a per-kid write handler is
              wired. Progressive disclosure: collapsed link until she
              needs it, then a compact card with a mini-pill row per
              kid. Keeps the one-tap common case fast while giving
              the "Alice yes, Bob sick" edge case a real path that
              doesn't require leaving the dashboard. */}
          {linkedPlayers && linkedPlayers.length >= 2 && onPlayerRsvp && (
            <div className="mt-3">
              {!splitOpen ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => setSplitOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold tracking-wide text-brand-primary-soft/85 hover:text-brand-primary-soft transition"
                  >
                    <span className="underline decoration-brand-primary-soft/40 underline-offset-2">Different for one kid?</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                </div>
              ) : (
                <div className="rounded-xl bg-black/45 ring-1 ring-white/10 px-3 pt-2 pb-2.5 backdrop-blur-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-white/65">Set per kid</span>
                    <button
                      type="button"
                      onClick={() => setSplitOpen(false)}
                      className="inline-flex items-center gap-0.5 text-[10px] font-bold text-white/60 hover:text-white/85"
                      aria-label="Collapse per-kid split"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path d="M18 15l-6-6-6 6" />
                      </svg>
                      Close
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {linkedPlayers.map((p) => {
                      const s = playerStatuses?.[p.id] ?? null;
                      const first = (p.name || 'Player').trim().split(/\s+/)[0];
                      return (
                        <div key={p.id} className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white/90 flex-1 truncate min-w-0" title={p.name}>{first}</span>
                          <div className="flex gap-1 shrink-0">
                            <MiniRsvpPill tone="going" active={s === 'going'} label="Going" onClick={() => onPlayerRsvp(p.id, p.name, 'going')} />
                            <MiniRsvpPill tone="maybe" active={s === 'maybe'} label="Maybe" onClick={() => onPlayerRsvp(p.id, p.name, 'maybe')} />
                            <MiniRsvpPill tone="no"    active={s === 'no'}    label="No"    onClick={() => onPlayerRsvp(p.id, p.name, 'no')} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Going / pending tally line. Quiet, just-the-facts. */}
          <p className="mt-3 text-center text-[12px] text-white/70 drop-shadow">
            <span className="font-bold text-white">{goingCount}</span> going
            {pendingCount > 0 && (
              <>
                {' · '}
                <span className="font-bold text-white">{pendingCount}</span> pending
              </>
            )}
          </p>
        </div>
      </article>
    </section>
  );
};

// Slim strip under the greeting that answers the busy-parent
// question: "did I miss anything?" — one line, one tap. Silent when
// there's nothing to show (returns null so the greeting layout is
// unchanged on quiet days). Warm brand tint so it reads as "come
// see this" without competing with the greeting text above it.
//
// Tap fires the parent's onOpen callback which opens the digest
// sheet on Dashboard. No navigation — the parent stays on the
// dashboard, sees a categorized list, then chooses where to go.
function DigestStrip({ total, onOpen }: {
  total: number;
  onOpen?: () => void;
}) {
  if (!total || total <= 0 || !onOpen) return null;
  const label = total === 1 ? '1 thing needs you' : `${total} things need you`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-primary/25 ring-1 ring-brand-primary/45 px-2.5 py-1 text-[11px] font-black tracking-wide text-white shadow-sm backdrop-blur-sm hover:bg-brand-primary/35 active:scale-[0.98] transition"
      aria-label={`${label}. Tap for details.`}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      </svg>
      <span>{label}</span>
      <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

function RsvpButton({ tone, active, label, onClick }: {
  tone: RsvpStatus;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const base = 'inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-[12px] font-extrabold uppercase tracking-widest transition-colors duration-150 active:scale-[0.97]';
  const activeStyles: Record<RsvpStatus, string> = {
    going: 'bg-emerald-500 text-white ring-1 ring-emerald-300/60 shadow-lg shadow-emerald-500/30',
    maybe: 'bg-amber-400 text-charcoal-950 ring-1 ring-amber-300/60 shadow-lg shadow-amber-500/30',
    no:    'bg-rose-500 text-white ring-1 ring-rose-300/60 shadow-lg shadow-rose-500/30',
  };
  const inactiveStyles = 'bg-black/50 text-white/90 ring-1 ring-white/10 backdrop-blur-md hover:bg-black/60';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} ${active ? activeStyles[tone] : inactiveStyles}`}
    >
      {active && (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <polyline points="5 12 10 17 19 7" />
        </svg>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

// Compact per-kid RSVP pill used inside the "Set per kid" split
// panel. Same tone palette as the primary RsvpButton so the visual
// language reads consistent across the poster, just tighter padding
// + smaller type so three kid rows can stack without pushing the
// tally line off-screen on a phone.
function MiniRsvpPill({ tone, active, label, onClick }: {
  tone: RsvpStatus;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const base = 'inline-flex items-center justify-center px-2 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wider transition-colors duration-150 active:scale-[0.97]';
  const activeStyles: Record<RsvpStatus, string> = {
    going: 'bg-emerald-500 text-white ring-1 ring-emerald-300/60',
    maybe: 'bg-amber-400 text-charcoal-950 ring-1 ring-amber-300/60',
    no:    'bg-rose-500 text-white ring-1 ring-rose-300/60',
  };
  const inactiveStyles = 'bg-black/50 text-white/85 ring-1 ring-white/10 hover:bg-black/65';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} ${active ? activeStyles[tone] : inactiveStyles}`}
    >
      {label}
    </button>
  );
}

export default NextEventPoster;
