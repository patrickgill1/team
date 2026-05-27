// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoach } from '../../utils/helpers';
import EventForm from './EventForm';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';
import { getShareOrigin } from '../../utils/origin';
import ImportScheduleModal from './ImportScheduleModal';
import EventPhotos from './EventPhotos';
import AppIcon from '../common/AppIcon';
import { collection, query as fsQuery, where as fsWhere, getDocs as fsGetDocs } from 'firebase/firestore';
import { db } from '../../utils/firebase';

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

/** Build a Maps URL that opens in the user's default map app.
 *  iOS Safari + Capacitor → Apple Maps via the maps.apple.com universal
 *  link. Everywhere else → Google Maps. Both apps accept a free-text
 *  query so we don't need to geocode upfront. */
const mapsUrlFor = (location: string): string => {
  const q = encodeURIComponent(location.trim());
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua);
  return isApple
    ? `https://maps.apple.com/?q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
};

const downloadEventIcs = (event: CalendarEvent) => {
  try {
    const start = new Date(event.date);
    const end = new Date(start.getTime() + 90 * 60 * 1000); // default 90 min
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Team App//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${event.id}@team-app`,
      `DTSTAMP:${formatIcsDate(new Date())}`,
      `DTSTART:${formatIcsDate(start)}`,
      `DTEND:${formatIcsDate(end)}`,
      `SUMMARY:${escapeIcs(event.title || event.type)}`,
      event.location ? `LOCATION:${escapeIcs(event.location)}` : '',
      event.description ? `DESCRIPTION:${escapeIcs(event.description)}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
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
  } catch (err) {
    console.error('Failed to export ICS', err);
    alert('Could not generate calendar file.');
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
  const { selectedTeamId } = useTeam();
  const { getDocuments, addDocument, updateDocument, deleteDocument } = useFirestore();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'month' | 'list'>(initialViewMode);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isEventFormOpen, setIsEventFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // In list mode, parents almost always want "what's next" (Scheduled).
  // Past is one tap away.
  const [listTab, setListTab] = useState<'scheduled' | 'past'>('scheduled');

  const isUserCoach = userData ? isCoach(userData.role) : false;

  // Every active player on this team that the current user is linked to
  // as a parent. Used to render one RSVP row per kid on every event
  // card (so a parent with two kids gets two responder rows, plus their
  // own row). Single fetch, not per-card, to avoid N+1.
  const [myLinkedPlayers, setMyLinkedPlayers] = useState<Array<{ id: string; name: string }>>([]);
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
          .filter((p: any) => p.isActive !== false)
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

  // Load events on component mount
  useEffect(() => {
    const loadEvents = async () => {
      if (!selectedTeamId) return;
      
      try {
        console.log('Loading events for team:', selectedTeamId);
        // Use the correct collection name - should match what EventForm uses
        const allEvents = await getDocuments('events', []);
        console.log('All events loaded:', allEvents);
        
        // Filter events for this team and convert dates
        const teamEvents = allEvents
          .filter((event: any) => event.teamId === selectedTeamId)
          .map((event: any) => ({
            ...event,
            date: event.date?.toDate ? event.date.toDate() : new Date(event.date),
            createdAt: event.createdAt?.toDate ? event.createdAt.toDate() : new Date(event.createdAt || Date.now())
          })) as CalendarEvent[];
        
        console.log('Team events processed:', teamEvents);
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
    console.log('Event updated:', updatedEvent);
    
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

  const handleDeleteEvent = async (eventId: string) => {
    if (!window.confirm('Are you sure you want to delete this event? This action cannot be undone.')) {
      return;
    }

    setDeletingIds(prev => new Set(prev).add(eventId));
    try {
      await deleteDocument('events', eventId);
      setEvents(prevEvents => prevEvents.filter(event => event.id !== eventId));
    } catch (error) {
      console.error('Error deleting event:', error);
      alert('Failed to delete event. Please try again.');
    } finally {
      setDeletingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(eventId);
        return newSet;
      });
    }
  };

  const handleRsvp = async (eventId: string, status: 'going' | 'maybe' | 'no') => {
    if (!userData) return;
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    const newRsvps = {
      ...(ev.rsvps || {}),
      [userData.uid]: {
        status,
        name: userData.name || userData.email || 'Unknown',
        respondedAt: new Date(),
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
    const newPlayerRsvps = {
      ...((ev as any).playerRsvps || {}),
      [playerId]: {
        status,
        playerName,
        byUid: userData.uid,
        byName: userData.name || undefined,
        respondedAt: new Date(),
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
      case 'practice': return 'bg-fire-500/10 text-fire-800 border-fire-300/50';
      case 'event': return 'bg-emerald-500/10 text-emerald-700 border-emerald-300/50';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
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
      days.push(<div key={`empty-${i}`} className="h-24 sm:h-28 bg-slate-50/60"></div>);
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
          className={`h-24 sm:h-28 border border-slate-200/70 p-1.5 cursor-pointer transition-all duration-150 ${
            isToday
              ? 'bg-gradient-to-br from-fire-50 to-white ring-1 ring-fire-300/60'
              : isPast
                ? 'bg-slate-50/40 hover:bg-slate-50'
                : 'bg-white hover:bg-fire-50/40'
          }`}
        >
          <div className={`text-xs font-semibold mb-1 inline-flex items-center justify-center ${
            isToday
              ? 'w-6 h-6 rounded-full bg-fire-600 text-white shadow-sm'
              : isPast ? 'text-slate-400' : 'text-slate-700'
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
                className={`text-[11px] px-1.5 py-0.5 rounded-md truncate border ${getEventTypeColor(event.type)} ${isUserCoach ? 'cursor-pointer hover:ring-1 hover:ring-fire-400' : ''}`}
                title={isUserCoach ? `Edit: ${event.title} — ${event.location}` : `${event.title} - ${event.location}`}
              >
                {getEventTypeIcon(event.type)} {event.title}
              </div>
            ))}
            {dayEvents.length > 2 && (
              <div className="text-[10px] text-slate-500 px-1 font-medium">
                +{dayEvents.length - 2} more
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 overflow-hidden">
        {/* Calendar Header */}
        <div className="bg-gradient-to-r from-navy-700 via-navy-600 to-fire-700 px-5 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h2>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => navigateMonth('prev')}
                className="p-2 hover:bg-white/15 active:bg-white/25 text-white rounded-lg transition-colors"
                aria-label="Previous month"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setCurrentDate(new Date())}
                className="px-3 py-1.5 text-xs font-semibold bg-white/15 hover:bg-white/25 text-white rounded-lg transition-colors backdrop-blur-sm"
              >
                Today
              </button>
              <button
                onClick={() => navigateMonth('next')}
                className="p-2 hover:bg-white/15 active:bg-white/25 text-white rounded-lg transition-colors"
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
        <div className="grid grid-cols-7 bg-slate-50 border-b border-slate-200/70">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="py-2 px-3 text-center text-[11px] font-bold uppercase tracking-wider text-slate-500">
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
          <div className="px-5 sm:px-6 py-3 bg-fire-50/60 border-t border-fire-100">
            <p className="text-xs sm:text-sm text-navy-700 font-medium">
              💡 Click any date to create a new event
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderListView = () => {
    const upcomingEvents = events
      .filter(event => new Date(event.date) >= new Date())
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const pastEvents = events
      .filter(event => new Date(event.date) < new Date())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const showing = listTab === 'scheduled' ? upcomingEvents : pastEvents;

    return (
      <div className="space-y-4">
        {/* Scheduled / Past tab strip */}
        <div className="flex items-center border-b border-gray-200 bg-white rounded-t-2xl">
          <button
            onClick={() => setListTab('scheduled')}
            className={`flex-1 py-3 text-sm font-bold transition-colors relative ${
              listTab === 'scheduled' ? 'text-emerald-700' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            Scheduled <span className="ml-1 text-gray-400 text-xs font-semibold">({upcomingEvents.length})</span>
            {listTab === 'scheduled' && <span className="absolute -bottom-px left-4 right-4 h-0.5 bg-emerald-500" />}
          </button>
          <button
            onClick={() => setListTab('past')}
            className={`flex-1 py-3 text-sm font-bold transition-colors relative ${
              listTab === 'past' ? 'text-emerald-700' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            Past <span className="ml-1 text-gray-400 text-xs font-semibold">({pastEvents.length})</span>
            {listTab === 'past' && <span className="absolute -bottom-px left-4 right-4 h-0.5 bg-emerald-500" />}
          </button>
        </div>

        {/* Event list */}
        <div className="space-y-3">
          {showing.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-10 text-center">
              <div className="text-gray-300 mb-3 flex justify-center">
                <AppIcon name="calendar" className="w-12 h-12" />
              </div>
              <p className="text-gray-600 font-medium">
                {listTab === 'scheduled' ? 'No upcoming events.' : 'No past events.'}
              </p>
              {listTab === 'scheduled' && isUserCoach && (
                <button
                  onClick={() => {
                    setEditingEvent(null);
                    setSelectedDate(null);
                    setIsEventFormOpen(true);
                  }}
                  className="mt-4 bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold py-2.5 px-5 rounded-xl shadow-sm hover:shadow transition-all"
                >
                  Create First Event
                </button>
              )}
            </div>
          ) : (
            showing.map(event => (
              <div
                key={event.id}
                id={`event-${event.id}`}
                className={focusEventId === event.id ? 'ring-2 ring-cyan-400 ring-offset-2 rounded-2xl transition' : ''}
              >
                <EventCard
                  event={event}
                  onEdit={handleEditEvent}
                  onDelete={handleDeleteEvent}
                  onRsvp={handleRsvp}
                  onPlayerRsvp={handlePlayerRsvp}
                  onAddCarpool={handleAddCarpoolPost}
                  onDeleteCarpool={handleDeleteCarpoolPost}
                  userUid={userData?.uid}
                  userName={userData?.name}
                  myLinkedPlayers={myLinkedPlayers}
                  canEdit={isUserCoach}
                  isDeleting={deletingIds.has(event.id)}
                  isPast={listTab === 'past'}
                />
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-2 border-fire-200 border-t-fire-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top action row — no page title here (the page Header already
          shows "Events"); just the desktop view toggle and coach tools.
          Calendar subscription is reached from Settings → Calendar
          Syncing, so we don't surface a confusing chevron button here. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Month/List toggle — desktop only. On phones the month grid
            is too cramped to be useful; the list is the right default
            and the only mode worth showing. */}
        <div className="hidden lg:flex bg-slate-100 rounded-xl p-1 mr-auto">
          <button
            onClick={() => setViewMode('month')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              viewMode === 'month'
                ? 'bg-white text-navy-700 shadow-sm ring-1 ring-slate-200'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Month
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              viewMode === 'list'
                ? 'bg-white text-navy-700 shadow-sm ring-1 ring-slate-200'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            List
          </button>
        </div>

        {isUserCoach && showCreateButton && (
          <>
            <button
              onClick={() => setIsImportOpen(true)}
              className="bg-white hover:bg-gray-50 ring-1 ring-gray-300 text-gray-700 font-semibold py-2 px-3.5 rounded-xl shadow-sm transition-all flex items-center gap-2 text-sm"
              title="Import a season schedule from a .ics file"
            >
              <AppIcon name="arrow-right" className="w-4 h-4 rotate-90" />
              <span className="hidden sm:inline">Import</span>
            </button>
            <button
              onClick={() => {
                setEditingEvent(null);
                setSelectedDate(null);
                setIsEventFormOpen(true);
              }}
              className="bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold py-2 px-4 rounded-xl shadow-sm hover:shadow transition-all flex items-center gap-2 text-sm"
            >
              <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
              <span>Add Event</span>
            </button>
          </>
        )}
      </div>

      {/* Calendar Content */}
      {viewMode === 'month' ? renderMonthView() : renderListView()}

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
            .filter((ev: any) => ev.teamId === selectedTeamId)
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
  myLinkedPlayers?: Array<{ id: string; name: string }>;
  canEdit: boolean;
  isDeleting: boolean;
  isPast?: boolean;
}

// Color palette per event type — used for the left stripe + bottom-icon
// background, mirroring the at-a-glance type cue from the screenshots
// (game=amber, practice=violet, neutral=cyan).
const eventColors = (type: string) => {
  switch (type) {
    case 'game':
      return { stripe: 'bg-amber-400', stripeText: 'text-amber-950', pill: 'bg-amber-100 text-amber-800' };
    case 'practice':
      return { stripe: 'bg-violet-400', stripeText: 'text-white', pill: 'bg-violet-100 text-violet-800' };
    case 'event':
      return { stripe: 'bg-emerald-400', stripeText: 'text-emerald-950', pill: 'bg-emerald-100 text-emerald-800' };
    default:
      return { stripe: 'bg-cyan-400', stripeText: 'text-white', pill: 'bg-cyan-100 text-cyan-800' };
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
  myLinkedPlayers,
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
    getWeatherForEvent(event.location || '', dt).then(w => { if (!cancelled) setWeather(w); });
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

  // Custom Fire FC iconography: soccer ball for games, cone for
  // practices, flag for "events" (anything else — tournaments, team
  // dinners, photo day). Not borrowed from Ollie.
  const typeIcon: 'soccer' | 'cone' | 'flag' = event.type === 'game' ? 'soccer' : event.type === 'practice' ? 'cone' : 'flag';

  return (
    <div className={`rounded-2xl ring-1 overflow-hidden bg-white shadow-sm transition-all ${
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
              <h4 className={`font-bold text-[15px] leading-snug break-words ${isPast ? 'text-gray-700' : 'text-gray-900'}`}>
                {event.title}
              </h4>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-full ${colors.pill}`}>
                  {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
                </span>
                {(event as any).seriesId && (
                  <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-gray-100 text-gray-700" title="Recurring">
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
                  className="p-1.5 text-gray-400 hover:text-cyan-700 hover:bg-cyan-50 rounded-lg transition disabled:opacity-50"
                  title="Edit"
                >
                  <AppIcon name="edit" className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onDelete(event.id)}
                  disabled={isDeleting}
                  className="p-1.5 text-gray-400 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition disabled:opacity-50"
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
          <div className={`mt-2 text-sm space-y-1 ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
            <div className="flex items-center gap-1.5 min-w-0">
              <AppIcon name="clock" className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {timeLabel}
                {(event as any).arriveOffsetMinutes > 0 && (() => {
                  const arrive = new Date(dt.getTime() - (event as any).arriveOffsetMinutes * 60_000);
                  const arriveLabel = arrive.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                  return <span className="ml-1 text-gray-500">(arrive {arriveLabel})</span>;
                })()}
              </span>
            </div>
            {event.location && (
              <a
                href={mapsUrlFor(event.location)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 min-w-0 hover:text-cyan-700 transition-colors"
                title="Open in Maps"
              >
                <AppIcon name="map-pin" className="w-4 h-4 shrink-0" />
                <span className="truncate underline decoration-dotted underline-offset-2">{event.location}</span>
              </a>
            )}
          </div>

          {event.description && (
            <p className={`text-sm mt-2 break-words ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
              {event.description}
            </p>
          )}

          {weather && (
            <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-cyan-50 ring-1 ring-cyan-200 text-cyan-900 text-xs font-semibold max-w-full self-start">
              <span className="text-base leading-none shrink-0">{weather.icon}</span>
              <span className="truncate">{weather.label} · {weather.tempMaxF}°/{weather.tempMinF}°F{weather.precipChance > 0 ? ` · ${weather.precipChance}% rain` : ''}</span>
            </div>
          )}

          {/* Bottom chip row */}
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            {!isPast && (
              <button
                onClick={() => downloadEventIcs(event)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
                title="Add to my phone calendar"
              >
                <AppIcon name="calendar" className="w-3.5 h-3.5" />
                <span>Add to calendar</span>
              </button>
            )}
            <button
              onClick={handleShare}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
              title="Share event link"
            >
              <AppIcon name="arrow-right" className="w-3.5 h-3.5" />
              <span>Share</span>
            </button>
            {event.type === 'game' && (
              <a
                href={`/game-day/${event.id}`}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 rounded-full shadow-sm transition-colors"
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
          myLinkedPlayers={myLinkedPlayers}
          onRsvp={onRsvp}
          onPlayerRsvp={onPlayerRsvp}
          isPast={isPast}
        />
        <CarpoolBar event={event} userUid={userUid} onAdd={onAddCarpool} onDelete={onDeleteCarpool} isPast={isPast} />
        <EventPhotos eventId={event.id} teamId={event.teamId} canModerate={canEdit} />
      </div>
    </div>
  );
};

const RsvpBar: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  userName?: string;
  myLinkedPlayers?: Array<{ id: string; name: string }>;
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
  onPlayerRsvp?: (eventId: string, playerId: string, playerName: string, status: 'going' | 'maybe' | 'no') => void;
  isPast?: boolean;
}> = ({ event, userUid, userName, myLinkedPlayers = [], onRsvp, onPlayerRsvp, isPast }) => {
  const [showList, setShowList] = useState<null | 'going' | 'maybe' | 'no'>(null);
  if (event.type !== 'game' && event.type !== 'practice' && event.type !== 'event') return null;
  const rsvps = event.rsvps || {};
  const publicRsvps = (event as any).publicRsvps || {};
  const playerRsvps = (event as any).playerRsvps || {};
  type Entry = { id: string; status: 'going' | 'maybe' | 'no'; name: string; isGuest: boolean; isCoach: boolean; isPlayer: boolean };
  const entries: Entry[] = [
    ...Object.entries(rsvps).map(([uid, v]: any) => ({ id: uid, status: v.status, name: v.name, isGuest: false, isCoach: false, isPlayer: false })),
    ...Object.entries(publicRsvps).map(([token, v]: any) => ({ id: `g_${token}`, status: v.status, name: v.name, isGuest: true, isCoach: !!v.isCoach, isPlayer: false })),
    ...Object.entries(playerRsvps).map(([pid, v]: any) => ({ id: `p_${pid}`, status: v.status, name: v.playerName || 'Player', isGuest: false, isCoach: false, isPlayer: true })),
  ];
  // Coaches want player attendance counts — those drive lineups. Adult
  // RSVPs (the parent's own row) are still recorded but live in a
  // separate strip below the player rows.
  const playerCounts = {
    going: Object.values(playerRsvps).filter((v: any) => v.status === 'going').length,
    maybe: Object.values(playerRsvps).filter((v: any) => v.status === 'maybe').length,
    no: Object.values(playerRsvps).filter((v: any) => v.status === 'no').length,
  };
  const adultCounts = {
    going: Object.values(rsvps).filter((v: any) => v.status === 'going').length
      + Object.values(publicRsvps).filter((v: any) => v.status === 'going').length,
    maybe: Object.values(rsvps).filter((v: any) => v.status === 'maybe').length
      + Object.values(publicRsvps).filter((v: any) => v.status === 'maybe').length,
    no: Object.values(rsvps).filter((v: any) => v.status === 'no').length
      + Object.values(publicRsvps).filter((v: any) => v.status === 'no').length,
  };
  // Combined counts surfaced at the top of the strip — total "people
  // saying yes" across all responder types.
  const counts = {
    going: playerCounts.going + adultCounts.going,
    maybe: playerCounts.maybe + adultCounts.maybe,
    no: playerCounts.no + adultCounts.no,
  };
  const my = userUid ? rsvps[userUid]?.status : undefined;
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
          : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <StatusBadge status={status} size="sm" />
      <span>{label}</span>
    </button>
  );
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {isPast ? 'Final RSVPs' : 'Will you be there?'}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setShowList('going')} className="inline-flex items-center gap-1 text-emerald-700 font-semibold hover:underline">
            <StatusBadge status="going" />
            <span>{counts.going}</span>
          </button>
          <button onClick={() => setShowList('maybe')} className="inline-flex items-center gap-1 text-amber-700 font-semibold hover:underline">
            <StatusBadge status="maybe" />
            <span>{counts.maybe}</span>
          </button>
          <button onClick={() => setShowList('no')} className="inline-flex items-center gap-1 text-rose-700 font-semibold hover:underline">
            <StatusBadge status="no" />
            <span>{counts.no}</span>
          </button>
        </div>
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
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <StatusBadge status={status} size="sm" />
                <span>{label}</span>
              </button>
            );
            return (
              <div key={p.id} className="flex items-center gap-2">
                <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-gray-800 truncate" title={p.name}>{p.name}</div>
                <div className="flex-1 flex gap-1.5">
                  {pBtn('going', 'Going', 'bg-emerald-600')}
                  {pBtn('maybe', 'Maybe', 'bg-amber-500')}
                  {pBtn('no', "Can't", 'bg-rose-600')}
                </div>
              </div>
            );
          })}
          {/* Self row — the parent's / coach's own attendance. Distinct
              from the player row because adults aren't on the field
              lineup, but the coach still needs to know who's coming. */}
          <div className="flex items-center gap-2">
            <div className="w-20 sm:w-28 shrink-0 text-xs font-semibold text-gray-500 truncate">
              {userName ? `Me · ${userName.split(' ')[0]}` : 'Me'}
            </div>
            <div className="flex-1 flex gap-1.5">
              {btn('going', 'Going', 'bg-emerald-600', 'text-white')}
              {btn('maybe', 'Maybe', 'bg-amber-500', 'text-white')}
              {btn('no', "Can't", 'bg-rose-600', 'text-white')}
            </div>
          </div>
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
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-full overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-gray-50 to-white">
              <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
                <StatusBadge status={showList} size="md" />
                <span>
                  {showList === 'going' && `Going (${counts.going})`}
                  {showList === 'maybe' && `Maybe (${counts.maybe})`}
                  {showList === 'no' && `Can't make it (${counts.no})`}
                </span>
              </h3>
              <button onClick={() => setShowList(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {entries.filter(e => e.status === showList).length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-500">No one yet.</p>
              ) : (
                <>
                  {/* Players first — coaches read this section to know
                      who's on the field. Adults follow as supplementary. */}
                  {entries.some(e => e.status === showList && e.isPlayer) && (
                    <>
                      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Players</div>
                      <ul className="divide-y divide-gray-100">
                        {entries.filter(e => e.status === showList && e.isPlayer).map(e => (
                          <li key={e.id} className="px-4 py-2.5 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {(e.name || '?').charAt(0).toUpperCase()}
                            </div>
                            <span className="text-sm text-gray-800 flex-1 min-w-0 break-words">{e.name || 'Player'}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {entries.some(e => e.status === showList && !e.isPlayer) && (
                    <>
                      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Adults</div>
                      <ul className="divide-y divide-gray-100">
                        {entries.filter(e => e.status === showList && !e.isPlayer).map(e => (
                          <li key={e.id} className="px-4 py-2.5 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-400 to-gray-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {(e.name || '?').charAt(0).toUpperCase()}
                            </div>
                            <span className="text-sm text-gray-800 flex-1 min-w-0 break-words">{e.name || 'Unknown'}</span>
                            {e.isCoach && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 shrink-0">
                                coach
                              </span>
                            )}
                            {e.isGuest && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200 shrink-0">
                                via link
                              </span>
                            )}
                          </li>
                        ))}
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
    </div>
  );
};

const CarpoolBar: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  onAdd?: (eventId: string, post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }) => void;
  onDelete?: (eventId: string, postId: string) => void;
  isPast?: boolean;
}> = ({ event, userUid, onAdd, onDelete, isPast }) => {
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
    <div className="mt-2 pt-2 border-t border-dashed border-gray-100">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-xs font-medium text-gray-600 hover:text-gray-800"
      >
        <span className="uppercase tracking-wide">🚗 Carpool board</span>
        <span className="flex items-center gap-2 text-[11px]">
          <span className="text-emerald-700">{offerCount} offer{offerCount !== 1 ? 's' : ''}</span>
          <span className="text-amber-700">{requestCount} request{requestCount !== 1 ? 's' : ''}</span>
          <span className="text-gray-400">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {posts.length === 0 && (
            <p className="text-xs text-gray-400 italic">No posts yet — be the first.</p>
          )}
          {posts.map(p => (
            <div
              key={p.id}
              className={`flex items-start justify-between gap-2 p-2 rounded-lg text-xs ${
                p.type === 'offer' ? 'bg-emerald-50 border border-emerald-100' : 'bg-amber-50 border border-amber-100'
              }`}
            >
              <div className="flex-1">
                <div className="font-semibold text-gray-800">
                  {p.type === 'offer' ? '🚙 Offering ride' : '🙋 Need ride'} — {p.name}
                </div>
                <div className="text-gray-700 mt-0.5">
                  {p.seats ? `${p.seats} seat${p.seats !== 1 ? 's' : ''}` : ''}
                  {p.seats && p.location ? ' · ' : ''}
                  {p.location || ''}
                </div>
                {p.note && <div className="text-gray-600 mt-0.5">{p.note}</div>}
              </div>
              {userUid === p.uid && onDelete && (
                <button
                  onClick={() => onDelete(event.id, p.id)}
                  className="text-gray-400 hover:text-red-600 text-sm leading-none"
                  title="Delete"
                >✕</button>
              )}
            </div>
          ))}
          {!isPast && userUid && onAdd && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-2">
              <div className="flex gap-1">
                <button
                  onClick={() => setType('offer')}
                  className={`flex-1 px-2 py-1 rounded text-xs font-medium border ${
                    type === 'offer' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-700 border-gray-200'
                  }`}
                >🚙 Offer</button>
                <button
                  onClick={() => setType('request')}
                  className={`flex-1 px-2 py-1 rounded text-xs font-medium border ${
                    type === 'request' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-gray-700 border-gray-200'
                  }`}
                >🙋 Request</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number" min="0"
                  placeholder={type === 'offer' ? 'Seats' : 'Riders'}
                  value={seats}
                  onChange={e => setSeats(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded"
                />
                <input
                  type="text"
                  placeholder="Pickup area"
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded"
                />
              </div>
              <input
                type="text"
                placeholder="Optional note (e.g. leaving at 8:30)"
                value={note}
                onChange={e => setNote(e.target.value)}
                className="w-full px-2 py-1 text-xs border border-gray-200 rounded"
              />
              <button
                onClick={submit}
                className="w-full px-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded"
              >Post</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Calendar;