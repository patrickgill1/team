import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { CalendarEvent } from '../types';

const TOKEN_KEY = 'public_event_rsvp_token';
const NAME_KEY = 'public_event_rsvp_name';

const getToken = (): string => {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = `g_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
};

const formatIcsDate = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z'
  );
};
const escapeIcs = (s: string = '') =>
  s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

const downloadIcs = (event: CalendarEvent) => {
  const start = event.date instanceof Date ? event.date : new Date(event.date);
  const end = new Date(start.getTime() + 90 * 60 * 1000);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Team App//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@team-app`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcs(event.title || event.type)}`,
    event.location ? `LOCATION:${escapeIcs(event.location)}` : '',
    event.description ? `DESCRIPTION:${escapeIcs(event.description)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(event.title || 'event').replace(/[^a-z0-9]+/gi, '_')}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const formatLong = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const formatTime = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const eventTypeIcon = (t: string) => (t === 'game' ? '⚽' : t === 'practice' ? '🏃' : '📅');
const eventTypeLabel = (t: string) => (t === 'game' ? 'Game' : t === 'practice' ? 'Practice' : 'Event');

const PublicEvent: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string>(localStorage.getItem(NAME_KEY) || '');
  const [submitting, setSubmitting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const token = useMemo(() => getToken(), []);

  useEffect(() => {
    if (!eventId) {
      setError('Invalid link.');
      setLoading(false);
      return;
    }
    const cleanId = decodeURIComponent(eventId).split(/[\s,]/)[0].trim();
    const unsub = onSnapshot(
      doc(db, 'events', cleanId),
      snap => {
        if (!snap.exists()) {
          setError('This event could not be found or may have been removed.');
          setLoading(false);
          return;
        }
        const data = snap.data() as any;
        setEvent({
          id: snap.id,
          ...data,
          date: data.date?.toDate ? data.date.toDate() : new Date(data.date),
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || Date.now()),
        });
        setLoading(false);
      },
      err => {
        console.error('Error loading event', err);
        setError('Could not load this event.');
        setLoading(false);
      }
    );
    return () => unsub();
  }, [eventId]);

  const myRsvp = event?.publicRsvps?.[token];
  const myStatus = myRsvp?.status;

  const counts = useMemo(() => {
    const all = {
      ...(event?.rsvps || {}),
      ...(event?.publicRsvps || {}),
    };
    const entries = Object.values(all);
    return {
      going: entries.filter((v: any) => v.status === 'going').length,
      maybe: entries.filter((v: any) => v.status === 'maybe').length,
      no: entries.filter((v: any) => v.status === 'no').length,
    };
  }, [event?.rsvps, event?.publicRsvps]);

  const goingNames = useMemo(() => {
    const all = { ...(event?.rsvps || {}), ...(event?.publicRsvps || {}) };
    return Object.values(all)
      .filter((v: any) => v.status === 'going')
      .map((v: any) => v.name)
      .filter(Boolean) as string[];
  }, [event?.rsvps, event?.publicRsvps]);

  const handleRsvp = async (status: 'going' | 'maybe' | 'no') => {
    if (!event || !eventId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      alert('Please enter your name first so the team knows who responded.');
      return;
    }
    setSubmitting(true);
    try {
      localStorage.setItem(NAME_KEY, trimmed);
      const newPublicRsvps = {
        ...(event.publicRsvps || {}),
        [token]: {
          status,
          name: trimmed,
          respondedAt: new Date(),
        },
      };
      await updateDoc(doc(db, 'events', eventId), { publicRsvps: newPublicRsvps });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1800);
    } catch (err) {
      console.error('Error saving RSVP', err);
      alert('Sorry, we could not save your RSVP. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">📅</div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Event Not Found</h1>
          <p className="text-slate-500 text-sm mb-6">{error || 'This event may have been removed.'}</p>
          <Link to="/" className="inline-block px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-semibold rounded-lg">
            Go Home
          </Link>
        </div>
      </div>
    );
  }

  const start = event.date instanceof Date ? event.date : new Date(event.date);
  const isPast = start.getTime() < Date.now();

  const RsvpButton: React.FC<{ status: 'going' | 'maybe' | 'no'; label: string; icon: string; activeColor: string }> = ({ status, label, icon, activeColor }) => {
    const active = myStatus === status;
    return (
      <button
        onClick={() => handleRsvp(status)}
        disabled={submitting || isPast}
        className={`flex-1 px-3 py-3 rounded-xl text-sm font-semibold border transition-all ${
          active
            ? `${activeColor} text-white border-transparent shadow-md`
            : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <div className="text-xl mb-0.5">{icon}</div>
        {label}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="max-w-xl mx-auto px-4 py-6 sm:py-10">
        <div className="bg-white rounded-3xl shadow-sm ring-1 ring-slate-200/70 overflow-hidden">
          {/* Header banner */}
          <div className="bg-gradient-to-r from-navy-700 via-navy-600 to-fire-700 px-6 py-6 text-white">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/80 mb-2">
              <span>{eventTypeIcon(event.type)}</span>
              <span>{eventTypeLabel(event.type)}</span>
              {isPast && <span className="ml-auto px-2 py-0.5 rounded-full bg-white/15">Past event</span>}
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight break-words">
              {event.title}
            </h1>
          </div>

          {/* Details */}
          <div className="px-6 py-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="text-2xl shrink-0">📅</div>
              <div className="min-w-0">
                <div className="text-sm text-slate-500 font-medium">When</div>
                <div className="text-base text-slate-900 font-semibold break-words">
                  {formatLong(start)}
                </div>
                <div className="text-sm text-slate-600">{formatTime(start)}</div>
              </div>
            </div>

            {event.location && (
              <div className="flex items-start gap-3">
                <div className="text-2xl shrink-0">📍</div>
                <div className="min-w-0">
                  <div className="text-sm text-slate-500 font-medium">Where</div>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-base text-cyan-700 hover:text-cyan-800 font-semibold break-words underline-offset-2 hover:underline"
                  >
                    {event.location}
                  </a>
                </div>
              </div>
            )}

            {event.description && (
              <div className="flex items-start gap-3">
                <div className="text-2xl shrink-0">📝</div>
                <div className="min-w-0">
                  <div className="text-sm text-slate-500 font-medium">Details</div>
                  <p className="text-sm text-slate-700 whitespace-pre-line break-words">
                    {event.description}
                  </p>
                </div>
              </div>
            )}

            {event.createdByName && (
              <div className="text-xs text-slate-500 pt-1 border-t border-slate-100">
                Posted by {event.createdByName}
              </div>
            )}
          </div>

          {/* RSVP */}
          <div className="px-6 py-5 bg-slate-50 border-t border-slate-200/70">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600 mb-3">
              {isPast ? 'Final RSVPs' : 'Will you be there?'}
            </h2>

            {!isPast && (
              <>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-3 py-2.5 mb-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent"
                  maxLength={60}
                />

                <div className="flex gap-2">
                  <RsvpButton status="going" label="Going" icon="✅" activeColor="bg-emerald-600" />
                  <RsvpButton status="maybe" label="Maybe" icon="🤔" activeColor="bg-amber-500" />
                  <RsvpButton status="no" label="Can't" icon="❌" activeColor="bg-rose-600" />
                </div>

                {myStatus && (
                  <p className="text-xs text-center text-slate-600 mt-3">
                    {justSaved ? '✓ Saved! ' : ''}You responded:{' '}
                    <span className="font-semibold">
                      {myStatus === 'going' && '✅ Going'}
                      {myStatus === 'maybe' && '🤔 Maybe'}
                      {myStatus === 'no' && "❌ Can't make it"}
                    </span>
                    . Tap a different button to change it.
                  </p>
                )}
              </>
            )}

            {/* Counts */}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-white border border-emerald-100 py-2">
                <div className="text-lg font-bold text-emerald-700">{counts.going}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Going</div>
              </div>
              <div className="rounded-xl bg-white border border-amber-100 py-2">
                <div className="text-lg font-bold text-amber-700">{counts.maybe}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Maybe</div>
              </div>
              <div className="rounded-xl bg-white border border-rose-100 py-2">
                <div className="text-lg font-bold text-rose-700">{counts.no}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Can't</div>
              </div>
            </div>

            {goingNames.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                  Going ({goingNames.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {goingNames.slice(0, 30).map((n, i) => (
                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium">
                      {n}
                    </span>
                  ))}
                  {goingNames.length > 30 && (
                    <span className="text-xs text-slate-500 self-center">+{goingNames.length - 30} more</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="px-6 py-4 border-t border-slate-200/70 flex flex-wrap gap-2">
            <button
              onClick={() => downloadIcs(event)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-navy-700 bg-fire-50 hover:bg-fire-100 rounded-lg border border-fire-200 transition-colors"
            >
              📅 Add to my calendar
            </button>
            <button
              onClick={async () => {
                const url = window.location.href;
                try {
                  if ((navigator as any).share) {
                    await (navigator as any).share({ title: event.title, url });
                    return;
                  }
                } catch { /* ignore */ }
                try {
                  await navigator.clipboard.writeText(url);
                  alert('Link copied!');
                } catch {
                  window.prompt('Copy this link:', url);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-navy-700 bg-cyan-50 hover:bg-cyan-100 rounded-lg border border-cyan-200 transition-colors"
            >
              🔗 Share this event
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Powered by your team app
        </p>
      </div>
    </div>
  );
};

export default PublicEvent;
