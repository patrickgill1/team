import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, News, CalendarEvent, GameStat } from '../types';
import { formatDateTime, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import PlayerCard from '../components/player/PlayerCard';
import NewsList from '../components/news/NewsList';

const Dashboard: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getPlayersByTeam, getNewsByTeam, getEventsByTeam } = useFirestore();
  
  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState<Player[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);
  const [recentNews, setRecentNews] = useState<News[]>([]);
  const [teamStats, setTeamStats] = useState({
    totalPlayers: 0,
    totalGoals: 0,
    totalGames: 0,
    nextEvent: null as CalendarEvent | null
  });

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    const loadDashboardData = async () => {
      if (!selectedTeamId) { setLoading(false); return; }

      try {
        // Load players and events in parallel
        const [teamPlayers, teamEvents] = await Promise.all([
          getPlayersByTeam(selectedTeamId),
          getEventsByTeam(selectedTeamId)
        ]);

        const playersWithDates = teamPlayers.map((player: any) => ({
          ...player,
          createdAt: player.createdAt?.toDate ? player.createdAt.toDate() : new Date(player.createdAt)
        })) as Player[];
        setPlayers(playersWithDates);

        const eventsWithDates = teamEvents.map((event: any) => ({
          ...event,
          date: event.date?.toDate ? event.date.toDate() : new Date(event.date),
          createdAt: event.createdAt?.toDate ? event.createdAt.toDate() : new Date(event.createdAt)
        })) as CalendarEvent[];
        
        const upcoming = eventsWithDates
          .filter(event => new Date(event.date) >= new Date())
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
          .slice(0, 3);
        setUpcomingEvents(upcoming);

        // Calculate team stats
        const totalGoals = playersWithDates.reduce((sum, player) => sum + player.stats.goals, 0);
        const totalGames = Math.max(...playersWithDates.map(player => player.stats.gamesPlayed), 0);
        const nextEvent = upcoming.length > 0 ? upcoming[0] : null;

        setTeamStats({
          totalPlayers: playersWithDates.length,
          totalGoals,
          totalGames,
          nextEvent
        });

      } catch (error) {
        console.error('Error loading dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDashboardData();
  }, [selectedTeamId, getPlayersByTeam, getEventsByTeam]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
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
    <div>
      <Header 
        title={`${getGreeting()}, ${userData?.name?.split(' ')[0] || 'Coach'}!`}
        subtitle={`Welcome back to your ${isUserCoach ? 'coaching' : 'team'} dashboard`}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-8">
          <div className="card-modern p-5">
            <div className="flex items-center">
              <div className="p-3 bg-cyan-50 rounded-2xl">
                <span className="text-2xl">👥</span>
              </div>
              <div className="ml-3">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Players</p>
                <p className="text-2xl font-bold text-fire-950">{teamStats.totalPlayers}</p>
              </div>
            </div>
          </div>

          <div className="card-modern p-5">
            <div className="flex items-center">
              <div className="p-3 bg-emerald-50 rounded-2xl">
                <span className="text-2xl">⚽</span>
              </div>
              <div className="ml-3">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Goals</p>
                <p className="text-2xl font-bold text-fire-950">{teamStats.totalGoals}</p>
              </div>
            </div>
          </div>

          <div className="card-modern p-5">
            <div className="flex items-center">
              <div className="p-3 bg-sky-50 rounded-2xl">
                <span className="text-2xl">🏆</span>
              </div>
              <div className="ml-3">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Games</p>
                <p className="text-2xl font-bold text-fire-950">{teamStats.totalGames}</p>
              </div>
            </div>
          </div>

          <div className="card-modern p-5">
            <div className="flex items-center">
              <div className="p-3 bg-amber-50 rounded-2xl">
                <span className="text-2xl">📅</span>
              </div>
              <div className="ml-3">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Next Event</p>
                <p className="text-sm font-bold text-fire-950">
                  {teamStats.nextEvent 
                    ? new Date(teamStats.nextEvent.date).toLocaleDateString()
                    : 'No events'
                  }
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-8">
            {/* Upcoming Events */}
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-fire-950">Upcoming Events</h2>
                <Link 
                  to="/calendar"
                  className="text-cyan-600 hover:text-cyan-700 text-sm font-medium"
                >
                  View All
                </Link>
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
                      <Link 
                        to="/calendar"
                        className="inline-block mt-3 bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200"
                      >
                        Schedule Event
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {upcomingEvents.map(event => (
                      <div key={event.id} className="border border-gray-100 rounded-2xl p-4 hover:bg-fire-50/50 transition-colors">
                        <div className="flex items-start space-x-3">
                          <div className="text-2xl">{getEventTypeIcon(event.type)}</div>
                          <div className="flex-1">
                            <div className="flex items-center space-x-2 mb-1">
                              <h3 className="font-semibold text-gray-900">{event.title}</h3>
                              <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getEventTypeColor(event.type)}`}>
                                {event.type.charAt(0).toUpperCase() + event.type.slice(1)}
                              </span>
                            </div>
                            <div className="text-sm text-gray-600 space-y-1">
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
                            </div>
                            {event.description && (
                              <p className="text-sm text-gray-600 mt-2">{event.description}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Recent News */}
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-fire-950">Latest News</h2>
                <Link 
                  to="/news"
                  className="text-cyan-600 hover:text-cyan-700 text-sm font-medium"
                >
                  View All
                </Link>
              </div>
              <div className="p-6">
                <NewsList 
                  limit={3} 
                  showCreateButton={false}
                />
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-8">
            {/* Quick Actions */}
            <div className="card-modern">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-fire-950">Quick Actions</h2>
              </div>
              <div className="p-6 space-y-3">
                {isUserCoach ? (
                  <>
                    <Link
                      to="/players"
                      className="flex items-center w-full p-3 bg-cyan-50 hover:bg-cyan-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">👥</span>
                      <div>
                        <p className="font-medium text-fire-950">Manage Players</p>
                        <p className="text-sm text-gray-500">Add or edit team roster</p>
                      </div>
                    </Link>
                    <Link
                      to="/stats"
                      className="flex items-center w-full p-3 bg-emerald-50 hover:bg-emerald-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📊</span>
                      <div>
                        <p className="font-medium text-fire-950">Track Stats</p>
                        <p className="text-sm text-gray-500">Record game statistics</p>
                      </div>
                    </Link>
                    <Link
                      to="/news"
                      className="flex items-center w-full p-3 bg-sky-50 hover:bg-sky-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📰</span>
                      <div>
                        <p className="font-medium text-fire-950">Post News</p>
                        <p className="text-sm text-gray-500">Share team updates</p>
                      </div>
                    </Link>
                    <Link
                      to="/calendar"
                      className="flex items-center w-full p-3 bg-amber-50 hover:bg-amber-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📅</span>
                      <div>
                        <p className="font-medium text-fire-950">Schedule Events</p>
                        <p className="text-sm text-gray-500">Plan practices & games</p>
                      </div>
                    </Link>
                  </>
                ) : (
                  <>
                    <Link
                      to="/players"
                      className="flex items-center w-full p-3 bg-cyan-50 hover:bg-cyan-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">👥</span>
                      <div>
                        <p className="font-medium text-fire-950">View Players</p>
                        <p className="text-sm text-gray-500">See team roster & stats</p>
                      </div>
                    </Link>
                    <Link
                      to="/stats"
                      className="flex items-center w-full p-3 bg-emerald-50 hover:bg-emerald-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📊</span>
                      <div>
                        <p className="font-medium text-fire-950">View Stats</p>
                        <p className="text-sm text-gray-500">Check player performance</p>
                      </div>
                    </Link>
                    <Link
                      to="/gallery"
                      className="flex items-center w-full p-3 bg-sky-50 hover:bg-sky-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📸</span>
                      <div>
                        <p className="font-medium text-fire-950">Media</p>
                        <p className="text-sm text-gray-500">Share team photos</p>
                      </div>
                    </Link>
                    <Link
                      to="/calendar"
                      className="flex items-center w-full p-3 bg-amber-50 hover:bg-amber-100 rounded-xl transition-colors duration-200"
                    >
                      <span className="text-2xl mr-3">📅</span>
                      <div>
                        <p className="font-medium text-fire-950">Team Calendar</p>
                        <p className="text-sm text-gray-500">View upcoming events</p>
                      </div>
                    </Link>
                  </>
                )}
              </div>
            </div>

            {/* Top Players */}
            {players.length > 0 && (
              <div className="card-modern">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-fire-950">Top Performers</h2>
                  <Link 
                    to="/players"
                    className="text-cyan-600 hover:text-cyan-700 text-sm font-medium"
                  >
                    View All
                  </Link>
                </div>
                <div className="p-6">
                  <div className="space-y-4">
                    {players
                      .sort((a, b) => b.stats.goals - a.stats.goals)
                      .slice(0, 3)
                      .map((player, index) => (
                        <div key={player.id} className="flex items-center space-x-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                            index === 0 ? 'bg-yellow-100 text-yellow-800' :
                            index === 1 ? 'bg-gray-100 text-gray-800' :
                            'bg-orange-100 text-orange-800'
                          }`}>
                            {index + 1}
                          </div>
                          <div className="flex-1">
                            <p className="font-medium text-gray-900">{player.name}</p>
                            <p className="text-sm text-gray-600">#{player.jerseyNumber} • {player.position}</p>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold text-gray-900">{player.stats.goals}</p>
                            <p className="text-sm text-gray-600">goals</p>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;