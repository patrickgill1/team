// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { formatDateTime, isCoach } from '../../utils/helpers';
import EventForm from './EventForm';

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
      case 'game': return 'bg-red-100 text-red-800 border-red-200';
      case 'practice': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'event': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
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
      days.push(<div key={`empty-${i}`} className="h-24 bg-gray-50"></div>);
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
          className={`h-24 border border-gray-200 p-1 cursor-pointer transition-colors duration-200 ${
            isToday 
              ? 'bg-blue-50 border-blue-200' 
              : isPast 
                ? 'bg-gray-50 hover:bg-gray-100' 
                : 'hover:bg-gray-50'
          } ${isUserCoach ? 'hover:bg-blue-50' : ''}`}
        >
          <div className={`text-sm font-medium mb-1 ${
            isToday ? 'text-blue-600' : isPast ? 'text-gray-400' : 'text-gray-900'
          }`}>
            {day}
          </div>
          <div className="space-y-1 overflow-hidden">
            {dayEvents.slice(0, 2).map(event => (
              <div
                key={event.id}
                className={`text-xs px-1 py-0.5 rounded truncate ${getEventTypeColor(event.type)}`}
                title={`${event.title} - ${event.location}`}
              >
                {getEventTypeIcon(event.type)} {event.title}
              </div>
            ))}
            {dayEvents.length > 2 && (
              <div className="text-xs text-gray-500 px-1">
                +{dayEvents.length - 2} more
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        {/* Calendar Header */}
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h2>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => navigateMonth('prev')}
                className="p-2 hover:bg-gray-200 rounded-lg transition-colors duration-200"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setCurrentDate(new Date())}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-200"
              >
                Today
              </button>
              <button
                onClick={() => navigateMonth('next')}
                className="p-2 hover:bg-gray-200 rounded-lg transition-colors duration-200"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Days of Week Header */}
        <div className="grid grid-cols-7 bg-gray-100">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="py-2 px-3 text-center text-sm font-medium text-gray-700">
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
          <div className="px-6 py-3 bg-blue-50 border-t border-blue-200">
            <p className="text-sm text-blue-700">
              💡 Click on any date to create a new event
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
        <div className="bg-white rounded-lg shadow-md">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Upcoming Events</h3>
          </div>
          <div className="p-6">
            {upcomingEvents.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-gray-400 mb-2">
                  <svg className="mx-auto h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-gray-600">No upcoming events scheduled</p>
                {isUserCoach && (
                  <button
                    onClick={() => {
                      setEditingEvent(null);
                      setSelectedDate(null);
                      setIsEventFormOpen(true);
                    }}
                    className="mt-4 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
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
                    userUid={userData?.uid}
                    canEdit={isUserCoach && event.createdBy === userData?.uid}
                    isDeleting={deletingIds.has(event.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Past Events */}
        {pastEvents.length > 0 && (
          <div className="bg-white rounded-lg shadow-md">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Past Events</h3>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                {pastEvents.slice(0, 5).map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onEdit={handleEditEvent}
                    onDelete={handleDeleteEvent}
                    onRsvp={handleRsvp}
                    userUid={userData?.uid}
                    canEdit={isUserCoach && event.createdBy === userData?.uid}
                    isDeleting={deletingIds.has(event.id)}
                    isPast={true}
                  />
                ))}
                {pastEvents.length > 5 && (
                  <p className="text-sm text-gray-500 text-center pt-4 border-t">
                    ... and {pastEvents.length - 5} more past events
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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center space-x-4">
          <h2 className="text-lg font-semibold text-gray-900">Team Calendar</h2>
          
          {/* View Mode Toggle */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('month')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                viewMode === 'month'
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Month
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors duration-200 ${
                viewMode === 'list'
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
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
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 flex items-center space-x-2"
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
  userUid,
  canEdit,
  isDeleting,
  isPast = false
}) => {
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
      game: 'bg-red-100 text-red-800 border-red-200',
      practice: 'bg-blue-100 text-blue-800 border-blue-200',
      event: 'bg-green-100 text-green-800 border-green-200'
    };
    return colors[type as keyof typeof colors] || 'bg-gray-100 text-gray-800 border-gray-200';
  };

  return (
    <div className={`border rounded-lg p-4 transition-all duration-200 ${
      isPast ? 'border-gray-200 bg-gray-50' : 'border-gray-200 hover:border-gray-300'
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start space-x-3 flex-1">
          <div className="text-2xl">{getEventTypeIcon(event.type)}</div>
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-1">
              <h4 className={`font-semibold ${isPast ? 'text-gray-600' : 'text-gray-900'}`}>
                {event.title}
              </h4>
              <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getEventTypeColor(event.type)} ${
                isPast ? 'opacity-60' : ''
              }`}>
                {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
              </span>
            </div>
            <div className={`text-sm space-y-1 ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
              <div className="flex items-center space-x-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>{formatDateTime(event.date)}</span>
              </div>
              <div className="flex items-center space-x-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>{event.location}</span>
              </div>
              {event.createdByName && (
                <div className="flex items-center space-x-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span>Created by {event.createdByName}</span>
                </div>
              )}
            </div>
            {event.description && (
              <p className={`text-sm mt-2 ${isPast ? 'text-gray-500' : 'text-gray-600'}`}>
                {event.description}
              </p>
            )}
          </div>
        </div>

        {/* Action buttons */}
        {canEdit && !isPast && (
          <div className="flex items-center space-x-2 ml-4">
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
  const entries = Object.entries(rsvps);
  const counts = {
    going: entries.filter(([, v]: any) => v.status === 'going').length,
    maybe: entries.filter(([, v]: any) => v.status === 'maybe').length,
    no: entries.filter(([, v]: any) => v.status === 'no').length,
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
              {entries.filter(([, v]: any) => v.status === showList).length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-500">No one yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {entries
                    .filter(([, v]: any) => v.status === showList)
                    .map(([uid, v]: any) => (
                      <li key={uid} className="px-4 py-2.5 flex items-center space-x-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                          {(v.name || '?').charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm text-gray-800">{v.name || 'Unknown'}</span>
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

export default Calendar;