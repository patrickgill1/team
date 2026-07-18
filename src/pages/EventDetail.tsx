// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { CalendarEvent } from '../types';
import { isCoachOfTeam } from '../utils/helpers';
import { getWeatherForEvent, WeatherSummary } from '../utils/weather';
import EventForm from '../components/calendar/EventForm';
import CarpoolBoard, { CarpoolPost } from '../components/calendar/CarpoolBoard';
import EventDiscussion from '../components/calendar/EventDiscussion';
import SnackAssignment from '../components/calendar/SnackAssignment';
import { mapsUrl, osmEmbedUrl } from '../utils/maps';
import RosterAvatar from '../components/common/RosterAvatar';
import { useTeamAudience } from '../hooks/useTeamAudience';
import SplitTeamsModal from '../components/calendar/SplitTeamsModal';
import { grossUpCents, coachNetCents, DROPIN_DEFAULT_PLATFORM_BPS } from '../utils/pricing';

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
    'from-brand-primary-soft to-surface-tint',
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
  const { selectedTeamId, teams } = useTeam() as any;
  const [splitOpen, setSplitOpen] = useState(false);
  const { getDocument, updateDocument, deleteDocument } = useFirestore();

  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);
  // Audience resolves against the EVENT's team when available, not
  // the app's selectedTeamId. A coach on multiple teams (youth Fire
  // FC + adult Saturday Pickup) might open an adult-team event
  // while their app still has the youth team selected; without this,
  // the "Split teams" button + other adult-only UI stays hidden.
  const audienceTeamId = event?.teamId || selectedTeamId;
  const audienceTeamObj = Array.isArray(teams) ? teams.find((t: any) => t.id === audienceTeamId) : null;
  const { isAdult: isAdultTeam } = useTeamAudience(audienceTeamObj);
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
  const [myLinkedPlayers, setMyLinkedPlayers] = useState<Array<{ id: string; name: string; photoURL?: string }>>([]);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, { feel?: string; energy?: string; confidence?: number; note?: string }>>({});
  const [feedbackSaving, setFeedbackSaving] = useState<Record<string, boolean>>({});
  // Which guest RSVP token, if any, the coach is currently merging.
  const [mergingToken, setMergingToken] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  // Edit dialog state (coaches only).
  const [isEditOpen, setIsEditOpen] = useState(false);
  // Coach-triggered RSVP nudge. Tracks in-flight so we don't double-fire.
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindToast, setRemindToast] = useState<string | null>(null);
  const [attendanceOpen, setAttendanceOpen] = useState(false);

  const isUserCoach = isCoachOfTeam(userData, audienceTeamObj);

  // Platform-fee override for the event's club, if any. Falls back
  // to the default (500 bps) so the client-side gross-up preview
  // matches whatever the worker will actually charge at Checkout.
  // Absent clubId (standalone coach who hasn't finished payments
  // setup yet) → default. See src/utils/pricing.ts.
  const [platformFeeBps, setPlatformFeeBps] = useState<number>(DROPIN_DEFAULT_PLATFORM_BPS);
  useEffect(() => {
    const clubId = (audienceTeamObj as any)?.clubId;
    if (!clubId) { setPlatformFeeBps(DROPIN_DEFAULT_PLATFORM_BPS); return; }
    let cancelled = false;
    (async () => {
      try {
        const { doc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (cancelled) return;
        const bps = (snap.exists() && typeof snap.data()?.platformFeeBps === 'number')
          ? Number(snap.data()!.platformFeeBps)
          : DROPIN_DEFAULT_PLATFORM_BPS;
        setPlatformFeeBps(bps);
      } catch {
        if (!cancelled) setPlatformFeeBps(DROPIN_DEFAULT_PLATFORM_BPS);
      }
    })();
    return () => { cancelled = true; };
  }, [(audienceTeamObj as any)?.clubId]);

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
          .map((p: any) => ({ id: p.id, name: p.name, photoURL: p.profilePhotoUrl || undefined }))
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
  // Prefer stamped locationCoords (from the address autocomplete) —
  // getWeatherForEvent uses them directly with no geocode round-trip.
  // Falls back to geocoding the location string. Prior shape only
  // gated on location and passed no coords, so events with just
  // "Home field" as a location string got no weather anywhere except
  // Dashboard (which does pass coords).
  useEffect(() => {
    if (!event) return;
    const coords = (event as any).locationCoords;
    const hasCoords = coords && typeof coords.lat === 'number' && typeof coords.lon === 'number';
    if (!event.location && !hasCoords) return;
    let cancelled = false;
    (async () => {
      try {
        const w = await getWeatherForEvent(event.location || '', new Date(event.date), coords);
        if (!cancelled) setWeather(w);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [event?.id, event?.location, event?.date, (event as any)?.locationCoords]);

  const eventDate = event ? new Date(event.date) : null;
  const eventEnd = event?.endDate ? new Date(event.endDate) : undefined;
  const eventEnded = !!eventDate && (eventEnd?.getTime() || eventDate.getTime() + 90 * 60_000) < now.getTime();
  const eventFocus = ((event as any)?.developmentFocus || '').trim();

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
    const hasCap = typeof (event as any).rsvpCap === 'number' && (event as any).rsvpCap > 0;

    // Capped events: route through worker /events/rsvp for atomic
    // cap enforcement + waitlist auto-promotion. Uncapped events
    // keep the fast dotted-path client write (no read needed, no
    // race for the common youth case).
    if (hasCap) {
      try {
        const { workerFetch } = await import('../utils/workerFetch');
        const res = await workerFetch('/events/rsvp', {
          method: 'POST',
          body: JSON.stringify({
            eventId: event.id,
            status,
            name: userData.name || userData.email || 'Unknown',
            role: (userData as any).role,
          }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          alert(data?.message || "Couldn't save your RSVP. Try again.");
          return;
        }
        // Re-fetch the event so we render the fresh rsvps + waitlist
        // (the worker may have promoted someone from the waitlist
        // when we released a going slot).
        try {
          const { doc: fsDoc, getDoc: fsGet } = await import('firebase/firestore');
          const { db } = await import('../utils/firebase');
          const snap = await fsGet(fsDoc(db, 'events', event.id));
          if (snap.exists()) {
            const raw: any = snap.data();
            setEvent({ ...event, ...raw, id: event.id } as CalendarEvent);
          }
        } catch { /* fall through — client will re-fetch on next load */ }
        if (data.waitlisted) {
          alert(`You're on the waitlist — position ${data.waitlistPosition}. If someone drops out you'll be moved up automatically.`);
        } else if (data.promoted) {
          // Optional celebration for the coach — someone got promoted.
          console.log('[rsvp] promoted from waitlist', data.promoted);
        }
      } catch (err) {
        console.error('rsvp failed', err);
        alert("Couldn't save your RSVP. Check your connection and try again.");
      }
      return;
    }

    // Uncapped path — fast dotted-path write, no race (Firestore
    // merges into the map field). Optimistic UI with rollback.
    const prevRsvps = event.rsvps;
    const prevEvent = event;
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
      // Dotted-path so simultaneous RSVPs across the roster don't
      // clobber each other (audit 2026-07-11 race fix).
      const { doc: fsDoc, updateDoc: fsUpdate } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      await fsUpdate(fsDoc(db, 'events', event.id), {
        [`rsvps.${userData.uid}`]: next[userData.uid],
      });
    } catch (err) {
      console.error('rsvp failed', err);
      setEvent({ ...prevEvent, rsvps: prevRsvps } as CalendarEvent);
      alert("Couldn't save your RSVP. Check your connection and try again.");
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
    const prevRsvps = event.rsvps;
    const prevEvent = event;
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
      setEvent({ ...prevEvent, rsvps: prevRsvps } as CalendarEvent);
      alert("Couldn't save your RSVP. Check your connection and try again.");
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

  const setFeedbackDraft = (playerId: string, patch: any) => {
    setFeedbackDrafts(prev => ({ ...prev, [playerId]: { ...(prev[playerId] || {}), ...patch } }));
  };

  const submitPlayerFeedback = async (player: { id: string; name: string; photoURL?: string }) => {
    if (!event || !userData?.uid) return;
    const draft = feedbackDrafts[player.id] || {};
    const feel = draft.feel || 'good';
    const feedbackMap = { ...((event as any).playerFeedback || {}) };
    const playerMap = { ...(feedbackMap[player.id] || {}) };
    const existing = playerMap[userData.uid] || {};
    const feedbackEntry = {
      ...existing,
      playerId: player.id,
      playerName: player.name,
      playerPhotoURL: player.photoURL || null,
      submittedByUid: userData.uid,
      submittedByName: userData.name || userData.email || 'Parent',
      feel,
      energy: draft.energy || 'okay',
      confidence: Number(draft.confidence || 3),
      note: (draft.note || '').trim() || null,
      focus: eventFocus || null,
      createdAt: existing.createdAt || new Date(),
      updatedAt: new Date(),
    };
    playerMap[userData.uid] = feedbackEntry;
    feedbackMap[player.id] = playerMap;
    setFeedbackSaving(prev => ({ ...prev, [player.id]: true }));
    setEvent({ ...event, playerFeedback: feedbackMap } as any);
    try {
      await updateDocument('events', event.id, { [`playerFeedback.${player.id}.${userData.uid}`]: feedbackEntry });
      setFeedbackDrafts(prev => ({ ...prev, [player.id]: {} }));
    } catch (err) {
      console.error('player feedback save failed', err);
      alert('Could not send feedback. Please try again.');
    } finally {
      setFeedbackSaving(prev => ({ ...prev, [player.id]: false }));
    }
  };

  const feedbackRows = useMemo(() => {
    const map = ((event as any)?.playerFeedback || {}) as Record<string, Record<string, any>>;
    const rows: any[] = [];
    Object.keys(map).forEach(playerId => {
      Object.keys(map[playerId] || {}).forEach(uid => {
        rows.push({ playerId, uid, ...map[playerId][uid] });
      });
    });
    return rows.sort((a, b) => {
      const at = a.updatedAt?.toDate?.() || a.updatedAt || a.createdAt?.toDate?.() || a.createdAt || 0;
      const bt = b.updatedAt?.toDate?.() || b.updatedAt || b.createdAt?.toDate?.() || b.createdAt || 0;
      return new Date(bt).getTime() - new Date(at).getTime();
    });
  }, [event]);

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
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
      </div>
    );
  }

  if (!event || !eventDate) {
    return (
      <div className="min-h-screen bg-surface-base flex flex-col items-center justify-center p-8 text-center">
        <p className="text-ink-primary/65 mb-4">Event not found.</p>
        <Link to="/calendar" className="text-brand-primary font-semibold">← Back to events</Link>
      </div>
    );
  }

  const typeColors: Record<string, { stripe: string; chip: string }> = {
    game: { stripe: 'from-rose-500 to-orange-500', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
    practice: { stripe: 'from-brand-primary to-surface-tint', chip: 'bg-brand-primary/10 text-brand-primary-soft border-brand-primary/30' },
    event: { stripe: 'from-purple-500 to-pink-500', chip: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
  };
  const colors = typeColors[event.type] || typeColors.event;

  const countdownClass =
    countdown?.variant === 'live'
      ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
      : countdown?.variant === 'past'
      ? 'bg-line-default/10 border-slate-500/20 text-ink-primary/50'
      : 'bg-brand-primary/10 border-brand-primary/25 text-ink-primary/85';
  const pulseClass =
    countdown?.variant === 'live' ? 'bg-rose-500'
    : countdown?.variant === 'past' ? 'bg-line-default/40'
    : 'bg-brand-primary-soft animate-pulse';

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base">
      {/* HERO — cinematic full-bleed treatment per v9 mockup. Ball-in-
          net photo lives on the right edge with a left-to-right
          gradient that fades it to near-black behind the copy, so the
          eyebrow / title / meta stay legible without a heavy overlay
          flattening the image. Same hero on every event by design
          ('feel free to push back' → 'yeah, i agree. same photo for
          every event'). */}
      <section className="relative overflow-hidden bg-surface-base border-b border-brand-primary/10">
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
          className="absolute inset-0 bg-gradient-to-r from-surface-base via-surface-base/85 to-surface-base/30"
        />
        {/* Bottom fade into the page so the hero doesn't sit on a
            hard horizon line. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-surface-elevated pointer-events-none"
        />

        <div className="relative px-4 sm:px-6 pt-4 pb-6">
          {/* Top chrome row: back · countdown pill · edit. Pill is
              dead-center so it reads as the event's status badge. */}
          <div className="flex items-center justify-between mb-5">
            <button
              onClick={() => navigate(-1)}
              className="w-9 h-9 rounded-full bg-line-default/10 backdrop-blur ring-1 ring-line-default/15 text-ink-primary/75 flex items-center justify-center hover:bg-line-default/15 hover:text-ink-primary"
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
                className="w-9 h-9 rounded-full bg-line-default/10 backdrop-blur ring-1 ring-line-default/15 text-ink-primary/75 flex items-center justify-center hover:bg-line-default/15 hover:text-ink-primary"
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
            <h1 className="mt-1 text-3xl sm:text-4xl font-black text-ink-primary leading-[1.05] tracking-tight">
              {event.title}
            </h1>
            <p className="mt-3 text-[13.5px] text-ink-primary/70 flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="cal" className="w-3.5 h-3.5 text-brand-primary-soft" />
                {eventDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="text-ink-primary/50">·</span>
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
        <div className="bg-rose-500/15 border-y border-rose-400/30 px-4 sm:px-6 py-3">
          <div className="flex items-start gap-3 max-w-3xl mx-auto">
            <div className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-rose-600 text-rose-50 flex-shrink-0">
              Cancelled
            </div>
            <div className="text-sm text-rose-100 flex-1 min-w-0">
              {event.cancelReason ? (
                <p className="leading-snug">{event.cancelReason}</p>
              ) : (
                <p className="leading-snug italic text-rose-100/60">No reason given.</p>
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
          <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 overflow-hidden">
            <button
              type="button"
              onClick={() => setAttendanceOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-line-default/[0.05] text-left"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon name="check" className="w-3 h-3 text-brand-primary shrink-0" />
                <span className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70">Mark attendance</span>
                <span className="text-[10px] text-ink-primary/50 font-bold ml-1 truncate">
                  · {goingCount} going · {roster.length} on roster
                </span>
              </div>
              <svg className={`w-4 h-4 text-ink-primary/50 shrink-0 transition-transform ${attendanceOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {attendanceOpen && (
              <ul className="divide-y divide-line-default/10 px-4 sm:px-6 pb-3">
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
                          : 'bg-surface-elevated text-ink-primary/70 border-line-default/10 hover:border-line-default/15'
                      }`}
                    >
                      {label}
                    </button>
                  );
                  return (
                    <li key={p.id} className="flex items-center gap-2 py-1.5">
                      <RosterAvatar name={p.name} photoUrl={p.photoURL} size={28} className="ring-1 ring-line-default/10" />
                      <div className="flex-1 min-w-0 text-sm font-semibold text-ink-primary truncate" title={p.name}>{p.name}</div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {btn('going', 'Present', 'bg-emerald-600')}
                        {btn('maybe', 'Maybe', 'bg-sky-500')}
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
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/10 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 mb-2 flex items-center gap-1.5">
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
                      : 'bg-surface-input text-ink-primary/75 border-line-default/10 hover:border-line-default/20'
                  }`}
                >
                  {label}
                </button>
              );
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-ink-primary truncate" title={p.name}>{p.name}</div>
                  <div className="flex-1 flex gap-1.5">
                    {btn('going', 'Going', 'bg-emerald-600')}
                    {btn('maybe', 'Maybe', 'bg-sky-500')}
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
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 mb-2 flex items-center gap-1.5">
            <Icon name="check" className="w-3 h-3 text-brand-primary" />
            Coach attendance
          </div>
          <p className="text-[12px] text-ink-primary/60 leading-snug mb-3">
            {isAdultTeam
              ? "Mark whether you'll be there as coach — separate from your own player RSVP above."
              : "Separate from your kid's RSVP above — mark whether you'll be there as coach."}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(['going', 'maybe', 'no'] as RsvpStatus[]).map((s) => {
              const active = coachStatus === s;
              const label = s === 'going' ? 'Going' : s === 'maybe' ? 'Maybe' : "Can't go";
              const toneActive = s === 'going'
                ? 'bg-emerald-500 text-charcoal-950 ring-emerald-400'
                : s === 'maybe'
                  ? 'bg-sky-500 text-sky-950 ring-sky-400'
                  : 'bg-rose-500 text-white ring-rose-400';
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setCoachRsvp(active ? null : s)}
                  className={`text-[12px] font-extrabold tracking-wider uppercase px-3 py-2.5 rounded-lg ring-1 transition-colors ${
                    active
                      ? toneActive
                      : 'bg-surface-input ring-line-default/10 text-ink-primary/75 hover:bg-surface-raised'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* QUICK ACTIONS — coach-only Cancel/Restore + Split Teams
          (adult only). Share button removed 2026-06-24 when the
          public RSVP page was killed (everyone's expected to be on
          the app now). */}
      {/* Drop-in fee — visible to anyone going who hasn't paid yet.
          Opens Stripe Checkout on the club's connected account. Paid
          status is the union of paidUids (Stripe) and paidByCoach
          (coach marked cash). Player-facing copy shows ONE number
          (the gross-up total when they'd cover fees). */}
      {(() => {
        const feeCents = Number((event as any).feeCents || 0);
        if (feeCents <= 0) return null;
        if (myRsvp?.status !== 'going') return null;
        const paidUids: string[] = Array.isArray((event as any).paidUids) ? (event as any).paidUids : [];
        const paidByCoach: string[] = Array.isArray((event as any).paidByCoach) ? (event as any).paidByCoach : [];
        // iPaid only checks uid-space (Stripe-paid ∪ coach-marked adult).
        // Kid marks live in paidByCoachPlayerIds and never turn a
        // parent's own "You paid" pill on — a parent with two kids
        // where only one is settled shouldn't lose the pay button.
        const iPaid = !!userData?.uid && (paidUids.includes(userData.uid) || paidByCoach.includes(userData.uid));
        const feeCoveredBy: 'player' | 'coach' = (event as any).feeCoveredBy === 'coach' ? 'coach' : 'player';
        // Player-facing preview of the actual charge. When 'player'
        // covers fees the client uses the same gross-up formula the
        // worker uses so the number matches what Stripe will present.
        // Passes the club's real platformFeeBps so any non-default
        // rate doesn't drift between preview and Checkout.
        const playerCharge = feeCoveredBy === 'player' ? grossUpCents(feeCents, platformFeeBps) : feeCents;
        if (iPaid) return (
          <section className="bg-emerald-500/10 ring-1 ring-emerald-500/30 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 px-4 py-3 flex items-center gap-2 text-emerald-200">
            <Icon name="check" className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-black uppercase tracking-widest">You paid</span>
            <span className="text-[11px] text-emerald-200/70 ml-auto">${(playerCharge / 100).toFixed(2)}</span>
          </section>
        );
        return (
          <section className="bg-amber-500/10 ring-1 ring-amber-500/30 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 px-4 py-3">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-widest text-amber-300">Drop-in fee</p>
                <p className="text-[11px] text-amber-200/75 truncate">Pay to lock in your spot for this event.</p>
              </div>
              <span className="shrink-0 text-lg font-black text-amber-100">${(playerCharge / 100).toFixed(2)}</span>
            </div>
            <button
              onClick={async () => {
                try {
                  const { workerFetch } = await import('../utils/workerFetch');
                  const res = await workerFetch('/stripe/event-dropin-checkout', {
                    method: 'POST',
                    body: JSON.stringify({
                      eventId: event.id,
                      uid: userData?.uid,
                      customerEmail: userData?.email,
                    }),
                  });
                  const data: any = await res.json().catch(() => ({}));
                  if (!res.ok || !data?.ok) {
                    alert(data?.hint || data?.error || "Couldn't start checkout. Try again.");
                    return;
                  }
                  window.location.href = data.url;
                } catch (err) {
                  console.error('event dropin checkout failed', err);
                  alert("Couldn't start checkout. Check your connection and try again.");
                }
              }}
              className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-sm font-black uppercase tracking-widest transition"
            >
              Pay ${(playerCharge / 100).toFixed(2)}
            </button>
          </section>
        );
      })()}

      {/* Coach fee summary — discreet card showing net-per-player
          and a running total from paid attendees. Coach-only. */}
      {isUserCoach && Number((event as any).feeCents || 0) > 0 && (() => {
        const feeCents = Number((event as any).feeCents || 0);
        const feeCoveredBy: 'player' | 'coach' = (event as any).feeCoveredBy === 'coach' ? 'coach' : 'player';
        const charged = feeCoveredBy === 'player' ? grossUpCents(feeCents, platformFeeBps) : feeCents;
        const netCents = feeCoveredBy === 'player' ? feeCents : coachNetCents(charged, platformFeeBps);
        const paidUids: string[] = Array.isArray((event as any).paidUids) ? (event as any).paidUids : [];
        const paidByCoach: string[] = Array.isArray((event as any).paidByCoach) ? (event as any).paidByCoach : [];
        const paidByCoachPlayerIds: string[] = Array.isArray((event as any).paidByCoachPlayerIds) ? (event as any).paidByCoachPlayerIds : [];
        // Uid-tracked adults and playerId-tracked kids live in
        // distinct namespaces; a person can't appear in both. Total
        // paid heads = adults (uid ∪ Stripe) + kids by playerId.
        const paidAdults = new Set<string>([...paidUids, ...paidByCoach]).size;
        const paidKids = new Set<string>(paidByCoachPlayerIds).size;
        const paidCount = paidAdults + paidKids;
        const totalNet = paidCount * netCents;
        return (
          <section className="bg-surface-elevated ring-1 ring-line-default/15 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">You net</p>
                <p className="text-base font-black text-ink-primary">${(netCents / 100).toFixed(2)} <span className="text-[11px] font-semibold text-ink-primary/60">/ player</span></p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">Collected</p>
                <p className="text-base font-black text-ink-primary">${(totalNet / 100).toFixed(2)} <span className="text-[11px] font-semibold text-ink-primary/60">({paidCount} paid)</span></p>
              </div>
            </div>
            <p className="text-[11px] text-ink-primary/60 mt-2 leading-snug">
              {feeCoveredBy === 'player'
                ? `Player sees $${(charged / 100).toFixed(2)}. Card + platform fees are baked into their price.`
                : `Player sees $${(charged / 100).toFixed(2)}. You absorb card + platform fees.`}
            </p>
          </section>
        );
      })()}

      {/* Pickup result — coach picks the winning side after the event.
          Appears only on adult teams with a teamSplit set and once the
          event date has passed. Distinct from external opponent
          scoring — pickup results don't roll into season stats. */}
      {isUserCoach && isAdultTeam && (event as any).teamSplit && !event.isCancelled && eventDate && eventDate.getTime() < now.getTime() && (
        <PickupResultPanel
          event={event}
          userData={userData}
          onSave={async (patch) => {
            await updateDocument('events', event.id, { pickupResult: patch });
            setEvent({ ...event, pickupResult: patch } as any);
          }}
          onClear={async () => {
            await updateDocument('events', event.id, { pickupResult: null });
            setEvent({ ...event, pickupResult: undefined } as any);
          }}
        />
      )}
      {isUserCoach && (
      <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4 grid grid-cols-1 gap-2">
        {isAdultTeam && (
          <button
            onClick={() => setSplitOpen(true)}
            className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand-primary/15 ring-1 ring-brand-primary-soft/40 text-brand-primary-soft text-xs font-bold tracking-wider uppercase hover:bg-brand-primary/25 transition"
          >
            <Icon name="users" className="w-4 h-4" />
            {(event as any).teamSplit ? 'Edit team split' : 'Split teams'}
          </button>
        )}
        {event.isCancelled ? (
          <button
            onClick={handleRestore}
            className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/40 text-emerald-700 text-xs font-bold tracking-wider uppercase hover:bg-emerald-500/25 transition"
          >
            <Icon name="check" className="w-4 h-4" />
            Restore
          </button>
        ) : (
          <button
            onClick={handleCancel}
            className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-lg bg-rose-500/15 ring-1 ring-rose-400/40 text-rose-300 text-xs font-bold tracking-wider uppercase hover:bg-rose-500/25 transition"
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
            ? 'bg-surface-elevated ring-1 ring-line-default/15 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 shadow-sm'
            : 'bg-surface-elevated ring-1 ring-line-default/10/80 rounded-2xl mx-3 sm:mx-4 my-3 sm:my-4 shadow-sm'
        }`}>
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* Jersey swatch doubles as the icon. */}
              <span className={`inline-block w-9 h-9 rounded-md border-2 flex-shrink-0 ${
                (event as any).homeAway === 'home'
                  ? 'bg-surface-elevated border-slate-600'
                  : 'bg-surface-elevated border-line-default/15'
              }`} aria-hidden />
              <div>
                <div className={`text-xs font-extrabold tracking-widest uppercase ${
                  (event as any).homeAway === 'home' ? 'text-brand-primary' : 'text-ink-primary/75'
                }`}>
                  {(event as any).homeAway === 'home' ? 'Home game' : 'Away game'}
                </div>
                <div className={`text-[11px] mt-0.5 ${
                  (event as any).homeAway === 'home' ? 'text-ink-primary/50' : 'text-ink-primary/50'
                }`}>
                  Wear your <span className="font-bold">{(event as any).homeAway === 'home' ? 'black' : 'white'}</span> jersey
                </div>
              </div>
            </div>
            <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border ${
              (event as any).homeAway === 'home'
                ? 'bg-brand-primary/15 text-ink-primary border-brand-primary/30'
                : 'bg-surface-base text-ink-primary/65 border-line-default/10'
            }`}>
              {(event as any).homeAway === 'home' ? 'Home' : 'Away'}
            </span>
          </div>
        </section>
      )}

      {/* RSVPS */}
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 flex items-center gap-1.5">
            <Icon name="users" className="w-3 h-3 text-brand-primary" />
            RSVPs
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="relative overflow-hidden rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-emerald-500" />
            <div className="text-2xl font-black text-emerald-300 leading-none">
              {buckets.going.length}
              {typeof (event as any).rsvpCap === 'number' && (event as any).rsvpCap > 0 && (
                <span className="text-sm text-emerald-300/70 font-black">
                  {' / '}{(event as any).rsvpCap}
                </span>
              )}
            </div>
            <div className="text-[9px] font-extrabold tracking-widest text-ink-primary/65 mt-1">GOING</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-sky-500/15 ring-1 ring-sky-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-sky-500" />
            <div className="text-2xl font-black text-sky-300 leading-none">{buckets.maybe.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-ink-primary/65 mt-1">MAYBE</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-rose-500/15 ring-1 ring-rose-400/40 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-rose-500" />
            <div className="text-2xl font-black text-rose-300 leading-none">{buckets.cant.length}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-ink-primary/65 mt-1">CAN'T</div>
          </div>
          <div className="relative overflow-hidden rounded-lg bg-surface-input ring-1 ring-line-default/10 px-3 py-2.5">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-line-default/40" />
            <div className="text-2xl font-black text-ink-primary/75 leading-none">{buckets.pending}</div>
            <div className="text-[9px] font-extrabold tracking-widest text-ink-primary/65 mt-1">PENDING</div>
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
              <span className="text-[11px] font-semibold text-ink-primary/65">{remindToast}</span>
            )}
          </div>
        )}
        {Array.isArray((event as any).waitlist) && (event as any).waitlist.length > 0 && (
          <div className="mt-3 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/30 px-3 py-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-amber-300">
                Waitlist · {(event as any).waitlist.length}
              </span>
              <span className="text-[10px] text-amber-200/70">Auto-promotes when a slot opens</span>
            </div>
            <ol className="space-y-0.5 text-[12px] text-amber-100/85">
              {(event as any).waitlist.slice(0, 8).map((w: any, i: number) => (
                <li key={w.uid || i} className="flex items-center gap-2">
                  <span className="w-4 text-right text-amber-300/70 font-mono text-[10px]">{i + 1}.</span>
                  <span className="truncate">{w.name || 'Member'}</span>
                </li>
              ))}
              {(event as any).waitlist.length > 8 && (
                <li className="text-[10px] text-amber-200/60 pl-6">+ {(event as any).waitlist.length - 8} more</li>
              )}
            </ol>
          </div>
        )}
        {buckets.going.length > 0 && (
          <ul className="mt-3 divide-y divide-line-default/10">
            {buckets.going.map((p: any, i) => {
              const photo = photoForEntry(p);
              // Mark-paid target: prefer playerId (roster kid) so
              // siblings don't collide via a shared parent uid. Adult
              // staff entries carry p.uid directly. Guest entries
              // (no playerId, no uid) currently can't be marked —
              // they need to be merged into a roster player or
              // resolved to a uid first.
              const targetPlayerId: string | undefined = p.playerId || undefined;
              const targetUid: string | undefined = targetPlayerId ? undefined : (p.uid || undefined);
              const feeCentsForList = Number((event as any).feeCents || 0);
              const paidUidsList: string[] = Array.isArray((event as any).paidUids) ? (event as any).paidUids : [];
              const paidByCoachListInner: string[] = Array.isArray((event as any).paidByCoach) ? (event as any).paidByCoach : [];
              const paidByCoachPidsInner: string[] = Array.isArray((event as any).paidByCoachPlayerIds) ? (event as any).paidByCoachPlayerIds : [];
              const isPaidStripe = !!targetUid && paidUidsList.includes(targetUid);
              const isPaidCash = targetPlayerId
                ? paidByCoachPidsInner.includes(targetPlayerId)
                : (!!targetUid && paidByCoachListInner.includes(targetUid));
              const canToggleCash = isUserCoach && feeCentsForList > 0 && (!!targetUid || !!targetPlayerId);

              const togglePaid = async () => {
                if (!targetUid && !targetPlayerId) return;
                try {
                  const { workerFetch } = await import('../utils/workerFetch');
                  const body: Record<string, any> = {
                    eventId: event.id,
                    paid: !isPaidCash,
                  };
                  if (targetPlayerId) body.playerId = targetPlayerId;
                  else body.uid = targetUid;
                  const res = await workerFetch('/events/mark-paid', {
                    method: 'POST',
                    body: JSON.stringify(body),
                  });
                  const data: any = await res.json().catch(() => ({}));
                  if (!res.ok || !data?.ok) {
                    alert(data?.error || "Couldn't update paid status.");
                    return;
                  }
                  setEvent({
                    ...event,
                    paidByCoach: data.paidByCoach,
                    paidByCoachPlayerIds: data.paidByCoachPlayerIds,
                  } as any);
                } catch (err) {
                  console.error('mark-paid failed', err);
                }
              };

              return (
              <li key={`go-${i}`} className="py-1.5">
                <div className="flex items-center gap-2.5">
                  <RosterAvatar name={p.name} photoUrl={photo} size={28} className="ring-1 ring-line-default/10" />
                  <span className="text-sm font-semibold text-ink-primary flex-1 truncate">{p.name}</span>
                  {canToggleCash && (
                    <button
                      onClick={togglePaid}
                      title={isPaidStripe ? 'Paid via Stripe' : (isPaidCash ? 'Marked cash-paid. Tap to undo.' : 'Mark cash-paid')}
                      disabled={isPaidStripe}
                      className={`text-[9px] font-extrabold tracking-widest px-2 py-0.5 rounded ring-1 transition ${
                        isPaidStripe
                          ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-400/40 opacity-75 cursor-default'
                          : isPaidCash
                            ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-400/40 hover:bg-emerald-500/25'
                            : 'bg-surface-input text-ink-primary/65 ring-line-default/15 hover:ring-line-default/30'
                      }`}
                    >
                      {isPaidStripe ? 'PAID' : (isPaidCash ? 'CASH PAID' : 'MARK PAID')}
                    </button>
                  )}
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
                        : { label: 'GUEST',  cls: 'bg-surface-input text-ink-primary/65 ring-line-default/10' };
                    return (
                      <span className={`text-[9px] font-extrabold tracking-widest px-1.5 py-0.5 rounded ring-1 ${badge.cls}`}>
                        {badge.label}
                      </span>
                    );
                  })()}
                </div>
                {p.kind === 'guest' && mergingToken === p.guestToken && (
                  <div className="mt-2 ml-9 rounded-lg border border-brand-primary-soft/30 bg-brand-primary/[0.15] p-2">
                    <div className="text-[11px] text-ink-primary/75 mb-1.5">
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
                              matches ? 'font-bold text-brand-primary-dim' : 'text-ink-primary/75'
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
                      className="mt-1 w-full text-center text-[11px] font-bold text-ink-primary/50 py-1 hover:text-ink-primary/75"
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

      {/* EVENT PULSE — private post-event player feedback. Parents / players
          send a quick check-in to the coach; coaches see the rolled-up feed
          here. Nothing posts to Wall or Chat automatically. */}
      {eventEnded && !event.isCancelled && (myLinkedPlayers.length > 0 || (isUserCoach && feedbackRows.length > 0)) && (
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 flex items-center gap-1.5">
                <Icon name="bell" className="w-3 h-3 text-brand-primary" />
                Event Pulse
              </div>
              <p className="mt-1 text-[12px] leading-snug text-ink-primary/55">
                {eventFocus ? `How did ${eventFocus.toLowerCase()} feel today?` : 'How did the session feel today?'}
              </p>
            </div>
            {isUserCoach && feedbackRows.length > 0 && (
              <span className="shrink-0 rounded-full bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30 px-2 py-1 text-[10px] font-extrabold tracking-widest uppercase">
                {feedbackRows.length} sent
              </span>
            )}
          </div>

          {myLinkedPlayers.length > 0 && (
            <div className="space-y-3">
              {myLinkedPlayers.map(player => {
                const mine = ((event as any).playerFeedback || {})?.[player.id]?.[userData?.uid || ''];
                const draft = feedbackDrafts[player.id] || {};
                const selectedFeel = draft.feel || mine?.feel || '';
                const selectedEnergy = draft.energy || mine?.energy || '';
                const selectedConfidence = Number(draft.confidence || mine?.confidence || 3);
                const feelBtn = (value: string, label: string) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFeedbackDraft(player.id, { feel: value })}
                    className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold ring-1 transition ${
                      selectedFeel === value
                        ? 'bg-brand-primary text-white ring-brand-primary-soft/40 shadow-sm'
                        : 'bg-surface-input text-ink-primary/70 ring-line-default/10 hover:ring-line-default/20'
                    }`}
                  >
                    {label}
                  </button>
                );
                return (
                  <div key={player.id} className="rounded-xl bg-surface-input/75 ring-1 ring-line-default/15 p-3">
                    <div className="flex items-center gap-2.5 mb-3">
                      <RosterAvatar name={player.name} photoUrl={player.photoURL} size={36} className="ring-1 ring-line-default/10" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-black text-ink-primary truncate">{player.name}</div>
                        <div className="text-[11px] text-ink-primary/50">
                          {mine ? 'Feedback sent. You can update it.' : 'Send a quick private note to coach.'}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5 mb-2">
                      {feelBtn('great', 'Great')}
                      {feelBtn('good', 'Good')}
                      {feelBtn('tough', 'Tough')}
                      {feelBtn('frustrated', 'Hard')}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <select
                        value={selectedEnergy}
                        onChange={(e) => setFeedbackDraft(player.id, { energy: e.target.value })}
                        className="w-full rounded-lg bg-surface-elevated text-ink-primary ring-1 ring-line-default/15 px-2 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      >
                        <option value="">Energy</option>
                        <option value="low">Low energy</option>
                        <option value="okay">Okay energy</option>
                        <option value="high">High energy</option>
                      </select>
                      <select
                        value={selectedConfidence}
                        onChange={(e) => setFeedbackDraft(player.id, { confidence: Number(e.target.value) })}
                        className="w-full rounded-lg bg-surface-elevated text-ink-primary ring-1 ring-line-default/15 px-2 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      >
                        <option value={1}>Confidence 1/5</option>
                        <option value={2}>Confidence 2/5</option>
                        <option value={3}>Confidence 3/5</option>
                        <option value={4}>Confidence 4/5</option>
                        <option value={5}>Confidence 5/5</option>
                      </select>
                    </div>
                    <textarea
                      value={draft.note ?? mine?.note ?? ''}
                      onChange={(e) => setFeedbackDraft(player.id, { note: e.target.value })}
                      rows={2}
                      placeholder="Anything coach should know?"
                      className="w-full rounded-lg bg-surface-elevated text-ink-primary placeholder:text-ink-primary/40 ring-1 ring-line-default/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/40 resize-none"
                    />
                    <button
                      type="button"
                      disabled={feedbackSaving[player.id] || !selectedFeel}
                      onClick={() => submitPlayerFeedback(player)}
                      className="mt-2 w-full rounded-lg bg-brand-primary text-white px-3 py-2 text-[12px] font-extrabold uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {feedbackSaving[player.id] ? 'Sending...' : mine ? 'Update Coach' : 'Send to Coach'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {isUserCoach && feedbackRows.length > 0 && (
            <ul className={`${myLinkedPlayers.length > 0 ? 'mt-4 pt-4 border-t border-line-default/10' : ''} space-y-2`}>
              {feedbackRows.map(row => {
                const rosterPlayer = roster.find(p => p.id === row.playerId);
                const conf = typeof row.confidence === 'number' ? `${row.confidence}/5` : '—';
                return (
                  <li key={`${row.playerId}_${row.uid}`} className="rounded-xl bg-surface-input/75 ring-1 ring-line-default/15 p-3">
                    <div className="flex items-start gap-2.5">
                      <RosterAvatar name={row.playerName || rosterPlayer?.name || 'Player'} photoUrl={row.playerPhotoURL || rosterPlayer?.photoURL} size={36} className="ring-1 ring-line-default/10" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-black text-ink-primary truncate">{row.playerName || rosterPlayer?.name || 'Player'}</p>
                          <span className="rounded-full bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-widest">
                            {String(row.feel || 'good')}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-ink-primary/55">
                          Energy {row.energy || 'okay'} · Confidence {conf}{row.focus ? ` · Focus: ${row.focus}` : ''}
                        </p>
                        {row.note && <p className="mt-2 text-sm leading-snug text-ink-primary/80 whitespace-pre-wrap">{row.note}</p>}
                        <p className="mt-2 text-[10px] font-semibold text-ink-primary/45">From {row.submittedByName || 'parent/player'}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* WEATHER */}
      {weather && (
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 flex items-center gap-1.5">
              <Icon name="cloud" className="w-3 h-3 text-brand-primary" />
              Weather
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden>{weather.icon}</span>
            <div>
              <div className="text-xl font-black text-ink-primary leading-none">
                {weather.tempMaxF}° <span className="text-ink-primary/50 font-semibold text-sm">/ {weather.tempMinF}°</span>
              </div>
              <div className="text-[11px] text-ink-primary/50 mt-1 tracking-wide uppercase">
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
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
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
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 px-4 sm:px-5 py-4 mb-4 mx-3 sm:mx-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Form signups</div>
              <h2 className="text-base font-black text-ink-primary leading-tight">
                {signups.length} {signups.length === 1 ? 'submission' : 'submissions'}
              </h2>
            </div>
          </div>
          <ul className="divide-y divide-line-default/5">
            {signups.map(s => (
              <li key={s.id} className="py-2.5">
                <details>
                  <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-ink-primary truncate">
                        {s.submittedByName || 'Parent'} · {s.formName}
                      </div>
                      <div className="text-[11px] text-ink-primary/50">
                        {s.submittedAt ? s.submittedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-ink-primary/50 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                  </summary>
                  <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                    {Object.keys(s.answers).map(qid => (
                      <div key={qid} className="min-w-0">
                        <dt className="text-ink-primary/50 truncate">{s.answerLabels[qid] || qid}</dt>
                        <dd className="text-ink-primary font-semibold truncate">{String(s.answers[qid] ?? '—')}</dd>
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
            alert("Couldn't save the packing list. Check your connection and try again.");
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
          catch (err) {
            console.error('carpool add failed', err);
            alert("Couldn't post to the carpool board. Check your connection and try again.");
          }
        }}
        onDelete={async (postId) => {
          if (!event) return;
          const next = (((event as any).carpoolPosts || []) as CarpoolPost[]).filter(p => p.id !== postId);
          setEvent({ ...event, carpoolPosts: next } as any);
          try { await updateDocument('events', event.id, { carpoolPosts: next }); }
          catch (err) {
            console.error('carpool delete failed', err);
            alert("Couldn't remove that carpool post. Check your connection and try again.");
          }
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
          catch (err) {
            console.error('carpool claim failed', err);
            alert("Couldn't update your carpool claim. Check your connection and try again.");
          }
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
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 mb-1.5">
            About
          </div>
          <p className="text-sm leading-relaxed text-ink-primary/85 whitespace-pre-wrap">{event.description}</p>
        </section>
      )}

      {/* MAP — only render when we have coords (free-text-only events
          would just embed an unhelpful Null Island view). The iframe is
          OSM-branded but free + zero deps. Tap-targets cover "Open in
          Maps" so users always have an escape hatch to their preferred
          maps app. */}
      {(event as any).locationCoords?.lat && (
        <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70">Map</div>
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
          <div className="rounded-xl overflow-hidden border border-line-default/10">
            <iframe
              title="Event location"
              src={osmEmbedUrl((event as any).locationCoords.lat, (event as any).locationCoords.lon, 16)}
              className="w-full h-44 block bg-surface-base"
              loading="lazy"
            />
          </div>
          {(event as any).locationAddress && (
            <p className="mt-1.5 text-[11px] text-ink-primary/50">{(event as any).locationAddress}</p>
          )}
        </section>
      )}

      {/* Split Teams modal — adult-team pickup auto-balance. Opens
          from the coach action row. Saves the split to
          event.teamSplit on Save. */}
      {splitOpen && event && (
        <SplitTeamsModal
          event={event}
          onClose={() => setSplitOpen(false)}
          onSave={async (split) => {
            try {
              await updateDocument('events', event.id, { teamSplit: split });
              setEvent({ ...event, teamSplit: split } as any);
              setSplitOpen(false);
            } catch (err) {
              console.error('team split save failed', err);
              alert("Couldn't save the team split. Check your connection and try again.");
            }
          }}
        />
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
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/70 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          What to bring
        </div>
        {isCoach && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-brand-primary text-white hover:bg-brand-primary-hov dark:bg-transparent dark:text-brand-primary dark:hover:text-brand-primary-dim"
          >
            {list.length === 0 ? '+ Add' : 'Edit'}
          </button>
        )}
        {editing && (
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="text-[11px] font-bold tracking-wide text-ink-primary/50">Cancel</button>
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
                className="flex-1 px-3 py-1.5 border border-line-default/10 rounded-md text-sm"
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
              className="flex-1 px-3 py-1.5 border border-line-default/10 rounded-md text-sm"
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
        <p className="text-sm text-ink-primary/50">No packing list set yet.</p>
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
                    isChecked ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-line-default/15'
                  }`}>
                    {isChecked && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </span>
                  <span className={`text-sm ${isChecked ? 'line-through text-ink-primary/50' : 'text-ink-primary/75'}`}>
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

// ── Pickup result panel — the "who won" flow ────────────────────
// Shown to the coach on an adult team's event that has a teamSplit
// AND has ended (event.date < now). Coach picks the winning side
// (or ties), optionally names an MVP from the rostered players, and
// saves. Persists on event.pickupResult; distinct from external
// opponent scoring since pickup games don't roll to season stats.
interface PickupResultPanelProps {
  event: CalendarEvent;
  userData: any;
  onSave: (patch: any) => Promise<void>;
  onClear: () => Promise<void>;
}

const PickupResultPanel: React.FC<PickupResultPanelProps> = ({ event, userData, onSave, onClear }) => {
  const split = (event as any).teamSplit;
  const existing = (event as any).pickupResult;
  const sides: Array<{ label: string; playerIds: string[] }> = Array.isArray(split?.sides) ? split.sides : [];
  const [selectedSide, setSelectedSide] = React.useState<string | null>(existing?.winningSide || null);
  const [isTie, setIsTie] = React.useState<boolean>(!!existing?.tie);
  const [mvpId, setMvpId] = React.useState<string>(existing?.mvpPlayerId || '');
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<boolean>(!existing);

  const allPlayers = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sides) for (const pid of (s.playerIds || [])) {
      if (!seen.has(pid)) { seen.add(pid); out.push(pid); }
    }
    return out;
  }, [sides]);

  if (sides.length === 0) return null;

  const handleSave = async () => {
    if (!selectedSide && !isTie) return;
    setBusy(true);
    try {
      const mvpName = mvpId
        ? (allPlayers.find(() => true), '') // resolved by caller for now — we just persist id
        : '';
      const patch: any = {
        winningSide: isTie ? '' : selectedSide,
        tie: isTie,
        recordedAt: new Date(),
        recordedBy: userData?.uid || 'unknown',
      };
      if (mvpId) patch.mvpPlayerId = mvpId;
      if (mvpName) patch.mvpPlayerName = mvpName;
      await onSave(patch);
      setEditing(false);
    } catch (err) {
      console.error('save pickup result failed', err);
      alert("Couldn't save the result. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Clear the recorded result?')) return;
    setBusy(true);
    try {
      await onClear();
      setSelectedSide(null);
      setIsTie(false);
      setMvpId('');
      setEditing(true);
    } finally {
      setBusy(false);
    }
  };

  // Read-only view when a result is already recorded and we're not
  // editing.
  if (!editing && existing) {
    return (
      <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-2">Result</p>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {existing.tie ? (
              <p className="text-lg font-black text-ink-primary">Tie</p>
            ) : (
              <p className="text-lg font-black text-ink-primary truncate">
                <span className="text-brand-primary-soft">{existing.winningSide}</span> won
              </p>
            )}
            {existing.mvpPlayerId && (
              <p className="text-[12px] text-ink-primary/60 mt-0.5 truncate">
                MVP · {existing.mvpPlayerName || existing.mvpPlayerId}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 rounded-lg bg-surface-base ring-1 ring-line-default/10 text-[11px] font-black uppercase tracking-widest text-ink-primary/75"
            >
              Edit
            </button>
            <button
              onClick={handleClear}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-rose-500/15 ring-1 ring-rose-500/30 text-[11px] font-black uppercase tracking-widest text-rose-300"
            >
              Clear
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-3">Record result</p>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {sides.map((s) => (
          <button
            key={s.label}
            onClick={() => { setSelectedSide(s.label); setIsTie(false); }}
            className={`py-2.5 rounded-lg text-sm font-black uppercase tracking-widest transition ${
              !isTie && selectedSide === s.label
                ? 'bg-brand-primary text-brand-primary-fg'
                : 'bg-surface-base ring-1 ring-line-default/10 text-ink-primary/80 hover:ring-brand-primary/40'
            }`}
          >
            {s.label} won
          </button>
        ))}
      </div>
      <button
        onClick={() => { setIsTie(true); setSelectedSide(null); }}
        className={`w-full py-2 rounded-lg text-xs font-black uppercase tracking-widest transition mb-3 ${
          isTie ? 'bg-brand-primary text-brand-primary-fg' : 'bg-surface-base ring-1 ring-line-default/10 text-ink-primary/60 hover:ring-brand-primary/40'
        }`}
      >
        Tie
      </button>

      <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-1.5">MVP (optional)</label>
      <select
        value={mvpId}
        onChange={(e) => setMvpId(e.target.value)}
        className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-brand-primary/50 mb-3"
      >
        <option value="">No MVP</option>
        {allPlayers.map((pid) => (
          <option key={pid} value={pid}>{pid}</option>
        ))}
      </select>

      <div className="flex items-center gap-2">
        {existing && (
          <button
            onClick={() => setEditing(false)}
            className="px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/10 text-xs font-bold text-ink-primary/70"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={busy || (!selectedSide && !isTie)}
          className="flex-1 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary-hov text-brand-primary-fg text-xs font-black uppercase tracking-widest disabled:opacity-40 transition"
        >
          {busy ? 'Saving…' : 'Save result'}
        </button>
      </div>
    </section>
  );
};

export default EventDetail;
