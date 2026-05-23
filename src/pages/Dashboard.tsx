// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, News, CalendarEvent, PlayerMedia as PlayerMediaType } from '../types';
import { formatDateTime, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import NewsList from '../components/news/NewsList';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { streamThumbnailUrl } from '../utils/streamUpload';
import { ChatThread } from '../types';

// Pick the best thumbnail image for a clip. Stream videos → Cloudflare's
// auto-generated JPEG poster. Photos → the photo itself. Legacy R2 videos →
// fall back to a stored thumbnailUrl if one exists (most don't).
function clipThumb(clip: any): string | undefined {
  if (clip?.type === 'video' && clip.streamUid) {
    return streamThumbnailUrl(clip.streamUid, {
      height: 480,
      time: clip.posterTimeSeconds != null ? `${clip.posterTimeSeconds}s` : undefined,
    });
  }
  if (clip?.type === 'photo') return clip.url;
  return clip?.thumbnailUrl;
}

const Dashboard: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const {
    getPlayersByTeam,
    getEventsByTeam,
    getPlayerMediaByTeam,
    getTeamPlayerStatsMap,
    subscribeToChatThreads,
    updateDocument,
  } = useFirestore();

  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState<Player[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const { season: activeSeason } = useActiveSeason();

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

  // Subscribe to chat threads so the "Recent Chats" card stays live.
  useEffect(() => {
    if (!selectedTeamId) return;
    const unsub = subscribeToChatThreads(selectedTeamId, (threads) => {
      // Hide DMs the current user isn't in, then sort by most recent activity.
      const visible = threads
        .filter((t: any) => {
          if (t.isPrivate && !isUserCoach) return false;
          if (t.isDM && userData?.uid && !t.participants?.includes(userData.uid)) return false;
          return true;
        })
        .map((t: any) => ({
          ...t,
          lastActivity: t.lastActivity instanceof Date ? t.lastActivity : new Date(t.lastActivity || Date.now()),
        }))
        .sort((a: any, b: any) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
      setChatThreads(visible);
    });
    return () => { unsub && unsub(); };
  }, [selectedTeamId, subscribeToChatThreads, isUserCoach, userData?.uid]);

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

  // The parent's linked player on this team (their kid).
  const myPlayer = useMemo(() => {
    if (!userData || isUserCoach) return null;
    return players.find((p: any) =>
      (Array.isArray(p.parentIds) && p.parentIds.includes(userData.uid)) ||
      p.parentId === userData.uid
    ) || null;
  }, [players, userData, isUserCoach]);

  // Most recent clip featuring my player (parents) or just the latest clip (coaches).
  const featuredClip = useMemo(() => {
    if (myPlayer) {
      const mine = media.find((m: any) =>
        m.playerId === myPlayer.id ||
        (Array.isArray(m.playerIds) && m.playerIds.includes(myPlayer.id))
      );
      if (mine) return mine;
    }
    return media[0] || null;
  }, [media, myPlayer]);

  const nextEvent = upcomingEvents[0] || null;
  const recentChats = chatThreads.slice(0, 3);
  // The current user's RSVP on the next event, if they've responded.
  const myRsvp = nextEvent && userData?.uid ? (nextEvent.rsvps || {})[userData.uid] : null;

  const setMyRsvp = async (status: 'going' | 'maybe' | 'no') => {
    if (!nextEvent || !userData?.uid) return;
    const next = {
      ...(nextEvent.rsvps || {}),
      [userData.uid]: {
        status,
        name: userData.name || 'Player',
        respondedAt: new Date(),
      },
    };
    setUpcomingEvents((prev) =>
      prev.map((e) => (e.id === nextEvent.id ? ({ ...e, rsvps: next } as CalendarEvent) : e))
    );
    try {
      await updateDocument('events', nextEvent.id, { rsvps: next });
    } catch (err) {
      console.error('rsvp failed', err);
    }
  };

  // "Tomorrow at 5:00 PM" / "in 3 days" / "in 2 hours"
  const friendlyWhen = (d: Date): string => {
    const now = new Date();
    const ms = d.getTime() - now.getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins <= 5 ? 'Starting now' : `In ${mins} min`;
    const hrs = Math.round(mins / 60);
    if (hrs < 12) return `In ${hrs} hour${hrs === 1 ? '' : 's'}`;
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today at ${time}`;
    if (isTomorrow) return `Tomorrow at ${time}`;
    const days = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (days < 7) {
      return `${d.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
    }
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
  };

  // Aggregate RSVP counts for the next event. Includes BOTH authenticated
  // rsvps AND publicRsvps (guests who tapped the public share link without
  // signing in) so the head-count on the hero matches reality.
  const rsvpCounts = useMemo(() => {
    const r = (nextEvent?.rsvps || {}) as Record<string, { status: string }>;
    const pub = ((nextEvent as any)?.publicRsvps || {}) as Record<string, { status: string }>;
    let going = 0, maybe = 0, no = 0;
    const tally = (status: string) => {
      if (status === 'going') going++;
      else if (status === 'maybe') maybe++;
      else if (status === 'no') no++;
    };
    Object.values(r).forEach((v) => tally(v.status));
    Object.values(pub).forEach((v) => tally(v.status));
    const responded = going + maybe + no;
    const pending = Math.max(0, players.length - responded);
    return { going, maybe, no, pending };
  }, [nextEvent, players.length]);

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

  // --- NEW SUBTITLE: prefer something concrete over a generic welcome ---
  let subtitle: string;
  if (nextEvent) {
    const t = nextEvent.type === 'game' ? 'game' : nextEvent.type === 'practice' ? 'practice' : 'event';
    subtitle = `Next ${t}: ${friendlyWhen(new Date(nextEvent.date))}`;
  } else {
    subtitle = myPlayer
      ? `Here's what's new with ${myPlayer.name.split(' ')[0]} and the team.`
      : `Here's what's new with your team.`;
  }

  return (
    <div>
      <Header title={`${greeting}, ${firstName}!`} subtitle={subtitle} />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* ── NEXT EVENT (HERO) ─────────────────────────────────── */}
        {nextEvent ? (
          <NextEventHero
            event={nextEvent}
            whenText={friendlyWhen(new Date(nextEvent.date))}
            isCoach={isUserCoach}
            myRsvp={myRsvp?.status as any}
            onRsvp={setMyRsvp}
            counts={rsvpCounts}
          />
        ) : (
          // Slim no-event banner — keeps the page flowing into the
          // Recent chats / Your player row instead of leaving a giant
          // empty rectangle at the top.
          <div className="rounded-2xl bg-white ring-1 ring-gray-200 px-4 py-3 flex items-center gap-3">
            <span className="text-2xl">📅</span>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 text-sm">No upcoming events</p>
              <p className="text-xs text-gray-500">
                {isUserCoach ? 'Add a practice or game to get the season started.' : 'Your coach will post one soon.'}
              </p>
            </div>
            {isUserCoach && (
              <Link to="/calendar" className="bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-1.5 px-3 rounded-full text-xs whitespace-nowrap">
                ➕ Add event
              </Link>
            )}
          </div>
        )}

        {/* ── RECENT CHATS + (PARENT: Your Player) | (COACH: Team Pulse) ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RecentChatsCard chats={recentChats} userUid={userData?.uid || ''} />
          {myPlayer ? (
            <MyPlayerCard player={myPlayer} latestThumb={featuredClip ? clipThumb(featuredClip) : undefined} />
          ) : (
            <TeamPulseCard
              topScorer={topScorers[0]}
              topAssister={topAssists[0]}
              totalGoals={totalGoals}
              totalAssists={totalAssists}
              totalGames={totalGames}
              playerCount={players.length}
            />
          )}
        </div>

        {/* ── FEATURED HIGHLIGHT (one big tile) ─────────────────── */}
        {featuredClip && (
          <FeaturedHighlight clip={featuredClip} />
        )}

        {/* ── REST OF UPCOMING (compact strip if more than one) ── */}
        {upcomingEvents.length > 1 && (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-fire-950">Also coming up</h3>
              <Link to="/calendar" className="text-cyan-600 text-sm font-semibold">View all</Link>
            </div>
            <ul className="divide-y divide-gray-100">
              {upcomingEvents.slice(1).map((e) => (
                <li key={e.id}>
                  <Link to="/calendar" className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                    <div className={`flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br ${eventGradient(e.type)} flex items-center justify-center text-xl shadow-sm`}>
                      {eventEmoji(e.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{e.title}</p>
                      <p className="text-xs text-gray-500 truncate">{friendlyWhen(new Date(e.date))}{e.location ? ` · ${e.location}` : ''}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── SMALL FOOTER STATS ─────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-2">
          <FooterStat label="Players" value={players.length} />
          <FooterStat label="Goals" value={totalGoals} />
          <FooterStat label="Games" value={totalGames} />
          <FooterStat label="Clips" value={totalClips} />
        </div>
      </div>
    </div>
  );
};

// ── Replacement-era sub-components ────────────────────────────

const NextEventHero: React.FC<{
  event: CalendarEvent;
  whenText: string;
  isCoach: boolean;
  myRsvp?: 'going' | 'maybe' | 'no';
  onRsvp: (status: 'going' | 'maybe' | 'no') => void;
  counts: { going: number; maybe: number; no: number; pending: number };
}> = ({ event, whenText, isCoach, myRsvp, onRsvp, counts }) => {
  const navigate = useNavigate();
  const typeBg =
    event.type === 'game' ? 'from-rose-600 to-orange-600' :
    event.type === 'practice' ? 'from-cyan-600 to-blue-700' :
    'from-violet-600 to-fuchsia-700';
  const typeLabel =
    event.type === 'game' ? 'Game' : event.type === 'practice' ? 'Practice' : 'Event';
  // Tap on the card → calendar list view, scrolled to this event.
  // RSVP buttons stop propagation so they don't fire the navigation.
  const goToCalendar = () => navigate(`/calendar?view=list&event=${event.id}`);
  return (
    <section
      onClick={goToCalendar}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') goToCalendar(); }}
      className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${typeBg} text-white shadow-xl cursor-pointer hover:shadow-2xl active:scale-[0.995] transition`}
    >
      <div className="p-6 sm:p-7">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/15 ring-1 ring-white/20">
            {typeLabel}
          </span>
          {event.opponent && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">
              {event.homeAway === 'away' ? 'vs.' : 'vs.'} {event.opponent}
            </span>
          )}
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-white/70 inline-flex items-center gap-1">
            Open
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-black leading-tight">{event.title}</h2>
        <p className="text-white/90 text-base sm:text-lg font-semibold mt-1">{whenText}</p>
        {event.location && (
          <p className="text-white/75 text-sm mt-1">📍 {event.location}</p>
        )}

        {/* Parent RSVP */}
        {!isCoach && (
          <div className="mt-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/75 mb-2">
              {myRsvp ? `You're ${myRsvp === 'going' ? 'going' : myRsvp === 'maybe' ? 'maybe' : 'not going'}` : 'Will you be there?'}
            </p>
            <div className="flex gap-2 flex-wrap">
              {[
                { k: 'going' as const, label: '✅ Going' },
                { k: 'maybe' as const, label: '🤔 Maybe' },
                { k: 'no' as const, label: '❌ Can\'t make it' },
              ].map((b) => {
                const active = myRsvp === b.k;
                return (
                  <button
                    key={b.k}
                    onClick={(e) => { e.stopPropagation(); onRsvp(b.k); }}
                    className={`px-3.5 py-1.5 rounded-full text-sm font-semibold transition ${
                      active
                        ? 'bg-white text-fire-900 shadow'
                        : 'bg-white/15 ring-1 ring-white/25 text-white hover:bg-white/25'
                    }`}
                  >
                    {b.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Coach attendance summary */}
        {isCoach && (
          <div className="mt-5 grid grid-cols-4 gap-2">
            <AttendancePill label="Going" value={counts.going} />
            <AttendancePill label="Maybe" value={counts.maybe} />
            <AttendancePill label="Can't" value={counts.no} />
            <AttendancePill label="Pending" value={counts.pending} dim />
          </div>
        )}
      </div>
    </section>
  );
};

const AttendancePill: React.FC<{ label: string; value: number; dim?: boolean }> = ({ label, value, dim }) => (
  <div className={`rounded-xl px-3 py-2 text-center ${dim ? 'bg-white/5 ring-1 ring-white/10' : 'bg-white/15 ring-1 ring-white/20'}`}>
    <div className="text-xl font-black leading-tight">{value}</div>
    <div className="text-[10px] uppercase tracking-wider font-bold text-white/80">{label}</div>
  </div>
);

const RecentChatsCard: React.FC<{ chats: ChatThread[]; userUid: string }> = ({ chats, userUid }) => {
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-bold text-fire-950">💬 Recent chats</h3>
        <Link to="/chat" className="text-cyan-600 text-sm font-semibold">Open chat</Link>
      </div>
      {chats.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-500">No conversations yet.</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {chats.map((thread: any) => {
            const isDM = thread.isDM === true;
            const otherUid = isDM ? (thread.participants || []).find((u: string) => u !== userUid) : null;
            const displayTitle = isDM
              ? (thread.dmParticipantNames?.[otherUid] || thread.title.replace(/^DM:\s*/, ''))
              : thread.title;
            const initial = (displayTitle || '?').charAt(0).toUpperCase();
            let hash = 0;
            for (let i = 0; i < (displayTitle || '').length; i++) hash = (hash * 31 + displayTitle.charCodeAt(i)) >>> 0;
            const palette = ['bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-cyan-500', 'bg-violet-500', 'bg-blue-500', 'bg-teal-500'];
            const avatarBg = palette[hash % palette.length];
            const last = thread.lastMessage;
            return (
              <li key={thread.id}>
                <Link to={`/chat?thread=${thread.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                  <div className={`flex-shrink-0 w-10 h-10 rounded-full text-white font-bold flex items-center justify-center shadow-sm ${avatarBg}`}>
                    {initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900 truncate">{displayTitle}</p>
                      <span className="text-[10px] text-gray-400 flex-shrink-0">{relativeTime(new Date(thread.lastActivity))}</span>
                    </div>
                    <p className="text-sm text-gray-500 truncate">
                      {last?.senderName ? <span className="font-medium text-gray-700">{last.senderName}: </span> : null}
                      {last?.content || (isDM ? 'Tap to start chatting' : 'No messages yet')}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const MyPlayerCard: React.FC<{ player: Player; latestThumb?: string }> = ({ player, latestThumb }) => {
  const p: any = player;
  return (
    <Link
      to={`/player/${player.id}`}
      className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden hover:shadow-md transition flex flex-col"
    >
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-bold text-fire-950">⚽ Your player</h3>
        <span className="text-cyan-600 text-sm font-semibold">View profile →</span>
      </div>
      <div className="p-5 flex items-center gap-4">
        <div className="relative flex-shrink-0">
          {p.profilePhotoUrl ? (
            <img
              src={p.profilePhotoUrl}
              alt={player.name}
              className="w-20 h-20 rounded-2xl object-cover ring-2 ring-fire-100"
              loading="lazy"
            />
          ) : (
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center text-white text-3xl font-black ring-2 ring-fire-100">
              {player.name.charAt(0)}
            </div>
          )}
          {player.jerseyNumber != null && (
            <span className="absolute -bottom-1 -right-1 px-1.5 py-0.5 rounded-md bg-fire-900 text-white text-[10px] font-black ring-2 ring-white">
              #{player.jerseyNumber}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-lg text-fire-950 truncate">{player.name}</p>
          <p className="text-xs text-gray-500 mb-2">{player.position || 'Player'}</p>
          <div className="flex gap-3 text-sm">
            <span className="font-bold text-emerald-700">{player.stats?.goals || 0} <span className="text-gray-500 font-medium">goals</span></span>
            <span className="font-bold text-cyan-700">{player.stats?.assists || 0} <span className="text-gray-500 font-medium">assists</span></span>
          </div>
        </div>
      </div>
      {latestThumb && (
        <div className="aspect-[16/7] bg-gray-100 overflow-hidden">
          <img src={latestThumb} alt="" className="w-full h-full object-cover" loading="lazy" />
        </div>
      )}
    </Link>
  );
};

const TeamPulseCard: React.FC<{
  topScorer?: Player;
  topAssister?: Player;
  totalGoals: number;
  totalAssists: number;
  totalGames: number;
  playerCount: number;
}> = ({ topScorer, topAssister, totalGoals, totalAssists, totalGames, playerCount }) => {
  const ts: any = topScorer;
  const ta: any = topAssister;
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden flex flex-col">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-bold text-fire-950">📊 Team pulse</h3>
        <Link to="/stats" className="text-cyan-600 text-sm font-semibold">Stats →</Link>
      </div>
      <div className="p-5 space-y-3 flex-1">
        {topScorer && (
          <Link to={`/player/${topScorer.id}`} className="flex items-center gap-3 p-2 rounded-xl hover:bg-emerald-50/60 transition">
            <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-amber-300 to-yellow-500 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
              {ts.profilePhotoUrl ? (
                <img src={ts.profilePhotoUrl} alt={topScorer.name} className="w-full h-full object-cover" />
              ) : (
                <span>{topScorer.name.charAt(0)}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Top scorer</p>
              <p className="font-bold text-fire-950 truncate">{topScorer.name}</p>
            </div>
            <div className="text-right">
              <p className="font-black text-emerald-700 leading-tight">{topScorer.stats?.goals || 0}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">goals</p>
            </div>
          </Link>
        )}
        {topAssister && topAssister.id !== topScorer?.id && (
          <Link to={`/player/${topAssister.id}`} className="flex items-center gap-3 p-2 rounded-xl hover:bg-cyan-50/60 transition">
            <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
              {ta.profilePhotoUrl ? (
                <img src={ta.profilePhotoUrl} alt={topAssister.name} className="w-full h-full object-cover" />
              ) : (
                <span>{topAssister.name.charAt(0)}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Top assister</p>
              <p className="font-bold text-fire-950 truncate">{topAssister.name}</p>
            </div>
            <div className="text-right">
              <p className="font-black text-cyan-700 leading-tight">{topAssister.stats?.assists || 0}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">assists</p>
            </div>
          </Link>
        )}
        {!topScorer && !topAssister && (
          <p className="text-sm text-gray-500 text-center py-2">Log a game to see who's leading the team.</p>
        )}
      </div>
    </div>
  );
};

const FeaturedHighlight: React.FC<{ clip: any }> = ({ clip }) => {
  const thumb = clipThumb(clip);
  return (
    <Link
      to={`/player-media?clip=${clip.id}`}
      className="block relative overflow-hidden rounded-3xl ring-1 ring-gray-200 bg-gray-900 group"
    >
      <div className="aspect-[16/9] sm:aspect-[16/7]">
        {thumb ? (
          <img src={thumb} alt={clip.caption || clip.playerName} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-6xl">🎬</div>
        )}
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 p-5 text-white">
        <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1">
          {clip.type === 'video' ? '▶ Latest highlight' : '📸 Latest photo'}
        </p>
        <p className="text-lg font-black truncate">{clip.caption || clip.playerName || 'Team highlight'}</p>
        {clip.playerName && clip.caption && (
          <p className="text-sm text-white/80 truncate">{clip.playerName}</p>
        )}
      </div>
    </Link>
  );
};

const FooterStat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-white rounded-xl ring-1 ring-gray-200 px-3 py-2 text-center">
    <div className="text-xl font-black text-fire-950 leading-tight">{value}</div>
    <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">{label}</div>
  </div>
);

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default Dashboard;
