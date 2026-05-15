// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoach } from '../../utils/helpers';
import EventForm from './EventForm';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';

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
}

const Calendar: React.FC<CalendarProps> = ({ 
  viewMode: initialViewMode = 'month',
  showCreateButton = true 
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
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const isUserCoach = userData ? isCoach(userData.role) : false;

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

    return (
      <div className="space-y-6">
        {/* Upcoming Events */}
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200/70 flex items-center gap-2">
            <span className="w-1.5 h-5 bg-fire-500 rounded-full"></span>
            <h3 className="text-base font-bold text-navy-900 tracking-tight">Upcoming</h3>
            <span className="ml-auto text-xs font-semibold text-slate-500">{upcomingEvents.length}</span>
          </div>
          <div className="p-5 sm:p-6">
            {upcomingEvents.length === 0 ? (
              <div className="text-center py-10">
                <div className="text-slate-300 mb-3">
                  <svg className="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-slate-600 font-medium">No upcoming events scheduled</p>
                {isUserCoach && (
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
              <div className="space-y-4">
                {upcomingEvents.map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onEdit={handleEditEvent}
                    onDelete={handleDeleteEvent}
                    onRsvp={handleRsvp}
                    onAddCarpool={handleAddCarpoolPost}
                    onDeleteCarpool={handleDeleteCarpoolPost}
                    userUid={userData?.uid}
                    canEdit={isUserCoach}
                    isDeleting={deletingIds.has(event.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Past Events */}
        {pastEvents.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70">
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200/70 flex items-center gap-2">
              <span className="w-1.5 h-5 bg-slate-300 rounded-full"></span>
              <h3 className="text-base font-bold text-slate-700 tracking-tight">Past Events</h3>
              <span className="ml-auto text-xs font-semibold text-slate-400">{pastEvents.length}</span>
            </div>
            <div className="p-5 sm:p-6">
              <div className="space-y-4">
                {pastEvents.slice(0, 5).map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onEdit={handleEditEvent}
                    onDelete={handleDeleteEvent}
                    onRsvp={handleRsvp}
                    onAddCarpool={handleAddCarpoolPost}
                    onDeleteCarpool={handleDeleteCarpoolPost}
                    userUid={userData?.uid}
                    canEdit={isUserCoach}
                    isDeleting={deletingIds.has(event.id)}
                    isPast={true}
                  />
                ))}
                {pastEvents.length > 5 && (
                  <p className="text-sm text-slate-400 text-center pt-4 border-t border-slate-200/60">
                    … and {pastEvents.length - 5} more past events
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
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
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-navy-900 tracking-tight">Team Calendar</h2>

          {/* View Mode Toggle */}
          <div className="flex bg-slate-100 rounded-xl p-1">
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
        </div>

        {/* Create Event Button (Coach only) */}
        {isUserCoach && showCreateButton && (
          <button
            onClick={() => {
              setEditingEvent(null);
              setSelectedDate(null);
              setIsEventFormOpen(true);
            }}
            className="bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold py-2.5 px-5 rounded-xl shadow-sm hover:shadow transition-all flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Add Event</span>
          </button>
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
    </div>
  );
};

// Event Card Component for List View
interface EventCardProps {
  event: CalendarEvent;
  onEdit: (event: CalendarEvent) => void;
  onDelete: (eventId: string) => void;
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
  onAddCarpool?: (eventId: string, post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }) => void;
  onDeleteCarpool?: (eventId: string, postId: string) => void;
  userUid?: string;
  canEdit: boolean;
  isDeleting: boolean;
  isPast?: boolean;
}

const EventCard: React.FC<EventCardProps> = ({
  event,
  onEdit,
  onDelete,
  onRsvp,
  onAddCarpool,
  onDeleteCarpool,
  userUid,
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
  const getEventTypeIcon = (type: string) => {
    switch (type) {
      case 'game': return '⚽';
      case 'practice': return '🏃';
      case 'event': return '📅';
      default: return '📅';
    }
  };

  const getEventTypeColor = (type: string) => {
    const colors = {
      game: 'bg-rose-500/10 text-rose-700 border-rose-300/50',
      practice: 'bg-fire-500/10 text-fire-800 border-fire-300/50',
      event: 'bg-emerald-500/10 text-emerald-700 border-emerald-300/50'
    };
    return colors[type as keyof typeof colors] || 'bg-slate-100 text-slate-700 border-slate-200';
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/event/${event.id}`;
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

  return (
    <div className={`rounded-2xl p-4 sm:p-5 transition-all ring-1 overflow-hidden ${
      isPast
        ? 'ring-slate-200 bg-slate-50/60'
        : 'ring-slate-200/70 bg-white hover:ring-fire-300/60 hover:shadow-md hover:-translate-y-0.5'
    }`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl shrink-0 leading-none mt-0.5">{getEventTypeIcon(event.type)}</div>
        <div className="flex-1 min-w-0">
          {/* Title + type chip — wraps cleanly on narrow screens */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            <h4 className={`font-semibold break-words ${isPast ? 'text-gray-600' : 'text-gray-900'}`}>
              {event.title}
            </h4>
            <span className={`px-2 py-0.5 text-[11px] font-medium rounded-full border ${getEventTypeColor(event.type)} ${
              isPast ? 'opacity-60' : ''
            }`}>
              {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
            </span>
            {(event as any).seriesId && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-violet-700 text-[11px] font-semibold" title="Part of a recurring series">
                🔁 {(event as any).recurrence || 'recurring'}
              </span>
            )}
          </div>

          {/* Meta rows */}
          <div className={`text-sm space-y-1 ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
            <div className="flex items-start gap-1.5">
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="break-words min-w-0">{formatDateTime(event.date)}</span>
            </div>
            {event.location && (
              <div className="flex items-start gap-1.5">
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="break-words min-w-0">{event.location}</span>
              </div>
            )}
            {event.createdByName && (
              <div className="flex items-start gap-1.5">
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <span className="break-words min-w-0">Created by {event.createdByName}</span>
              </div>
            )}
          </div>

          {event.description && (
            <p className={`text-sm mt-2 break-words ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
              {event.description}
            </p>
          )}

          {weather && (
            <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-fire-50 border border-fire-200 text-navy-700 text-xs font-semibold max-w-full">
              <span className="text-base leading-none shrink-0">{weather.icon}</span>
              <span className="truncate">{weather.label} · {weather.tempMaxF}°/{weather.tempMinF}°F{weather.precipChance > 0 ? ` · ${weather.precipChance}% rain` : ''}</span>
            </div>
          )}

          {/* Action chip row — wraps so nothing escapes the card */}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {!isPast && (
              <button
                onClick={() => downloadEventIcs(event)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-navy-700 bg-fire-50 hover:bg-fire-100 rounded-lg border border-fire-200 transition-colors"
                title="Download .ics calendar file"
              >
                📅 Add to my calendar
              </button>
            )}
            <button
              onClick={handleShare}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-navy-700 bg-cyan-50 hover:bg-cyan-100 rounded-lg border border-cyan-200 transition-colors"
              title="Share event link with RSVP"
            >
              🔗 Share & RSVP
            </button>
            {event.type === 'game' && (
              <a
                href={`/game-day/${event.id}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold text-white bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 rounded-md shadow-sm transition-colors"
                title="Open Game Day live tracker"
              >
                🎯 Game Day {isPast ? 'recap' : 'live'}
              </a>
            )}
          </div>
        </div>

        {/* Edit/Delete (coach only) */}
        {canEdit && !isPast && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onEdit(event)}
              disabled={isDeleting}
              className="p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors duration-200 disabled:opacity-50"
              title="Edit Event"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              onClick={() => onDelete(event.id)}
              disabled={isDeleting}
              className="p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 disabled:opacity-50"
              title="Delete Event"
            >
              {isDeleting ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600"></div>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
      <RsvpBar event={event} userUid={userUid} onRsvp={onRsvp} isPast={isPast} />
      <CarpoolBar event={event} userUid={userUid} onAdd={onAddCarpool} onDelete={onDeleteCarpool} isPast={isPast} />
    </div>
  );
};

const RsvpBar: React.FC<{
  event: CalendarEvent;
  userUid?: string;
  onRsvp?: (eventId: string, status: 'going' | 'maybe' | 'no') => void;
  isPast?: boolean;
}> = ({ event, userUid, onRsvp, isPast }) => {
  const [showList, setShowList] = useState<null | 'going' | 'maybe' | 'no'>(null);
  if (event.type !== 'game' && event.type !== 'practice' && event.type !== 'event') return null;
  const rsvps = event.rsvps || {};
  const publicRsvps = (event as any).publicRsvps || {};
  type Entry = { id: string; status: 'going' | 'maybe' | 'no'; name: string; isGuest: boolean };
  const entries: Entry[] = [
    ...Object.entries(rsvps).map(([uid, v]: any) => ({ id: uid, status: v.status, name: v.name, isGuest: false })),
    ...Object.entries(publicRsvps).map(([token, v]: any) => ({ id: `g_${token}`, status: v.status, name: v.name, isGuest: true })),
  ];
  const counts = {
    going: entries.filter(e => e.status === 'going').length,
    maybe: entries.filter(e => e.status === 'maybe').length,
    no: entries.filter(e => e.status === 'no').length,
  };
  const my = userUid ? rsvps[userUid]?.status : undefined;
  const btn = (status: 'going' | 'maybe' | 'no', label: string, icon: string, color: string) => (
    <button
      key={status}
      onClick={() => onRsvp && onRsvp(event.id, status)}
      disabled={!userUid || isPast}
      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium border transition-all ${
        my === status
          ? `${color} text-white border-transparent shadow-sm`
          : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      {icon} {label}
    </button>
  );
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {isPast ? 'Final RSVPs' : 'Will you be there?'}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setShowList('going')} className="text-green-700 font-semibold hover:underline">
            ✅ {counts.going}
          </button>
          <button onClick={() => setShowList('maybe')} className="text-amber-700 font-semibold hover:underline">
            🤔 {counts.maybe}
          </button>
          <button onClick={() => setShowList('no')} className="text-rose-700 font-semibold hover:underline">
            ❌ {counts.no}
          </button>
        </div>
      </div>
      {!isPast && (
        <div className="flex gap-2">
          {btn('going', 'Going', '✅', 'bg-green-600')}
          {btn('maybe', 'Maybe', '🤔', 'bg-amber-500')}
          {btn('no', "Can't", '❌', 'bg-rose-600')}
        </div>
      )}
      {showList && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setShowList(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-sm w-full max-h-[70vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">
                {showList === 'going' && `✅ Going (${counts.going})`}
                {showList === 'maybe' && `🤔 Maybe (${counts.maybe})`}
                {showList === 'no' && `❌ Can't make it (${counts.no})`}
              </h3>
              <button onClick={() => setShowList(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {entries.filter(e => e.status === showList).length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-500">No one yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {entries
                    .filter(e => e.status === showList)
                    .map(e => (
                      <li key={e.id} className="px-4 py-2.5 flex items-center space-x-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                          {(e.name || '?').charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm text-gray-800 flex-1">{e.name || 'Unknown'}</span>
                        {e.isGuest && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200" title="Responded via shared link">
                            via link
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        </div>
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