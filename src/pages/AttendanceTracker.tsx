import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player } from '../types';
import { formatDate, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';

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
      <Header title="Attendance" subtitle="Track who showed up to practices, games, and events" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {calendarEvents.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-6 mb-6 flex items-center justify-between gap-4">
            <p className="text-sm text-gray-600">No practices or games found yet.</p>
            <a
              href="/calendar"
              className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              <AppIcon name="calendar" className="w-4 h-4" />
              <span>Create events</span>
            </a>
          </div>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatTile icon="calendar" tint="cyan" label="Total Events" value={stats.totalEvents} />
          <StatTile icon="check" tint="emerald" label="Average Attendance" value={`${stats.averageAttendance}%`} />
          <StatTile icon="players" tint="fire" label="Total Players" value={players.length} />
        </div>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Attendance Taking */}
          <div className="lg:col-span-2">
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-200">
                {/* Stack on mobile so a long event name in the select
                    can't push the row past the viewport (which was
                    triggering horizontal scroll on the whole page). */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
                  <h2 className="text-lg font-semibold text-gray-900 shrink-0">Take Attendance</h2>
                  {calendarEvents.length > 0 && (
                    <select
                      value={selectedEvent}
                      onChange={(e) => setSelectedEvent(e.target.value)}
                      className="min-w-0 max-w-full w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
                      style={{ fontSize: '16px' }}
                    >
                      <option value="">Select an event...</option>
                      {calendarEvents.map(event => {
                        const isPast = new Date(event.date) < new Date();
                        const isToday = new Date(event.date).toDateString() === new Date().toDateString();
                        return (
                          <option key={event.id} value={event.id}>
                            {isPast && !isToday ? 'Past · ' : isToday ? 'Today · ' : 'Upcoming · '}
                            {event.title} — {formatDate(event.date)}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
              </div>

              {selectedEventData ? (
                <div className="p-4 sm:p-6">
                  {/* Event Info — wraps on narrow screens; chip colors
                      follow the brand event palette. */}
                  <div className="mb-4 p-4 bg-cyan-50 rounded-lg">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 min-w-0">
                      <div className="min-w-0">
                        <h3 className="font-medium text-cyan-900 truncate">{selectedEventData.title}</h3>
                        <p className="text-sm text-cyan-700 truncate">
                          {formatDate(selectedEventData.date)} • {selectedEventData.location || 'No location'}
                        </p>
                        <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                          selectedEventData.type === 'game'
                            ? 'bg-navy-700/10 text-navy-800'
                            : selectedEventData.type === 'practice'
                              ? 'bg-fire-100 text-fire-800'
                              : 'bg-fire-50 text-fire-700'
                        }`}>
                          {selectedEventData.type.charAt(0).toUpperCase() + selectedEventData.type.slice(1)}
                        </span>
                      </div>
                      <a
                        href="/calendar"
                        className="inline-flex items-center gap-1 text-cyan-700 hover:text-cyan-800 text-sm font-semibold shrink-0"
                      >
                        <AppIcon name="calendar" className="w-4 h-4" />
                        <span>View in Events</span>
                      </a>
                    </div>
                  </div>

                  {/* Players List */}
                  {players.length > 0 ? (
                    <div className="space-y-3">
                      {players.map(player => {
                        const currentStatus = attendanceData[player.id] || 'present';

                        return (
                          <div key={player.id} className="p-3 border border-gray-200 rounded-lg">
                            {/* Stack player + buttons vertically on mobile,
                                row layout on sm+. Buttons get their own
                                wrappable row so 4 of them can sit on a
                                narrow screen without spilling. */}
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
                              <div className="flex items-center gap-3 min-w-0">
                                {/* Real player photo when available — falls back to the
                                    jersey-number chip so brand-new players still look
                                    deliberate. */}
                                {(player as any).profilePhotoUrl ? (
                                  <img
                                    src={(player as any).profilePhotoUrl}
                                    alt={player.name}
                                    className="w-10 h-10 rounded-full object-cover ring-2 ring-cyan-100 shrink-0"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                  />
                                ) : (
                                  <div className="bg-cyan-50 rounded-full w-10 h-10 flex items-center justify-center shrink-0">
                                    <span className="text-sm font-bold text-cyan-600">#{player.jerseyNumber}</span>
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <p className="font-medium text-gray-900 truncate">
                                    {player.name}
                                    {player.jerseyNumber != null && (player as any).profilePhotoUrl && (
                                      <span className="text-xs text-gray-500 font-normal ml-1.5">#{player.jerseyNumber}</span>
                                    )}
                                  </p>
                                  <p className="text-sm text-gray-600 truncate">{player.position}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1.5 sm:gap-2 sm:shrink-0">
                                {['present', 'absent', 'late', 'excused'].map(status => (
                                  <button
                                    key={status}
                                    onClick={() => handleAttendanceChange(player.id, status)}
                                    disabled={!isUserCoach}
                                    className={`flex-1 sm:flex-initial min-w-0 px-2.5 py-1 rounded text-xs sm:text-sm font-medium transition-colors ${
                                      currentStatus === status
                                        ? status === 'present' ? 'bg-emerald-100 text-emerald-800'
                                          : status === 'absent' ? 'bg-rose-100 text-rose-800'
                                          : status === 'late' ? 'bg-amber-100 text-amber-800'
                                          : 'bg-cyan-50 text-cyan-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    } ${!isUserCoach ? 'cursor-not-allowed opacity-50' : ''}`}
                                  >
                                    {status.charAt(0).toUpperCase() + status.slice(1)}
                                  </button>
                                ))}
                              </div>
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
                        className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 px-4 rounded-lg transition"
                      >
                        <AppIcon name="calendar" className="w-4 h-4" />
                        <span>Go to Events</span>
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

const TINT_BG: Record<string, string> = {
  cyan: 'bg-cyan-50 text-cyan-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  fire: 'bg-fire-50 text-fire-700',
  navy: 'bg-navy-700/10 text-navy-700',
  amber: 'bg-amber-50 text-amber-700',
};

const StatTile: React.FC<{ icon: any; tint: string; label: string; value: React.ReactNode }> = ({ icon, tint, label, value }) => (
  <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-5 flex items-center gap-4">
    <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${TINT_BG[tint] || TINT_BG.cyan}`}>
      <AppIcon name={icon} className="w-5 h-5" />
    </span>
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-0.5">{value}</p>
    </div>
  </div>
);

export default AttendanceTracker;