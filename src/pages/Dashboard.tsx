// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, News, CalendarEvent, PlayerMedia as PlayerMediaType } from '../types';
import { formatDateTime, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import NewsList from '../components/news/NewsList';

const Dashboard: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const {
    getPlayersByTeam,
    getEventsByTeam,
    getPlayerMediaByTeam,
    getTeamPlayerStatsMap,
  } = useFirestore();

  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState<Player[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    const load = async () => {
      if (!selectedTeamId) { setLoading(false); return; }
      setLoading(true);
      try {
        const [teamPlayers, teamEvents, teamMedia, statsMap] = await Promise.all([
          getPlayersByTeam(selectedTeamId),
          getEventsByTeam(selectedTeamId),
          getPlayerMediaByTeam(selectedTeamId).catch(() => []),
          getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
        ]);

        const playersWithDates = (teamPlayers as any[]).map((p: any) => {
          const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
          const teamScoped = (statsMap as any)[p.id];
          // Shared players (rostered on multiple teams) MUST NOT fall back
          // to the global p.stats aggregate, which combines goals across
          // every team they play for.
          const isShared = Array.isArray(p.teamIds) && p.teamIds.length > 1;
          const stats = teamScoped || (isShared ? empty : (p.stats || empty));
          return {
            ...p,
            createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
            stats,
          };
        }) as Player[];
        setPlayers(playersWithDates);

        const eventsWithDates = (teamEvents as any[]).map((e: any) => ({
          ...e,
          date: e.date?.toDate ? e.date.toDate() : new Date(e.date),
          createdAt: e.createdAt?.toDate ? e.createdAt.toDate() : new Date(e.createdAt),
        })) as CalendarEvent[];
        const upcoming = eventsWithDates
          .filter(ev => new Date(ev.date) >= new Date())
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
          .slice(0, 3);
        setUpcomingEvents(upcoming);

        const formattedMedia = (teamMedia as any[]).map((m: any) => ({
          ...m,
          createdAt: m.createdAt?.toDate ? m.createdAt.toDate() : new Date(m.createdAt),
        })) as PlayerMediaType[];
        setMedia(formattedMedia);
      } catch (err) {
        console.error('Error loading dashboard data:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [selectedTeamId, getPlayersByTeam, getEventsByTeam, getPlayerMediaByTeam, getTeamPlayerStatsMap]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const totalGoals = players.reduce((s, p) => s + (p.stats?.goals || 0), 0);
  const totalAssists = players.reduce((s, p) => s + (p.stats?.assists || 0), 0);
  const totalGames = Math.max(0, ...players.map(p => p.stats?.gamesPlayed || 0));
  const totalClips = media.filter(m => m.type === 'video').length;

  // Hot clips: most-liked videos (fallback to most-viewed, then most recent)
  const hotClips = useMemo(() => {
    const videos = media.filter(m => m.type === 'video');
    return [...videos]
      .sort((a: any, b: any) => {
        const al = a.likeCount || a.likes?.length || 0;
        const bl = b.likeCount || b.likes?.length || 0;
        if (bl !== al) return bl - al;
        const av = a.viewCount || a.views?.length || 0;
        const bv = b.viewCount || b.views?.length || 0;
        if (bv !== av) return bv - av;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, 6);
  }, [media]);

  // Recent uploads strip (any media)
  const recentClips = useMemo(() => {
    return [...media]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 8);
  }, [media]);

  const topScorers = useMemo(() => {
    return [...players]
      .filter(p => (p.stats?.goals || 0) > 0)
      .sort((a, b) => (b.stats?.goals || 0) - (a.stats?.goals || 0))
      .slice(0, 5);
  }, [players]);

  const topAssists = useMemo(() => {
    return [...players]
      .filter(p => (p.stats?.assists || 0) > 0)
      .sort((a, b) => (b.stats?.assists || 0) - (a.stats?.assists || 0))
      .slice(0, 3);
  }, [players]);

  const eventEmoji = (t: string) => t === 'game' ? '⚽' : t === 'practice' ? '🏃' : '📅';
  const eventGradient = (t: string) =>
    t === 'game' ? 'from-rose-500 to-orange-500'
      : t === 'practice' ? 'from-cyan-500 to-blue-600'
      : 'from-violet-500 to-fuchsia-500';

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

  const firstName = userData?.name?.split(' ')[0] || (isUserCoach ? 'Coach' : 'Friend');

  return (
    <div>
      <Header
        title={`${greeting}, ${firstName}!`}
        subtitle={`Welcome back to your ${isUserCoach ? 'coaching' : 'team'} dashboard`}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        {/* ── HERO ──────────────────────────────────────────────── */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-fire-700 via-fire-800 to-navy-900 p-6 sm:p-8 text-white shadow-2xl ring-1 ring-white/10">
          {/* decorative blobs */}
          <div className="absolute -top-16 -right-16 w-72 h-72 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-20 -left-10 w-72 h-72 bg-rose-500/20 rounded-full blur-3xl pointer-events-none" />
          <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-6 items-center">
            <div className="sm:col-span-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-xs font-bold uppercase tracking-wider mb-3 backdrop-blur">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                {selectedTeam?.name || 'Your Team'}
              </div>
              <h2 className="text-2xl sm:text-3xl font-black leading-tight mb-2">
                Season at a glance
              </h2>
              <p className="text-white/80 text-sm sm:text-base max-w-md">
                {totalGames > 0
                  ? `${totalGoals} goals · ${totalAssists} assists across ${totalGames} game${totalGames === 1 ? '' : 's'}.`
                  : 'No games logged yet — tap Quick Game to get started.'}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {isUserCoach && (
                  <Link
                    to="/game-day"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-fire-200 font-bold text-sm shadow hover:scale-105 transition"
                  >
                    ⚡ Quick Game
                  </Link>
                )}
                <Link
                  to="/player-media"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 ring-1 ring-white/20 text-white font-semibold text-sm hover:bg-white/25 transition backdrop-blur"
                >
                  🎬 Highlights
                </Link>
                <Link
                  to="/calendar"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 ring-1 ring-white/20 text-white font-semibold text-sm hover:bg-white/25 transition backdrop-blur"
                >
                  📅 Calendar
                </Link>
              </div>
            </div>
            {/* Mini stat tiles */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <MiniStat label="Goals" value={totalGoals} accent="emerald" />
              <MiniStat label="Assists" value={totalAssists} accent="cyan" />
              <MiniStat label="Clips" value={totalClips} accent="violet" />
            </div>
          </div>
        </section>

        {/* ── QUICK STATS GRID ───────────────────────────────────── */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard icon="👥" label="Players" value={players.length} gradient="from-cyan-500 to-blue-600" />
          <StatCard icon="⚽" label="Goals" value={totalGoals} gradient="from-emerald-500 to-teal-600" />
          <StatCard icon="🏆" label="Games" value={totalGames} gradient="from-amber-500 to-orange-500" />
          <StatCard
            icon="📅"
            label="Next Event"
            value={upcomingEvents[0]
              ? new Date(upcomingEvents[0].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : '—'}
            gradient="from-violet-500 to-fuchsia-600"
            small
          />
        </section>

        {/* ── HOT CLIPS ──────────────────────────────────────────── */}
        {hotClips.length > 0 && (
          <section>
            <SectionHeader
              title="🔥 Hot Clips"
              subtitle="Most loved highlights this season"
              link={{ to: '/media', label: 'See all' }}
            />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {hotClips.map((clip, idx) => (
                <ClipTile key={clip.id} clip={clip} rank={idx + 1} />
              ))}
            </div>
          </section>
        )}

        {/* ── MAIN GRID ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Upcoming Events */}
            <div className="card-modern overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-cyan-500/10 to-transparent">
                <div>
                  <h2 className="text-lg font-bold text-white">Upcoming Events</h2>
                  <p className="text-xs text-gray-400">Practices and games on deck</p>
                </div>
                <Link to="/calendar" className="text-cyan-600 hover:text-cyan-300 text-sm font-semibold">
                  View All →
                </Link>
              </div>
              <div className="p-6">
                {upcomingEvents.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-5xl mb-3">📭</div>
                    <p className="text-gray-300 mb-4">No upcoming events scheduled</p>
                    {isUserCoach && (
                      <Link
                        to="/calendar"
                        className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white font-semibold py-2 px-5 rounded-full transition shadow"
                      >
                        ➕ Schedule Event
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {upcomingEvents.map(event => (
                      <Link
                        key={event.id}
                        to="/calendar"
                        className="group flex items-stretch gap-4 p-3 rounded-2xl border border-white/10 hover:border-cyan-200 hover:shadow-md hover:bg-cyan-500/10/30 transition"
                      >
                        <div className={`flex-shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br ${eventGradient(event.type)} flex items-center justify-center text-2xl shadow-md`}>
                          {eventEmoji(event.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-bold text-white truncate group-hover:text-cyan-300">{event.title}</h3>
                            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-fire-50 text-fire-200">
                              {event.type}
                            </span>
                          </div>
                          <div className="text-xs text-gray-300 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            <span>🕒 {formatDateTime(event.date)}</span>
                            {event.location && <span>📍 {event.location}</span>}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Recent Clips Strip */}
            {recentClips.length > 0 && (
              <div className="card-modern overflow-hidden">
                <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-violet-500/10 to-transparent">
                  <div>
                    <h2 className="text-lg font-bold text-white">Recent Uploads</h2>
                    <p className="text-xs text-gray-400">Latest team media</p>
                  </div>
                  <Link to="/player-media" className="text-violet-600 hover:text-violet-700 text-sm font-semibold">
                    View All →
                  </Link>
                </div>
                <div className="p-4">
                  <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
                    {recentClips.map(c => (
                      <ClipThumb key={c.id} clip={c} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Latest News */}
            <div className="card-modern overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-amber-50 to-white">
                <div>
                  <h2 className="text-lg font-bold text-white">Latest News</h2>
                  <p className="text-xs text-gray-400">From your coaching staff</p>
                </div>
                <Link to="/news" className="text-amber-600 hover:text-amber-300 text-sm font-semibold">
                  View All →
                </Link>
              </div>
              <div className="p-6">
                <NewsList limit={3} showCreateButton={false} />
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {/* Quick Actions */}
            <div className="card-modern overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-fire-500/10 to-transparent">
                <h2 className="text-lg font-bold text-white">Quick Actions</h2>
                <p className="text-xs text-gray-400">Jump back in</p>
              </div>
              <div className="p-4 grid grid-cols-2 gap-2">
                {isUserCoach ? (
                  <>
                    <ActionTile to="/game-day" emoji="⚡" label="Quick Game" gradient="from-rose-500 to-orange-500" />
                    <ActionTile to="/stats" emoji="📊" label="Track Stats" gradient="from-emerald-500 to-teal-600" />
                    <ActionTile to="/players" emoji="👥" label="Roster" gradient="from-cyan-500 to-blue-600" />
                    <ActionTile to="/news" emoji="📰" label="Post News" gradient="from-amber-500 to-orange-500" />
                    <ActionTile to="/calendar" emoji="📅" label="Schedule" gradient="from-violet-500 to-fuchsia-600" />
                    <ActionTile to="/player-media" emoji="🎬" label="Media" gradient="from-pink-500 to-rose-500" />
                  </>
                ) : (
                  <>
                    <ActionTile to="/players" emoji="👥" label="Roster" gradient="from-cyan-500 to-blue-600" />
                    <ActionTile to="/stats" emoji="📊" label="Stats" gradient="from-emerald-500 to-teal-600" />
                    <ActionTile to="/player-media" emoji="🎬" label="Media" gradient="from-pink-500 to-rose-500" />
                    <ActionTile to="/calendar" emoji="📅" label="Calendar" gradient="from-violet-500 to-fuchsia-600" />
                  </>
                )}
              </div>
            </div>

            {/* Top Scorers */}
            {topScorers.length > 0 && (
              <div className="card-modern overflow-hidden">
                <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-emerald-50 to-white">
                  <div>
                    <h2 className="text-lg font-bold text-white">🏅 Top Scorers</h2>
                    <p className="text-xs text-gray-400">Leading the table</p>
                  </div>
                  <Link to="/stats" className="text-emerald-600 hover:text-emerald-300 text-sm font-semibold">
                    View All →
                  </Link>
                </div>
                <div className="p-4 space-y-2">
                  {topScorers.map((player, index) => (
                    <Link
                      key={player.id}
                      to={`/player/${player.id}`}
                      className="flex items-center gap-3 p-2 rounded-xl hover:bg-fire-50/60 transition group"
                    >
                      <div className={`relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-black shadow ${
                        index === 0 ? 'bg-gradient-to-br from-amber-300 to-yellow-500 text-amber-200 ring-2 ring-amber-300/50' :
                        index === 1 ? 'bg-gradient-to-br from-gray-200 to-gray-400 text-gray-800' :
                        index === 2 ? 'bg-gradient-to-br from-orange-300 to-amber-600 text-orange-900' :
                        'bg-white/5 text-gray-300'
                      }`}>
                        {index + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-white truncate group-hover:text-cyan-300">{player.name}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {player.jerseyNumber != null ? `#${player.jerseyNumber} · ` : ''}{player.position || 'Player'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-black text-white leading-tight">{player.stats?.goals || 0}</p>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wide">goals</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Top Assists (compact) */}
            {topAssists.length > 0 && (
              <div className="card-modern overflow-hidden">
                <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-transparent">
                  <h2 className="text-lg font-bold text-white">🎯 Playmakers</h2>
                  <p className="text-xs text-gray-400">Top assist providers</p>
                </div>
                <div className="p-4 space-y-2">
                  {topAssists.map((player) => (
                    <Link
                      key={player.id}
                      to={`/player/${player.id}`}
                      className="flex items-center gap-3 p-2 rounded-xl hover:bg-cyan-500/10 transition"
                    >
                      <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white font-black shadow">
                        {(player as any).profilePhotoUrl ? (
                          <img src={(player as any).profilePhotoUrl} alt={player.name} className="w-full h-full object-cover" />
                        ) : (
                          <span>{player.name.charAt(0)}</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-white truncate">{player.name}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {player.jerseyNumber != null ? `#${player.jerseyNumber} · ` : ''}{player.position || 'Player'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-black text-cyan-300 leading-tight">{player.stats?.assists || 0}</p>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wide">assists</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Sub-components ─────────────────────────────────────────────

const MiniStat: React.FC<{ label: string; value: number; accent: 'emerald' | 'cyan' | 'violet' }> = ({ label, value, accent }) => {
  const ring = accent === 'emerald' ? 'text-emerald-300' : accent === 'cyan' ? 'text-cyan-300' : 'text-violet-300';
  return (
    <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-3 text-center">
      <div className={`text-2xl sm:text-3xl font-black ${ring}`}>{value}</div>
      <div className="text-[10px] sm:text-xs uppercase tracking-wider text-white/70 font-bold">{label}</div>
    </div>
  );
};

const StatCard: React.FC<{ icon: string; label: string; value: number | string; gradient: string; small?: boolean }> = ({ icon, label, value, gradient, small }) => (
  <div className="group relative overflow-hidden rounded-2xl bg-white/5 ring-1 ring-white/10 p-4 sm:p-5 hover:shadow-lg hover:-translate-y-0.5 transition">
    <div className={`absolute -top-8 -right-8 w-24 h-24 rounded-full bg-gradient-to-br ${gradient} opacity-10 group-hover:opacity-20 transition`} />
    <div className="relative flex items-center gap-3">
      <div className={`flex-shrink-0 w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br ${gradient} flex items-center justify-center text-xl sm:text-2xl shadow-md`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] sm:text-xs font-bold text-gray-400 uppercase tracking-wider">{label}</p>
        <p className={`font-black text-white leading-tight ${small ? 'text-base sm:text-lg' : 'text-2xl sm:text-3xl'}`}>{value}</p>
      </div>
    </div>
  </div>
);

const SectionHeader: React.FC<{ title: string; subtitle?: string; link?: { to: string; label: string } }> = ({ title, subtitle, link }) => (
  <div className="flex items-end justify-between mb-3 px-1">
    <div>
      <h2 className="text-xl font-black text-white">{title}</h2>
      {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
    </div>
    {link && (
      <Link to={link.to} className="text-sm font-semibold text-cyan-600 hover:text-cyan-300">
        {link.label} →
      </Link>
    )}
  </div>
);

const ClipTile: React.FC<{ clip: any; rank: number }> = ({ clip, rank }) => {
  const thumb = clip.thumbnailUrl || (clip.type === 'photo' ? clip.url : undefined);
  const likes = clip.likeCount || clip.likes?.length || 0;
  return (
    <Link
      to={`/player-media?clip=${clip.id}`}
      className="group relative aspect-[3/4] rounded-2xl overflow-hidden ring-1 ring-white/10 bg-gradient-to-br from-gray-800 to-gray-950 shadow hover:shadow-xl hover:-translate-y-0.5 transition"
    >
      {thumb ? (
        <img src={thumb} alt={clip.caption || clip.playerName} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition" loading="lazy" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-4xl">🎬</div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-white/90 backdrop-blur text-fire-100 text-[10px] font-black flex items-center gap-1">
        #{rank} 🔥
      </div>
      {clip.type === 'video' && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-bold">▶ VIDEO</div>
      )}
      <div className="absolute bottom-0 left-0 right-0 p-2 text-white">
        <p className="text-xs font-bold truncate">{clip.playerName || 'Team'}</p>
        {(clip.caption || likes > 0) && (
          <p className="text-[10px] text-white/80 truncate">
            {likes > 0 ? `❤ ${likes}` : ''}{likes > 0 && clip.caption ? ' · ' : ''}{clip.caption || ''}
          </p>
        )}
      </div>
    </Link>
  );
};

const ClipThumb: React.FC<{ clip: any }> = ({ clip }) => {
  const thumb = clip.thumbnailUrl || (clip.type === 'photo' ? clip.url : undefined);
  return (
    <Link
      to={`/player-media?clip=${clip.id}`}
      className="group flex-shrink-0 w-28 sm:w-32 rounded-xl overflow-hidden ring-1 ring-white/10 bg-gray-100 hover:ring-cyan-300 hover:shadow-md transition"
    >
      <div className="relative aspect-square bg-gradient-to-br from-gray-700 to-gray-900">
        {thumb ? (
          <img src={thumb} alt={clip.caption || clip.playerName} className="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl">🎬</div>
        )}
        {clip.type === 'video' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white">▶</div>
          </div>
        )}
      </div>
      <div className="px-2 py-1.5 bg-gray-900/60">
        <p className="text-[11px] font-bold text-white truncate">{clip.playerName || 'Team'}</p>
        <p className="text-[10px] text-gray-400 truncate">{timeAgo(new Date(clip.createdAt))}</p>
      </div>
    </Link>
  );
};

const ActionTile: React.FC<{ to: string; emoji: string; label: string; gradient: string }> = ({ to, emoji, label, gradient }) => (
  <Link
    to={to}
    className="group relative overflow-hidden rounded-2xl p-3 ring-1 ring-white/10 bg-white/5 hover:shadow-md hover:-translate-y-0.5 transition flex flex-col items-center justify-center text-center min-h-[80px]"
  >
    <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-0 group-hover:opacity-10 transition`} />
    <div className={`relative w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-lg shadow mb-1`}>
      {emoji}
    </div>
    <span className="relative text-xs font-bold text-white">{label}</span>
  </Link>
);

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default Dashboard;
