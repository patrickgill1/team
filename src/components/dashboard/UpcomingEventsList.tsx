// UpcomingEventsList — "THIS WEEK" list card. Renders the next N
// upcoming events (default 3, since most weeks have ~3 events) as
// action-forward rows: colored circular icon on the left, event
// name + date/time/location in the middle, live RSVP pill on the
// right. Tapping the pill expands an inline segmented control so
// a parent can flip between Going / Maybe / Can't Go without
// leaving the dashboard.
//
// Replaces the earlier MATCHWEEK fixture-ladder rail. Patrick
// 2026-07-13: "the calendar looks too much and making it more
// actionable will be easy. so it shows the next 3 events, as
// most weeks only have 3 events." List-of-3 beats the fixture
// ladder on scannability + on the ability to actually DO
// something (RSVP) from the home screen.

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent, Player } from '../../types';

interface Props {
  events: CalendarEvent[];
  /** Maximum rows to show. Default 3. */
  max?: number;
  /** The current user's linked player ids on this team. Determines
   *  whose RSVP we're mutating when the pill is tapped (kid mode
   *  when linked kids exist, self mode otherwise). */
  myLinkedPlayers?: Player[];
  /** Uid on the auth session — used for the byUid audit field
   *  when we write a playerRsvp on behalf of a kid. */
  currentUid?: string;
  /** Coach mode? When true we don't render the RSVP pill (coaches
   *  don't RSVP for themselves from the parent-family surface). */
  isCoach?: boolean;
  /** Handler that persists an RSVP change. Should mirror the
   *  quickRsvp path in Dashboard.tsx — accepts eventId + status
   *  and does the kid-vs-self dispatch internally. */
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => Promise<void>;
}

type RsvpStatus = 'going' | 'maybe' | 'no' | null;

function readCurrentRsvp(
  event: CalendarEvent,
  myLinkedPlayers: Player[] | undefined,
  currentUid: string | undefined,
): RsvpStatus {
  // Kid-mode: all linked kids share a status → surface that status.
  if (myLinkedPlayers && myLinkedPlayers.length > 0) {
    const playerR = ((event as any).playerRsvps || {}) as Record<string, { status?: string }>;
    const statuses = myLinkedPlayers.map((p) => playerR[p.id]?.status);
    if (statuses.length > 0 && statuses.every((s) => s === 'going')) return 'going';
    if (statuses.length > 0 && statuses.every((s) => s === 'maybe')) return 'maybe';
    if (statuses.length > 0 && statuses.every((s) => s === 'no')) return 'no';
    return null;
  }
  // Self-mode
  if (currentUid) {
    const s = ((event.rsvps || {}) as any)[currentUid]?.status;
    if (s === 'going' || s === 'maybe' || s === 'no') return s;
  }
  return null;
}

function eventTitle(event: CalendarEvent): { primary: string; icon: 'game' | 'practice' | 'event' } {
  const day = event.date.toLocaleDateString([], { weekday: 'short' });
  if (event.type === 'game') {
    const opp = String((event as any).opponent || '').trim();
    const shortOpp = opp
      ? opp.split(/\s+/).slice(0, 3).map((w) => w[0]).join('').toUpperCase().slice(0, 3)
      : '';
    return {
      primary: shortOpp ? `${day} Game vs ${shortOpp}` : `${day} Game`,
      icon: 'game',
    };
  }
  if (event.type === 'practice') {
    return { primary: `${day} Practice`, icon: 'practice' };
  }
  return { primary: `${day} ${String(event.title || 'Event').slice(0, 24)}`, icon: 'event' };
}

// ── Icons ────────────────────────────────────────────────────────

const BallGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6l3 2-1 4-4 0-1-4z" />
    <path d="M12 22l-3-5M12 22l3-5M6 10l2 4M18 10l-2 4" />
  </svg>
);

const BibGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <path d="M7 5l3-1 4 0 3 1 2 2-1 3-2 0v11h-8V10H6l-1-3z" />
    <path d="M8 13h8" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <polyline points="5 12 10 17 19 8" />
  </svg>
);

const MaybeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="9" />
  </svg>
);

const NoIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <path d="M6 6l12 12M6 18L18 6" />
  </svg>
);

const ChevronRight: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const CalendarGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

// ── RSVP pill ────────────────────────────────────────────────────

const RsvpPill: React.FC<{
  status: RsvpStatus;
  busy: boolean;
  onSelect: (status: 'going' | 'maybe' | 'no') => void;
}> = ({ status, busy, onSelect }) => {
  const [expanded, setExpanded] = useState(false);
  const label = status === 'going' ? 'GOING'
    : status === 'maybe' ? 'MAYBE'
    : status === 'no' ? "CAN'T GO"
    : 'RSVP';
  const tone = status === 'going' ? 'bg-emerald-500/10 ring-emerald-400/40 text-emerald-300'
    : status === 'maybe' ? 'bg-amber-500/10 ring-amber-400/40 text-amber-200'
    : status === 'no' ? 'bg-rose-500/10 ring-rose-400/40 text-rose-300'
    : 'bg-line-default/8 ring-line-default/25 text-ink-primary/75';
  const Icon = status === 'going' ? CheckIcon : status === 'maybe' ? MaybeIcon : status === 'no' ? NoIcon : null;

  if (expanded) {
    return (
      <div
        className="flex items-center gap-1 rounded-full bg-surface-input/60 ring-1 ring-line-default/20 px-1 py-1 shadow-inner"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect('going'); setExpanded(false); }}
          disabled={busy}
          aria-label="Going"
          className="w-7 h-7 rounded-full inline-flex items-center justify-center bg-emerald-500/15 hover:bg-emerald-500/25 ring-1 ring-emerald-400/40 text-emerald-300 active:scale-95 transition"
        >
          <CheckIcon className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect('maybe'); setExpanded(false); }}
          disabled={busy}
          aria-label="Maybe"
          className="w-7 h-7 rounded-full inline-flex items-center justify-center bg-amber-500/15 hover:bg-amber-500/25 ring-1 ring-amber-400/40 text-amber-200 active:scale-95 transition"
        >
          <MaybeIcon className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect('no'); setExpanded(false); }}
          disabled={busy}
          aria-label="Can't go"
          className="w-7 h-7 rounded-full inline-flex items-center justify-center bg-rose-500/15 hover:bg-rose-500/25 ring-1 ring-rose-400/40 text-rose-300 active:scale-95 transition"
        >
          <NoIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(true); }}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full ring-1 text-[10px] font-black tracking-widest uppercase ${tone} hover:brightness-110 active:scale-95 transition`}
    >
      {Icon ? <Icon className="w-3 h-3" /> : null}
      {label}
    </button>
  );
};

// ── Component ────────────────────────────────────────────────────

const UpcomingEventsList: React.FC<Props> = ({ events, max = 3, myLinkedPlayers, currentUid, isCoach, onRsvp }) => {
  const [busyByEvent, setBusyByEvent] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const now = Date.now();
    return [...events]
      .filter((e) => e.date instanceof Date && e.date.getTime() >= now - 60 * 60 * 1000) // 1h grace for in-progress
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, max)
      .map((event) => {
        const { primary, icon } = eventTitle(event);
        const dateShort = event.date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const dayShort = event.date.toLocaleDateString([], { weekday: 'short' });
        const time = event.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
        return { event, primary, icon, dateShort, dayShort, time };
      });
  }, [events, max]);

  if (rows.length === 0) return null;

  const handleRsvp = async (eventId: string, status: 'going' | 'maybe' | 'no') => {
    if (!onRsvp) return;
    setBusyByEvent((prev) => ({ ...prev, [eventId]: true }));
    try {
      await onRsvp(eventId, status);
    } finally {
      setBusyByEvent((prev) => ({ ...prev, [eventId]: false }));
    }
  };

  return (
    <section
      aria-label={`This week — next ${rows.length} events`}
      className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 shadow-lg shadow-black/5 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 pt-3.5 pb-2 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.3em] text-ink-primary/70">
          <CalendarGlyph className="w-4 h-4 text-brand-primary" />
          This week
        </div>
        <Link
          to="/calendar"
          className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition"
        >
          View full schedule
          <ChevronRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Rows */}
      <ul className="divide-y divide-line-default/8">
        {rows.map((r) => {
          const status = readCurrentRsvp(r.event, myLinkedPlayers, currentUid);
          const iconClass = r.icon === 'game'
            ? 'bg-brand-primary/12 ring-brand-primary/40 text-brand-primary-soft'
            : r.icon === 'practice'
              ? 'bg-emerald-500/12 ring-emerald-400/40 text-emerald-300'
              : 'bg-line-default/10 ring-line-default/25 text-ink-primary/70';
          const IconGlyph = r.icon === 'game' ? BallGlyph : r.icon === 'practice' ? BibGlyph : CalendarGlyph;
          return (
            <li key={r.event.id}>
              <Link
                to={`/event/${r.event.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-line-default/[0.03] transition group"
              >
                {/* Left icon */}
                <span
                  className={`flex-shrink-0 w-10 h-10 rounded-full inline-flex items-center justify-center ring-1 ${iconClass}`}
                  aria-hidden
                >
                  <IconGlyph className="w-5 h-5" />
                </span>

                {/* Middle: title + subline */}
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-black text-ink-primary leading-tight truncate">
                    {r.primary}
                  </p>
                  <p className="text-[11px] text-ink-primary/55 leading-snug truncate mt-0.5">
                    <span className="font-bold text-ink-primary/70">{r.dateShort}</span>
                    <span> · {r.dayShort} · {r.time}</span>
                    {r.event.location && (
                      <span> · <span className="text-ink-primary/60">{r.event.location}</span></span>
                    )}
                  </p>
                </div>

                {/* Right: RSVP pill (parent) or nothing (coach) */}
                {!isCoach && onRsvp && (
                  <div className="flex-shrink-0">
                    <RsvpPill
                      status={status}
                      busy={!!busyByEvent[r.event.id]}
                      onSelect={(s) => handleRsvp(r.event.id, s)}
                    />
                  </div>
                )}
                <ChevronRight className="w-4 h-4 text-ink-primary/35 group-hover:text-brand-primary-soft transition flex-shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default UpcomingEventsList;
