import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { mapsUrl } from '../../utils/maps';
import { normalizeKit } from '../../utils/kitColors';
import { useTeam } from '../../contexts/TeamContext';
import RosterAvatar from '../common/RosterAvatar';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';
import WeatherIcon from '../common/WeatherIcon';

// Event list card — cinematic dark surface matching the GoalKickr v9
// mockup. Black-on-black with crimson accents: vertical date badge
// left, type + RSVP pills top, dense info strip at the bottom, then
// the avatar preview row Patrick specifically called out as
// untouchable ("the team bubbles that show who is going at the
// bottom with their pictures, i love that"). Snacks chip and
// cancelled state preserved from the previous design.

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

type RsvpStatus = 'going' | 'maybe' | 'no';

interface PreviewPerson {
  name: string;
  photoURL?: string;
  isGuest?: boolean;
}

interface NoRsvpNote {
  name: string;
  reason?: string;
}

interface Props {
  event: CalendarEvent;
  myRsvp?: RsvpStatus | null;
  onRsvp: (status: RsvpStatus) => void;
  goingCount: number;
  pendingCount: number;
  goingPreview: PreviewPerson[];
  arriveText?: string;
  arriveLabel?: string;
  /** Legacy escape hatches — if the parent already computed weather
   *  and passed strings in, we render those instead of fetching. Empty
   *  means the card fetches its own forecast via getWeatherForEvent. */
  weatherText?: string;
  weatherIcon?: string;
  eventChatUnread?: number;
  rsvpLabel?: string;
  /** Coach view unlocks the Can't-make-it reason surface. Parents
   *  never see other parents' stated reasons. */
  isCoach?: boolean;
  /** Coach-only: names + optional reasons for anyone who RSVP'd "no".
   *  When a reason is present we render it as a tiny italic note next
   *  to the name; without a reason, the row still renders the name so
   *  the coach sees who declined. */
  noRsvpNotes?: NoRsvpNote[];
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-3.5 h-3.5' }) => {
  switch (name) {
    case 'check':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'q':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'x':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case 'clock':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case 'pin':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 22s-8-4.5-8-12a8 8 0 1 1 16 0c0 7.5-8 12-8 12z"/><circle cx="12" cy="10" r="3"/></svg>;
    case 'users':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>;
    case 'chat':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
    case 'arrive':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>;
  }
  return null;
};

function formatTimeRange(start: Date, end?: Date): string {
  const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // Drop the range half when end is missing OR not a real Date.
  // Recurring-event materialization sometimes leaves endDate as a
  // non-parseable string; new Date(...) returns an Invalid Date
  // (truthy) and toLocaleTimeString returns the literal string
  // 'Invalid Date'. Patrick screenshot: '6:00 PM – Invalid Date'.
  if (!end || isNaN(end.getTime())) return s;
  const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${s} – ${e}`;
}

// Color spec per event type — drives the type pill and the left-edge
// accent stripe. Game = crimson (most charged event), practice = also
// crimson but softer, anything else = amber (events / camps / etc.).
function typeSpec(type: string | undefined) {
  switch (type) {
    case 'game':
      return { label: 'Game', pillBg: 'bg-brand-primary/15', pillRing: 'ring-brand-primary-soft/40', pillText: 'text-brand-primary-soft', edge: 'bg-brand-primary' };
    case 'practice':
      return { label: 'Practice', pillBg: 'bg-brand-primary/10', pillRing: 'ring-brand-primary-soft/30', pillText: 'text-brand-primary-soft', edge: 'bg-brand-primary/70' };
    default:
      return { label: 'Event', pillBg: 'bg-amber-500/15', pillRing: 'ring-amber-400/40', pillText: 'text-amber-600', edge: 'bg-amber-500' };
  }
}

// First name only on the RSVP pill, so the chip doesn't blow out on
// long names. "Hunter Gill" → "Hunter".
function firstName(label?: string): string {
  if (!label) return '';
  return label.trim().split(/\s+/)[0] || '';
}

const EventListCard: React.FC<Props> = ({
  event,
  myRsvp,
  onRsvp,
  goingCount,
  pendingCount,
  goingPreview,
  arriveText,
  arriveLabel,
  weatherText,
  weatherIcon,
  eventChatUnread = 0,
  rsvpLabel = 'YOU',
  isCoach = false,
  noRsvpNotes,
}) => {
  const date = new Date(event.date);
  const end = event.endDate ? new Date(event.endDate) : undefined;
  const month = MONTHS_SHORT[date.getMonth()];
  const day = date.getDate();
  const dow = DOWS_SHORT[date.getDay()];

  // Weather chip — self-fetch per event so scroll doesn't refetch
  // (useEffect keyed on event id + location + date). Silent when the
  // event is outside the 15-day forecast window, offline, or when
  // Open-Meteo can't resolve the venue. Skips the fetch entirely when
  // the parent already passed weather strings in (legacy path — no
  // caller does this today but the props are still supported).
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const parentSuppliedWeather = !!weatherText;
  useEffect(() => {
    if (parentSuppliedWeather) return;
    let cancelled = false;
    setWeather(null);
    if (!event?.date) return;
    const dt = event.date instanceof Date ? event.date : new Date(event.date);
    if (Number.isNaN(dt.getTime())) return;
    const diffDays = Math.floor((dt.getTime() - Date.now()) / 86400_000);
    if (diffDays < 0 || diffDays > 15) return;
    const coords = (event as any).locationCoords || null;
    getWeatherForEvent(event.location || '', dt, coords).then(w => {
      if (!cancelled) setWeather(w);
    });
    return () => { cancelled = true; };
  }, [event?.id, event?.location, event?.date, parentSuppliedWeather]);

  // Resolve the header-row values. Prefer parent-supplied text, then
  // the self-fetched summary. The parent-supplied `weatherIcon` prop
  // is a legacy emoji string — we deliberately do NOT render it
  // (violates "no emojis in UI code"). Only the self-fetched summary
  // renders a lucide glyph via <WeatherIcon>. No caller uses the
  // parent-supplied path today; the prop stays for API stability.
  void weatherIcon;
  const effectiveWeatherIconName = weatherText ? undefined : weather?.iconName;
  const effectiveWeatherText = weatherText
    ? weatherText
    : (weather ? `${weather.tempMaxF}° / ${weather.tempMinF}°` : undefined);

  const t = typeSpec(event.type);
  const cancelled = !!(event as any).isCancelled;
  // Kit color label comes from the team doc, not a hardcoded "Black /
  // White" — different teams have different uniforms.
  const { selectedTeam } = useTeam();
  const isHome = (event as any).homeAway === 'home';
  const rawKit = isHome ? selectedTeam?.homeKitColor : selectedTeam?.awayKitColor;
  const kitHex = normalizeKit(rawKit);

  // RSVP pill chrome per status. The "going" pill is the loudest
  // (filled emerald) since it's a celebratory state; maybe/can't are
  // ringed outlines so they don't shout. Untouched events show "RSVP"
  // as a faint outline-only nudge.
  const rsvpPill = (() => {
    const name = firstName(rsvpLabel === 'YOU' ? 'You' : rsvpLabel);
    if (myRsvp === 'going') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-extrabold tracking-wider uppercase bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-400/50">
          <Icon name="check" className="w-3 h-3" />
          {name}: Going
        </span>
      );
    }
    if (myRsvp === 'maybe') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-extrabold tracking-wider uppercase bg-amber-500/15 text-amber-600 ring-1 ring-amber-400/50">
          <Icon name="q" className="w-3 h-3" />
          {name}: Maybe
        </span>
      );
    }
    if (myRsvp === 'no') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-extrabold tracking-wider uppercase bg-rose-500/15 text-rose-500 ring-1 ring-rose-400/50">
          <Icon name="x" className="w-3 h-3" />
          {name}: Can't
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-extrabold tracking-wider uppercase text-charcoal-300 ring-1 ring-charcoal-500/50 hover:ring-brand-primary/40 transition-colors">
        Tap to RSVP
      </span>
    );
  })();

  const handleQuickRsvp = (status: RsvpStatus, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRsvp(status);
  };

  return (
    <Link
      to={`/events/${event.id}`}
      className={`relative block overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/50 transition shadow-xl shadow-black/40 ${cancelled ? 'opacity-60' : ''}`}
    >
      {/* Left-edge accent stripe, color from event type. Cancelled
          events go neutral grey so the card reads as "not happening". */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 ${cancelled ? 'bg-surface-tint' : t.edge}`}
      />

      <div className="relative pl-4 pr-4 py-3.5">
        {/* Row 1: top pills — type chip on the left, RSVP chip on
            the right. Cancelled badge folds into the same row. */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-extrabold tracking-widest uppercase ring-1 ${t.pillBg} ${t.pillRing} ${t.pillText}`}>
              {t.label}
            </span>
            {cancelled && (
              <span className="inline-flex items-center px-2 py-1 rounded-full text-[10px] font-extrabold tracking-widest uppercase bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40">
                Cancelled
              </span>
            )}
          </div>
          <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            {/* Tap the pill itself to cycle through RSVP states.
                Going → Maybe → Can't → none. Keeps the card tappable
                without nesting three buttons. */}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const next: RsvpStatus =
                  myRsvp === 'going' ? 'maybe' :
                  myRsvp === 'maybe' ? 'no' :
                  'going';
                onRsvp(next);
              }}
              aria-label="Cycle RSVP"
              className="block"
            >
              {rsvpPill}
            </button>
          </div>
        </div>

        {/* Row 2: date badge + title block */}
        <div className="grid grid-cols-[auto_1fr] gap-3 items-start">
          <div className="w-[52px] rounded-lg bg-surface-base ring-1 ring-brand-primary-soft/30 flex flex-col items-center justify-center py-1.5">
            <span className="text-[9px] font-extrabold tracking-widest text-brand-primary-soft">{month}</span>
            <span className={`text-[22px] font-black leading-none text-ink-primary ${cancelled ? 'line-through decoration-2' : ''}`}>{day}</span>
            <span className="text-[8px] font-bold tracking-widest text-charcoal-400 mt-0.5">{dow}</span>
          </div>

          <div className="min-w-0">
            <h3 className={`text-[16px] font-extrabold leading-tight tracking-tight text-ink-primary ${cancelled ? 'line-through' : ''}`}>
              {event.title}
            </h3>
            <div className="mt-1 text-[11.5px] text-charcoal-300 flex items-center gap-1 flex-wrap">
              <Icon name="clock" className="w-3 h-3 text-brand-primary-soft" />
              <span>{formatTimeRange(date, end)}</span>
              {effectiveWeatherText && (
                <>
                  <span className="text-charcoal-500">·</span>
                  <span className="inline-flex items-center gap-1" title={weather?.label || undefined}>
                    {effectiveWeatherIconName && (
                      <WeatherIcon iconName={effectiveWeatherIconName} className="w-3 h-3 text-brand-primary-soft" />
                    )}
                    <span>{effectiveWeatherText}</span>
                  </span>
                </>
              )}
              {(event as any).fieldNumber && (
                <>
                  <span className="text-charcoal-500">·</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-brand-primary/15 text-brand-primary-soft text-[9px] font-extrabold tracking-widest uppercase ring-1 ring-brand-primary-soft/30">
                    {(event as any).fieldNumber}
                  </span>
                </>
              )}
              {event.type === 'game' && (event as any).homeAway && (
                <>
                  <span className="text-ink-primary/40">·</span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-extrabold tracking-widest uppercase">
                    <span
                      className="inline-block w-3 h-3 rounded-sm ring-1 ring-line-default/25"
                      style={{ backgroundColor: kitHex || 'transparent' }}
                      aria-hidden
                    />
                    <span className="text-ink-primary/75">
                      {isHome ? 'Home' : 'Away'}
                    </span>
                  </span>
                </>
              )}
            </div>
            {event.location && (
              <a
                href={mapsUrl({
                  name: event.location,
                  address: (event as any).locationAddress,
                  lat: (event as any).locationCoords?.lat,
                  lon: (event as any).locationCoords?.lon,
                })}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.stopPropagation(); }}
                className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-brand-primary-soft hover:text-brand-primary-soft truncate max-w-full"
                title="Open in Maps"
              >
                <Icon name="pin" className="w-3 h-3" />
                <span className="truncate underline decoration-dotted underline-offset-2">{event.location}</span>
              </a>
            )}
          </div>
        </div>

        {/* Row 3: 4-column info strip — GOING / PENDING / ARRIVE / NEW.
            White-on-charcoal density block, separators are thin charcoal
            lines. Each column gets a crimson icon + bold number + small
            label so the eye lands on the count, not the chrome. */}
        <div className="mt-3 pt-3 border-t border-line-default/5 grid grid-cols-4 gap-2 text-center">
          <div className="flex items-center gap-1.5 justify-start pl-1">
            <Icon name="users" className="w-3.5 h-3.5 text-brand-primary-soft shrink-0" />
            <div className="text-left">
              <div className="text-[12px] font-black text-ink-primary leading-none tabular-nums">{goingCount}</div>
              <div className="text-[8.5px] font-extrabold tracking-widest uppercase text-charcoal-400 mt-0.5">Going</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 justify-start pl-1 border-l border-line-default/5">
            <Icon name="clock" className="w-3.5 h-3.5 text-brand-primary-soft shrink-0" />
            <div className="text-left">
              <div className="text-[12px] font-black text-ink-primary leading-none tabular-nums">{pendingCount}</div>
              <div className="text-[8.5px] font-extrabold tracking-widest uppercase text-charcoal-400 mt-0.5">Pending</div>
            </div>
          </div>
          {arriveText ? (
            <div className="flex items-center gap-1.5 justify-start pl-1 border-l border-line-default/5">
              <Icon name="arrive" className="w-3.5 h-3.5 text-brand-primary-soft shrink-0" />
              <div className="text-left min-w-0">
                <div className="text-[11px] font-black text-ink-primary leading-none truncate">{arriveText.replace(/^Arrive\s*/i, '')}</div>
                <div className="text-[8.5px] font-extrabold tracking-widest uppercase text-charcoal-400 mt-0.5">Arrive</div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-start pl-1 border-l border-line-default/5 text-charcoal-600 text-[10px]">—</div>
          )}
          <div className="flex items-center gap-1.5 justify-start pl-1 border-l border-line-default/5">
            <Icon name="chat" className="w-3.5 h-3.5 text-brand-primary-soft shrink-0" />
            <div className="text-left">
              <div className="text-[12px] font-black text-ink-primary leading-none tabular-nums">{eventChatUnread}</div>
              <div className="text-[8.5px] font-extrabold tracking-widest uppercase text-charcoal-400 mt-0.5">Comments</div>
            </div>
          </div>
        </div>

        {/* Avatar preview row — Patrick's untouchable "team bubbles."
            Now up to 6 avatars followed by a +N pill (no fallback text
            names) so the row scans as a squad, not a caption. Missing
            photos render as a colored-initial circle via RosterAvatar
            (initials-instant with photo fade-in) so the row is never
            blank and never regresses to gradient blobs. */}
        {goingPreview.length > 0 && (() => {
          const shown = goingPreview.slice(0, 6);
          // Overflow is anything past what we're rendering, PLUS the
          // gap between the truncated preview and the authoritative
          // going count (goingCount can exceed goingPreview.length
          // because the parent slices to 6 upstream).
          const overflow = Math.max(
            0,
            (goingCount || goingPreview.length) - shown.length,
          );
          return (
            <div className="mt-3 flex items-center gap-1.5">
              <div className="flex">
                {shown.map((p, i) => (
                  <RosterAvatar
                    key={i}
                    name={p.name}
                    photoUrl={p.photoURL || undefined}
                    size={26}
                    className={`ring-2 ring-surface-elevated ${i > 0 ? '-ml-1.5' : ''}`}
                  />
                ))}
              </div>
              {overflow > 0 && (
                <span
                  className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-1.5 rounded-full ring-2 ring-surface-elevated bg-surface-raised text-ink-primary text-[10px] font-extrabold tabular-nums -ml-1.5"
                  aria-label={`${overflow} more going`}
                >
                  +{overflow}
                </span>
              )}
            </div>
          );
        })()}

        {/* Coach-only Can't-make-it reason surface. Rendered as a
            compact list under the avatar row so the coach can spot
            "hurt heel," "family trip" etc. at a glance without opening
            the detail screen. Parents never see other parents' stated
            reasons — the whole block is gated on isCoach. Only rows
            with a reason attached render here — "no reason attached,
            no visual change" per spec. Coach can tap into the event
            detail to see the full Can't-make-it roster. */}
        {isCoach && (() => {
          const withReasons = (noRsvpNotes || []).filter(
            n => n.reason && n.reason.trim(),
          );
          if (withReasons.length === 0) return null;
          return (
            <div className="mt-2.5 pt-2.5 border-t border-line-default/5">
              <div className="text-[8.5px] font-extrabold tracking-widest uppercase text-charcoal-400 mb-1">
                Can't make it
              </div>
              <ul className="space-y-0.5">
                {withReasons.map((n, i) => (
                  <li
                    key={i}
                    className="text-[11px] text-charcoal-300 flex items-baseline gap-1.5 flex-wrap min-w-0"
                  >
                    <span className="font-semibold text-ink-primary/85">
                      {n.name.split(' ')[0] || n.name}
                    </span>
                    <span className="italic text-charcoal-400 truncate min-w-0">
                      {n.reason!.trim()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {/* Snacks chip — preserved from the prior design. */}
        {(event as any).snackAssignment?.playerName && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-charcoal-300">
            <span className="text-[9px] font-extrabold tracking-widest uppercase text-charcoal-500">Snacks</span>
            <span className="font-bold text-ink-primary">{(event as any).snackAssignment.playerName}</span>
          </div>
        )}
      </div>

      {/* Quick-RSVP buttons hidden behind the pill (cycle on tap) but
          we still expose hidden labels for accessibility. */}
      <span className="sr-only">
        <button onClick={(e) => handleQuickRsvp('going', e)}>Mark going</button>
        <button onClick={(e) => handleQuickRsvp('maybe', e)}>Mark maybe</button>
        <button onClick={(e) => handleQuickRsvp('no', e)}>Mark can't go</button>
      </span>
    </Link>
  );
};

export default EventListCard;
