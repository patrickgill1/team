import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { formatDateTime } from '../utils/helpers';

interface CalendarEvent {
  id: string;
  title: string;
  date: Date;
  type: 'practice' | 'game' | 'event';
  location: string;
  teamId: string;
  createdBy: string;
  createdByName: string;
}

interface VolunteerOpportunity {
  id: string;
  title: string;
  description: string;
  date: Date;
  location: string;
  type: 'snacks' | 'setup' | 'cleanup' | 'transportation' | 'equipment' | 'other';
  slotsNeeded: number;
  slotsBooked: VolunteerSlot[];
  calendarEventId: string; // Link to calendar event
  teamId: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
}

interface VolunteerSlot {
  volunteerId: string;
  volunteerName: string;
  signedUpAt: Date;
  notes?: string;
}

const VolunteerScheduler: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addDocument, updateDocument } = useFirestore();
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [opportunities, setOpportunities] = useState<VolunteerOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [newOpportunity, setNewOpportunity] = useState({
    type: 'snacks' as const,
    slotsNeeded: 1,
    description: '',
    timeOffset: 0 // minutes offset from event time
  });

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Load events and volunteer opportunities in parallel
      const [eventsData, oppsData] = await Promise.all([
        getDocuments('events', []),
        getDocuments('volunteer_opportunities', [])
      ]);

      const teamEvents = eventsData
        .filter((e: any) => e.teamId === selectedTeamId)
        .map((e: any) => ({
          ...e,
          date: e.date?.toDate ? e.date.toDate() : new Date(e.date || Date.now())
        }))
        .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
      
      setCalendarEvents(teamEvents);

      const teamOpps = oppsData
        .filter((doc: any) => doc.teamId === selectedTeamId)
        .map((doc: any) => ({
          ...doc,
          date: doc.date?.toDate ? doc.date.toDate() : new Date(doc.date),
          createdAt: doc.createdAt?.toDate ? doc.createdAt.toDate() : new Date(doc.createdAt),
          slotsBooked: doc.slotsBooked || []
        }))
        .sort((a: any, b: any) => a.date.getTime() - b.date.getTime());

      setOpportunities(teamOpps);
    } catch (error) {
      console.error('Error loading volunteer data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateOpportunity = async () => {
    if (!userData || !selectedEvent) return;

    const selectedCalendarEvent = calendarEvents.find(e => e.id === selectedEvent);
    if (!selectedCalendarEvent) return;

    try {
      // Calculate the volunteer opportunity time based on offset
      const opportunityDate = new Date(selectedCalendarEvent.date.getTime() + newOpportunity.timeOffset * 60 * 1000);
      
      // Auto-generate title and description based on type
      const typeInfo = getTypeInfo(newOpportunity.type);
      const title = `${typeInfo.title} - ${selectedCalendarEvent.title}`;
      const description = newOpportunity.description || typeInfo.defaultDescription;
      
      const opportunity: Omit<VolunteerOpportunity, 'id'> = {
        title,
        description,
        date: opportunityDate,
        location: selectedCalendarEvent.location,
        type: newOpportunity.type,
        slotsNeeded: newOpportunity.slotsNeeded,
        slotsBooked: [],
        calendarEventId: selectedEvent,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        createdAt: new Date()
      };

      await addDocument('volunteer_opportunities', opportunity);
      setShowCreateModal(false);
      setNewOpportunity({
        type: 'snacks',
        slotsNeeded: 1,
        description: '',
        timeOffset: 0
      });
      setSelectedEvent('');
      loadData();
    } catch (error) {
      console.error('Error creating volunteer opportunity:', error);
    }
  };

  const getTypeInfo = (type: string) => {
    const typeMap = {
      snacks: {
        title: 'Snacks & Drinks',
        defaultDescription: 'Provide snacks and drinks for the team',
        icon: '🍎',
        defaultSlots: 2,
        defaultOffset: 0
      },
      setup: {
        title: 'Setup Help',
        defaultDescription: 'Help set up equipment and field preparation',
        icon: '⚙️',
        defaultSlots: 3,
        defaultOffset: -30
      },
      cleanup: {
        title: 'Cleanup',
        defaultDescription: 'Help clean up after the event',
        icon: '🧹',
        defaultSlots: 2,
        defaultOffset: 120
      },
      transportation: {
        title: 'Transportation',
        defaultDescription: 'Help with player transportation',
        icon: '🚗',
        defaultSlots: 2,
        defaultOffset: -15
      },
      equipment: {
        title: 'Equipment',
        defaultDescription: 'Help manage and transport equipment',
        icon: '⚽',
        defaultSlots: 2,
        defaultOffset: -30
      },
      other: {
        title: 'Other Help',
        defaultDescription: 'General volunteer help needed',
        icon: '👥',
        defaultSlots: 1,
        defaultOffset: 0
      }
    };
    return typeMap[type as keyof typeof typeMap] || typeMap.other;
  };

  const handleSignUp = async (opportunityId: string, notes: string = '') => {
    if (!userData) return;

    try {
      const opportunity = opportunities.find(o => o.id === opportunityId);
      if (!opportunity) return;

      const newSlot: VolunteerSlot = {
        volunteerId: userData.uid,
        volunteerName: userData.name,
        signedUpAt: new Date(),
        notes
      };

      const updatedSlots = [...opportunity.slotsBooked, newSlot];
      
      await updateDocument('volunteer_opportunities', opportunityId, {
        slotsBooked: updatedSlots
      });

      loadData();
    } catch (error) {
      console.error('Error signing up for volunteer opportunity:', error);
    }
  };

  const handleWithdraw = async (opportunityId: string) => {
    if (!userData) return;

    try {
      const opportunity = opportunities.find(o => o.id === opportunityId);
      if (!opportunity) return;

      const updatedSlots = opportunity.slotsBooked.filter(
        slot => slot.volunteerId !== userData.uid
      );
      
      await updateDocument('volunteer_opportunities', opportunityId, {
        slotsBooked: updatedSlots
      });

      loadData();
    } catch (error) {
      console.error('Error withdrawing from volunteer opportunity:', error);
    }
  };

  const getTypeIcon = (type: string) => {
    return getTypeInfo(type).icon;
  };

  const getTypeColor = (type: string) => {
    const colors = {
      snacks: 'bg-orange-100 text-orange-800',
      setup: 'bg-blue-100 text-blue-800',
      cleanup: 'bg-green-100 text-green-800',
      transportation: 'bg-purple-100 text-purple-800',
      equipment: 'bg-red-100 text-red-800',
      other: 'bg-gray-100 text-gray-800'
    };
    return colors[type as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const isUserSignedUp = (opportunity: VolunteerOpportunity) => {
    return opportunity.slotsBooked.some(slot => slot.volunteerId === userData?.uid);
  };

  const getEventOpportunities = (eventId: string) => {
    return opportunities.filter(opp => opp.calendarEventId === eventId);
  };

  const upcomingEvents = calendarEvents.filter(event => new Date(event.date) >= new Date());
  const filteredOpportunities = opportunities.filter(opp => 
    filterType === 'all' || opp.type === filterType
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Volunteer Scheduler</h1>
              <p className="text-gray-600 mt-1">Help make team events successful by volunteering</p>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              disabled={upcomingEvents.length === 0}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200 flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              <span>Add Volunteer Need</span>
            </button>
          </div>
          
          {upcomingEvents.length === 0 && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-center space-x-2">
                <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <div>
                  <p className="text-yellow-800 font-medium">No upcoming events found</p>
                  <p className="text-yellow-700 text-sm">
                    Create events in the calendar first, then add volunteer opportunities here.
                  </p>
                </div>
              </div>
              <a 
                href="/calendar"
                className="mt-2 inline-block bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded text-sm font-medium transition-colors"
              >
                📅 Go to Calendar
              </a>
            </div>
          )}
        </div>

        {/* Calendar Events with Volunteer Needs */}
        {upcomingEvents.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">📅 Upcoming Events</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {upcomingEvents.map(event => {
                const eventOpps = getEventOpportunities(event.id);
                const totalSlots = eventOpps.reduce((sum, opp) => sum + opp.slotsNeeded, 0);
                const filledSlots = eventOpps.reduce((sum, opp) => sum + opp.slotsBooked.length, 0);
                
                return (
                  <div key={event.id} className="bg-white rounded-lg border border-gray-200 p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-gray-900">{event.title}</h3>
                        <p className="text-sm text-gray-600">{formatDateTime(event.date)}</p>
                        <p className="text-sm text-gray-500">{event.location}</p>
                      </div>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        event.type === 'game' ? 'bg-red-100 text-red-800' :
                        event.type === 'practice' ? 'bg-blue-100 text-blue-800' :
                        'bg-green-100 text-green-800'
                      }`}>
                        {event.type}
                      </span>
                    </div>
                    
                    {eventOpps.length > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-600">Volunteer needs:</span>
                          <span className={`font-medium ${
                            filledSlots >= totalSlots ? 'text-green-600' : 'text-orange-600'
                          }`}>
                            {filledSlots}/{totalSlots} filled
                          </span>
                        </div>
                        {eventOpps.map(opp => (
                          <div key={opp.id} className="text-xs text-gray-600 flex items-center justify-between">
                            <span>{getTypeIcon(opp.type)} {opp.title}</span>
                            <span>{opp.slotsBooked.length}/{opp.slotsNeeded}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">No volunteer needs yet</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-6">
          <div className="flex flex-wrap gap-2">
            {['all', 'snacks', 'setup', 'cleanup', 'transportation', 'equipment', 'other'].map(type => (
              <button
                key={type}
                onClick={() => setFilterType(type)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors duration-200 ${
                  filterType === type
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {type === 'all' ? '🔍 All' : `${getTypeIcon(type)} ${type.charAt(0).toUpperCase() + type.slice(1)}`}
              </button>
            ))}
          </div>
        </div>

        {/* Volunteer Opportunities */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredOpportunities.map((opportunity) => {
            const isSignedUp = isUserSignedUp(opportunity);
            const slotsRemaining = opportunity.slotsNeeded - opportunity.slotsBooked.length;
            const isFull = slotsRemaining <= 0;
            const linkedEvent = calendarEvents.find(e => e.id === opportunity.calendarEventId);

            return (
              <div key={opportunity.id} className="bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
                {/* Header */}
                <div className="p-4 border-b border-gray-200">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-2">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${getTypeColor(opportunity.type)}`}>
                          {getTypeIcon(opportunity.type)} {opportunity.type.charAt(0).toUpperCase() + opportunity.type.slice(1)}
                        </span>
                        {isSignedUp && (
                          <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs font-medium">
                            ✓ You're helping!
                          </span>
                        )}
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900">{opportunity.title}</h3>
                      {opportunity.description && (
                        <p className="text-sm text-gray-600 mt-1">{opportunity.description}</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Details */}
                <div className="p-4 space-y-3">
                  <div className="flex items-center space-x-2 text-sm text-gray-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span>{formatDateTime(opportunity.date)}</span>
                  </div>

                  <div className="flex items-center space-x-2 text-sm text-gray-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span>{opportunity.location}</span>
                  </div>

                  {linkedEvent && (
                    <div className="flex items-center space-x-2 text-sm text-blue-600">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      <span>For: {linkedEvent.title}</span>
                    </div>
                  )}

                  <div className="flex items-center space-x-2 text-sm">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <span className={slotsRemaining > 0 ? 'text-gray-600' : 'text-red-600'}>
                      {slotsRemaining} of {opportunity.slotsNeeded} spots available
                    </span>
                  </div>

                  {/* Volunteers */}
                  {opportunity.slotsBooked.length > 0 && (
                    <div className="pt-3 border-t border-gray-200">
                      <h4 className="text-sm font-medium text-gray-700 mb-2">Volunteers:</h4>
                      <div className="space-y-1">
                        {opportunity.slotsBooked.map((slot, index) => (
                          <div key={index} className="text-sm text-gray-600">
                            • {slot.volunteerName}
                            {slot.notes && <span className="text-gray-400"> - {slot.notes}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="p-4 border-t border-gray-200">
                  {isSignedUp ? (
                    <button
                      onClick={() => handleWithdraw(opportunity.id)}
                      className="w-full bg-red-100 hover:bg-red-200 text-red-700 font-medium py-2 px-4 rounded-lg transition duration-200"
                    >
                      Withdraw
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSignUp(opportunity.id)}
                      disabled={isFull}
                      className={`w-full font-medium py-2 px-4 rounded-lg transition duration-200 ${
                        isFull
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}
                    >
                      {isFull ? 'Full' : 'Sign Up to Help'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Empty State */}
        {filteredOpportunities.length === 0 && (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No volunteer opportunities</h3>
            <p className="text-gray-600">Create volunteer needs for your team events</p>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Add Volunteer Need</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">For which event?</label>
                <select
                  value={selectedEvent}
                  onChange={(e) => setSelectedEvent(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select an event...</option>
                  {upcomingEvents.map(event => (
                    <option key={event.id} value={event.id}>
                      {event.title} - {formatDateTime(event.date)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type of help needed</label>
                <select
                  value={newOpportunity.type}
                  onChange={(e) => {
                    const type = e.target.value as any;
                    const typeInfo = getTypeInfo(type);
                    setNewOpportunity({
                      ...newOpportunity, 
                      type,
                      slotsNeeded: typeInfo.defaultSlots,
                      timeOffset: typeInfo.defaultOffset
                    });
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="snacks">🍎 Snacks & Drinks</option>
                  <option value="setup">⚙️ Setup Help</option>
                  <option value="cleanup">🧹 Cleanup</option>
                  <option value="transportation">🚗 Transportation</option>
                  <option value="equipment">⚽ Equipment</option>
                  <option value="other">👥 Other</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Volunteers needed</label>
                  <input
                    type="number"
                    min="1"
                    value={newOpportunity.slotsNeeded}
                    onChange={(e) => setNewOpportunity({...newOpportunity, slotsNeeded: parseInt(e.target.value) || 1})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Time offset (minutes)</label>
                  <input
                    type="number"
                    value={newOpportunity.timeOffset}
                    onChange={(e) => setNewOpportunity({...newOpportunity, timeOffset: parseInt(e.target.value) || 0})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Negative = before event, Positive = after event
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newOpportunity.description}
                  onChange={(e) => setNewOpportunity({...newOpportunity, description: e.target.value})}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={getTypeInfo(newOpportunity.type).defaultDescription}
                />
              </div>
            </div>

            <div className="flex space-x-3 pt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateOpportunity}
                disabled={!selectedEvent}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VolunteerScheduler;