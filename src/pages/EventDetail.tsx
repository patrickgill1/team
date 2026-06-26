// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { CalendarEvent } from '../types';
import { isCoach } from '../utils/helpers';
import { getWeatherForEvent, WeatherSummary } from '../utils/weather';
import EventForm from '../components/calendar/EventForm';
import CarpoolBoard, { CarpoolPost } from '../components/calendar/CarpoolBoard';
import EventDiscussion from '../components/calendar/EventDiscussion';
import SnackAssignment from '../components/calendar/SnackAssignment';
import { mapsUrl, osmEmbedUrl } from '../utils/maps';
import RosterAvatar from '../components/common/RosterAvatar';

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

// Stable color from name hash for initial-letter avatars in the RSVP
// list. Same palette as chat avatars so the look is consistent.
function rsvpAvatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = [
    'from-rose-400 to-rose-600',
    'from-amber-400 to-orange-600',
    'from-emerald-400 to-emerald-600',
    'from-brand-primary-soft to-brand-primary',
    'from-violet-400 to-violet-600',
    'from-fuchsia-400 to-pink-600',
    'from-brand-primary-soft to-charcoal-600',
    'from-teal-400 to-teal-600',
  ];
  return palette[h % palette.length];
}

function formatTimeRange(start: Date, end?: Date): string {
  const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!end || isNaN(end.getTime())) return s;
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
    case 'bell':
      return <svg className={common} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
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
  // Team roster — loaded for everyone (not just coaches) so parents
  // also see player profile photos in the RSVP list. The coach-only
  // merge-guest UI gates separately on isUserCoach below.
  const [roster, setRoster] = useState<Array<{ id: string; name: string; photoURL?: string }>>([]);
  // User photo lookup for parent RSVPs — fetched lazily once we know
  // which uids actually RSVPed.
  const [userPhotoMap, setUserPhotoMap] = useState<Record<string, string>>({});
  // Players linked to the current user (parent → kids). Drives the
  // per-kid RSVP rows so a coach-who-is-also-a-parent can RSVP for
  // themselves AND their kid in the same screen.
  const [myLinkedPlayers, setMyLinkedPlayers] = useState<Array<{ id: string; name: string }>>([]);
  // Which guest RSVP token, if any, the coach is currently merging.
  const [mergingToken, setMergingToken] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  // Edit dialog state (coaches only).
  const [isEditOpen, setIsEditOpen] = useState(false);
  // Coach-triggered RSVP nudge. Tracks in-flight so we don't double-fire.
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindToast, setRemindToast] = useState<string | null>(null);
  const [attendanceOpen, setAttendanceOpen] = useState(false);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // Form signups — when a coach attaches a questionnaire-style form
  // to this event via FormDefinition.allocateToEventId, each submitter
  // gets stamped on form_submissions with linkedEventId. We query
  // those once on load and surface them in a coach-visible section
  // beneath the RSVP / attendance area.
  const [signups, setSignups] = useState<Array<{
    id: string;
    playerId: string;
    formName: string;
    submittedAt: Date | null;
    submittedByName?: string;
    answers: Record<string, any>;
    answerLabels: Record<string, string>;
  }>>([]);
  useEffect(() => {
    if (!eventId || !isUserCoach) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          collection(db, 'form_submissions'),
          where('linkedEventId', '==', eventId),
        ));
        if (cancelled) return;
        const rows = snap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            playerId: data.playerId || '',
            formName: data.formName || 'Form',
            submittedAt: data.submittedAt?.toDate?.() || null,
            submittedByName: data.submittedByName,
            answers: data.answers || {},
            answerLabels: data.answerLabels || {},
          };
        });
        rows.sort((a, b) => (b.submittedAt?.getTime() || 0) - (a.submittedAt?.getTime() || 0));
        setSignups(rows);
      } catch (err) {
        console.warn('signups load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, isUserCoach]);

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

  // Load players linked to the current user — drives the per-kid
  // RSVP rows. Any user with kids on this team (parent OR coach-with-
  // kid) sees them. Runs for everyone, not just coaches.
  useEffect(() => {
    if (!userData?.uid || !event?.teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false)
          .filter((p: any) => Array.isArray(p.teamIds) ? p.teamIds.includes(event.teamId) : true)
          .map((p: any) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setMyLinkedPlayers(list);
      } catch (err) {
        console.warn('linked players load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, event?.teamId]);

  // Load roster — runs for everyone so player avatars resolve for
  // parents too. Coach-only merge UI gates separately below.
  useEffect(() => {
    const teamId = event?.teamId || selectedTeamId;
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', teamId),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false)
          .map((p: any) => ({ id: p.id, name: p.name, photoURL: p.profilePhotoUrl || undefined }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setRoster(list);
      } catch (err) {
        console.warn('roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [event?.teamId, selectedTeamId]);

  // Lazy-fetch user photoURLs for everyone in the rsvps map so parent
  // RSVP rows render their avatars. Diffs against the existing map so
  // we don't re-fetch on every render.
  useEffect(() => {
    if (!event?.rsvps) return;
    const uids = Object.keys(event.rsvps).filter(uid => uid && !(uid in userPhotoMap));
    if (uids.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { doc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const next: Record<string, string> = {};
        for (const uid of uids) {
          try {
            const snap = await getDoc(doc(db, 'users', uid));
            if (snap.exists()) {
              const u: any = snap.data();
              next[uid] = u.photoURL || u.profilePhotoUrl || '';
            } else {
              next[uid] = '';
            }
          } catch { next[uid] = ''; }
        }
        if (!cancelled) setUserPhotoMap(prev => ({ ...prev, ...next }));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [event?.rsvps, userPhotoMap]);

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

  // RSVP aggregation. Patrick 2026-06-21 attribution rework:
  //   ROSTER = playerRsvps (kid attendance, source of truth)
  //   STAFF  = adult rsvps with role 'coach' or 'staff' (Patrick
  //            attending AS coach, distinct from his kid's RSVP)
  //   GUEST  = publicRsvps (share-link RSVPs without a roster match)
  const buckets = useMemo(() => {
    if (!event) return { going: [], maybe: [], cant: [], pending: 0 };
    type Entry = { name: string; uid?: string; playerId?: string; kind: 'roster' | 'staff' | 'guest'; matchedPlayerId?: string; guestToken?: string };
    const going: Entry[] = [];
    const maybe: Entry[] = [];
    const cant: Entry[] = [];
    const seen = new Set<string>();
    const playerR = (event as any).playerRsvps || {};
    for (const pid of Object.keys(playerR)) {
      const r = playerR[pid];
      const key = `player:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.status === 'going') going.push({ name: r.playerName, playerId: pid, kind: 'roster' });
      else if (r.status === 'maybe') maybe.push({ name: r.playerName, playerId: pid, kind: 'roster' });
      else if (r.status === 'no') cant.push({ name: r.playerName, playerId: pid, kind: 'roster' });
    }
    // Adult RSVPs tagged with role 'coach' or 'staff' — surface as
    // their own STAFF row in the headcount, distinct from any kid
    // attendance they may have stamped above. Untagged adult RSVPs
    // (legacy entries with no role) are intentionally dropped from
    // the list to avoid the historical 'Chantel showing as roster'
    // confusion. Once a parent re-RSVPs through the new flow their
    // entry routes to playerRsvps and they stop showing as adult.
    const adultR = (event as any).rsvps || {};
    for (const uid of Object.keys(adultR)) {
      const r = adultR[uid];
      if (r.role !== 'coach' && r.role !== 'staff') continue;
      const entry: Entry = { name: r.name || 'Coach', uid, kind: 'staff' };
      if (r.status === 'going') going.push(entry);
      else if (r.status === 'maybe') maybe.push(entry);
      else if (r.status === 'no') cant.push(entry);
    }
    const publicR = (event as any).publicRsvps || {};
    for (const tok of Object.keys(publicR)) {
      const r = publicR[tok];
      const entry: Entry = {
        name: r.name,
        guestToken: tok,
        // If the guest used the share-form autocomplete to pre-match
        // a roster player, the entry counts as a roster RSVP for that
        // kid (use the player's name from roster if available); else
        // it's a guest. If they self-tagged as coach via the public
        // form's checkbox, treat as staff.
        kind: r.matchedPlayerId ? 'roster' : (r.isCoach ? 'staff' : 'guest'),
      };
      if (r.matchedPlayerId) {
        entry.matchedPlayerId = r.matchedPlayerId;
        const matched = roster.find(p => p.id === r.matchedPlayerId);
        if (matched) entry.name = matched.name;
      }
      if (r.status === 'going') going.push(entry);
      else if (r.status === 'maybe') maybe.push(entry);
      else if (r.status === 'no') cant.push(entry);
    }
    // Pending = roster size minus everyone with a playerRsvp (any status).
    const pending = Math.max(0, roster.length - Object.keys(playerR).length);
    return { going, maybe, cant, pending };
  }, [event, roster.length]);

  // Photo lookup for an RSVP row. Players: roster.photoURL by playerId.
  // Parents: userPhotoMap by uid. Falls back to a colored-initial
  // gradient circle when nothing's available.
  const photoForEntry = (p: { uid?: string; playerId?: string }): string | undefined => {
    if (p.playerId) return roster.find(r => r.id === p.playerId)?.photoURL;
    if (p.uid) return userPhotoMap[p.uid] || undefined;
    return undefined;
  };

  const myRsvp = event && userData?.uid ? (event.rsvps || {})[userData.uid] : null;

  // When a non-staff user has linked players, the Quick Actions
  // Going / Can't-go buttons should RSVP the KID, not the parent —
  // the parent's adult attendance isn't what the coach is planning
  // around. Coaches keep their personal RSVP (they need to track
  // their own attendance, AND they have per-kid rows below). For
  // parents with zero linked players, fall back to personal RSVP so
  // they still have a way to respond.
  // Use kid quick actions whenever the user has linked kids on this
  // team — regardless of coach role. Coaches who are also parents get
  // a SEPARATE 'Coach attendance' card below (Patrick 2026-06-21:
  // 'i am going to need to also be able to rsvp and show coach is
  // going separate from my son').
  const useKidQuickActions = myLinkedPlayers.length > 0;

  // For the button's active state when in kid-mode: only highlight
  // when ALL linked kids share the same status, otherwise leave it
  // neutral so the parent uses the per-kid rows for fine control.
  const kidGroupStatus: RsvpStatus | null = (() => {
    if (!useKidQuickActions || !event) return null;
    const playerR = (event as any).playerRsvps || {};
    const statuses = myLinkedPlayers.map(p => playerR[p.id]?.status as RsvpStatus | undefined);
    if (statuses.every(s => s === 'going')) return 'going';
    if (statuses.every(s => s === 'no')) return 'no';
    return null;
  })();

  const handleQuickRsvp = async (status: RsvpStatus) => {
    if (useKidQuickActions && event && userData?.uid) {
      // Build the updated playerRsvps map in one go so a multi-kid
      // parent doesn't see only the last kid's RSVP land (sequential
      // setPlayerRsvp() calls would race on stale state).
      const nextMap: Record<string, any> = { ...((event as any).playerRsvps || {}) };
      for (const p of myLinkedPlayers) {
        nextMap[p.id] = {
          status,
          playerName: p.name,
          byUid: userData.uid,
          byName: userData.name || undefined,
          respondedAt: new Date(),
        };
      }
      setEvent({ ...event, playerRsvps: nextMap } as any);
      try {
        await updateDocument('events', event.id, { playerRsvps: nextMap });
      } catch (err) {
        console.error('quick RSVP (kid) failed', err);
        alert('Failed to save RSVP.');
      }
      return;
    }
    await setMyRsvp(status);
  };

  // Active status the buttons display against — kid-group when in
  // parent-mode, parent's own RSVP otherwise.
  const quickActiveStatus: RsvpStatus | null = useKidQuickActions
    ? kidGroupStatus
    : (myRsvp?.status as RsvpStatus | null) || null;

  // Button label changes when we're RSVPing on behalf of a kid so
  // there's no confusion about who's being marked going.
  const quickGoingLabel = quickActiveStatus === 'going'
    ? 'Going'
    : useKidQuickActions
      ? (myLinkedPlayers.length === 1
          ? `${myLinkedPlayers[0].name.split(' ')[0]} going`
          : 'All going')
      : "I'm going";
  const quickNoLabel = useKidQuickActions
    ? (myLinkedPlayers.length === 1 ? "Can't go" : "None going")
    : "Can't go";

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

  // Coach attendance — only for coaches with linked kids. Writes to
  // event.rsvps[uid] with role: 'coach' so the headcount shows the
  // entry as STAFF, separate from the kid's roster RSVP above.
  const coachStatus: RsvpStatus | null = useMemo(() => {
    if (!isUserCoach || !event || !userData?.uid) return null;
    const r = ((event.rsvps || {}) as any)[userData.uid];
    return r?.role === 'coach' ? (r.status as RsvpStatus) : null;
  }, [isUserCoach, event, userData?.uid]);

  const setCoachRsvp = async (status: RsvpStatus | null) => {
    if (!event || !userData?.uid || !isUserCoach) return;
    const next: Record<string, any> = { ...(event.rsvps || {}) };
    if (status === null) {
      delete next[userData.uid];
    } else {
      next[userData.uid] = {
        status,
        name: (userData as any).name || 'Coach',
        role: 'coach',
        respondedAt: new Date(),
      };
    }
    setEvent({ ...event, rsvps: next } as CalendarEvent);
    try {
      await updateDocument('events', event.id, { rsvps: next });
    } catch (err) {
      console.error('coach rsvp failed', err);
    }
  };

  const setPlayerRsvp = async (playerId: string, playerName: string, status: RsvpStatus) => {
    if (!event || !userData?.uid) return;
    const next = {
      ...((event as any).playerRsvps || {}),
      [playerId]: {
        status,
        playerName,
        byUid: userData.uid,
        byName: userData.name || undefined,
        respondedAt: new Date(),
      },
    };
    setEvent({ ...event, playerRsvps: next } as any);
    try {
      await updateDocument('events', event.id, { playerRsvps: next });
    } catch (err) {
      console.error('player rsvp failed', err);
      alert('Failed to save RSVP.');
    }
  };

  // Convert a guest (share-link) RSVP into an official roster RSVP.
  // Removes the entry from publicRsvps and adds it to playerRsvps so
  // the player's lineup math is correct. Coach-only.
  // 2026-06-24: public share page killed; no NEW publicRsvps come in,
  // but old data can still be merged.
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
    if (!window.confirm(`Permanently delete "${event.title}"? This removes it for everyone. Use "Cancel event" instead if you want it to stay visible with a CANCELLED badge.`)) return;
    try {
      await deleteDocument('events', event.id);
      navigate('/calendar');
    } catch (err) {
      console.error('delete failed', err);
      alert('Failed to delete.');
    }
  };

  const handleCancel = async () => {
    if (!event || !userData?.uid) return;
    const reason = window.prompt(
      `Cancel "${event.title}"? Attendees will be notified.\n\nOptional reason (shown to everyone):`,
      ''
    );
    // window.prompt returns null on Cancel button, '' on empty submit.
    if (reason === null) return;
    try {
      await updateDocument('events', event.id, {
        isCancelled: true,
        cancelledAt: new Date(),
        cancelledBy: userData.uid,
        cancelReason: reason.trim() || null,
        updatedAt: new Date(),
      });
      // Optimistic local refresh.
      setEvent({
        ...event,
        isCancelled: true,
        cancelledAt: new Date(),
        cancelledBy: userData.uid,
        cancelReason: reason.trim() || undefined,
      } as any);
      // Push every authenticated participant (skip public guest tokens).
      try {
        const recipients = new Set<string>();
        Object.keys(event.rsvps || {}).forEach(uid => recipients.add(uid));
        Object.values(event.playerRsvps || {}).forEach((r: any) => { if (r?.byUid) recipients.add(r.byUid); });
        recipients.delete(userData.uid);
        if (recipients.size > 0) {
          const { sendPushToUsers } = await import('../utils/notify');
          await sendPushToUsers(Array.from(recipients), {
            title: `CANCELLED: ${event.title}`,
            body: reason.trim()
              ? `${userData.name || 'Coach'}: ${reason.trim().slice(0, 140)}`
              : `${userData.name || 'Coach'} cancelled this event.`,
            url: `/events/${event.id}`,
          }, { pushPrefKey: 'events' });
        }
      } catch (err) {
        console.warn('cancel push failed', err);
      }
    } catch (err) {
      console.error('cancel failed', err);
      alert('Failed to cancel.');
    }
  };

  // Coach-only: nudge parents of roster players who haven't RSVPed yet.
  // Skips players already in playerRsvps (any status — going/maybe/no
  // all count as "responded"). One push per parent UID, deduped.
  const handleRemindPending = async () => {
    if (!event || !userData?.uid) return;
    if (remindBusy) return;
    const playerR: Record<string, any> = (event as any).playerRsvps || {};
    const pendingPlayers = roster.filter(p => !playerR[p.id]);
    if (pendingPlayers.length === 0) {
      setRemindToast('Everyone has already RSVPed.');
      window.setTimeout(() => setRemindToast(null), 3500);
      return;
    }
    setRemindBusy(true);
    try {
      const { collection, getDocs, query, where, documentId } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      const parentUids = new Set<string>();
      // Firestore "in" caps at 30 ids per query — chunk it.
      const ids = pendingPlayers.map(p => p.id);
      for (let i = 0; i < ids.length; i += 30) {
        const slice = ids.slice(i, i + 30);
        const snap = await getDocs(query(
          collection(db, 'players'),
          where(documentId(), 'in', slice),
        ));
        snap.docs.forEach(d => {
          const p: any = d.data();
          if (Array.isArray(p.parentIds)) p.parentIds.forEach((u: string) => u && parentUids.add(u));
          if (p.parentId) parentUids.add(p.parentId);
        });
      }
      parentUids.delete(userData.uid);
      if (parentUids.size === 0) {
        setRemindToast('No parent accounts found for those players yet.');
        window.setTimeout(() => setRemindToast(null), 4000);
        return;
      }
      const { sendPushToUsers } = await import('../utils/notify');
      await sendPushToUsers(Array.from(parentUids), {
        title: `RSVP needed: ${event.title}`,
        body: `${userData.name || 'Coach'} is asking — please mark your player going/maybe/can't.`,
        url: `/events/${event.id}`,
      }, { pushPrefKey: 'events' });
      setRemindToast(`Reminder sent to ${parentUids.size} parent${parentUids.size === 1 ? '' : 's'}.`);
      window.setTimeout(() => setRemindToast(null), 4000);
    } catch (err) {
      console.error('remind pending failed', err);
      setRemindToast('Reminder failed — try again.');
      window.setTimeout(() => setRemindToast(null), 4000);
    } finally {
      setRemindBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!event || !userData?.uid) return;
    if (!window.confirm(`Restore "${event.title}"? Attendees will be notified it's back on.`)) return;
    try {
      await updateDocument('events', event.id, {
        isCancelled: false,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        updatedAt: new Date(),
      });
      setEvent({
        ...event,
        isCancelled: false,
        cancelledAt: undefined,
        cancelledBy: undefined,
        cancelReason: undefined,
      } as any);
      try {
        const recipients = new Set<string>();
        Object.keys(event.rsvps || {}).forEach(uid => recipients.add(uid));
        Object.values(event.playerRsvps || {}).forEach((r: any) => { if (r?.byUid) recipients.add(r.byUid); });
        recipients.delete(userData.uid);
        if (recipients.size > 0) {
          const { sendPushToUsers } = await import('../utils/notify');
          await sendPushToUsers(Array.from(recipients), {
            title: `Back on: ${event.title}`,
            body: `${userData.name || 'Coach'} restored this event.`,
            url: `/events/${event.id}`,
          }, { pushPrefKey: 'events' });
        }
      } catch (err) {
        console.warn('restore push failed', err);
      }
    } catch (err) {
      console.error('restore failed', err);
      alert('Failed to restore.');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
      </div>
    );
  }

  if (!event || !eventDate) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex flex-col items-center justify-center p-8 text-center">
        <p className="text-charcoal-400 mb-4">Event not found.</p>
        <Link to="/calendar" className="text-brand-primary font-semibold">← Back to events</Link>
      </div>
    );
  }

  const typeColors: Record<string, { stripe: string; chip: string }> = {
    game: { stripe: 'from-rose-500 to-orange-500', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
    practice: { stripe: 'from-brand-primary to-charcoal-600', chip: 'bg-brand-primary/10 text-brand-primary-soft border-brand-primary/30' },
    event: { stripe: 'from-purple-500 to-pink-500', chip: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
  };
  const colors = typeColors[event.type] || typeColors.event;

  const countdownClass =
    countdown?.variant === 'live'
      ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
      : countdown?.variant === 'past'
      ? 'bg-white/[0.04]0/10 border-slate-500/20 text-bone/50'
      : 'bg-brand-primary/10 border-brand-primary/25 text-bone/85';
  const pulseClass =
    countdown?.variant === 'live' ? 'bg-rose-500'
    : countdown?.variant === 'past' ? 'bg-white/[0.04]0'
    : 'bg-brand-primary-soft animate-pulse';

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-800 to-charcoal-950">
      {/* HERO — cinematic full-bleed treatment per v9 mockup. Ball-in-
          net photo lives on the right edge with a left-to-right
          gradient that fades it to near-black behind the copy, so the
          eyebrow / title / meta stay legible without a heavy overlay
          flattening the image. Same hero on every event by design
          ('feel free to push back' → 'yeah, i agree. same photo for
          every event'). */}
      <section className="relative overflow-hidden bg-charcoal-950 border-b border-brand-primary/10">
        {/* Background photo, right-anchored. object-right keeps the
            soccer ball in the visible portion when the section is
            wide; on phone widths the gradient eats the left half
            anyway so the image presence comes through as a glow on
            the right side. */}
        <img
          src="/images/event-hero.jpg"
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover object-right opacity-90"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* Left-to-right fade so text reads. The 70% stop sits past
            the title column, so the photo retains its right-edge
            presence and isn't washed flat. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-r from-charcoal-950 via-charcoal-950/85 to-charcoal-950/30"
        />
        {/* Bottom fade into the page so the hero doesn't sit on a
            hard horizon line. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-charcoal-900 pointer-events-none"
        />

        <div className="relative px-4 sm:px-6 pt-4 pb-6">
          {/* Top chrome row: back · countdown pill · edit. Pill is
              dead-center so it reads as the event's status badge. */}
          <div className="flex items-center justify-between mb-5">
            <button
              onClick={() => navigate(-1)}
              className="w-9 h-9 rounded-full bg-white/10 backdrop-blur ring-1 ring-white/15 text-white flex items-center justify-center hover:bg-white/15"
              aria-label="Back"
            >
              <Icon name="arrow-left" className="w-4 h-4" />
            </button>
            {countdown && (
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-extrabold tracking-widest uppercase ${countdownClass}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${pulseClass}`} />
                {countdown.label}
              </span>
            )}
            {isUserCoach ? (
              <button
                onClick={() => setIsEditOpen(true)}
                className="w-9 h-9 rounded-full bg-white/10 backdrop-blur ring-1 ring-white/15 text-white flex items-center justify-center hover:bg-white/15"
                aria-label="Edit event"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
            ) : (
              <span className="w-9 h-9" aria-hidden />
            )}
          </div>

          {/* Eyebrow + title + meta — sit on the left column. The
              max-w cap keeps the title from running into the right-
              edge photo on tablets/desktop. */}
          <div className="max-w-[78%]">
            <span className="inline-block text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft">
              {event.type}
            </span>
            <h1 className="mt-1 text-3xl sm:text-4xl font-black text-bone leading-[1.05] tracking-tight">
              {event.title}
            </h1>
            <p className="mt-3 text-[13.5px] text-charcoal-200 flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="cal" className="w-3.5 h-3.5 text-brand-primary-soft" />
                {eventDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="text-bone/50">·</span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="clock" className="w-3.5 h-3.5 text-brand-primary-soft" />
                {formatTimeRange(eventDate, eventEnd)}
              </span>
            </p>
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
                className="mt-1 inline-flex items-center gap-1.5 text-[13.5px] text-brand-primary-soft hover:text-brand-primary-soft underline decoration-dotted underline-offset-2"
                title="Open in Maps"
              >
                <Icon name="pin" className="w-3.5 h-3.5" />
                {event.location}
              </a>
            )}
            {(event as any).fieldNumber && (
              <div className="mt-2">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30 text-[10px] font-extrabold tracking-widest uppercase">
                  {(event as any).fieldNumber}
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* CANCELLED banner — shown to everyone when the event has been
          called off. Keeps the event visible so attendees see WHY
          nothing's happening, instead of the event silently vanishing. */}
      {event.isCancelled && (
        <div className="bg-amber-500/15 border-y border-amber-400/30 px-4 sm:px-6 py-3">
          <div className="flex items-start gap-3 max-w-3xl mx-auto">
            <div className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-amber-600 text-amber-50 flex-shrink-0">
              Cancelled
            </div>
            <div className="text-sm text-amber-200 flex-1 min-w-0">
              {event.cancelReason ? (
                <p className="leading-snug">{event.cancelReason}</p>
              ) : (
                <p className="leading-snug italic text-amber-200/60">No reason given.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PER-KID RSVPS — the primary RSVP path when the viewer has
          linked players. Sits above the personal Quick Actions so
          parents (and coach-with-kid) see their kid's RSVP as the
          default thing to act on. */}
      {/* Coach-side inline attendance — collapsed disclosure by
          default. Header is always visible (shows live going-count)
          so the coach can see the state at a glance; tap to expand
          the full roster + buttons. Writes to the same playerRsvps
          map parents touch via the per-kid RSVP rows below. */}
      {isUserCoach && roster.length > 0 && (() => {
        const goingCount = Object.values(((event as any).playerRsvps || {})).filter((r: any) => r?.status === 'going').length;
        return (
          <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 overflow-hidden">
            <button
              type="button"
              onClick={() => setAttendanceOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-white/[0.05] text-left"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon name="check" className="w-3 h-3 text-brand-primary shrink-0" />
                <span className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400">Mark attendance</span>
                <span className="text-[10px] text-bone/50 font-bold ml-1 truncate">
                  · {goingCount} going · {roster.length} on roster
                </span>
              </div>
              <svg className={`w-4 h-4 text-bone/50 shrink-0 transition-transform ${attendanceOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {attendanceOpen && (
              <ul className="divide-y divide-white/10 px-4 sm:px-6 pb-3">
                {roster.map(p => {
                  const current = ((event as any).playerRsvps || {})[p.id]?.status as RsvpStatus | undefined;
                  const btn = (status: RsvpStatus, label: string, active: string) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setPlayerRsvp(p.id, p.name, status)}
                      className={`inline-flex items-center justify-center px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${
                        current === status
                          ? `${active} text-white border-transparent shadow-sm`
                          : 'bg-charcoal-900 text-charcoal-400 border-white/10 hover:border-white/15'
                      }`}
                    >
                      {label}
                    </button>
                  );
                  return (
                    <li key={p.id} className="flex items-center gap-2 py-1.5">
                      <RosterAvatar name={p.name} photoUrl={p.photoURL} size={28} className="ring-1 ring-white/10" />
                      <div className="flex-1 min-w-0 text-sm font-semibold text-bone truncate" title={p.name}>{p.name}</div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {btn('going', 'Present', 'bg-emerald-600')}
                        {btn('maybe', 'Maybe', 'bg-amber-500')}
                        {btn('no', 'Absent', 'bg-rose-600')}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })()}

      {myLinkedPlayers.length > 0 && (
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 mb-2 flex items-center gap-1.5">
            <Icon name="users" className="w-3 h-3 text-brand-primary" />
            RSVP for your {myLinkedPlayers.length > 1 ? 'players' : 'player'}
          </div>
          <div className="space-y-2">
            {myLinkedPlayers.map(p => {
              const current = ((event as any).playerRsvps || {})[p.id]?.status as RsvpStatus | undefined;
              const btn = (status: RsvpStatus, label: string, active: string) => (
                <button
                  key={status}
                  onClick={() => setPlayerRsvp(p.id, p.name, status)}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                    current === status
                      ? `${active} text-white border-transparent shadow-sm`
                      : 'bg-charcoal-800 text-charcoal-200 border-white/10 hover:border-white/20'
                  }`}
                >
                  {label}
                </button>
              );
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-bone truncate" title={p.name}>{p.name}</div>
                  <div className="flex-1 flex gap-1.5">
                    {btn('going', 'Going', 'bg-emerald-600')}
                    {btn('maybe', 'Maybe', 'bg-amber-500')}
                    {btn('no', "Can't", 'bg-rose-600')}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* COACH ATTENDANCE — separate from kid RSVP, only visible to
          coaches with linked kids on this team. The kid RSVP above
          tracks Hunter going; this row tracks Patrick-the-coach
          going. Two RSVPs, two records, distinct STAFF row in the
          headcount. Patrick 2026-06-21: 'i want to clean up the
          header' (moved off the dashboard hero into here). */}
      {isUserCoach && myLinkedPlayers.length > 0 && (
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 mb-2 flex items-center gap-1.5">
            <Icon name="check" className="w-3 h-3 text-brand-primary" />
            Coach attendance
          </div>
          <p className="text-[12px] text-bone/60 leading-snug mb-3">
            Separate from your kid&apos;s RSVP above — mark whether you&apos;ll be there as coach.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(['going', 'maybe', 'no'] as RsvpStatus[]).map((s) => {
              const active = coachStatus === s;
              const label = s === 'going' ? 'Going' : s === 'maybe' ? 'Maybe' : "Can't go";
              const toneActive = s === 'going'
                ? 'bg-emerald-500 text-charcoal-950 ring-emerald-400'
                : s === 'maybe'
                  ? 'bg-amber-500 text-amber-950 ring-amber-400'
                  : 'bg-rose-500 text-white ring-rose-400';
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setCoachRsvp(active ? null : s)}
                  className={`text-[12px] font-extrabold tracking-wider uppercase px-3 py-2.5 rounded-lg ring-1 transition-colors ${
                    active
                      ? toneActive
                      : 'bg-charcoal-800 ring-white/10 text-bone/75 hover:bg-charcoal-700'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* QUICK ACTIONS — coach-only Cancel/Restore. Share button
          removed 2026-06-24 when the public RSVP page was killed
          (everyone's expected to be on the app now). */}
      {isUserCoach && (
      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4 grid grid-cols-1 gap-2">
        {event.isCancelled ? (
          <button
            onClick={handleRestore}
            className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/40 text-emerald-300 text-xs font-bold tracking-wider uppercase hover:bg-emerald-500/25 transition"
          >
            <Icon name="check" className="w-4 h-4" />
            Restore
          </button>
        ) : (
          <button
            onClick={handleCancel}
            className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-amber-500/15 ring-1 ring-amber-400/40 text-amber-300 text-xs font-bold tracking-wider uppercase hover:bg-amber-500/25 transition"
          >
            <Icon name="trash" className="w-4 h-4" />
            Cancel
          </button>
        )}
      </div>
      )}

      {/* JERSEY BANNER — game days only. The jersey swatch IS the
          icon: a black or white square shows parents at a glance which
          kit to pack. No decorative emoji needed. */}
      {event.type === 'game' && (event as any).homeAway && (
        <section className={`px-4 sm:px-6 py-3 ${
          (event as any).homeAway === 'home'
            ? 'bg-charcoal-900 ring-1 ring-charcoal-700 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 shadow-sm'
            : 'bg-charcoal-900 ring-1 ring-white/10/80 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 shadow-sm'
        }`}>
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* Jersey swatch doubles as the icon. */}
              <span className={`inline-block w-9 h-9 rounded-md border-2 flex-shrink-0 ${
                (event as any).homeAway === 'home'
                  ? 'bg-charcoal-900 border-slate-600'
                  : 'bg-charcoal-900 border-white/15'
              }`} aria-hidden />
              <div>
                <div className={`text-xs font-extrabold tracking-widest uppercase ${
                  (event as any).homeAway === 'home' ? 'text-brand-primary-soft' : 'text-charcoal-200'
                }`}>
                  {(event as any).homeAway === 'home' ? 'Home game' : 'Away game'}
                </div>
                <div className={`text-[11px] mt-0.5 ${
                  (event as any).homeAway === 'home' ? 'text-bone/50' : 'text-bone/50'
                }`}>
                  Wear your <span className="font-bold">{(event as any).homeAway === 'home' ? 'black' : 'white'}</span> jersey
                </div>
              </div>
            </div>
            <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border ${
              (event as any).homeAway === 'home'
                ? 'bg-brand-primary/15 text-bone border-brand-primary/30'
                : 'bg-charcoal-950 text-charcoal-400 border-white/10'
            }`}>
              {(event as any).homeAway === 'home' ? 'Home' : 'Away'}
            </span>
          </div>
        </section>
      )}

      {/* RSVPS */}
      <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 flex items-center gap-1.5">
            <Icon name="users" className="w-3 h-3 text-brand-primary" />
            RSVPs
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="relative overflow-hidden rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-emerald-500" />
            <div className="text-2xl font-black text-emerald-300 leading-none">{buckets.going.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-charcoal-400 mt-1">GOING</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-amber-500/15 ring-1 ring-amber-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-amber-500" />
            <div className="text-2xl font-black text-amber-300 leading-none">{buckets.maybe.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-charcoal-400 mt-1">MAYBE</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-rose-500/15 ring-1 ring-rose-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-rose-500" />
            <div className="text-2xl font-black text-rose-300 leading-none">{buckets.cant.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-charcoal-400 mt-1">CAN'T</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-charcoal-800 ring-1 ring-white/10 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-white/40" />
            <div className="text-2xl font-black text-charcoal-200 leading-none">{buckets.pending}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-charcoal-400 mt-1">PENDING</div>
          </div>
        </div>
        {isUserCoach && buckets.pending > 0 && !event.isCancelled && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleRemindPending}
              disabled={remindBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary text-white text-[11px] font-bold tracking-wider uppercase hover:bg-brand-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Icon name="bell" className="w-3.5 h-3.5" />
              {remindBusy ? 'Sending…' : `Remind ${buckets.pending} pending`}
            </button>
            {remindToast && (
              <span className="text-[11px] font-semibold text-charcoal-400">{remindToast}</span>
            )}
          </div>
        )}
        {buckets.going.length > 0 && (
          <ul className="mt-3 divide-y divide-white/10">
            {buckets.going.map((p: any, i) => {
              const photo = photoForEntry(p);
              return (
              <li key={`go-${i}`} className="py-1.5">
                <div className="flex items-center gap-2.5">
                  <RosterAvatar name={p.name} photoUrl={photo} size={28} className="ring-1 ring-white/10" />
                  <span className="text-sm font-semibold text-bone flex-1 truncate">{p.name}</span>
                  {p.kind === 'guest' && isUserCoach && roster.length > 0 && (
                    <button
                      onClick={() => setMergingToken(mergingToken === p.guestToken ? null : p.guestToken)}
                      className={`text-[9px] font-extrabold tracking-widest px-2 py-0.5 rounded border ${
                        p.matchedPlayerId
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-300 hover:bg-emerald-500/20'
                          : 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/30 hover:bg-brand-primary/20'
                      }`}
                    >
                      {p.matchedPlayerId ? 'ACCEPT MATCH' : 'MERGE'}
                    </button>
                  )}
                  {(() => {
                    const badge = p.kind === 'roster'
                      ? { label: 'ROSTER', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40' }
                      : p.kind === 'staff'
                        ? { label: 'STAFF',  cls: 'bg-brand-primary/15 text-brand-primary-soft ring-brand-primary-soft/40' }
                        : { label: 'GUEST',  cls: 'bg-charcoal-800 text-charcoal-300 ring-white/10' };
                    return (
                      <span className={`text-[9px] font-extrabold tracking-widest px-1.5 py-0.5 rounded ring-1 ${badge.cls}`}>
                        {badge.label}
                      </span>
                    );
                  })()}
                </div>
                {p.kind === 'guest' && mergingToken === p.guestToken && (
                  <div className="mt-2 ml-9 rounded-lg border border-brand-primary-soft/30 bg-brand-primary/15/60 p-2">
                    <div className="text-[11px] text-charcoal-200 mb-1.5">
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
                            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between hover:bg-brand-primary/20 disabled:opacity-50 ${
                              matches ? 'font-bold text-brand-primary-dim' : 'text-charcoal-200'
                            }`}
                          >
                            <span>{rp.name}</span>
                            {matches && <span className="text-[9px] font-extrabold tracking-widest text-brand-primary">SUGGESTED</span>}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => setMergingToken(null)}
                      className="mt-1 w-full text-center text-[11px] font-bold text-bone/50 py-1 hover:text-charcoal-200"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* WEATHER */}
      {weather && (
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 flex items-center gap-1.5">
              <Icon name="cloud" className="w-3 h-3 text-brand-primary" />
              Weather
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>{weather.icon}</span>
            <div>
              <div className="text-xl font-black text-bone leading-none">
                {weather.tempMaxF}° <span className="text-bone/50 font-semibold text-sm">/ {weather.tempMinF}°</span>
              </div>
              <div className="text-[11px] text-bone/50 mt-1 tracking-wide uppercase">
                {weather.label}
                {weather.precipChance >= 20 && ` · ${weather.precipChance}% rain`}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* COMMENTS — inline per-event discussion thread (separate from
          team chat). Writes to the eventComments collection — anyone
          on this event can read + post here without flooding the
          team chat firehose. */}
      <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
        <EventDiscussion
          eventId={event.id}
          teamId={event.teamId}
          userUid={userData?.uid}
          userName={userData?.name}
          userPhotoURL={(userData as any)?.photoURL}
          eventTitle={event.title}
        />
      </section>

      {/* SNACKS — coach assigns one family per event, family sees they're
          up. Only renders when there's an assignment OR the viewer is a
          coach who can create one. Push goes to assignee's parents. */}
      {/* Form signups — coach-only block listing every parent who
          submitted a questionnaire form pointing at this event. Each
          row expands to show the answers. Only renders when at least
          one signup exists (no zero-state visual clutter). */}
      {isUserCoach && signups.length > 0 && (
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 px-4 sm:px-5 py-4 mb-4 mx-3 sm:mx-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55">Form signups</div>
              <h2 className="text-base font-black text-bone leading-tight">
                {signups.length} {signups.length === 1 ? 'submission' : 'submissions'}
              </h2>
            </div>
          </div>
          <ul className="divide-y divide-white/5">
            {signups.map(s => (
              <li key={s.id} className="py-2.5">
                <details>
                  <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-bone truncate">
                        {s.submittedByName || 'Parent'} · {s.formName}
                      </div>
                      <div className="text-[11px] text-bone/50">
                        {s.submittedAt ? s.submittedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-bone/50 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                  </summary>
                  <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                    {Object.keys(s.answers).map(qid => (
                      <div key={qid} className="min-w-0">
                        <dt className="text-bone/50 truncate">{s.answerLabels[qid] || qid}</dt>
                        <dd className="text-bone font-semibold truncate">{String(s.answers[qid] ?? '—')}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(isUserCoach || (event as any).snackAssignment) && (
        <SnackAssignment
          eventId={event.id}
          teamId={event.teamId}
          isCoach={isUserCoach}
          assignment={(event as any).snackAssignment || null}
          roster={roster}
          onChange={async (next) => {
            if (!event || !userData?.uid) return;
            const patch = next
              ? {
                  snackAssignment: {
                    playerId: next.playerId,
                    playerName: next.playerName,
                    notes: next.notes || null,
                    assignedAt: new Date(),
                    assignedBy: userData.uid,
                    assignedByName: userData.name || null,
                  },
                }
              : { snackAssignment: null };
            setEvent({ ...event, ...patch } as any);
            try {
              await updateDocument('events', event.id, patch);
              // Notify the player's parents that they're up. Only on
              // initial assignment / reassignment to a different family.
              if (next && next.playerId !== (event as any).snackAssignment?.playerId) {
                try {
                  const { sendPushToPlayerParents } = await import('../utils/notify');
                  const eventDateTxt = new Date(event.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                  await sendPushToPlayerParents(next.playerId, {
                    title: `Snacks: ${next.playerName.split(' ')[0]}'s family is up`,
                    body: `${event.title} — ${eventDateTxt}${next.notes ? ` · ${next.notes}` : ''}`,
                    url: `/events/${event.id}`,
                  }, { pushPrefKey: 'events' });
                } catch (err) {
                  console.warn('snack push failed', err);
                }
              }
            } catch (err) {
              console.error('snack save failed', err);
              alert('Failed to save snack assignment.');
            }
          }}
        />
      )}

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
        onToggleClaim={async (postId) => {
          if (!event || !userData?.uid) return;
          const current = ((event as any).carpoolPosts || []) as CarpoolPost[];
          const next = current.map(p => {
            if (p.id !== postId) return p;
            const claimedByMe = p.claimedByUid === userData.uid;
            if (claimedByMe) {
              const { claimedByUid: _u, claimedByName: _n, claimedAt: _a, ...rest } = p as any;
              return rest as CarpoolPost;
            }
            return {
              ...p,
              claimedByUid: userData.uid,
              claimedByName: userData.name || 'Member',
              claimedAt: new Date(),
            };
          });
          setEvent({ ...event, carpoolPosts: next } as any);
          try { await updateDocument('events', event.id, { carpoolPosts: next }); }
          catch (err) { console.error('carpool claim failed', err); }
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
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 mb-1.5">
            About
          </div>
          <p className="text-sm text-charcoal-200 whitespace-pre-wrap">{event.description}</p>
        </section>
      )}

      {/* MAP — only render when we have coords (free-text-only events
          would just embed an unhelpful Null Island view). The iframe is
          OSM-branded but free + zero deps. Tap-targets cover "Open in
          Maps" so users always have an escape hatch to their preferred
          maps app. */}
      {(event as any).locationCoords?.lat && (
        <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400">Map</div>
            <a
              href={mapsUrl({
                name: event.location,
                address: (event as any).locationAddress,
                lat: (event as any).locationCoords.lat,
                lon: (event as any).locationCoords.lon,
              })}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-brand-primary-dim"
            >
              Open in Maps →
            </a>
          </div>
          <div className="rounded-xl overflow-hidden border border-white/10">
            <iframe
              title="Event location"
              src={osmEmbedUrl((event as any).locationCoords.lat, (event as any).locationCoords.lon, 16)}
              className="w-full h-44 block bg-charcoal-950"
              loading="lazy"
            />
          </div>
          {(event as any).locationAddress && (
            <p className="mt-1.5 text-[11px] text-bone/50">{(event as any).locationAddress}</p>
          )}
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
    <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          What to bring
        </div>
        {isCoach && !editing && (
          <button onClick={() => setEditing(true)} className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary">
            {list.length === 0 ? '+ Add' : 'Edit'}
          </button>
        )}
        {editing && (
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="text-[11px] font-bold tracking-wide text-bone/50">Cancel</button>
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
                className="flex-1 px-3 py-1.5 border border-white/10 rounded-md text-sm"
                placeholder="e.g. Cleats"
              />
              <button
                onClick={() => setDraftLabels(draftLabels.filter((_, j) => j !== i))}
                className="text-rose-300 text-xs font-bold"
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
              className="flex-1 px-3 py-1.5 border border-white/10 rounded-md text-sm"
              placeholder="Add an item — press Enter"
            />
            <button
              onClick={() => {
                if (newLabel.trim()) {
                  setDraftLabels([...draftLabels, newLabel.trim()]);
                  setNewLabel('');
                }
              }}
              className="px-3 py-1.5 bg-brand-primary text-white text-xs font-bold rounded-md"
            >Add</button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-bone/50">No packing list set yet.</p>
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
                    isChecked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-white/15'
                  }`}>
                    {isChecked && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </span>
                  <span className={`text-sm ${isChecked ? 'line-through text-bone/50' : 'text-charcoal-200'}`}>
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
