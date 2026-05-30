// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { CalendarEvent } from '../types';
import { isCoach } from '../utils/helpers';
import { getWeatherForEvent, WeatherSummary } from '../utils/weather';
import EventDiscussion from '../components/calendar/EventDiscussion';
import EventForm from '../components/calendar/EventForm';
import CarpoolBoard, { CarpoolPost } from '../components/calendar/CarpoolBoard';

// Authenticated event detail page — the "command center" for a single
// event. Replaces the old inline-expanded Calendar row and the public
// share-link page (PublicEvent) for logged-in users. Navy command-style
// hero, RSVP buckets w/ ROSTER vs GUEST tagging, weather + carpool.

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

type RsvpStatus = 'going' | 'maybe' | 'no';

interface CountdownState {
  label: string;
  variant: 'upcoming' | 'live' | 'past';
}

function computeCountdown(start: Date, end?: Date): CountdownState {
  const now = Date.now();
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : startMs + 90 * 60 * 1000; // assume 90 min if no end
  if (now < startMs) {
    const diff = startMs - now;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return { label: `Starts in ${minutes}m`, variant: 'upcoming' };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { label: `Starts in ${hours}h`, variant: 'upcoming' };
    const days = Math.floor(hours / 24);
    return { label: `Starts in ${days}d`, variant: 'upcoming' };
  }
  if (now < endMs) {
    return { label: 'Live now', variant: 'live' };
  }
  const ago = now - endMs;
  const hoursAgo = Math.floor(ago / 3_600_000);
  if (hoursAgo < 24) return { label: `Ended ${hoursAgo}h ago`, variant: 'past' };
  const daysAgo = Math.floor(hoursAgo / 24);
  return { label: `Ended ${daysAgo}d ago`, variant: 'past' };
}

function formatTimeRange(start: Date, end?: Date): string {
  const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!end) return s;
  const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${s} – ${e}`;
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-3.5 h-3.5' }) => {
  const common = `${className} stroke-current`;
  switch (name) {
    case 'arrow-left':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
    case 'edit':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case 'check':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'share':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>;
    case 'trash':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>;
    case 'users':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case 'cal':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case 'clock':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case 'pin':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 22s-8-4.5-8-12a8 8 0 1 1 16 0c0 7.5-8 12-8 12z"/><circle cx="12" cy="10" r="3"/></svg>;
    case 'cloud':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="17" cy="9" r="3"/><path d="M9 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11.79-1.5A4 4 0 1 0 7 18h2z"/></svg>;
    case 'car':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M3 17v-5l2-5h14l2 5v5h-3a2 2 0 0 1-4 0H10a2 2 0 0 1-4 0H3z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>;
    case 'link':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
  }
  return null;
};

const EventDetail: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocument, updateDocument, deleteDocument } = useFirestore();

  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const [now, setNow] = useState(() => new Date());
  // Team roster — only fetched when the viewer is a coach so we can
  // show the merge-guest-into-roster UI without leaking the roster to
  // parents/share-link viewers.
  const [roster, setRoster] = useState<Array<{ id: string; name: string }>>([]);
  // Which guest RSVP token, if any, the coach is currently merging.
  const [mergingToken, setMergingToken] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  // Edit dialog state (coaches only).
  const [isEditOpen, setIsEditOpen] = useState(false);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // Re-tick the countdown each minute.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await getDocument('events', eventId);
        if (cancelled) return;
        if (!raw) { setLoading(false); return; }
        const e = raw as any;
        setEvent({
          ...e,
          date: e.date?.toDate ? e.date.toDate() : new Date(e.date),
          endDate: e.endDate?.toDate ? e.endDate.toDate() : (e.endDate ? new Date(e.endDate) : undefined),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, getDocument]);

  // Load roster (coach only — drives the merge-into-roster picker).
  useEffect(() => {
    if (!isUserCoach || !selectedTeamId) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', selectedTeamId),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false)
          .map((p: any) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setRoster(list);
      } catch (err) {
        console.warn('roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isUserCoach, selectedTeamId]);

  // Fetch weather (next-event window only — Open-Meteo is ~16 days out).
  useEffect(() => {
    if (!event?.location) return;
    let cancelled = false;
    (async () => {
      try {
        const w = await getWeatherForEvent(event.location, new Date(event.date));
        if (!cancelled) setWeather(w);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [event?.id, event?.location, event?.date]);

  const eventDate = event ? new Date(event.date) : null;
  const eventEnd = event?.endDate ? new Date(event.endDate) : undefined;

  const countdown = useMemo(() => {
    if (!eventDate) return null;
    void now; // re-tick dependency
    return computeCountdown(eventDate, eventEnd);
  }, [eventDate?.getTime(), eventEnd?.getTime(), now]);

  // RSVP aggregation. ROSTER = playerRsvps + authenticated parent rsvps.
  // GUEST = publicRsvps (share-link).
  const buckets = useMemo(() => {
    if (!event) return { going: [], maybe: [], pending: 0 };
    const going: { name: string; uid?: string; isGuest: boolean }[] = [];
    const maybe: { name: string; uid?: string; isGuest: boolean }[] = [];
    const seen = new Set<string>();
    const playerR = (event as any).playerRsvps || {};
    for (const pid of Object.keys(playerR)) {
      const r = playerR[pid];
      const key = `player:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.status === 'going') going.push({ name: r.playerName, isGuest: false });
      else if (r.status === 'maybe') maybe.push({ name: r.playerName, isGuest: false });
    }
    const userR = event.rsvps || {};
    for (const uid of Object.keys(userR)) {
      const r = userR[uid];
      const key = `user:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.status === 'going') going.push({ name: r.name, uid, isGuest: false });
      else if (r.status === 'maybe') maybe.push({ name: r.name, uid, isGuest: false });
    }
    const publicR = (event as any).publicRsvps || {};
    for (const tok of Object.keys(publicR)) {
      const r = publicR[tok];
      const entry: any = { name: r.name, isGuest: true, guestToken: tok };
      // If the guest used the share-form autocomplete to pre-match a
      // roster player, surface that so the coach gets a "MATCHED"
      // pill (and the merge picker pre-suggests that player).
      if (r.matchedPlayerId) entry.matchedPlayerId = r.matchedPlayerId;
      if (r.status === 'going') going.push(entry);
      else if (r.status === 'maybe') maybe.push(entry);
    }
    // Pending = roster size minus everyone with a playerRsvp.
    const pending = Math.max(0, roster.length - Object.keys(playerR).length);
    return { going, maybe, pending };
  }, [event, roster.length]);

  const myRsvp = event && userData?.uid ? (event.rsvps || {})[userData.uid] : null;

  const setMyRsvp = async (status: RsvpStatus) => {
    if (!event || !userData?.uid) return;
    const next = {
      ...(event.rsvps || {}),
      [userData.uid]: {
        status,
        name: userData.name || userData.email || 'Unknown',
        role: (userData as any).role,
        respondedAt: new Date(),
      },
    };
    setEvent({ ...event, rsvps: next } as CalendarEvent);
    try {
      await updateDocument('events', event.id, { rsvps: next });
    } catch (err) {
      console.error('rsvp failed', err);
    }
  };

  const handleShare = async () => {
    if (!event) return;
    const shareUrl = `${window.location.origin}/event/${event.id}`;
    if (navigator.share) {
      try { await navigator.share({ title: event.title, url: shareUrl }); } catch {}
    } else {
      try { await navigator.clipboard.writeText(shareUrl); alert('Share link copied'); } catch {}
    }
  };

  // Convert a guest (share-link) RSVP into an official roster RSVP.
  // Removes the entry from publicRsvps and adds it to playerRsvps so
  // the player's lineup math is correct. Coach-only.
  const mergeGuestIntoRoster = async (guestToken: string, playerId: string, playerName: string) => {
    if (!event || !userData?.uid) return;
    setMergeBusy(true);
    try {
      const publicR = { ...((event as any).publicRsvps || {}) } as Record<string, any>;
      const guest = publicR[guestToken];
      if (!guest) { setMergingToken(null); setMergeBusy(false); return; }
      delete publicR[guestToken];
      const playerR = {
        ...((event as any).playerRsvps || {}),
        [playerId]: {
          status: guest.status,
          playerName,
          byUid: userData.uid,
          byName: userData.name || undefined,
          respondedAt: new Date(),
          // Note we keep a breadcrumb so coaches can later audit which
          // playerRsvps started life as a guest entry, in case we ever
          // need to undo or re-merge.
          mergedFromGuest: true,
          mergedFromGuestName: guest.name,
        },
      };
      // Optimistic.
      setEvent({ ...event, publicRsvps: publicR, playerRsvps: playerR } as any);
      await updateDocument('events', event.id, { publicRsvps: publicR, playerRsvps: playerR });
      setMergingToken(null);
    } catch (err) {
      console.error('merge failed', err);
      alert('Failed to merge — please try again.');
    } finally {
      setMergeBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!event) return;
    if (!window.confirm(`Delete "${event.title}"? This can't be undone.`)) return;
    try {
      await deleteDocument('events', event.id);
      navigate('/calendar');
    } catch (err) {
      console.error('delete failed', err);
      alert('Failed to delete.');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-cyan-200 border-t-cyan-500" />
      </div>
    );
  }

  if (!event || !eventDate) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-8 text-center">
        <p className="text-slate-600 mb-4">Event not found.</p>
        <Link to="/calendar" className="text-cyan-600 font-semibold">← Back to events</Link>
      </div>
    );
  }

  const typeColors: Record<string, { stripe: string; chip: string }> = {
    game: { stripe: 'from-rose-500 to-orange-500', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
    practice: { stripe: 'from-cyan-500 to-blue-600', chip: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
    event: { stripe: 'from-purple-500 to-pink-500', chip: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
  };
  const colors = typeColors[event.type] || typeColors.event;

  const countdownClass =
    countdown?.variant === 'live'
      ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
      : countdown?.variant === 'past'
      ? 'bg-slate-500/10 border-slate-500/20 text-slate-400'
      : 'bg-cyan-500/10 border-cyan-500/25 text-slate-200';
  const pulseClass =
    countdown?.variant === 'live' ? 'bg-rose-500'
    : countdown?.variant === 'past' ? 'bg-slate-500'
    : 'bg-cyan-400 animate-pulse';

  return (
    <div className="min-h-screen bg-slate-100">
      {/* HERO */}
      <section className="relative overflow-hidden bg-gradient-to-b from-slate-950 to-slate-900 border-b border-cyan-500/10 px-4 sm:px-6 pt-4 pb-5">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full bg-white/5 border border-white/10 text-white flex items-center justify-center hover:bg-white/10"
            aria-label="Back"
          >
            <Icon name="arrow-left" className="w-4 h-4" />
          </button>
          {countdown && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-extrabold tracking-widest uppercase ${countdownClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${pulseClass}`} />
              {countdown.label}
            </span>
          )}
          {isUserCoach ? (
            <button
              onClick={() => setIsEditOpen(true)}
              className="w-9 h-9 rounded-full bg-white/5 border border-white/10 text-white flex items-center justify-center hover:bg-white/10"
              aria-label="Edit event"
            >
              <Icon name="edit" className="w-4 h-4" />
            </button>
          ) : (
            <span className="w-9 h-9" aria-hidden />
          )}
        </div>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-extrabold tracking-widest uppercase ${colors.chip}`}>
          {event.type}
        </span>
        <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white leading-tight">
          {event.title}
        </h1>
        <p className="mt-2 text-sm text-slate-300 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1"><Icon name="cal" className="w-3 h-3 text-slate-400" /> {eventDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span className="text-slate-600">·</span>
          <span className="inline-flex items-center gap-1"><Icon name="clock" className="w-3 h-3 text-slate-400" /> {formatTimeRange(eventDate, eventEnd)}</span>
          {event.location && <>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1"><Icon name="pin" className="w-3 h-3 text-slate-400" /> {event.location}</span>
          </>}
        </p>
      </section>

      {/* QUICK ACTIONS */}
      <div className="bg-slate-50 px-4 sm:px-6 py-3 grid grid-cols-3 gap-2 border-b border-slate-200">
        <button
          onClick={() => setMyRsvp('going')}
          className={`flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg text-xs font-bold tracking-wider uppercase ${
            myRsvp?.status === 'going'
              ? 'bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-900 hover:border-emerald-400'
          }`}
        >
          <Icon name="check" className="w-4 h-4" />
          {myRsvp?.status === 'going' ? 'Going' : "I'm going"}
        </button>
        <button
          onClick={handleShare}
          className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-white border border-slate-200 text-slate-900 text-xs font-bold tracking-wider uppercase hover:border-cyan-400"
        >
          <Icon name="share" className="w-4 h-4" />
          Share
        </button>
        {isUserCoach ? (
          <button
            onClick={handleDelete}
            className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-white border border-rose-200 text-rose-700 text-xs font-bold tracking-wider uppercase hover:bg-rose-50"
          >
            <Icon name="trash" className="w-4 h-4" />
            Delete
          </button>
        ) : (
          <button
            onClick={() => setMyRsvp('no')}
            className={`flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg text-xs font-bold tracking-wider uppercase ${
              myRsvp?.status === 'no'
                ? 'bg-slate-700 text-white'
                : 'bg-white border border-slate-200 text-slate-900 hover:border-slate-400'
            }`}
          >
            Can't go
          </button>
        )}
      </div>

      {/* RSVPS */}
      <section className="bg-white px-4 sm:px-6 py-3 border-b border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 flex items-center gap-1.5">
            <Icon name="users" className="w-3 h-3 text-cyan-500" />
            RSVPs
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="relative overflow-hidden rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-emerald-500" />
            <div className="text-2xl font-black text-emerald-700 leading-none">{buckets.going.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-slate-600 mt-1">GOING</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-amber-500" />
            <div className="text-2xl font-black text-amber-700 leading-none">{buckets.maybe.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-slate-600 mt-1">MAYBE</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-slate-400" />
            <div className="text-2xl font-black text-slate-700 leading-none">{buckets.pending}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-slate-600 mt-1">PENDING</div>
          </div>
        </div>
        {buckets.going.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100">
            {buckets.going.map((p: any, i) => (
              <li key={`go-${i}`} className="py-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-blue-700 flex-shrink-0" />
                  <span className="text-sm font-semibold text-slate-900 flex-1 truncate">{p.name}</span>
                  {p.isGuest && isUserCoach && roster.length > 0 && (
                    <button
                      onClick={() => setMergingToken(mergingToken === p.guestToken ? null : p.guestToken)}
                      className={`text-[9px] font-extrabold tracking-widest px-2 py-0.5 rounded border ${
                        p.matchedPlayerId
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                          : 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100'
                      }`}
                    >
                      {p.matchedPlayerId ? 'ACCEPT MATCH' : 'MERGE'}
                    </button>
                  )}
                  <span className={`text-[9px] font-extrabold tracking-widest px-1.5 py-0.5 rounded border ${
                    p.isGuest
                      ? 'bg-slate-100 text-slate-500 border-slate-300'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  }`}>
                    {p.isGuest ? 'GUEST' : 'ROSTER'}
                  </span>
                </div>
                {p.isGuest && mergingToken === p.guestToken && (
                  <div className="mt-2 ml-9 rounded-lg border border-cyan-200 bg-cyan-50/60 p-2">
                    <div className="text-[11px] text-slate-700 mb-1.5">
                      Merge <span className="font-bold">"{p.name}"</span> into roster player:
                    </div>
                    <div className="max-h-44 overflow-y-auto -mx-1">
                      {roster.map(rp => {
                        // Cheap heuristic — sort suggested matches first
                        // (anyone whose name shares any token with the
                        // guest name).
                        const guestTokens = p.name.toLowerCase().split(/\s+/);
                        const playerTokens = rp.name.toLowerCase().split(/\s+/);
                        const matches = guestTokens.some(g => playerTokens.some(pt => pt.startsWith(g) || g.startsWith(pt)));
                        return (
                          <button
                            key={rp.id}
                            disabled={mergeBusy}
                            onClick={() => mergeGuestIntoRoster(p.guestToken, rp.id, rp.name)}
                            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between hover:bg-cyan-100 disabled:opacity-50 ${
                              matches ? 'font-bold text-cyan-900' : 'text-slate-700'
                            }`}
                          >
                            <span>{rp.name}</span>
                            {matches && <span className="text-[9px] font-extrabold tracking-widest text-cyan-600">SUGGESTED</span>}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => setMergingToken(null)}
                      className="mt-1 w-full text-center text-[11px] font-bold text-slate-500 py-1 hover:text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* WEATHER */}
      {weather && (
        <section className="bg-white px-4 sm:px-6 py-3 border-b border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 flex items-center gap-1.5">
              <Icon name="cloud" className="w-3 h-3 text-cyan-500" />
              Weather
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>{weather.icon}</span>
            <div>
              <div className="text-xl font-black text-slate-900 leading-none">
                {weather.tempMaxF}° <span className="text-slate-400 font-semibold text-sm">/ {weather.tempMinF}°</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tracking-wide uppercase">
                {weather.label}
                {weather.precipChance >= 20 && ` · ${weather.precipChance}% rain`}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* DISCUSSION — per-event comment thread (doesn't clog the chat tab).
          notifyUids = everyone who RSVPd going/maybe through the
          authenticated rsvps map. Per-player RSVPs key by playerId
          (not uid) so they're skipped; share-link guest RSVPs have no
          uid and are skipped too — they get nothing. */}
      <EventDiscussion
        eventId={event.id}
        teamId={event.teamId}
        userUid={userData?.uid}
        userName={userData?.name}
        userPhotoURL={(userData as any)?.photoURL}
        eventTitle={event.title}
        notifyUids={(() => {
          const r = (event.rsvps || {}) as Record<string, any>;
          return Object.entries(r)
            .filter(([, v]) => v.status === 'going' || v.status === 'maybe')
            .map(([uid]) => uid);
        })()}
      />

      {/* WHAT TO BRING — coach-editable checklist, parent ticks per-uid */}
      <PackingListSection
        event={event}
        userUid={userData?.uid}
        isCoach={isUserCoach}
        onSave={async (next) => {
          if (!event) return;
          setEvent({ ...event, ...next } as any);
          try {
            await updateDocument('events', event.id, next);
          } catch (err) {
            console.error('packing save failed', err);
          }
        }}
      />

      {/* CARPOOL BOARD — offer / request / claim rides for this event */}
      <CarpoolBoard
        posts={((event as any).carpoolPosts || []) as CarpoolPost[]}
        currentUid={userData?.uid}
        currentName={userData?.name}
        onAdd={async (post) => {
          if (!event || !userData?.uid) return;
          const entry: CarpoolPost = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            uid: userData.uid,
            name: userData.name || userData.email || 'Unknown',
            type: post.type,
            seats: post.seats,
            location: post.location,
            note: post.note,
            createdAt: new Date(),
          };
          const next = [...(((event as any).carpoolPosts || []) as CarpoolPost[]), entry];
          setEvent({ ...event, carpoolPosts: next } as any);
          try { await updateDocument('events', event.id, { carpoolPosts: next }); }
          catch (err) { console.error('carpool add failed', err); }
        }}
        onDelete={async (postId) => {
          if (!event) return;
          const next = (((event as any).carpoolPosts || []) as CarpoolPost[]).filter(p => p.id !== postId);
          setEvent({ ...event, carpoolPosts: next } as any);
          try { await updateDocument('events', event.id, { carpoolPosts: next }); }
          catch (err) { console.error('carpool delete failed', err); }
        }}
      />

      {/* EDIT MODAL (coach only) */}
      {isUserCoach && (
        <EventForm
          isOpen={isEditOpen}
          onClose={() => setIsEditOpen(false)}
          onEventUpdated={(updated: any) => {
            // Refresh the local event with the saved version so the hero
            // / RSVP / weather all reflect the edit immediately.
            if (updated) {
              setEvent({
                ...updated,
                date: updated.date instanceof Date ? updated.date : new Date(updated.date),
                endDate: updated.endDate
                  ? (updated.endDate instanceof Date ? updated.endDate : new Date(updated.endDate))
                  : undefined,
              } as CalendarEvent);
            }
            setIsEditOpen(false);
          }}
          editingEvent={event}
        />
      )}

      {/* DESCRIPTION */}
      {event.description && (
        <section className="bg-white px-4 sm:px-6 py-3 border-b border-slate-200">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 mb-1.5">
            About
          </div>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{event.description}</p>
        </section>
      )}
    </div>
  );
};

// ---------- Packing checklist ----------
const PackingListSection: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  isCoach: boolean;
  onSave: (patch: { packingList?: any[]; packingCheckedBy?: Record<string, string[]> }) => Promise<void>;
}> = ({ event, userUid, isCoach, onSave }) => {
  const list = (event as any).packingList || [];
  const checkedByAll = ((event as any).packingCheckedBy || {}) as Record<string, string[]>;
  const myChecked = userUid ? (checkedByAll[userUid] || []) : [];

  const [editing, setEditing] = useState(false);
  const [draftLabels, setDraftLabels] = useState<string[]>(list.map((i: any) => i.label));
  const [newLabel, setNewLabel] = useState('');

  // When the user opens edit mode, snapshot the current labels.
  useEffect(() => {
    if (editing) setDraftLabels(list.map((i: any) => i.label));
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (itemId: string) => {
    if (!userUid) return;
    const nextSet = new Set(myChecked);
    if (nextSet.has(itemId)) nextSet.delete(itemId);
    else nextSet.add(itemId);
    const nextChecked = { ...checkedByAll, [userUid]: Array.from(nextSet) };
    await onSave({ packingCheckedBy: nextChecked });
  };

  const saveEdits = async () => {
    const cleaned = draftLabels.map(l => l.trim()).filter(Boolean);
    const nextList = cleaned.map((label, i) => {
      // Try to keep the original id so per-parent checkmarks survive
      // edits when the label hasn't changed.
      const existing = list[i];
      return { id: existing?.id || `pl_${Date.now()}_${i}`, label };
    });
    await onSave({ packingList: nextList });
    setEditing(false);
  };

  // No list yet + not coach → don't render the section at all.
  if (list.length === 0 && !isCoach) return null;

  return (
    <section className="bg-white px-4 sm:px-6 py-3 border-b border-slate-200">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-cyan-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          What to bring
        </div>
        {isCoach && !editing && (
          <button onClick={() => setEditing(true)} className="text-[11px] font-extrabold tracking-widest uppercase text-cyan-600">
            {list.length === 0 ? '+ Add' : 'Edit'}
          </button>
        )}
        {editing && (
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="text-[11px] font-bold tracking-wide text-slate-500">Cancel</button>
            <button onClick={saveEdits} className="text-[11px] font-extrabold tracking-widest uppercase text-emerald-600">Save</button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          {draftLabels.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={label}
                onChange={(e) => {
                  const copy = [...draftLabels];
                  copy[i] = e.target.value;
                  setDraftLabels(copy);
                }}
                className="flex-1 px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                placeholder="e.g. Cleats"
              />
              <button
                onClick={() => setDraftLabels(draftLabels.filter((_, j) => j !== i))}
                className="text-rose-500 text-xs font-bold"
              >Remove</button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newLabel.trim()) {
                  setDraftLabels([...draftLabels, newLabel.trim()]);
                  setNewLabel('');
                  e.preventDefault();
                }
              }}
              className="flex-1 px-3 py-1.5 border border-slate-200 rounded-md text-sm"
              placeholder="Add an item — press Enter"
            />
            <button
              onClick={() => {
                if (newLabel.trim()) {
                  setDraftLabels([...draftLabels, newLabel.trim()]);
                  setNewLabel('');
                }
              }}
              className="px-3 py-1.5 bg-cyan-600 text-white text-xs font-bold rounded-md"
            >Add</button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">No packing list set yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((item: any) => {
            const isChecked = myChecked.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  onClick={() => toggle(item.id)}
                  disabled={!userUid}
                  className="w-full flex items-center gap-2.5 py-1 text-left disabled:cursor-not-allowed"
                >
                  <span className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center flex-shrink-0 ${
                    isChecked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300'
                  }`}>
                    {isChecked && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </span>
                  <span className={`text-sm ${isChecked ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                    {item.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default EventDetail;
