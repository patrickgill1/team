// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CalendarEvent } from '../../types';
import { isGuestActive } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoachOfTeam } from '../../utils/helpers';
import EventForm from './EventForm';
import DeleteEventSheet from './DeleteEventSheet';
import EventListCard from './EventListCard';
import EventWeekStrip from './EventWeekStrip';
import { useTrialGate } from '../../hooks/useTrialGate';
import TrialGateModal from '../common/TrialGateModal';
import DataGate from '../common/DataGate';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';
import WeatherIcon from '../common/WeatherIcon';
import { getShareOrigin } from '../../utils/origin';
import ImportScheduleModal from './ImportScheduleModal';
import EventPhotos from './EventPhotos';
import AppIcon from '../common/AppIcon';
import { collection, query as fsQuery, where as fsWhere, getDocs as fsGetDocs } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { debug } from '../../utils/debug';

// mapsUrlFor moved to ../../utils/maps so detail + list + public pages
// can share the same coord-aware logic. Re-imported below.
import { mapsUrl } from '../../utils/maps';
const mapsUrlForEvent = (event: any): string => mapsUrl({
  name: event.location,
  address: event.locationAddress,
  lat: event.locationCoords?.lat,
  lon: event.locationCoords?.lon,
});

// Hand a single event to the parent's phone calendar via the
// per-event .ics endpoint (api/calendar/event/[event].mjs). Same
// pattern as EventDetail's "Add to my calendar" button — share the
// URL if the OS share sheet is available (Capacitor / iOS Safari /
// Android Chrome), otherwise navigate to it so the browser downloads
// the file. Server-side generation means STATUS:CANCELLED, coach
// notes, opponent, and the real endDate all end up in the calendar
// row, none of which the old client-side blob builder honored.
const openAddToCalendar = async (event: CalendarEvent) => {
  try {
    const url = `${getShareOrigin()}/api/calendar/event/${event.id}.ics`;
    // Native: open in system browser via window.open(url, '_system')
    // — Safari/Chrome fetches the .ics response and prompts Add to
    // Calendar. See EventDetail.tsx handleAddToCalendar comment for
    // the full rationale (navigator.share on URLs doesn't offer
    // Calendar; window.location.href inside WKWebView nukes the app
    // session).
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      window.open(url, '_system');
    } else {
      window.location.href = url;
    }
  } catch (err) {
    console.error('Failed to open .ics', err);
    alert('Could not open calendar file.');
  }
};

interface CalendarProps {
  viewMode?: 'month' | 'list';
  showCreateButton?: boolean;
  /** If set, the list view will scroll the matching event card into view. */
  focusEventId?: string;
}

const Calendar: React.FC<CalendarProps> = ({
  // On phones the big month grid is more of a status object than a tool —
  // 95% of taps go to a single event card. Default to the list so the
  // first thing a parent sees on /calendar is "what's next".
  viewMode: initialViewMode = 'list',
  showCreateButton = true,
  focusEventId,
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();

  // Stamp last-seen so the header notifications bar drops the events
  // pill once the user has looked at the calendar. Runs on every
  // mount + team change; cheap localStorage write.
  useEffect(() => {
    (async () => {
      try {
        const { markCalendarSeen } = await import('../common/NotificationsHeaderBar');
        markCalendarSeen(selectedTeamId || null);
      } catch { /* ignore */ }
    })();
  }, [selectedTeamId]);
  const { getDocuments, addDocument, updateDocument } = useFirestore();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // eventId → total comment count on this team. Powers the
  // 'COMMENTS' chip on each event card. Patrick: 'I don't want a
  // button that doesn't do anything. I think the most helpful
  // thing would to show how many comments have been made on that
  // specific event.'
  const [commentCountByEventId, setCommentCountByEventId] = useState<Record<string, number>>({});
  const [viewMode, setViewMode] = useState<'month' | 'list'>(initialViewMode);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isEventFormOpen, setIsEventFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const { gated: trialGated, reason: trialReason } = useTrialGate();
  const [trialGateOpen, setTrialGateOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [deletingEvent, setDeletingEvent] = useState<CalendarEvent | null>(null);
  // In list mode, parents almost always want "what's next" (Scheduled).
  // Past is one tap away.
  // Pill filter for the list view. "upcoming" includes everything in the
  // future, "games"/"practice" further narrow to that type, "past" flips
  // to history (most recent first). Default to upcoming — that's the
  // glance most parents come to /calendar for.
  const [listTab, setListTab] = useState<'upcoming' | 'games' | 'practice' | 'past'>('upcoming');

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);

  // Every active player on this team that the current user is linked to
  // as a parent. Used to render one RSVP row per kid on every event
  // card (so a parent with two kids gets two responder rows, plus their
  // own row). Single fetch, not per-card, to avoid N+1.
  const [myLinkedPlayers, setMyLinkedPlayers] = useState<Array<{ id: string; name: string }>>([]);
  // uid -> photoURL for everyone on the team (parents + coaches +
  // managers). Drives avatars in the attendee modal and the carpool
  // board so we don't fall back to initial circles for users we know.
  const [userPhotoMap, setUserPhotoMap] = useState<Record<string, string>>({});
  // playerId -> profilePhotoUrl for every player on the team. Drives
  // avatars in the attendee modal for the per-kid RSVPs.
  const [playerPhotoMap, setPlayerPhotoMap] = useState<Record<string, string>>({});
  // Live subscription to eventComments for this team — build a
  // {eventId → count} map for the event-list 'COMMENTS' chip. One
  // collection-scoped onSnapshot, group client-side. Cheap because
  // every team only has a few events worth of comments at a time.
  useEffect(() => {
    if (!selectedTeamId) { setCommentCountByEventId({}); return; }
    let cancelled = false;
    (async () => {
      const { collection, onSnapshot, query, where } = await import('firebase/firestore');
      const q = query(collection(db, 'eventComments'), where('teamId', '==', selectedTeamId));
      const unsub = onSnapshot(q, (snap) => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        snap.forEach(d => {
          const eid = (d.data() as any).eventId;
          if (eid) counts[eid] = (counts[eid] || 0) + 1;
        });
        setCommentCountByEventId(counts);
      });
      // Return cleanup via a ref-style closure since this useEffect
      // runs the async loader inline.
      (Calendar as any)._commentUnsub = unsub;
    })();
    return () => {
      cancelled = true;
      const unsub = (Calendar as any)._commentUnsub;
      if (typeof unsub === 'function') unsub();
    };
  }, [selectedTeamId]);

  useEffect(() => {
    if (!userData?.uid || !selectedTeamId) { setMyLinkedPlayers([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await fsGetDocs(fsQuery(
          collection(db, 'players'),
          fsWhere('parentIds', 'array-contains', userData.uid),
        ));
        const rows = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false && isGuestActive(p))
          .filter((p: any) =>
            (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) ||
            p.teamId === selectedTeamId
          )
          .map((p: any) => ({ id: p.id, name: p.name || 'Player' }));
        if (!cancelled) setMyLinkedPlayers(rows);
      } catch (err) {
        console.error('Linked players lookup failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, selectedTeamId]);

  // Build photo lookup maps for the whole team — one Firestore query
  // each, refreshed when the team changes. Cheap because we read
  // these on every event card and we don't want N+1 user fetches.
  useEffect(() => {
    if (!selectedTeamId) { setUserPhotoMap({}); setPlayerPhotoMap({}); return; }
    let cancelled = false;
    (async () => {
      try {
        // Players in this team — both new teamIds[] shape and the
        // legacy single teamId shape.
        const [byTeamIds, byTeamId] = await Promise.all([
          fsGetDocs(fsQuery(collection(db, 'players'), fsWhere('teamIds', 'array-contains', selectedTeamId))),
          fsGetDocs(fsQuery(collection(db, 'players'), fsWhere('teamId', '==', selectedTeamId))),
        ]);
        const playerMap: Record<string, string> = {};
        const playerIds = new Set<string>();
        const parentIds = new Set<string>();
        [...byTeamIds.docs, ...byTeamId.docs].forEach((d) => {
          if (playerIds.has(d.id)) return;
          playerIds.add(d.id);
          const data: any = d.data();
          // Always register every active player — even those without a
          // profile photo — because this map is dual-purposed: it serves
          // photo URLs to "going" rows AND defines roster size for the
          // pending count. Skipping photoless kids caused
          // "5 pending of 9" instead of "9 pending of 9" on RSVPs
          // (Patrick: imported events showed "5 pending" with 9 on the
          // roster because 4 didn't have photos uploaded yet).
          playerMap[d.id] = data.profilePhotoUrl || '';
          (data.parentIds || []).forEach((pid: string) => parentIds.add(pid));
        });

        // Coaches on the team's `coachIds` array — pull the team doc.
        const teamSnap = await fsGetDocs(fsQuery(collection(db, 'teams'), fsWhere('__name__', '==', selectedTeamId)));
        teamSnap.docs.forEach((t) => {
          const data: any = t.data();
          (data.coachIds || []).forEach((uid: string) => parentIds.add(uid));
          (data.assistantCoachIds || []).forEach((uid: string) => parentIds.add(uid));
          if (data.headCoachId) parentIds.add(data.headCoachId);
        });

        // Resolve uids → photoURL. Chunked because Firestore `in` caps
        // at 30 values per query.
        const uidArr = Array.from(parentIds);
        const photoMap: Record<string, string> = {};
        for (let i = 0; i < uidArr.length; i += 30) {
          const chunk = uidArr.slice(i, i + 30);
          if (chunk.length === 0) continue;
          const snap = await fsGetDocs(fsQuery(collection(db, 'users'), fsWhere('uid', 'in', chunk)));
          snap.docs.forEach((u) => {
            const data: any = u.data();
            const url = data.photoURL || data.profilePhotoUrl;
            if (url) photoMap[data.uid] = url;
          });
        }
        if (cancelled) return;
        setUserPhotoMap(photoMap);
        setPlayerPhotoMap(playerMap);
      } catch (err) {
        console.error('Team photo-map lookup failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  // Load events on component mount
  useEffect(() => {
    const loadEvents = async () => {
      if (!selectedTeamId) return;
      
      try {
        debug('Loading events for team:', selectedTeamId);
        // Use the correct collection name - should match what EventForm uses
        const allEvents = await getDocuments('events', []);
        debug('All events loaded:', allEvents);
        
        // Filter events for this team and convert dates. Soft-deleted
        // events (isActive === false) are excluded here so tombstoned
        // items drop off every calendar surface — see EventDetail
        // handleDelete for the write path.
        const teamEvents = allEvents
          .filter((event: any) => event.teamId === selectedTeamId && event.isActive !== false)
          .map((event: any) => ({
            ...event,
            date: event.date?.toDate ? event.date.toDate() : new Date(event.date),
            createdAt: event.createdAt?.toDate ? event.createdAt.toDate() : new Date(event.createdAt || Date.now())
          })) as CalendarEvent[];
        
        debug('Team events processed:', teamEvents);
        setEvents(teamEvents);
      } catch (error) {
        console.error('Error loading events:', error);
      } finally {
        setLoading(false);
      }
    };

    loadEvents();
  }, [selectedTeamId, getDocuments]);

  // When a focusEventId is set in the URL (e.g. coming from the home
  // hero), scroll the matching event card into view after the list
  // renders. Wrapped in rAF to wait for the layout pass.
  useEffect(() => {
    if (!focusEventId || loading || viewMode !== 'list') return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`event-${focusEventId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [focusEventId, loading, viewMode, events.length]);

  const handleEventUpdated = (updatedEvent: CalendarEvent) => {
    debug('Event updated:', updatedEvent);
    
    if (editingEvent) {
      // Update existing event
      setEvents(prevEvents =>
        prevEvents.map(event =>
          event.id === updatedEvent.id ? updatedEvent : event
        )
      );
      setEditingEvent(null);
    } else {
      // Add new event
      setEvents(prevEvents => [...prevEvents, updatedEvent]);
    }
    setIsEventFormOpen(false);
  };

  const handleEditEvent = (event: CalendarEvent) => {
    setEditingEvent(event);
    setIsEventFormOpen(true);
  };

  // Open the delete confirmation sheet. The sheet handles the actual
  // Firestore delete + optional team push notification — this just
  // surfaces the right event into it.
  const handleDeleteEvent = (eventId: string) => {
    const target = events.find(e => e.id === eventId);
    if (target) setDeletingEvent(target);
  };

  const handleRsvp = async (eventId: string, status: 'going' | 'maybe' | 'no') => {
    if (!userData) return;
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    const now = new Date();
    // Snapshot the parent's photo + name at write time so the event
    // card avatar stack can render without an N+1 users lookup.
    const parentPhoto = (userData as any).photoURL || (userData as any).profilePhotoUrl || undefined;
    // Carry any prior 'no' reason forward — the reason itself is
    // edited on the event-detail page; the calendar just flips status.
    const priorReason = (ev.rsvps as any)?.[userData.uid]?.reason;
    const reason = status === 'no' && typeof priorReason === 'string' ? priorReason : undefined;
    const newRsvps = {
      ...(ev.rsvps || {}),
      [userData.uid]: {
        status,
        name: userData.name || userData.email || 'Unknown',
        // Snapshot role so the RsvpBar can distinguish "coach/staff
        // RSVP'd" from "parent RSVP'd" without a live user lookup.
        // Pure-parent self-RSVPs aren't counted toward the visible
        // totals (parents matter for player counts, not attendance).
        role: userData.role,
        ...(parentPhoto ? { photoUrl: parentPhoto } : {}),
        ...(reason ? { reason } : {}),
        updatedAt: now,
        respondedAt: now,
      },
    };
    // Optimistic
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, rsvps: newRsvps } : e));
    try {
      await updateDocument('events', eventId, { rsvps: newRsvps });
    } catch (err) {
      console.error('Error saving RSVP:', err);
      setEvents(prev => prev.map(e => e.id === eventId ? ev : e));
      alert('Failed to save RSVP.');
    }
  };

  /** RSVP on behalf of a linked player (the kid). Stored separately from
   *  the parent's own uid-keyed RSVP so the coach can see "Hunter going,
   *  Patrick going" rather than just one combined answer. */
  const handlePlayerRsvp = async (
    eventId: string,
    playerId: string,
    playerName: string,
    status: 'going' | 'maybe' | 'no',
  ) => {
    if (!userData) return;
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    const now = new Date();
    const parentPhoto = (userData as any).photoURL || (userData as any).profilePhotoUrl || undefined;
    // Preserve any prior 'no' reason when the status stays 'no'. The
    // reason itself is only edited on the event-detail page — the
    // calendar's quick-tap buttons don't expose a text input.
    const prior = ((ev as any).playerRsvps || {})[playerId] || {};
    const reason = status === 'no' && typeof prior.reason === 'string' ? prior.reason : undefined;
    const newPlayerRsvps = {
      ...((ev as any).playerRsvps || {}),
      [playerId]: {
        status,
        playerName,
        byUid: userData.uid,
        byName: userData.name || undefined,
        ...(parentPhoto ? { byPhotoUrl: parentPhoto } : {}),
        ...(reason ? { reason } : {}),
        updatedAt: now,
        respondedAt: now,
      },
    };
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, playerRsvps: newPlayerRsvps } as any : e));
    try {
      await updateDocument('events', eventId, { playerRsvps: newPlayerRsvps });
    } catch (err) {
      console.error('Error saving player RSVP:', err);
      setEvents(prev => prev.map(e => e.id === eventId ? ev : e));
      alert('Failed to save RSVP.');
    }
  };

  const handleAddCarpoolPost = async (
    eventId: string,
    post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }
  ) => {
    if (!userData) return;
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      uid: userData.uid,
      name: userData.name || userData.email || 'Unknown',
      type: post.type,
      seats: post.seats,
      location: post.location,
      note: post.note,
      createdAt: new Date(),
    };
    const newPosts = [...(ev.carpoolPosts || []), entry];
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, carpoolPosts: newPosts } : e));
    try {
      await updateDocument('events', eventId, { carpoolPosts: newPosts });
    } catch (err) {
      console.error('Error adding carpool post:', err);
      setEvents(prev => prev.map(e => e.id === eventId ? ev : e));
      alert('Failed to post.');
    }
  };

  const handleDeleteCarpoolPost = async (eventId: string, postId: string) => {
    if (!userData) return;
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    const newPosts = (ev.carpoolPosts || []).filter(p => p.id !== postId);
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, carpoolPosts: newPosts } : e));
    try {
      await updateDocument('events', eventId, { carpoolPosts: newPosts });
    } catch (err) {
      console.error('Error deleting carpool post:', err);
      setEvents(prev => prev.map(e => e.id === eventId ? ev : e));
    }
  };

  const getEventTypeIcon = (type: string) => {
    switch (type) {
      case 'game': return '⚽';
      case 'practice': return '🏃';
      case 'event': return '📅';
      default: return '📅';
    }
  };

  const getEventTypeColor = (type: string) => {
    switch (type) {
      case 'game': return 'bg-rose-500/10 text-rose-700 border-rose-300/50';
      case 'practice': return 'bg-brand-primary/10 text-brand-primary-soft border-brand-primary-soft/50';
      case 'event': return 'bg-emerald-500/10 text-emerald-700 border-emerald-300/50';
      default: return 'bg-surface-input text-ink-primary border-line-default';
    }
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const getEventsForDate = (date: Date) => {
    return events.filter(event => {
      const eventDate = new Date(event.date);
      return eventDate.toDateString() === date.toDateString();
    });
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    setCurrentDate(prevDate => {
      const newDate = new Date(prevDate);
      if (direction === 'prev') {
        newDate.setMonth(newDate.getMonth() - 1);
      } else {
        newDate.setMonth(newDate.getMonth() + 1);
      }
      return newDate;
    });
  };

  const handleDateClick = (date: Date) => {
    setSelectedDate(date);
    if (isUserCoach) {
      setEditingEvent(null);
      setIsEventFormOpen(true);
    }
  };

  const renderMonthView = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDay = getFirstDayOfMonth(currentDate);
    const days: React.ReactElement[] = [];

    // Empty cells for days before the first day of the month
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="h-24 sm:h-28 bg-surface-input/60"></div>);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
      const dayEvents = getEventsForDate(date);
      const isToday = date.toDateString() === new Date().toDateString();
      const isPast = date < new Date() && !isToday;

      days.push(
        <div
          key={day}
          onClick={() => handleDateClick(date)}
          className={`h-24 sm:h-28 border border-line-default/40 p-1.5 cursor-pointer transition-all duration-150 ${
            isToday
              ? 'bg-brand-primary/10 ring-1 ring-brand-primary/40'
              : isPast
                ? 'bg-surface-input/40 hover:bg-surface-input'
                : 'bg-surface-elevated hover:bg-brand-primary/10'
          }`}
        >
          <div className={`text-xs font-semibold mb-1 inline-flex items-center justify-center ${
            isToday
              ? 'w-6 h-6 rounded-full bg-surface-tint text-ink-primary shadow-sm'
              : isPast ? 'text-ink-primary/40' : 'text-ink-primary'
          }`}>
            {day}
          </div>
          <div className="space-y-1 overflow-hidden">
            {dayEvents.slice(0, 2).map(event => (
              <div
                key={event.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isUserCoach) {
                    handleEditEvent(event);
                  }
                }}
                className={`text-[11px] px-1.5 py-0.5 rounded-md truncate border ${getEventTypeColor(event.type)} ${isUserCoach ? 'cursor-pointer hover:ring-1 hover:ring-brand-primary-soft' : ''}`}
                title={isUserCoach ? `Edit: ${event.title} — ${event.location}` : `${event.title} - ${event.location}`}
              >
                {getEventTypeIcon(event.type)} {event.title}
              </div>
            ))}
            {dayEvents.length > 2 && (
              <div className="text-[10px] text-ink-primary/55 px-1 font-medium">
                +{dayEvents.length - 2} more
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/40 overflow-hidden">
        {/* Calendar Header */}
        <div className="bg-gradient-to-r from-surface-raised via-surface-tint to-surface-raised px-5 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg sm:text-xl font-bold text-ink-primary tracking-tight">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h2>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => navigateMonth('prev')}
                className="p-2 hover:bg-line-default/15 active:bg-line-default/25 text-ink-primary rounded-lg transition-colors"
                aria-label="Previous month"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setCurrentDate(new Date())}
                className="px-3 py-1.5 text-xs font-semibold bg-line-default/15 hover:bg-line-default/25 text-ink-primary rounded-lg transition-colors backdrop-blur-sm"
              >
                Today
              </button>
              <button
                onClick={() => navigateMonth('next')}
                className="p-2 hover:bg-line-default/15 active:bg-line-default/25 text-ink-primary rounded-lg transition-colors"
                aria-label="Next month"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Days of Week Header */}
        <div className="grid grid-cols-7 bg-surface-input border-b border-line-default/40">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="py-2 px-3 text-center text-[11px] font-bold uppercase tracking-wider text-ink-primary/55">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar Grid */}
        <div className="grid grid-cols-7">
          {days}
        </div>

        {/* Click hint for coaches */}
        {isUserCoach && (
          <div className="px-5 sm:px-6 py-3 bg-brand-primary-soft/60 border-t border-brand-primary-soft">
            <p className="text-xs sm:text-sm text-ink-primary font-medium">
              Click any date to create a new event
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderListView = () => {
    const now = new Date();
    const upcomingEvents = events
      .filter(event => new Date(event.date) >= now)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const pastEvents = events
      .filter(event => new Date(event.date) < now)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let showing: CalendarEvent[];
    if (listTab === 'past') showing = pastEvents;
    else if (listTab === 'games') showing = upcomingEvents.filter(e => e.type === 'game');
    else if (listTab === 'practice') showing = upcomingEvents.filter(e => e.type === 'practice');
    else showing = upcomingEvents;

    const pillFilters: { key: typeof listTab; label: string }[] = [
      { key: 'upcoming', label: 'Upcoming' },
      { key: 'games', label: 'Games' },
      { key: 'practice', label: 'Practice' },
      { key: 'past', label: 'Past' },
    ];

    // Build a compact card view-model per event. Counts are PLAYERS only.
    // Public share-link RSVPs were retired 2026-06-24 (everyone's on the
    // app via parent or extended-family invites); we no longer aggregate
    // publicRsvps into the card headcounts.
    const buildCardProps = (ev: CalendarEvent) => {
      const playerR = (ev as any).playerRsvps || {};
      const going: { name: string; photoURL?: string; isGuest?: boolean }[] = [];
      const noRsvpNotes: { name: string; reason?: string }[] = [];
      let goingCount = 0, maybeCount = 0, noCount = 0;
      for (const pid of Object.keys(playerR)) {
        const r = playerR[pid];
        if (r.status === 'going') goingCount++;
        else if (r.status === 'maybe') maybeCount++;
        else if (r.status === 'no') noCount++;
        if (r.status === 'going') {
          // Prefer the snapshotted photo on the RSVP entry (parallel
          // agent's work — lands on r.photoUrl when the write path
          // stamps it). Fall back to the team-wide playerPhotoMap so
          // legacy RSVPs still render an avatar instead of a blob.
          going.push({
            name: r.playerName,
            photoURL: (r as any).photoUrl || playerPhotoMap?.[pid] || undefined,
            isGuest: false,
          });
        } else if (r.status === 'no') {
          const reason = ((r as any).reason || '').toString().trim();
          noRsvpNotes.push({
            name: r.playerName || 'Player',
            reason: reason || undefined,
          });
        }
      }
      // Pending = roster size (from playerPhotoMap, which holds every
      // active player on this team) minus everyone who already responded.
      const respondedPlayers = new Set(Object.keys(playerR));
      const rosterSize = Object.keys(playerPhotoMap || {}).length;
      const pendingCount = Math.max(0, rosterSize - respondedPlayers.size);

      const arriveMin = (ev as any).arriveOffsetMinutes as number | undefined;
      let arriveText: string | undefined;
      let arriveLabel: string | undefined;
      if (typeof arriveMin === 'number' && arriveMin > 0) {
        const arriveAt = new Date(new Date(ev.date).getTime() - arriveMin * 60_000);
        arriveText = `Arrive ${arriveAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
        arriveLabel = `${arriveMin} MIN EARLY`;
      }

      // RSVP routing on the card. If the current user has exactly one
      // linked player (the common case — coach who's a parent of one
      // kid on the team), the card's checkmark / question / x buttons
      // should manage THAT player's RSVP, not the adult's own. Patrick:
      // 'the little checkmark is still referring to me, in stead of my
      // son. since we removed my as atending person, this check does
      // nothing.'
      //
      // Multi-kid case: leave the card buttons disabled at the personal
      // level (the per-player rows in the expanded EventCard handle
      // each kid individually). For tonight we keep showing the
      // adult's RSVP as a sensible fallback rather than nothing.
      const primaryPlayer = (myLinkedPlayers && myLinkedPlayers.length === 1)
        ? myLinkedPlayers[0]
        : null;
      const myRsvp = primaryPlayer
        ? ((ev as any).playerRsvps?.[primaryPlayer.id]?.status as any)
        : (userData?.uid ? (ev.rsvps?.[userData.uid]?.status as any) : null);
      return { goingCount, pendingCount, going, noRsvpNotes, arriveText, arriveLabel, myRsvp, primaryPlayer };
    };

    return (
      <div>
        {/* Page header — full-bleed navy. "Events" title + plus icon
            for new event. No subtitle (we don't need to say what
            events are). Lives in the navy band so the page reads
            as one continuous surface. */}
        <div className="bg-surface-base px-4 pt-4 pb-3 flex items-center justify-between">
          <h1 className="text-2xl font-black text-ink-primary tracking-tight">The Schedule</h1>
          {isUserCoach && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsImportOpen(true)}
                aria-label="Import schedule"
                title="Import schedule from Ollie / GotSoccer / .ics"
                className="w-9 h-9 rounded-full bg-line-default/10 ring-1 ring-line-default/15 text-ink-primary/70 flex items-center justify-center hover:bg-line-default/15 hover:text-ink-primary"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
              <button
                onClick={() => {
                  if (trialGated) { setTrialGateOpen(true); return; }
                  setEditingEvent(null);
                  setSelectedDate(null);
                  setIsEventFormOpen(true);
                }}
                aria-label="Add event"
                className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint text-white flex items-center justify-center shadow-lg shadow-brand-primary/30 hover:from-brand-primary-soft hover:to-brand-primary"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Pill filters — same navy continues */}
        <div className="bg-surface-base px-3.5 pb-2.5 flex gap-1.5 overflow-x-auto">
          {pillFilters.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setListTab(key)}
              className={`px-3 py-1 rounded-md text-[11px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                listTab === key
                  ? 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/40'
                  : 'bg-surface-input/40 text-ink-primary/60 border-line-default/15 hover:text-ink-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Week strip — quick scan of the next 7 days */}
        <EventWeekStrip
          events={upcomingEvents}
          onDayClick={(d) => {
            // scroll to the first event on that day, if any
            const target = upcomingEvents.find(e => {
              const ed = new Date(e.date);
              return ed.getFullYear() === d.getFullYear()
                && ed.getMonth() === d.getMonth()
                && ed.getDate() === d.getDate();
            });
            if (target) {
              const el = document.getElementById(`event-${target.id}`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }}
        />

        {/* Event card list — solid charcoal-950 (the darkest brand
            stop) so the charcoal-900 cards above always read as
            visibly lifted blocks instead of blending into the
            container as scroll position moves under them. */}
        <div className="bg-surface-base px-3 py-4 space-y-4 min-h-[200px]">
          {showing.length === 0 ? (
            <div className="bg-surface-elevated/60 rounded-xl ring-1 ring-line-default/10 p-8 text-center backdrop-blur-sm">
              <p className="text-ink-primary/70 font-medium text-sm">
                {listTab === 'past' ? 'Nothing in the books yet.' : 'Calendar is wide open.'}
              </p>
              {listTab !== 'past' && isUserCoach && (
                <button
                  onClick={() => {
                    setEditingEvent(null);
                    setSelectedDate(null);
                    setIsEventFormOpen(true);
                  }}
                  className="mt-4 bg-brand-primary hover:bg-brand-primary/90 text-white font-semibold py-2 px-4 rounded-lg shadow-sm transition-all text-sm"
                >
                  Put Something on the Calendar
                </button>
              )}
            </div>
          ) : (
            showing.map(event => {
              const p = buildCardProps(event);
              return (
                <div
                  key={event.id}
                  id={`event-${event.id}`}
                  className={focusEventId === event.id ? 'ring-2 ring-brand-primary-soft ring-offset-2 ring-offset-slate-800 rounded-xl' : ''}
                >
                  <EventListCard
                    event={event}
                    myRsvp={p.myRsvp}
                    onRsvp={(status) => {
                      // Route through the linked-player handler when there
                      // is one, so the inline RSVP buttons manage the kid's
                      // status (not the coach's own — see buildCardProps).
                      if (p.primaryPlayer) {
                        handlePlayerRsvp(event.id, p.primaryPlayer.id, p.primaryPlayer.name, status);
                      } else {
                        handleRsvp(event.id, status);
                      }
                    }}
                    rsvpLabel={p.primaryPlayer ? p.primaryPlayer.name.toUpperCase() : undefined}
                    goingCount={p.goingCount}
                    pendingCount={p.pendingCount}
                    goingPreview={p.going.slice(0, 6)}
                    arriveText={p.arriveText}
                    arriveLabel={p.arriveLabel}
                    eventChatUnread={commentCountByEventId[event.id] || 0}
                    isCoach={isUserCoach}
                    noRsvpNotes={p.noRsvpNotes}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  if (loading) return <DataGate when="loading" />;

  return (
    <div>
      {/* List view is the only mode — the legacy month grid was a
          desktop-only afterthought that opened bubbly EventCards
          (whole separate UI surface to maintain) and saw almost no
          use on mobile. The list view's own navy header carries the
          + Add button + filters / week strip / pill nav. */}
      {renderListView()}

      {/* Event Form Modal */}
      <EventForm
        isOpen={isEventFormOpen}
        onClose={() => {
          setIsEventFormOpen(false);
          setEditingEvent(null);
          setSelectedDate(null);
        }}
        onEventUpdated={handleEventUpdated}
        editingEvent={editingEvent}
        selectedDate={selectedDate || undefined}
      />

      {/* Delete confirmation — supports an "alert the team" toggle
          so removing an event can either ping the people who RSVPed
          or be a silent cleanup. */}
      <DeleteEventSheet
        event={deletingEvent}
        onClose={() => setDeletingEvent(null)}
        onDeleted={() => {
          if (deletingEvent) {
            setEvents(prev => prev.filter(e => e.id !== deletingEvent.id));
          }
        }}
      />

      {/* Schedule Import Modal */}
      <ImportScheduleModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        existingEvents={events.map((e) => ({ title: e.title, date: e.date }))}
        onImported={async () => {
          // Reload events after the bulk import completes — uses the same
          // path as the on-mount load so a fresh subscription isn't needed.
          if (!selectedTeamId) return;
          const all = await getDocuments('events', []);
          const list = (all || [])
            .filter((ev: any) => ev.teamId === selectedTeamId && ev.isActive !== false)
            .map((ev: any) => ({
              ...ev,
              date: ev.date?.toDate ? ev.date.toDate() : new Date(ev.date),
              createdAt: ev.createdAt?.toDate ? ev.createdAt.toDate() : new Date(ev.createdAt || Date.now()),
            })) as CalendarEvent[];
          setEvents(list);
        }}
      />
    </div>
  );
};

// Event Card Component for List View
interface EventCardProps {
  event: CalendarEvent;
  onEdit: (event: CalendarEvent) => void;
  onDelete: (eventId: string) => void;
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
  onPlayerRsvp?: (eventId: string, playerId: string, playerName: string, status: 'going' | 'maybe' | 'no') => void;
  onAddCarpool?: (eventId: string, post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }) => void;
  onDeleteCarpool?: (eventId: string, postId: string) => void;
  userUid?: string;
  userName?: string;
  userRole?: string;
  myLinkedPlayers?: Array<{ id: string; name: string }>;
  userPhotoMap?: Record<string, string>;
  playerPhotoMap?: Record<string, string>;
  canEdit: boolean;
  isDeleting: boolean;
  isPast?: boolean;
}

// Color palette per event type — all three stay inside the Fire FC
// brand (sky-blue + navy ramp), distinguished by lightness instead of
// hue so the cards still scan at a glance without going off-brand.
//   game     = navy-700  (most important — deep, official)
//   practice = fire-500  (bright sky — active energy)
//   event    = fire-700  (mid sky — social/team)
const eventColors = (type: string) => {
  switch (type) {
    case 'game':
      return { stripe: 'bg-surface-raised', stripeText: 'text-ink-primary', pill: 'bg-surface-raised/10 text-ink-primary' };
    case 'practice':
      return { stripe: 'bg-brand-primary', stripeText: 'text-white', pill: 'bg-brand-primary-soft text-charcoal-800' };
    case 'event':
      return { stripe: 'bg-surface-raised', stripeText: 'text-ink-primary', pill: 'bg-brand-primary-soft text-charcoal-800' };
    default:
      return { stripe: 'bg-brand-primary', stripeText: 'text-white', pill: 'bg-brand-primary-soft text-charcoal-800' };
  }
};

const EventCard: React.FC<EventCardProps> = ({
  event,
  onEdit,
  onDelete,
  onRsvp,
  onPlayerRsvp,
  onAddCarpool,
  onDeleteCarpool,
  userUid,
  userName,
  userRole,
  myLinkedPlayers,
  userPhotoMap = {},
  playerPhotoMap = {},
  canEdit,
  isDeleting,
  isPast = false
}) => {
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWeather(null);
    if (isPast || !event?.date) return;
    const dt = event.date instanceof Date ? event.date : new Date(event.date);
    if (Number.isNaN(dt.getTime())) return;
    const diffDays = Math.floor((dt.getTime() - Date.now()) / 86400_000);
    if (diffDays < 0 || diffDays > 15) return;
    const coords = (event as any).locationCoords || null;
    getWeatherForEvent(event.location || '', dt, coords).then(w => { if (!cancelled) setWeather(w); });
    return () => { cancelled = true; };
  }, [event?.id, event?.location, event?.date, isPast]);

  const colors = eventColors(event.type);
  const dt = event.date instanceof Date ? event.date : new Date(event.date);
  const dayLabel = dt.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const dayNum = dt.getDate();
  const monthLabel = dt.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  const timeLabel = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const handleShare = async () => {
    const url = `${getShareOrigin()}/event/${event.id}`;
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).share) {
        await (navigator as any).share({ url });
        return;
      }
    } catch {
      // user dismissed share sheet — fall through to copy
    }
    try {
      await navigator.clipboard.writeText(url);
      alert('Share link copied to clipboard!');
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  // Custom Fire FC iconography: soccer ball for games, running figure
  // for practices, flag for "events" (anything else — tournaments,
  // team dinners, photo day). Not borrowed from Ollie.
  const typeIcon: 'soccer' | 'running' | 'flag' = event.type === 'game' ? 'soccer' : event.type === 'practice' ? 'running' : 'flag';

  return (
    <div className={`rounded-2xl ring-1 overflow-hidden bg-surface-elevated shadow-sm transition-all ${
      isPast ? 'ring-gray-300 opacity-90' : 'ring-gray-300 hover:shadow-md'
    }`}>
      <div className="flex items-stretch min-h-[120px]">
        {/* Left date stripe — colored by event type, with day/num/month
            stacked, plus a type icon pinned to the bottom (the Ollie
            pattern). */}
        <div className={`${colors.stripe} ${colors.stripeText} w-20 shrink-0 relative flex flex-col items-center justify-center py-3`}>
          <span className="text-[10px] font-bold tracking-wider opacity-90">{dayLabel}</span>
          <span className="text-2xl font-black leading-none my-0.5">{dayNum}</span>
          <span className="text-[10px] font-bold tracking-wider opacity-90">{monthLabel}</span>
          <span className="absolute bottom-2 left-2 opacity-80">
            <AppIcon name={typeIcon} className="w-5 h-5" />
          </span>
        </div>

        {/* Right content */}
        <div className="flex-1 min-w-0 p-4 flex flex-col">
          {/* Header row: title + type pill + recurring + coach actions */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <h4 className={`font-bold text-[15px] leading-snug break-words ${isPast ? 'text-ink-primary/80' : 'text-ink-primary'}`}>
                {event.title}
              </h4>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-full ${colors.pill}`}>
                  {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
                </span>
                {(event as any).seriesId && (
                  <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-surface-input text-ink-primary" title="Recurring">
                    {(event as any).recurrence || 'recurring'}
                  </span>
                )}
              </div>
            </div>
            {canEdit && !isPast && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onEdit(event)}
                  disabled={isDeleting}
                  className="p-1.5 text-ink-primary/40 hover:text-brand-primary hover:bg-brand-primary-soft rounded-lg transition disabled:opacity-50"
                  title="Edit"
                >
                  <AppIcon name="edit" className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onDelete(event.id)}
                  disabled={isDeleting}
                  className="p-1.5 text-ink-primary/40 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition disabled:opacity-50"
                  title="Delete"
                >
                  {isDeleting ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-rose-300 border-t-rose-600" />
                  ) : (
                    <AppIcon name="trash" className="w-4 h-4" />
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Meta rows — single consistent icon set, single text color */}
          <div className={`mt-2 text-sm space-y-1 ${isPast ? 'text-ink-primary/55' : 'text-ink-primary/65'}`}>
            <div className="flex items-center gap-1.5 min-w-0">
              <AppIcon name="clock" className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {timeLabel}
                {(event as any).arriveOffsetMinutes > 0 && (() => {
                  const arrive = new Date(dt.getTime() - (event as any).arriveOffsetMinutes * 60_000);
                  const arriveLabel = arrive.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                  return <span className="ml-1 text-ink-primary/55">(arrive {arriveLabel})</span>;
                })()}
              </span>
            </div>
            {event.location && (
              <a
                href={mapsUrlForEvent(event)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 min-w-0 hover:text-brand-primary transition-colors"
                title="Open in Maps"
              >
                <AppIcon name="map-pin" className="w-4 h-4 shrink-0" />
                <span className="truncate underline decoration-dotted underline-offset-2">{event.location}</span>
              </a>
            )}
          </div>

          {event.description && (
            <p className={`text-sm mt-2 break-words ${isPast ? 'text-ink-primary/55' : 'text-ink-primary/65'}`}>
              {event.description}
            </p>
          )}

          {weather && (
            <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-brand-primary-soft ring-1 ring-brand-primary-soft text-brand-primary-dim text-xs font-semibold max-w-full self-start">
              <WeatherIcon iconName={weather.iconName} className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{weather.label} · {weather.tempMaxF}°/{weather.tempMinF}°F{weather.precipChance > 0 ? ` · ${weather.precipChance}% rain` : ''}</span>
            </div>
          )}

          {/* Bottom chip row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            {!isPast && (
              <button
                onClick={() => openAddToCalendar(event)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-ink-primary/80 bg-surface-input hover:bg-line-default/20 rounded-full transition-colors"
                title="Add to my phone calendar"
              >
                <AppIcon name="calendar" className="w-3.5 h-3.5" />
                <span>Add to calendar</span>
              </button>
            )}
            <button
              onClick={handleShare}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-ink-primary/80 bg-surface-input hover:bg-line-default/20 rounded-full transition-colors"
              title="Share event link"
            >
              <AppIcon name="arrow-right" className="w-3.5 h-3.5" />
              <span>Share</span>
            </button>
            {event.type === 'game' && (
              <a
                href={`/game-day/${event.id}`}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-brand-primary hover:brightness-110 rounded-full shadow-sm transition"
                title="Open Game Day live tracker"
              >
                <AppIcon name="whistle" className="w-3.5 h-3.5" />
                <span>Game Day {isPast ? 'recap' : 'live'}</span>
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="px-4">
        <RsvpBar
          event={event}
          userUid={userUid}
          userName={userName}
          userRole={userRole}
          myLinkedPlayers={myLinkedPlayers}
          userPhotoMap={userPhotoMap}
          playerPhotoMap={playerPhotoMap}
          onRsvp={onRsvp}
          onPlayerRsvp={onPlayerRsvp}
          isPast={isPast}
        />
        <CarpoolBar
          event={event}
          userUid={userUid}
          userPhotoMap={userPhotoMap}
          onAdd={onAddCarpool}
          onDelete={onDeleteCarpool}
          isPast={isPast}
        />
        <EventPhotos eventId={event.id} teamId={event.teamId} canModerate={canEdit} />
      </div>
    </div>
  );
};

const RsvpBar: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  userName?: string;
  userRole?: string;
  myLinkedPlayers?: Array<{ id: string; name: string }>;
  userPhotoMap?: Record<string, string>;
  playerPhotoMap?: Record<string, string>;
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
  onPlayerRsvp?: (eventId: string, playerId: string, playerName: string, status: 'going' | 'maybe' | 'no') => void;
  isPast?: boolean;
}> = ({ event, userUid, userName, userRole, myLinkedPlayers = [], userPhotoMap = {}, playerPhotoMap = {}, onRsvp, onPlayerRsvp, isPast }) => {
  const [showList, setShowList] = useState<null | 'going' | 'maybe' | 'no'>(null);
  if (event.type !== 'game' && event.type !== 'practice' && event.type !== 'event') return null;
  const rsvps = event.rsvps || {};
  const publicRsvps = (event as any).publicRsvps || {};
  const playerRsvps = (event as any).playerRsvps || {};
  // "Staff" = coaches + team managers. Their personal RSVP matters
  // (it tells the head coach who's running things). A pure-parent's
  // own RSVP doesn't affect lineups, so we never count it.
  const isStaffRole = (r: any) => r === 'coach' || r === 'team_manager';
  // isGuest = responded via the public share link (no account).
  type Entry = { id: string; uid?: string; playerId?: string; status: 'going' | 'maybe' | 'no'; name: string; isStaff: boolean; isPlayer: boolean; isGuest: boolean };
  const entries: Entry[] = [
    ...Object.entries(rsvps).map(([uid, v]: any) => ({ id: uid, uid, status: v.status, name: v.name, isStaff: isStaffRole(v.role), isPlayer: false, isGuest: false })),
    // Public-link RSVPs. They only count toward the COACH headline if
    // the responder self-tagged as coach, but every one of them is
    // still shown in the attendee modal so the coach can see exactly
    // who replied via the shared link (and who declined).
    ...Object.entries(publicRsvps).map(([token, v]: any) => ({ id: `g_${token}`, status: v.status, name: v.name, isStaff: !!v.isCoach, isPlayer: false, isGuest: true })),
    ...Object.entries(playerRsvps).map(([pid, v]: any) => ({ id: `p_${pid}`, playerId: pid, status: v.status, name: v.playerName || 'Player', isStaff: false, isPlayer: true, isGuest: false })),
  ];
  // Headline counts shown on the event card: players for lineup math,
  // coaches/staff for sideline coverage. Parents/guests are tracked
  // and fully listed in the modal but don't inflate these two numbers.
  const playerCounts = {
    going: Object.values(playerRsvps).filter((v: any) => v.status === 'going').length,
    maybe: Object.values(playerRsvps).filter((v: any) => v.status === 'maybe').length,
    no: Object.values(playerRsvps).filter((v: any) => v.status === 'no').length,
  };
  const staffCounts = {
    going: entries.filter(e => e.isStaff && e.status === 'going').length,
    maybe: entries.filter(e => e.isStaff && e.status === 'maybe').length,
    no: entries.filter(e => e.isStaff && e.status === 'no').length,
  };
  // "Others" = parents/guests who responded but aren't a player or a
  // coach. Surfaced in the modal (especially "Can't make it") so the
  // coach can always see who declined, app or share-link.
  const otherCount = (status: 'going' | 'maybe' | 'no') =>
    entries.filter(e => e.status === status && !e.isPlayer && !e.isStaff).length;
  const my = userUid ? rsvps[userUid]?.status : undefined;
  // Only show the "Me" row for staff. A pure parent RSVPing for
  // themself doesn't help anyone plan — their kid's RSVP is the
  // signal that matters.
  const showSelfRow = isStaffRole(userRole);
  // Colored circle badge — matches the Ollie pattern of "green check
  // circle / red X circle / amber ? circle" at the bottom of each row,
  // and replaces the emoji + label combo we used to ship.
  const StatusBadge: React.FC<{ status: 'going' | 'maybe' | 'no'; size?: 'sm' | 'md' }> = ({ status, size = 'sm' }) => {
    const cls = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
    const dim = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
    if (status === 'going') {
      return (
        <span className={`${cls} rounded-full bg-emerald-500 flex items-center justify-center text-white`}>
          <svg className={dim} fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );
    }
    if (status === 'no') {
      return (
        <span className={`${cls} rounded-full bg-rose-500 flex items-center justify-center text-white`}>
          <svg className={dim} fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      );
    }
    return (
      <span className={`${cls} rounded-full bg-amber-400 flex items-center justify-center text-white text-[10px] font-bold`}>
        ?
      </span>
    );
  };

  const btn = (status: 'going' | 'maybe' | 'no', label: string, color: string, activeText: string) => (
    <button
      key={status}
      onClick={() => onRsvp && onRsvp(event.id, status)}
      disabled={!userUid || isPast}
      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
        my === status
          ? `${color} ${activeText} border-transparent shadow-sm`
          : 'bg-surface-elevated text-ink-primary border-line-default hover:border-line-default/60'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <StatusBadge status={status} size="sm" />
      <span>{label}</span>
    </button>
  );
  // Total responders per status across everyone (players + staff +
  // parents/guests) — drives the tappable Going / Maybe / Can't pills
  // so the coach can open any list, including who declined.
  const totalFor = (status: 'going' | 'maybe' | 'no') =>
    entries.filter(e => e.status === status).length;

  return (
    <div className="mt-3 pt-3 border-t border-line-default/10">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <span className="text-xs font-medium text-ink-primary/55 uppercase tracking-wide">
          {isPast ? 'Final RSVPs' : 'Who’s coming?'}
        </span>
        {/* Tap any status to see the full breakdown (players, coaches,
            and parents/guests — including who responded via the share
            link). All three are reachable now, not just Going. */}
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => setShowList('going')}
            className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold hover:underline"
            title="Going"
          >
            <StatusBadge status="going" />
            <span>{totalFor('going')}</span>
          </button>
          <button
            onClick={() => setShowList('maybe')}
            className="inline-flex items-center gap-1.5 text-amber-700 font-semibold hover:underline"
            title="Maybe"
          >
            <StatusBadge status="maybe" />
            <span>{totalFor('maybe')}</span>
          </button>
          <button
            onClick={() => setShowList('no')}
            className="inline-flex items-center gap-1.5 text-rose-700 font-semibold hover:underline"
            title="Can't make it"
          >
            <StatusBadge status="no" />
            <span>{totalFor('no')}</span>
          </button>
        </div>
      </div>
      {/* Player + coach headline (the planning numbers) sits just under
          the tappable status pills so both signals are visible. */}
      <div className="flex items-center gap-3 text-[11px] text-ink-primary/55 mb-2">
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-50 ring-1 ring-emerald-200 text-emerald-700 text-[9px] font-bold">P</span>
          {playerCounts.going} player{playerCounts.going === 1 ? '' : 's'} going
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-brand-primary-soft ring-1 ring-brand-primary-soft text-brand-primary text-[9px] font-bold">C</span>
          {staffCounts.going} coach{staffCounts.going === 1 ? '' : 'es'} going
        </span>
      </div>
      {!isPast && (
        <div className="space-y-2">
          {/* One row per linked player — the parent (or coach + parent)
              answers Going/Maybe/Can't per kid. Coaches see these as the
              attendance signal that matters. */}
          {myLinkedPlayers.map((p) => {
            const current = (playerRsvps[p.id]?.status) as 'going' | 'maybe' | 'no' | undefined;
            const pBtn = (status: 'going' | 'maybe' | 'no', label: string, color: string) => (
              <button
                key={status}
                onClick={() => onPlayerRsvp && onPlayerRsvp(event.id, p.id, p.name, status)}
                disabled={!userUid}
                className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                  current === status
                    ? `${color} text-white border-transparent shadow-sm`
                    : 'bg-surface-elevated text-ink-primary border-line-default hover:border-line-default/60'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <StatusBadge status={status} size="sm" />
                <span>{label}</span>
              </button>
            );
            return (
              <div key={p.id} className="flex items-center gap-2">
                <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-ink-primary/90 truncate" title={p.name}>{p.name}</div>
                <div className="flex-1 flex gap-1.5">
                  {pBtn('going', 'Going', 'bg-emerald-600')}
                  {pBtn('maybe', 'Maybe', 'bg-amber-500')}
                  {pBtn('no', "Can't", 'bg-rose-600')}
                </div>
              </div>
            );
          })}
          {/* Self row — only renders for staff (coach / team manager).
              A pure parent's own attendance doesn't help anyone plan,
              and counting them would inflate the "who's coming"
              numbers — coaches just want player + coach counts. */}
          {showSelfRow && (
            <div className="flex items-center gap-2">
              <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-ink-primary/55 truncate">
                {userName ? `Me · ${userName.split(' ')[0]}` : 'Me'}
              </div>
              <div className="flex-1 flex gap-1.5">
                {btn('going', 'Going', 'bg-emerald-600', 'text-white')}
                {btn('maybe', 'Maybe', 'bg-amber-500', 'text-white')}
                {btn('no', "Can't", 'bg-rose-600', 'text-white')}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Attendee list modal — portaled to document.body so ancestor
          stacking contexts (rings, transforms, overflows on event cards
          / lists) can't trap it inside the event card. */}
      {showList && createPortal(
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
          style={{
            zIndex: 200,
            paddingTop: 'calc(4rem + env(safe-area-inset-top))',
            paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
          }}
          onClick={() => setShowList(null)}
        >
          <div
            className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-md max-h-full overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-line-default/10 flex items-center justify-between bg-surface-elevated">
              <h3 className="font-bold text-ink-primary text-base flex items-center gap-2">
                <StatusBadge status={showList} size="md" />
                <span>
                  {(() => {
                    const label = showList === 'going' ? 'Going' : showList === 'maybe' ? 'Maybe' : "Can't make it";
                    const p = playerCounts[showList];
                    const c = staffCounts[showList];
                    const o = otherCount(showList);
                    const parts = [`${p} player${p === 1 ? '' : 's'}`, `${c} coach${c === 1 ? '' : 'es'}`];
                    if (o > 0) parts.push(`${o} other${o === 1 ? '' : 's'}`);
                    return `${label} (${parts.join(' · ')})`;
                  })()}
                </span>
              </h3>
              <button onClick={() => setShowList(null)} className="p-2 rounded-lg hover:bg-line-default/10 text-ink-primary/55" aria-label="Close">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {entries.filter(e => e.status === showList).length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-ink-primary/55">No one yet.</p>
              ) : (
                <>
                  {/* Players first — coaches read this section to know
                      who's on the field. */}
                  {entries.some(e => e.status === showList && e.isPlayer) && (
                    <>
                      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-primary/40">Squad</div>
                      <ul className="divide-y divide-gray-100">
                        {entries.filter(e => e.status === showList && e.isPlayer).map(e => {
                          const photo = e.playerId ? playerPhotoMap[e.playerId] : undefined;
                          return (
                            <li key={e.id} className="px-4 py-2.5 flex items-center gap-2">
                              {photo ? (
                                <img src={photo} alt={e.name} className="w-8 h-8 rounded-full object-cover ring-1 ring-gray-200 shrink-0"
                                  onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-primary-soft to-brand-primary flex items-center justify-center text-white text-xs font-bold shrink-0">
                                  {(e.name || '?').charAt(0).toUpperCase()}
                                </div>
                              )}
                              <span className="text-sm text-ink-primary/90 flex-1 min-w-0 break-words">{e.name || 'Player'}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                  {/* Coaches & staff. */}
                  {entries.some(e => e.status === showList && e.isStaff) && (
                    <>
                      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-primary/40">Coaches & staff</div>
                      <ul className="divide-y divide-gray-100">
                        {entries.filter(e => e.status === showList && e.isStaff).map(e => {
                          const photo = e.uid ? userPhotoMap[e.uid] : undefined;
                          return (
                            <li key={e.id} className="px-4 py-2.5 flex items-center gap-2">
                              {photo ? (
                                <img src={photo} alt={e.name} className="w-8 h-8 rounded-full object-cover ring-1 ring-gray-200 shrink-0"
                                  onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary-dim flex items-center justify-center text-white text-xs font-bold shrink-0">
                                  {(e.name || '?').charAt(0).toUpperCase()}
                                </div>
                              )}
                              <span className="text-sm text-ink-primary/90 flex-1 min-w-0 break-words">{e.name || 'Unknown'}</span>
                              {e.isGuest && (
                                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-primary-soft text-brand-primary border border-brand-primary-soft shrink-0">
                                  via link
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                  {/* Parents & guests — anyone who responded who isn't a
                      player or a coach: authenticated parents replying for
                      themselves, plus non-coach share-link responses. This
                      is the section that was missing, so a coach couldn't
                      see who declined or who RSVP'd from the link. */}
                  {entries.some(e => e.status === showList && !e.isPlayer && !e.isStaff) && (
                    <>
                      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-primary/40">Parents & guests</div>
                      <ul className="divide-y divide-gray-100">
                        {entries.filter(e => e.status === showList && !e.isPlayer && !e.isStaff).map(e => {
                          const photo = e.uid ? userPhotoMap[e.uid] : undefined;
                          return (
                            <li key={e.id} className="px-4 py-2.5 flex items-center gap-2">
                              {photo ? (
                                <img src={photo} alt={e.name} className="w-8 h-8 rounded-full object-cover ring-1 ring-gray-200 shrink-0"
                                  onError={(ev) => { (ev.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-400 to-gray-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                                  {(e.name || '?').charAt(0).toUpperCase()}
                                </div>
                              )}
                              <span className="text-sm text-ink-primary/90 flex-1 min-w-0 break-words">{e.name || 'Guest'}</span>
                              {e.isGuest && (
                                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-primary-soft text-brand-primary border border-brand-primary-soft shrink-0">
                                  via link
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      <TrialGateModal
        open={trialGateOpen}
        onClose={() => setTrialGateOpen(false)}
        action="create events"
        reason={trialReason}
      />
    </div>
  );
};

const CarpoolBar: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  userPhotoMap?: Record<string, string>;
  onAdd?: (eventId: string, post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }) => void;
  onDelete?: (eventId: string, postId: string) => void;
  isPast?: boolean;
}> = ({ event, userUid, userPhotoMap = {}, onAdd, onDelete, isPast }) => {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'offer' | 'request'>('offer');
  const [seats, setSeats] = useState('');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  if (event.type !== 'game' && event.type !== 'event') return null;
  const posts = event.carpoolPosts || [];
  const offerCount = posts.filter(p => p.type === 'offer').length;
  const requestCount = posts.filter(p => p.type === 'request').length;
  const submit = () => {
    if (!onAdd) return;
    if (!location.trim() && !note.trim()) {
      alert('Add a pickup area or a note.');
      return;
    }
    onAdd(event.id, {
      type,
      seats: seats ? Math.max(0, parseInt(seats, 10) || 0) : undefined,
      location: location.trim() || undefined,
      note: note.trim() || undefined,
    });
    setSeats(''); setLocation(''); setNote('');
  };
  return (
    <div className="mt-2 pt-2 border-t border-dashed border-line-default/20">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-xs font-medium text-ink-primary/65 hover:text-ink-primary/90"
      >
        <span className="uppercase tracking-wide">Carpool board</span>
        <span className="flex items-center gap-2 text-[11px]">
          <span className="text-emerald-700">{offerCount} offer{offerCount !== 1 ? 's' : ''}</span>
          <span className="text-amber-700">{requestCount} request{requestCount !== 1 ? 's' : ''}</span>
          <span className="text-ink-primary/40">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {posts.length === 0 && (
            <p className="text-xs text-ink-primary/40 italic">No posts yet — be the first.</p>
          )}
          {posts.map(p => {
            const photo = userPhotoMap[p.uid];
            return (
              <div
                key={p.id}
                className={`flex items-start gap-2 p-2 rounded-lg text-xs ${
                  p.type === 'offer' ? 'bg-emerald-50 border border-emerald-100' : 'bg-amber-50 border border-amber-100'
                }`}
              >
                {photo ? (
                  <img
                    src={photo}
                    alt={p.name}
                    className="w-7 h-7 rounded-full object-cover ring-1 ring-white shrink-0 mt-0.5"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-primary-soft to-brand-primary flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">
                    {(p.name || '?').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink-primary/90">
                    {p.type === 'offer' ? 'Offering ride' : 'Need ride'} — {p.name}
                  </div>
                  <div className="text-ink-primary/80 mt-0.5">
                    {p.seats ? `${p.seats} seat${p.seats !== 1 ? 's' : ''}` : ''}
                    {p.seats && p.location ? ' · ' : ''}
                    {p.location || ''}
                  </div>
                  {p.note && <div className="text-ink-primary/65 mt-0.5">{p.note}</div>}
                </div>
                {userUid === p.uid && onDelete && (
                  <button
                    onClick={() => onDelete(event.id, p.id)}
                    className="text-ink-primary/40 hover:text-red-600 text-sm leading-none"
                    title="Delete"
                  >✕</button>
                )}
              </div>
            );
          })}
          {!isPast && userUid && onAdd && (
            <div className="bg-surface-input border border-line-default rounded-lg p-2 space-y-2">
              <div className="flex gap-1">
                <button
                  onClick={() => setType('offer')}
                  className={`flex-1 px-2 py-1 rounded text-xs font-medium border ${
                    type === 'offer' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-surface-elevated text-ink-primary/80 border-line-default'
                  }`}
                >Offer</button>
                <button
                  onClick={() => setType('request')}
                  className={`flex-1 px-2 py-1 rounded text-xs font-medium border ${
                    type === 'request' ? 'bg-amber-500 text-white border-amber-500' : 'bg-surface-elevated text-ink-primary/80 border-line-default'
                  }`}
                >Request</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number" min="0"
                  placeholder={type === 'offer' ? 'Seats' : 'Riders'}
                  value={seats}
                  onChange={e => setSeats(e.target.value)}
                  className="px-2 py-1 text-xs border border-line-default rounded"
                />
                <input
                  type="text"
                  placeholder="Pickup area"
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  className="px-2 py-1 text-xs border border-line-default rounded"
                />
              </div>
              <input
                type="text"
                placeholder="Optional note (e.g. leaving at 8:30)"
                value={note}
                onChange={e => setNote(e.target.value)}
                className="w-full px-2 py-1 text-xs border border-line-default rounded"
              />
              <button
                onClick={submit}
                className="w-full px-2 py-1.5 bg-surface-tint hover:bg-surface-raised text-ink-primary text-xs font-semibold rounded"
              >Post</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Calendar;