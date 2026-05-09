import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player } from '../types';
import { formatDate, isCoach } from '../utils/helpers';

interface CalendarEvent {
  id: string;
  title: string;
  date: Date;
  type: 'practice' | 'game' | 'event';
  location: string;
  teamId: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
}

interface AttendanceRecord {
  id: string;
  eventId: string;
  playerId: string;
  playerName: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  notes?: string;
  recordedBy: string;
  recordedByName: string;
  teamId: string;
  createdAt: Date;
}

const AttendanceTracker: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addDocument, updateDocument, deleteDocument } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [attendanceData, setAttendanceData] = useState<{[playerId: string]: string}>({});
  const [saving, setSaving] = useState(false);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  useEffect(() => {
    if (calendarEvents.length > 0 && !selectedEvent) {
      // Auto-select the next upcoming practice or game
      const upcomingEvents = calendarEvents
        .filter(event => 
          (event.type === 'practice' || event.type === 'game') && 
          new Date(event.date) >= new Date()
        )
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      
      if (upcomingEvents.length > 0) {
        setSelectedEvent(upcomingEvents[0].id);
      } else {
        // If no upcoming events, select the most recent past event
        const pastEvents = calendarEvents
          .filter(event => event.type === 'practice' || event.type === 'game')
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        if (pastEvents.length > 0) {
          setSelectedEvent(pastEvents[0].id);
        }
      }
    }
  }, [calendarEvents, selectedEvent]);

  useEffect(() => {
    loadAttendanceForEvent();
  }, [selectedEvent, attendanceRecords]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Load players, events, and attendance in parallel
      const [playersData, eventsData, recordsData] = await Promise.all([
        getDocuments('players', []),
        getDocuments('events', []),
        getDocuments('attendance_records', [])
      ]);

      const teamPlayers = playersData
        .filter((p: any) => p.teamId === selectedTeamId && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || Date.now())
        }));
      setPlayers(teamPlayers);

      const teamEvents = eventsData
        .filter((e: any) => 
          e.teamId === selectedTeamId && 
          (e.type === 'practice' || e.type === 'game')
        )
        .map((e: any) => ({
          ...e,
          date: e.date?.toDate ? e.date.toDate() : new Date(e.date || Date.now()),
          createdAt: e.createdAt?.toDate ? e.createdAt.toDate() : new Date(e.createdAt || Date.now())
        }))
        .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
      
      setCalendarEvents(teamEvents);

      const teamRecords = recordsData
        .filter((r: any) => r.teamId === selectedTeamId)
        .map((r: any) => ({
          ...r,
          createdAt: r.createdAt?.toDate ? r.createdAt.toDate() : new Date(r.createdAt || Date.now())
        }));
      
      setAttendanceRecords(teamRecords);
    } catch (error) {
      console.error('Error loading attendance data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAttendanceForEvent = () => {
    if (!selectedEvent) {
      setAttendanceData({});
      return;
    }

    const eventRecords = attendanceRecords.filter(r => r.eventId === selectedEvent);
    const data: {[playerId: string]: string} = {};
    
    eventRecords.forEach(record => {
      data[record.playerId] = record.status;
    });
    
    setAttendanceData(data);
  };

  const handleAttendanceChange = (playerId: string, status: string) => {
    setAttendanceData(prev => ({
      ...prev,
      [playerId]: status
    }));
  };

  const saveAttendance = async () => {
    if (!userData || !selectedEvent) return;

    try {
      setSaving(true);
      
      // Delete existing records for this event
      const existingRecords = attendanceRecords.filter(r => r.eventId === selectedEvent);
      for (const record of existingRecords) {
        await deleteDocument('attendance_records', record.id);
      }

      // Create new records
      const newRecords = [];
      for (const player of players) {
        const statusValue = attendanceData[player.id] || 'present';
        const status = ['present', 'absent', 'late', 'excused'].includes(statusValue) 
          ? statusValue as 'present' | 'absent' | 'late' | 'excused'
          : 'present';
        
        const { withSeasonId } = await import('../utils/seasons');
        const record = await withSeasonId({
          eventId: selectedEvent,
          playerId: player.id,
          playerName: player.name,
          status,
          recordedBy: userData.uid,
          recordedByName: userData.name,
          teamId: selectedTeamId,
          createdAt: new Date()
        }) as Omit<AttendanceRecord, 'id'>;

        const recordId = await addDocument('attendance_records', record);
        newRecords.push({
          ...record,
          id: recordId
        });
      }

      await loadData();
      alert('Attendance saved successfully!');
    } catch (error) {
      console.error('Error saving attendance:', error);
      alert('Failed to save attendance. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const getAttendanceStats = () => {
    const stats = {
      totalEvents: calendarEvents.length,
      averageAttendance: 0,
      playerStats: {} as {[playerId: string]: {present: number, total: number, percentage: number}}
    };

    players.forEach(player => {
      const playerRecords = attendanceRecords.filter(r => r.playerId === player.id);
      const present = playerRecords.filter(r => r.status === 'present').length;
      const total = playerRecords.length;

      stats.playerStats[player.id] = {
        present,
        total,
        percentage: total > 0 ? Math.round((present / total) * 100) : 0
      };
    });

    if (calendarEvents.length > 0 && players.length > 0) {
      const totalPresent = Object.values(stats.playerStats).reduce((sum, stat) => sum + stat.present, 0);
      const totalPossible = attendanceRecords.length;
      stats.averageAttendance = totalPossible > 0 ? Math.round((totalPresent / totalPossible) * 100) : 0;
    }

    return stats;
  };

  const selectedEventData = calendarEvents.find(e => e.id === selectedEvent);
  const stats = getAttendanceStats();

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
              <h1 className="text-3xl font-bold text-gray-900">Attendance Tracker</h1>
              <p className="text-gray-600 mt-1">Track attendance for practices and games from your calendar</p>
            </div>
            {calendarEvents.length === 0 && (
              <div className="text-right">
                <p className="text-sm text-gray-600 mb-2">No practices or games found</p>
                <a 
                  href="/calendar" 
                  className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-lg font-medium transition-colors duration-200"
                >
                  📅 Create Events in Calendar
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="card-modern p-6">
            <div className="flex items-center">
              <div className="p-2 bg-cyan-50 rounded-lg">
                <svg className="w-6 h-6 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Total Events</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalEvents}</p>
              </div>
            </div>
          </div>

          <div className="card-modern p-6">
            <div className="flex items-center">
              <div className="p-2 bg-green-100 rounded-lg">
                <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Average Attendance</p>
                <p className="text-2xl font-bold text-gray-900">{stats.averageAttendance}%</p>
              </div>
            </div>
          </div>

          <div className="card-modern p-6">
            <div className="flex items-center">
              <div className="p-2 bg-purple-100 rounded-lg">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Total Players</p>
                <p className="text-2xl font-bold text-gray-900">{players.length}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Attendance Taking */}
          <div className="lg:col-span-2">
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-gray-900">Take Attendance</h2>
                  {calendarEvents.length > 0 && (
                    <select
                      value={selectedEvent}
                      onChange={(e) => setSelectedEvent(e.target.value)}
                      className="px-3 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    >
                      <option value="">Select an event...</option>
                      {calendarEvents.map(event => {
                        const isPast = new Date(event.date) < new Date();
                        const isToday = new Date(event.date).toDateString() === new Date().toDateString();
                        return (
                          <option key={event.id} value={event.id}>
                            {isPast && !isToday ? '📜 ' : isToday ? '📅 ' : '⏰ '}
                            {event.title} - {formatDate(event.date)}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
              </div>

              {selectedEventData ? (
                <div className="p-6">
                  {/* Event Info */}
                  <div className="mb-4 p-4 bg-cyan-50 rounded-lg">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium text-cyan-900">{selectedEventData.title}</h3>
                        <p className="text-sm text-cyan-700">
                          {formatDate(selectedEventData.date)} • {selectedEventData.location || 'No location specified'}
                        </p>
                        <span className={`inline-block mt-1 px-2 py-1 rounded-full text-xs font-medium ${
                          selectedEventData.type === 'game' 
                            ? 'bg-red-100 text-red-800' 
                            : 'bg-green-100 text-green-800'
                        }`}>
                          {selectedEventData.type.charAt(0).toUpperCase() + selectedEventData.type.slice(1)}
                        </span>
                      </div>
                      <a 
                        href="/calendar" 
                        className="text-cyan-600 hover:text-cyan-700 text-sm font-medium"
                      >
                        📅 View in Calendar
                      </a>
                    </div>
                  </div>

                  {/* Players List */}
                  {players.length > 0 ? (
                    <div className="space-y-3">
                      {players.map(player => {
                        const currentStatus = attendanceData[player.id] || 'present';

                        return (
                          <div key={player.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                            <div className="flex items-center space-x-3">
                              <div className="bg-cyan-50 rounded-full w-10 h-10 flex items-center justify-center">
                                <span className="text-sm font-bold text-cyan-600">#{player.jerseyNumber}</span>
                              </div>
                              <div>
                                <p className="font-medium text-gray-900">{player.name}</p>
                                <p className="text-sm text-gray-600">{player.position}</p>
                              </div>
                            </div>

                            <div className="flex space-x-2">
                              {['present', 'absent', 'late', 'excused'].map(status => (
                                <button
                                  key={status}
                                  onClick={() => handleAttendanceChange(player.id, status)}
                                  disabled={!isUserCoach}
                                  className={`px-3 py-1 rounded text-sm font-medium transition-colors duration-200 ${
                                    currentStatus === status
                                      ? status === 'present' ? 'bg-green-100 text-green-800'
                                        : status === 'absent' ? 'bg-red-100 text-red-800'
                                        : status === 'late' ? 'bg-yellow-100 text-yellow-800'
                                        : 'bg-cyan-50 text-cyan-700'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  } ${!isUserCoach ? 'cursor-not-allowed opacity-50' : ''}`}
                                >
                                  {status.charAt(0).toUpperCase() + status.slice(1)}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-600">
                      <p>No players found. Add players to track attendance.</p>
                      <a 
                        href="/players"
                        className="mt-2 inline-block bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                      >
                        Add Players
                      </a>
                    </div>
                  )}

                  {/* Save Button */}
                  {isUserCoach && players.length > 0 && (
                    <div className="mt-6 pt-4 border-t border-gray-200">
                      <button
                        onClick={saveAttendance}
                        disabled={saving}
                        className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
                      >
                        {saving ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Saving...
                          </>
                        ) : (
                          'Save Attendance'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-6 text-center">
                  {calendarEvents.length === 0 ? (
                    <div>
                      <div className="text-gray-400 mb-4">
                        <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">No Events Found</h3>
                      <p className="text-gray-600 mb-4">
                        Create practices and games in the calendar first, then track attendance here.
                      </p>
                      <a
                        href="/calendar"
                        className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                      >
                        📅 Go to Calendar
                      </a>
                    </div>
                  ) : (
                    <p className="text-gray-600">Select an event to take attendance</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Player Stats */}
          <div>
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-semibold text-gray-900">Player Stats</h2>
              </div>
              <div className="p-6">
                {players.length > 0 ? (
                  <div className="space-y-4">
                    {players.map(player => {
                      const playerStat = stats.playerStats[player.id] || {present: 0, total: 0, percentage: 0};
                      return (
                        <div key={player.id} className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="bg-cyan-50 rounded-full w-8 h-8 flex items-center justify-center">
                              <span className="text-xs font-bold text-cyan-600">#{player.jerseyNumber}</span>
                            </div>
                            <span className="text-sm font-medium text-gray-900">{player.name}</span>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium text-gray-900">{playerStat.percentage}%</div>
                            <div className="text-xs text-gray-600">{playerStat.present}/{playerStat.total}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center text-gray-600">
                    <p>No players to show stats for</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AttendanceTracker;