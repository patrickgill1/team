import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player } from '../types';
import { formatDate, isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import { VOCAB } from '../vocab';

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
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getDocuments, addDocument, updateDocument, deleteDocument, getPlayersByTeam } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [attendanceData, setAttendanceData] = useState<{[playerId: string]: string}>({});
  const [saving, setSaving] = useState(false);

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);

  useEffect(() => {
    loadData();
  }, [selectedTeamId]);

  useEffect(() => {
    if (calendarEvents.length > 0 && !selectedEvent) {
      // Auto-select the next upcoming team event of any type. Anything
      // a parent might bring their kid to deserves attendance tracking
      // (a watch party counts; an internal coach-only meeting wouldn't,
      // but those aren't on the team calendar anyway).
      const upcomingEvents = calendarEvents
        .filter(event => new Date(event.date) >= new Date())
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      if (upcomingEvents.length > 0) {
        setSelectedEvent(upcomingEvents[0].id);
      } else {
        // If no upcoming events, select the most recent past event
        const pastEvents = calendarEvents
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        if (pastEvents.length > 0) {
          setSelectedEvent(pastEvents[0].id);
        }
      }
    }
  }, [calendarEvents, selectedEvent]);

  useEffect(() => {
    loadAttendanceForEvent();
    // Also re-seed when the event's playerRsvps map updates so an
    // RSVP made AFTER the coach opened the page still flows through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvent, attendanceRecords, calendarEvents]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }

    try {
      setLoading(true);
      
      // Load players (team-scoped via useFirestore), events, and
      // attendance in parallel. Unfiltered getDocuments('players', [])
      // used to work but breaks silently against the tightened
      // callerCanReadPlayer LIST rule — see getPlayersByTeam for the
      // canonical two-query scope.
      const [teamPlayers, eventsData, recordsData] = await Promise.all([
        getPlayersByTeam(selectedTeamId),
        getDocuments('events', []),
        getDocuments('attendance_records', []),
      ]);
      setPlayers(teamPlayers.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || Date.now()),
      })));

      const teamEvents = eventsData
        .filter((e: any) =>
          e.teamId === selectedTeamId &&
          !e.isCancelled
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

  // Pulls each player's CURRENT RSVP status straight from the event
  // doc's playerRsvps map. This page is now a coach-side RSVP tool —
  // it doesn't read or write the legacy attendance_records collection.
  const loadAttendanceForEvent = () => {
    if (!selectedEvent) {
      setAttendanceData({});
      return;
    }
    const ev: any = calendarEvents.find(e => e.id === selectedEvent);
    const playerRsvps: Record<string, { status?: string }> = ev?.playerRsvps || {};
    const data: { [playerId: string]: string } = {};
    Object.entries(playerRsvps).forEach(([pid, r]) => {
      if (r?.status) data[pid] = r.status;
    });
    setAttendanceData(data);
  };

  const handleAttendanceChange = (playerId: string, status: string) => {
    setAttendanceData(prev => ({
      ...prev,
      [playerId]: status
    }));
  };

  // Writes ALL players' RSVPs back to the event's playerRsvps map in
  // one update. The list reflects the coach's bulk-set decisions —
  // parent-side RSVPs the coach didn't touch in this session keep
  // their previous status because we merge instead of replacing.
  const saveAttendance = async () => {
    if (!userData || !selectedEvent) return;
    try {
      setSaving(true);
      const ev: any = calendarEvents.find(e => e.id === selectedEvent);
      const existing: Record<string, any> = ev?.playerRsvps || {};
      const next: Record<string, any> = { ...existing };
      for (const player of players) {
        const status = attendanceData[player.id];
        if (!status) continue; // skip "unset" rows entirely
        next[player.id] = {
          status,
          playerName: player.name,
          byUid: userData.uid,
          byName: userData.name,
          respondedAt: new Date(),
        };
      }
      await updateDocument('events', selectedEvent, { playerRsvps: next });
      alert('RSVPs saved.');
    } catch (error) {
      console.error('Error saving RSVPs:', error);
      alert('Failed to save RSVPs. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Per-player attendance rates, computed off each PAST event's
  // playerRsvps map (going === present). Skips events without any
  // recorded RSVPs so a brand-new team doesn't show 0%.
  const getAttendanceStats = () => {
    const now = Date.now();
    const pastEvents = calendarEvents.filter(e => {
      const d = (e as any).date instanceof Date ? (e as any).date : new Date((e as any).date || 0);
      return d.getTime() <= now;
    });
    const stats = {
      totalEvents: pastEvents.length,
      averageAttendance: 0,
      playerStats: {} as { [playerId: string]: { present: number; total: number; percentage: number } },
    };

    players.forEach(player => {
      let present = 0, total = 0;
      pastEvents.forEach(ev => {
        const r: any = (ev as any).playerRsvps?.[player.id];
        if (!r?.status) return;
        total++;
        if (r.status === 'going') present++;
      });
      stats.playerStats[player.id] = {
        present,
        total,
        percentage: total > 0 ? Math.round((present / total) * 100) : 0,
      };
    });

    const totals = Object.values(stats.playerStats);
    const totalPresent = totals.reduce((s, st) => s + st.present, 0);
    const totalPossible = totals.reduce((s, st) => s + st.total, 0);
    stats.averageAttendance = totalPossible > 0
      ? Math.round((totalPresent / totalPossible) * 100)
      : 0;

    return stats;
  };

  const selectedEventData = calendarEvents.find(e => e.id === selectedEvent);
  const stats = getAttendanceStats();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
          <span className="text-sm text-ink-primary/40 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title={VOCAB.checkIn} subtitle="Who showed up — sessions, matches, everything." />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {calendarEvents.length === 0 && (
          <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10 p-6 mb-6 flex items-center justify-between gap-4">
            <p className="text-sm text-ink-primary/65">Nothing to check in on yet.</p>
            <Link
              to="/calendar"
              className="inline-flex items-center gap-2 bg-brand-primary hover:bg-brand-primary text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              <AppIcon name="calendar" className="w-4 h-4" />
              <span>Create events</span>
            </Link>
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
              <div className="px-6 py-4 border-b border-line-default/10">
                {/* Stack on mobile so a long event name in the select
                    can't push the row past the viewport (which was
                    triggering horizontal scroll on the whole page). */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
                  <h2 className="text-lg font-semibold text-ink-primary shrink-0">Who's In?</h2>
                  {calendarEvents.length > 0 && (
                    <select
                      value={selectedEvent}
                      onChange={(e) => setSelectedEvent(e.target.value)}
                      className="min-w-0 max-w-full w-full sm:w-auto px-3 py-2 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm"
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
                  <div className="mb-4 p-4 bg-brand-primary/15 rounded-lg">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 min-w-0">
                      <div className="min-w-0">
                        <h3 className="font-medium text-brand-primary-dim truncate">{selectedEventData.title}</h3>
                        <p className="text-sm text-brand-primary-soft truncate">
                          {formatDate(selectedEventData.date)} • {selectedEventData.location || 'No location'}
                        </p>
                        <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                          selectedEventData.type === 'game'
                            ? 'bg-surface-raised/10 text-charcoal-800'
                            : selectedEventData.type === 'practice'
                              ? 'bg-brand-primary/20 text-charcoal-800'
                              : 'bg-brand-primary/15 text-ink-primary/85'
                        }`}>
                          {selectedEventData.type.charAt(0).toUpperCase() + selectedEventData.type.slice(1)}
                        </span>
                      </div>
                      <Link
                        to="/calendar"
                        className="inline-flex items-center gap-1 text-brand-primary-soft hover:text-brand-primary-soft text-sm font-semibold shrink-0"
                      >
                        <AppIcon name="calendar" className="w-4 h-4" />
                        <span>View in Events</span>
                      </Link>
                    </div>
                  </div>

                  {/* Players List */}
                  {players.length > 0 ? (
                    <div className="space-y-3">
                      {players.map(player => {
                        const currentStatus = attendanceData[player.id] || '';

                        return (
                          <div key={player.id} className="p-3 border border-line-default/10 rounded-lg">
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
                                    className="w-10 h-10 rounded-full object-cover ring-2 ring-brand-primary-soft shrink-0"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                  />
                                ) : (
                                  <div className="bg-brand-primary/15 rounded-full w-10 h-10 flex items-center justify-center shrink-0">
                                    <span className="text-sm font-bold text-brand-primary">#{player.jerseyNumber}</span>
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <p className="font-medium text-ink-primary truncate">
                                    {player.name}
                                    {player.jerseyNumber != null && (player as any).profilePhotoUrl && (
                                      <span className="text-xs text-ink-primary/50 font-normal ml-1.5">#{player.jerseyNumber}</span>
                                    )}
                                  </p>
                                  <p className="text-sm text-ink-primary/65 truncate">{player.position}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1.5 sm:gap-2 sm:shrink-0">
                                {[
                                  { key: 'going', label: 'Going', active: 'bg-emerald-500/20 text-emerald-200' },
                                  { key: 'maybe', label: 'Maybe', active: 'bg-amber-500/20 text-amber-200' },
                                  { key: 'no', label: "Can't", active: 'bg-rose-500/20 text-rose-800' },
                                ].map(({ key, label, active }) => (
                                  <button
                                    key={key}
                                    onClick={() => handleAttendanceChange(player.id, key)}
                                    disabled={!isUserCoach}
                                    className={`flex-1 sm:flex-initial min-w-0 px-2.5 py-1 rounded text-xs sm:text-sm font-medium transition-colors ${
                                      currentStatus === key
                                        ? active
                                        : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.1]'
                                    } ${!isUserCoach ? 'cursor-not-allowed opacity-50' : ''}`}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-ink-primary/65">
                      <p>Squad's empty. Add some players first.</p>
                      <Link
                        to="/players"
                        className="mt-2 inline-block bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200"
                      >
                        Build Your Squad
                      </Link>
                    </div>
                  )}

                  {/* Save Button */}
                  {isUserCoach && players.length > 0 && (
                    <div className="mt-6 pt-4 border-t border-line-default/10">
                      <button
                        onClick={saveAttendance}
                        disabled={saving}
                        className="w-full bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
                      >
                        {saving ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Saving...
                          </>
                        ) : (
                          'Lock It In'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-6 text-center">
                  {calendarEvents.length === 0 ? (
                    <div>
                      <div className="text-ink-primary/40 mb-4">
                        <svg className="mx-auto h-16 w-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <h3 className="text-lg font-medium text-ink-primary mb-2">No Events Found</h3>
                      <p className="text-ink-primary/65 mb-4">
                        Create events in the calendar first, then track attendance here.
                      </p>
                      <Link
                        to="/calendar"
                        className="inline-flex items-center gap-2 bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition"
                      >
                        <AppIcon name="calendar" className="w-4 h-4" />
                        <span>Go to Events</span>
                      </Link>
                    </div>
                  ) : (
                    <p className="text-ink-primary/65">Select an event to take attendance</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Player Stats */}
          <div>
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-line-default/10">
                <h2 className="text-lg font-semibold text-ink-primary">Player Stats</h2>
              </div>
              <div className="p-6">
                {players.length > 0 ? (
                  <div className="space-y-4">
                    {players.map(player => {
                      const playerStat = stats.playerStats[player.id] || {present: 0, total: 0, percentage: 0};
                      return (
                        <div key={player.id} className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="bg-brand-primary/15 rounded-full w-8 h-8 flex items-center justify-center">
                              <span className="text-xs font-bold text-brand-primary">#{player.jerseyNumber}</span>
                            </div>
                            <span className="text-sm font-medium text-ink-primary">{player.name}</span>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium text-ink-primary">{playerStat.percentage}%</div>
                            <div className="text-xs text-ink-primary/65">{playerStat.present}/{playerStat.total}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center text-ink-primary/65">
                    <p>Squad's empty.</p>
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
  cyan: 'bg-brand-primary/15 text-brand-primary-soft',
  emerald: 'bg-emerald-500/15 text-emerald-300',
  fire: 'bg-brand-primary/15 text-ink-primary/85',
  navy: 'bg-surface-raised/10 text-ink-primary/85',
  amber: 'bg-amber-500/15 text-amber-300',
};

const StatTile: React.FC<{ icon: any; tint: string; label: string; value: React.ReactNode }> = ({ icon, tint, label, value }) => (
  <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10 p-5 flex items-center gap-4">
    <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${TINT_BG[tint] || TINT_BG.cyan}`}>
      <AppIcon name={icon} className="w-5 h-5" />
    </span>
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-primary/50">{label}</p>
      <p className="text-2xl font-bold text-ink-primary mt-0.5">{value}</p>
    </div>
  </div>
);

export default AttendanceTracker;