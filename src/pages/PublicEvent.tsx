// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { CalendarEvent } from '../types';
import { getWeatherForEvent, WeatherSummary } from '../utils/weather';
import { mapsUrl } from '../utils/maps';

// Public share-link page for an event. Anyone with the URL can land
// here without signing in, see the event details, and RSVP.
// Visual language matches the new authenticated EventDetail (navy
// hero, monoline icons, type-stripes). Adds roster autocomplete to
// the name field so when a parent types "Logan" we can suggest
// "Logan Smith" → the resulting RSVP gets tagged with the matched
// playerId so the coach can one-tap accept it as official.

const TOKEN_KEY = 'public_event_rsvp_token';
const NAME_KEY = 'public_event_rsvp_name';
const COACH_KEY = 'public_event_rsvp_is_coach';

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

const getToken = (): string => {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = `g_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
};

type RsvpStatus = 'going' | 'maybe' | 'no';

interface CountdownState { label: string; variant: 'upcoming' | 'live' | 'past'; }

function computeCountdown(start: Date, end?: Date): CountdownState {
  const now = Date.now();
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : startMs + 90 * 60 * 1000;
  if (now < startMs) {
    const diff = startMs - now;
    const min = Math.floor(diff / 60_000);
    if (min < 60) return { label: `Starts in ${min}m`, variant: 'upcoming' };
    const hr = Math.floor(min / 60);
    if (hr < 24) return { label: `Starts in ${hr}h`, variant: 'upcoming' };
    return { label: `Starts in ${Math.floor(hr / 24)}d`, variant: 'upcoming' };
  }
  if (now < endMs) return { label: 'Live now', variant: 'live' };
  const ago = now - endMs;
  const hAgo = Math.floor(ago / 3_600_000);
  if (hAgo < 24) return { label: `Ended ${hAgo}h ago`, variant: 'past' };
  return { label: `Ended ${Math.floor(hAgo / 24)}d ago`, variant: 'past' };
}

function formatTimeRange(start: Date, end?: Date): string {
  const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!end) return s;
  const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${s} – ${e}`;
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-4 h-4' }) => {
  const c = `${className} stroke-current`;
  const p = { fill: 'none' as const, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'check': return <svg className={c} {...p} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'q': return <svg className={c} {...p} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'x': return <svg className={c} {...p} viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case 'cal': return <svg className={c} {...p} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case 'clock': return <svg className={c} {...p} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case 'pin': return <svg className={c} {...p} viewBox="0 0 24 24"><path d="M12 22s-8-4.5-8-12a8 8 0 1 1 16 0c0 7.5-8 12-8 12z"/><circle cx="12" cy="10" r="3"/></svg>;
    case 'cloud': return <svg className={c} {...p} viewBox="0 0 24 24"><circle cx="17" cy="9" r="3"/><path d="M9 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11.79-1.5A4 4 0 1 0 7 18h2z"/></svg>;
    case 'users': return <svg className={c} {...p} viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>;
  }
  return null;
};

const PublicEvent: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string>(localStorage.getItem(NAME_KEY) || '');
  const [isCoach, setIsCoach] = useState<boolean>(localStorage.getItem(COACH_KEY) === '1');
  const [submitting, setSubmitting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Roster fetched once we know the event's team. Used to suggest roster
  // matches when a guest types their name — the resulting RSVP carries
  // a matchedPlayerId hint so the coach can one-tap accept it.
  const [roster, setRoster] = useState<Array<{ id: string; name: string }>>([]);
  const [matchedPlayerId, setMatchedPlayerId] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  const [now, setNow] = useState(() => new Date());

  const token = useMemo(() => getToken(), []);

  // Re-tick the countdown each minute.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

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
          endDate: data.endDate?.toDate ? data.endDate.toDate() : (data.endDate ? new Date(data.endDate) : undefined),
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

  // Fetch roster once we know teamId. /players is publicly readable per
  // firestore.rules so this works without auth.
  useEffect(() => {
    if (!event?.teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', event.teamId),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false)
          .map((p: any) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setRoster(list);
      } catch (err) {
        // Non-fatal — autocomplete just won't work.
      }
    })();
    return () => { cancelled = true; };
  }, [event?.teamId]);

  // Fetch weather (if there's a location + the event is within the
  // Open-Meteo 16-day window).
  useEffect(() => {
    if (!event?.location || !event?.date) return;
    let cancelled = false;
    (async () => {
      try {
        const w = await getWeatherForEvent(event.location, new Date(event.date));
        if (!cancelled) setWeather(w);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [event?.id, event?.location, event?.date]);

  // Suggestions for the name input — fuzzy match against roster.
  const suggestions = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (q.length < 2) return [];
    const tokens = q.split(/\s+/);
    return roster
      .map(rp => {
        const rTokens = rp.name.toLowerCase().split(/\s+/);
        const score = tokens.reduce((s, t) => {
          const hit = rTokens.some(rt => rt.startsWith(t) || t.startsWith(rt));
          return s + (hit ? 1 : 0);
        }, 0);
        return { ...rp, score };
      })
      .filter(rp => rp.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [name, roster]);

  const myRsvp = event?.publicRsvps?.[token];
  const myStatus = myRsvp?.status as RsvpStatus | undefined;

  // RSVP counts. publicRsvps + authenticated rsvps + per-player rsvps
  // all contribute to the going/maybe/no totals.
  const counts = useMemo(() => {
    const r = (event?.rsvps || {}) as Record<string, any>;
    const pub = (event?.publicRsvps || {}) as Record<string, any>;
    const playerR = ((event as any)?.playerRsvps || {}) as Record<string, any>;
    const tally = (vals: any[]) => ({
      going: vals.filter((v: any) => v.status === 'going').length,
      maybe: vals.filter((v: any) => v.status === 'maybe').length,
      no: vals.filter((v: any) => v.status === 'no').length,
    });
    return tally([...Object.values(r), ...Object.values(pub), ...Object.values(playerR)]);
  }, [event?.rsvps, event?.publicRsvps, (event as any)?.playerRsvps]);

  // Build a roster lookup by id so RSVPs that have a matchedPlayerId
  // (parent RSVP'd via /event link, system matched them to a roster
  // kid) can DISPLAY the player's name instead of the parent's typed
  // name. Patrick 2026-06-21: 'I have a chantel flake who has a son
  // by the name of ruston. her name is coming up when she rsvps and
  // not her son's.' Display fix only — the underlying RSVP doc still
  // stores the typed name (for chase-down accountability). For roster
  // matches, the visible name flips to the player.
  const rosterById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of roster) map.set(p.id, p.name);
    return map;
  }, [roster]);

  const displayNameFor = (v: any): string => {
    if (v?.matchedPlayerId && rosterById.has(v.matchedPlayerId)) {
      return rosterById.get(v.matchedPlayerId)!;
    }
    return v?.playerName || v?.name || 'Member';
  };

  // Per-entry type for the headcount list. 'roster' = a kid on the
  // team is going. 'staff' = a coach/staff is going (separate from
  // any kid attendance they may also have stamped). 'guest' = an
  // unknown public RSVP or signed-in user with no roster match and
  // no coach role.
  type HeadcountEntry = { name: string; kind: 'roster' | 'staff' | 'guest' };

  const goingPeople = useMemo<HeadcountEntry[]>(() => {
    const r = (event?.rsvps || {}) as Record<string, any>;
    const pub = (event?.publicRsvps || {}) as Record<string, any>;
    const playerR = ((event as any)?.playerRsvps || {}) as Record<string, any>;
    const list: HeadcountEntry[] = [];
    // 1) Roster kids — playerRsvps is the canonical source per the
    //    2026-06-21 attribution rework.
    for (const v of Object.values(playerR) as any[]) {
      if (v.status !== 'going') continue;
      list.push({ name: v.playerName || 'Player', kind: 'roster' });
    }
    // 2) Coach / staff attendance — adults who tagged role=coach
    //    when RSVPing as themselves (Patrick going AS coach, distinct
    //    from his kid's RSVP above).
    for (const v of Object.values(r) as any[]) {
      if (v.status !== 'going') continue;
      const kind: HeadcountEntry['kind'] =
        v.role === 'coach' || v.role === 'staff' ? 'staff'
        : v.matchedPlayerId ? 'roster'
        : 'guest';
      const name = v.matchedPlayerId && rosterById.has(v.matchedPlayerId)
        ? rosterById.get(v.matchedPlayerId)!
        : (v.name || 'Member');
      list.push({ name, kind });
    }
    // 3) Public / share-link RSVPs — if matched to a roster kid,
    //    show as roster; otherwise guest.
    for (const v of Object.values(pub) as any[]) {
      if (v.status !== 'going') continue;
      const kind: HeadcountEntry['kind'] = v.matchedPlayerId ? 'roster' : (v.isCoach ? 'staff' : 'guest');
      const name = v.matchedPlayerId && rosterById.has(v.matchedPlayerId)
        ? rosterById.get(v.matchedPlayerId)!
        : (v.name || 'Guest');
      list.push({ name, kind });
    }
    return list;
  }, [event?.rsvps, event?.publicRsvps, (event as any)?.playerRsvps, rosterById]);

  const handleRsvp = async (status: RsvpStatus) => {
    if (!event || !eventId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      alert('Enter your name first so the coach knows who you are.');
      return;
    }
    setSubmitting(true);
    try {
      localStorage.setItem(NAME_KEY, trimmed);
      localStorage.setItem(COACH_KEY, isCoach ? '1' : '0');
      const newPublicRsvps = {
        ...(event.publicRsvps || {}),
        [token]: {
          status,
          name: trimmed,
          respondedAt: new Date(),
          ...(matchedPlayerId ? { matchedPlayerId } : {}),
          ...(isCoach ? { isCoach: true } : {}),
        },
      };
      await updateDoc(doc(db, 'events', eventId), { publicRsvps: newPublicRsvps });
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1800);
    } catch (err) {
      console.error('Error saving RSVP', err);
      alert('Sorry, we could not save your RSVP. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const pickSuggestion = (rp: { id: string; name: string }) => {
    setName(rp.name);
    setMatchedPlayerId(rp.id);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-crimson-400/30 border-t-cyan-500" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex flex-col items-center justify-center p-8 text-center">
        <p className="text-bone/65 mb-4 text-sm">{error || 'Event not found.'}</p>
        <Link to="/" className="text-crimson-600 font-semibold text-sm">← Go home</Link>
      </div>
    );
  }

  const startDate = event.date instanceof Date ? event.date : new Date(event.date);
  const endDate = event.endDate ? (event.endDate instanceof Date ? event.endDate : new Date(event.endDate)) : undefined;
  const countdown = computeCountdown(startDate, endDate);
  void now;

  const typeChip =
    event.type === 'game' ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
    : event.type === 'practice' ? 'bg-crimson-500/15 border-crimson-500/30 text-crimson-400'
    : 'bg-purple-500/15 border-purple-500/30 text-purple-300';
  const countdownClass =
    countdown.variant === 'live' ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
    : countdown.variant === 'past' ? 'bg-white/[0.04]0/10 border-slate-500/20 text-bone/40'
    : 'bg-crimson-500/10 border-crimson-500/25 text-bone/85';
  const pulseClass =
    countdown.variant === 'live' ? 'bg-rose-500'
    : countdown.variant === 'past' ? 'bg-white/[0.04]0'
    : 'bg-crimson-400 animate-pulse';

  const RsvpButton: React.FC<{ status: RsvpStatus; label: string; icon: string; activeBg: string; }> = ({ status, label, icon, activeBg }) => {
    const active = myStatus === status;
    return (
      <button
        onClick={() => handleRsvp(status)}
        disabled={submitting || countdown.variant === 'past'}
        className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 rounded-lg text-xs font-extrabold tracking-widest uppercase transition ${
          active
            ? `${activeBg} text-white shadow-md`
            : 'bg-charcoal-900 border border-white/10 text-bone hover:border-white/20'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        <Icon name={icon} className="w-4 h-4" />
        {label}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-charcoal-950">
      {/* HERO */}
      <section className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 border-b border-crimson-500/10 px-4 sm:px-6 pt-5 pb-6">
        <div className="max-w-xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] font-extrabold tracking-widest uppercase text-bone/35">
              <Icon name="users" className="w-3 h-3" /> Public invite
            </span>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-extrabold tracking-widest uppercase ${countdownClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${pulseClass}`} />
              {countdown.label}
            </span>
          </div>

          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-extrabold tracking-widest uppercase ${typeChip}`}>
            {event.type}
          </span>
          <h1 className="mt-1.5 text-2xl sm:text-3xl font-black text-white leading-tight">
            {event.title}
          </h1>
          <p className="mt-2 text-sm text-bone/35 flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1"><Icon name="cal" className="w-3 h-3 text-bone/40" /> {startDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span className="text-bone/65">·</span>
            <span className="inline-flex items-center gap-1"><Icon name="clock" className="w-3 h-3 text-bone/40" /> {formatTimeRange(startDate, endDate)}</span>
            {event.location && <>
              <span className="text-bone/65">·</span>
              <a
                href={mapsUrl({
                  name: event.location,
                  address: (event as any).locationAddress,
                  lat: (event as any).locationCoords?.lat,
                  lon: (event as any).locationCoords?.lon,
                })}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-crimson-400 underline decoration-dotted underline-offset-2"
              >
                <Icon name="pin" className="w-3 h-3 text-bone/40" /> {event.location}
              </a>
            </>}
          </p>
        </div>
      </section>

      <div className="max-w-xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* RSVP form */}
        <div className="bg-charcoal-900 rounded-xl shadow-sm p-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-bone/65 mb-2">
            Your RSVP
          </div>

          {/* Name + roster autocomplete. Placeholder + helper text
              clarify whose name belongs in the field — parents
              previously typed their own name and showed up as
              roster RSVPs (Patrick 2026-06-21 caught: 'her name is
              coming up when she rsvps and not her son's'). Now the
              prompt is explicit: type the PLAYER's name; coaches
              check the box below. */}
          <div className="relative">
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setMatchedPlayerId(null); }}
              placeholder="Player name (the kid attending)"
              className="w-full px-3 py-2.5 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-crimson-500/40"
            />
            {matchedPlayerId && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
                Matched
              </span>
            )}
          </div>
          {suggestions.length > 0 && !matchedPlayerId && (
            <div className="mt-1.5 -mb-1 flex flex-wrap gap-1.5">
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/40 self-center">Did you mean:</span>
              {suggestions.map(s => (
                <button
                  key={s.id}
                  onClick={() => pickSuggestion(s)}
                  className="text-[12px] font-bold px-2 py-1 rounded bg-crimson-500/15 border border-crimson-400/30 text-crimson-200 hover:bg-crimson-500/20"
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          <label className="mt-3 flex items-center gap-2 text-xs text-bone/65">
            <input
              type="checkbox"
              checked={isCoach}
              onChange={(e) => setIsCoach(e.target.checked)}
              className="rounded text-crimson-600 focus:ring-crimson-500"
            />
            I'm a coach / staff (not a player)
          </label>

          <div className="mt-3 flex gap-2">
            <RsvpButton status="going" label="Going" icon="check" activeBg="bg-gradient-to-br from-emerald-500 to-emerald-700" />
            <RsvpButton status="maybe" label="Maybe" icon="q" activeBg="bg-gradient-to-br from-amber-500 to-amber-700" />
            <RsvpButton status="no" label="Can't go" icon="x" activeBg="bg-gradient-to-br from-slate-600 to-charcoal-800" />
          </div>
          {justSaved && (
            <p className="mt-2 text-[11px] font-bold tracking-wide text-emerald-300 text-center">
              ✓ Saved. Thanks!
            </p>
          )}
        </div>

        {/* RSVP buckets + going list */}
        <div className="bg-charcoal-900 rounded-xl shadow-sm p-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-bone/65 mb-2 flex items-center gap-1.5">
            <Icon name="users" className="w-3 h-3 text-crimson-500" />
            Headcount
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="relative overflow-hidden rounded-lg bg-emerald-500/15 border border-emerald-400/30 px-3 py-2.5">
              <span className="absolute inset-x-0 top-0 h-0.5 bg-emerald-500" />
              <div className="text-2xl font-black text-emerald-300 leading-none">{counts.going}</div>
              <div className="text-[9px] font-extrabold tracking-widest text-bone/65 mt-1">GOING</div>
            </div>
            <div className="relative overflow-hidden rounded-lg bg-amber-500/15 border border-amber-400/30 px-3 py-2.5">
              <span className="absolute inset-x-0 top-0 h-0.5 bg-amber-500" />
              <div className="text-2xl font-black text-amber-300 leading-none">{counts.maybe}</div>
              <div className="text-[9px] font-extrabold tracking-widest text-bone/65 mt-1">MAYBE</div>
            </div>
            <div className="relative overflow-hidden rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2.5">
              <span className="absolute inset-x-0 top-0 h-0.5 bg-white/40" />
              <div className="text-2xl font-black text-bone/85 leading-none">{counts.no}</div>
              <div className="text-[9px] font-extrabold tracking-widest text-bone/65 mt-1">CAN'T GO</div>
            </div>
          </div>
          {goingPeople.length > 0 && (
            <ul className="mt-3 divide-y divide-white/5">
              {goingPeople.slice(0, 12).map((p, i) => {
                const badge = p.kind === 'roster'
                  ? { label: 'ROSTER', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30' }
                  : p.kind === 'staff'
                    ? { label: 'STAFF',  cls: 'bg-crimson-500/15 text-crimson-300 border-crimson-400/30' }
                    : { label: 'GUEST',  cls: 'bg-charcoal-950 text-bone/50 border-white/15' };
                return (
                  <li key={i} className="py-1.5 flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-gradient-to-br from-crimson-400 to-charcoal-700 flex-shrink-0" />
                    <span className="text-sm font-semibold text-bone flex-1 truncate">{p.name}</span>
                    <span className={`text-[9px] font-extrabold tracking-widest px-1.5 py-0.5 rounded border ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Weather */}
        {weather && (
          <div className="bg-charcoal-900 rounded-xl shadow-sm p-4">
            <div className="text-xs font-extrabold tracking-widest uppercase text-bone/65 mb-2 flex items-center gap-1.5">
              <Icon name="cloud" className="w-3 h-3 text-crimson-500" />
              Weather
            </div>
            <div className="flex items-center gap-3">
              <span className="text-3xl" aria-hidden>{weather.icon}</span>
              <div>
                <div className="text-xl font-black text-bone leading-none">
                  {weather.tempMaxF}° <span className="text-bone/40 font-semibold text-sm">/ {weather.tempMinF}°</span>
                </div>
                <div className="text-[11px] text-bone/50 mt-1 tracking-wide uppercase">
                  {weather.label}{weather.precipChance >= 20 && ` · ${weather.precipChance}% rain`}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Description */}
        {event.description && (
          <div className="bg-charcoal-900 rounded-xl shadow-sm p-4">
            <div className="text-xs font-extrabold tracking-widest uppercase text-bone/65 mb-1.5">
              About
            </div>
            <p className="text-sm text-bone/85 whitespace-pre-wrap">{event.description}</p>
          </div>
        )}

        <p className="text-[11px] text-bone/40 text-center pt-3">
          Get the full team experience —
          {' '}<a href="/" className="text-crimson-600 font-bold underline">install GoalKickr</a>.
        </p>
      </div>
    </div>
  );
};

export default PublicEvent;
