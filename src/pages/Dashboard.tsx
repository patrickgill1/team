// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, CalendarEvent, PlayerMedia as PlayerMediaType } from '../types';
import { formatDateTime, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import DashboardHero from '../components/common/DashboardHero';
import InThePoolHero from '../components/dashboard/InThePoolHero';
import NotificationsBanner from '../components/common/NotificationsBanner';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { streamThumbnailUrl } from '../utils/streamUpload';
import { ChatThread } from '../types';
import { getWeatherForEvent, WeatherSummary } from '../utils/weather';

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
    getDocuments,
  } = useFirestore();

  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState<Player[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  // Tonight's session — the next unfinished dev plan goal for my
  // linked player (parent OR coach-with-kid). One-tap into the drill
  // detail so a family with 15 minutes can just start.
  const [tonightGoal, setTonightGoal] = useState<{
    planId: string;
    goalId: string;
    planTitle: string;
    goalTitle: string;
    focus?: string;
    durationMinutes?: number;
    loggedToday: boolean;
  } | null>(null);
  // Wall posts = docs in the wall_posts collection (its own surface,
  // separate from chat). The dashboard surfaces the 5 most recent.
  const [wallPosts, setWallPosts] = useState<Array<{ id: string; threadId: string; content: string; senderName: string; senderRole?: string; timestamp: Date }>>([]);
  // uid → photoURL map used by the Recent Chats card to render real
  // avatars on DMs (and any future thread types that want a per-user
  // photo). Built once from the users collection per team selection.
  const [userPhotoMap, setUserPhotoMap] = useState<Record<string, string>>({});

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
          // Cancelled events still show on /calendar with a banner, but
          // the Dashboard hero is "what's next" — surfacing a cancelled
          // event there is misleading.
          .filter(ev => new Date(ev.date) >= new Date() && !(ev as any).isCancelled)
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

  // Build a uid → photoURL map for the Recent Chats card so DM rows
  // render real avatars. One-shot fetch — photos rarely change, and
  // re-subscribing for every dashboard refresh would be wasteful.
  useEffect(() => {
    if (!selectedTeamId) return;
    let cancelled = false;
    (async () => {
      try {
        const allUsers = await getDocuments('users', []);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const u of allUsers as any[]) {
          const uid = u?.uid || u?.id;
          if (uid && u?.photoURL) map[uid] = u.photoURL;
        }
        setUserPhotoMap(map);
      } catch { /* fallback to colored initials — not fatal */ }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments]);

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

  // Subscribe to the team's wall_posts collection — the wall has its
  // own surface now (not piggybacking on chat). Show the 5 most
  // recent so the dashboard surfaces today's announcements.
  useEffect(() => {
    if (!selectedTeamId) { setWallPosts([]); return; }
    let cancelled = false;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const { collection, onSnapshot, query, where, orderBy, limit } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const q = query(
          collection(db, 'wall_posts'),
          where('teamId', '==', selectedTeamId),
          orderBy('timestamp', 'desc'),
          limit(5),
        );
        unsub = onSnapshot(q, (snap) => {
          if (cancelled) return;
          const posts = snap.docs.map(d => {
            const data = d.data() as any;
            return {
              id: d.id,
              threadId: '',
              content: (data.content as string) || '',
              senderName: data.senderName as string,
              senderRole: data.senderRole as string | undefined,
              timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
            };
          });
          setWallPosts(posts);
        }, (err) => console.warn('wall posts subscribe failed', err));
      } catch (err) {
        console.warn('wall posts load failed', err);
      }
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [selectedTeamId]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  // Hero summary metrics.
  // Unread chat count = sum of per-user unread counts across visible threads.
  const newMessagesCount = useMemo(() => {
    if (!userData?.uid) return 0;
    return chatThreads.reduce((sum, t: any) => {
      const u = t?.unreadCount?.[userData.uid];
      return sum + (typeof u === 'number' ? u : 0);
    }, 0);
  }, [chatThreads, userData?.uid]);


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
  // Coaches with a kid on the team count too — the parentIds array on
  // a player is the source of truth, regardless of the user's role.
  const myPlayer = useMemo(() => {
    if (!userData) return null;
    return players.find((p: any) =>
      (Array.isArray(p.parentIds) && p.parentIds.includes(userData.uid)) ||
      p.parentId === userData.uid
    ) || null;
  }, [players, userData]);

  // Load the next-up development goal for my player. Picks the first
  // unfinished goal of the most recent active plan. Updates whenever
  // myPlayer changes (e.g., switching teams).
  useEffect(() => {
    if (!myPlayer) { setTonightGoal(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection: fsColl, query, where, getDocs, orderBy } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          fsColl(db, 'development_plans'),
          where('playerId', '==', myPlayer.id),
          where('status', '==', 'active'),
          orderBy('createdAt', 'desc'),
        ));
        if (cancelled) return;
        const plans = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
        for (const plan of plans) {
          const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
          const next = goals.find(g => !g.coachVerified);
          if (next) {
            const loggedToday = (next.practiceLog || []).some((l: any) => {
              const t = l.date?.toDate ? l.date.toDate().getTime() : new Date(l.date).getTime();
              return t >= todayStart;
            });
            setTonightGoal({
              planId: plan.id,
              goalId: next.id,
              planTitle: plan.title || 'Plan',
              goalTitle: next.title || 'Practice goal',
              focus: next.focus,
              durationMinutes: next.targetMinutes,
              loggedToday,
            });
            return;
          }
        }
        setTonightGoal(null);
      } catch (err) {
        console.warn('tonight goal load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [myPlayer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Weather lookup for the next event — best-effort, only renders a chip
  // on the card if we get something back within ~16 days.
  const [nextEventWeather, setNextEventWeather] = useState<WeatherSummary | null>(null);
  useEffect(() => {
    setNextEventWeather(null);
    if (!nextEvent?.location) return;
    let cancelled = false;
    (async () => {
      try {
        const w = await getWeatherForEvent(nextEvent.location, new Date(nextEvent.date));
        if (!cancelled) setNextEventWeather(w);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [nextEvent?.id, nextEvent?.location, nextEvent?.date]);

  // Is the next event happening today + is it a game? Drives the
  // "GAME DAY" pulse on the next-event card.
  const isGameDayToday = useMemo(() => {
    if (!nextEvent) return false;
    if (nextEvent.type !== 'game') return false;
    const d = new Date(nextEvent.date);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }, [nextEvent]);

  // Birthday today: any active player whose DOB month/day matches.
  // Surfaces as a pill below the greeting.
  const birthdayKids = useMemo(() => {
    const today = new Date();
    return players.filter((p: any) => {
      const dob = p.dateOfBirth instanceof Date ? p.dateOfBirth : (p.dateOfBirth ? new Date(p.dateOfBirth) : null);
      if (!dob || isNaN(dob.getTime())) return false;
      return dob.getMonth() === today.getMonth() && dob.getDate() === today.getDate();
    }).map((p: any) => {
      const dob = p.dateOfBirth instanceof Date ? p.dateOfBirth : new Date(p.dateOfBirth);
      // "Turning age": birthday this year minus birth year.
      const turning = today.getFullYear() - dob.getFullYear();
      return { id: p.id, name: p.name, turning };
    });
  }, [players]);

  // Season countdown: weeks remaining until the active season's endDate.
  // Subtle line under the greeting; hidden if no active season or the
  // season is already over.
  const seasonCountdown = useMemo(() => {
    if (!activeSeason?.endDate) return null;
    const end = activeSeason.endDate instanceof Date
      ? activeSeason.endDate
      : new Date((activeSeason.endDate as any)?.toDate?.() || activeSeason.endDate as any);
    if (isNaN(end.getTime())) return null;
    const ms = end.getTime() - Date.now();
    if (ms <= 0) return null;
    const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
    if (days <= 14) {
      return `${days} day${days === 1 ? '' : 's'} left in ${activeSeason.name || 'the season'}`;
    }
    const weeks = Math.ceil(days / 7);
    return `${weeks} weeks left in ${activeSeason.name || 'the season'}`;
  }, [activeSeason]);

  // Rain alert on the next event: precip% > 60 and event is within a week.
  const nextEventRainAlert = useMemo(() => {
    if (!nextEvent || !nextEventWeather) return null;
    if (nextEventWeather.precipChance <= 60) return null;
    const d = new Date(nextEvent.date);
    const days = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days > 7) return null;
    const isCold = nextEventWeather.tempMinF < 55;
    if (nextEvent.type === 'practice') {
      return isCold ? 'Bring layers — chance of rain' : 'Bring rain gear';
    }
    return isCold ? `${nextEventWeather.precipChance}% rain — pack layers` : `${nextEventWeather.precipChance}% chance of rain`;
  }, [nextEvent, nextEventWeather]);
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

  // Aggregate RSVP counts for the next event. Players only — same rule
  // as EventDetail and EventListCard. Adult event.rsvps no longer
  // contributes to the count (was leaving the hero saying "6 going"
  // when only 3 kids were actually going + 3 parents had self-RSVPed).
  const rsvpCounts = useMemo(() => {
    const playerR = ((nextEvent as any)?.playerRsvps || {}) as Record<string, { status: string }>;
    const pub = ((nextEvent as any)?.publicRsvps || {}) as Record<string, { status: string }>;
    let going = 0, maybe = 0, no = 0;
    const tally = (status: string) => {
      if (status === 'going') going++;
      else if (status === 'maybe') maybe++;
      else if (status === 'no') no++;
    };
    Object.values(playerR).forEach((v) => tally(v.status));
    Object.values(pub).forEach((v) => tally(v.status));
    const respondedPlayers = Object.keys(playerR).length;
    const pending = Math.max(0, players.length - respondedPlayers);
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

  const subtitle = `Here's what's happening with your team.`;

  // "In the pool" detection — a parent who registered through the new
  // auth-gated /register but hasn't been rostered on any team yet.
  // Without this, they'd land on a mostly-empty team dashboard with
  // no team selected and no obvious next step. Replaces the entire
  // hero + roster surface with a status-focused view.
  const isUnrosteredParent = !isUserCoach
    && !selectedTeamId
    && (!(userData as any)?.teamIds || (userData as any).teamIds.length === 0);
  if (isUnrosteredParent) {
    return <InThePoolHero firstName={firstName} email={userData?.email} />;
  }

  return (
    <div className="relative">
      {/* Stadium hero — navy scene with floodlights that toggle on
          at dusk/night, a faint pitch silhouette, and the day's
          most important glance-able info (next-event RSVP count,
          unread chats, fresh photos). Replaces the standalone
          greeting + the Next Event card. */}
      <DashboardHero
        greeting={greeting}
        firstName={firstName}
        nextEvent={nextEvent}
        goingCount={rsvpCounts.going}
        pendingRsvpCount={rsvpCounts.pending}
        whenText={nextEvent ? friendlyWhen(new Date(nextEvent.date)) : ''}
        newMessagesCount={newMessagesCount}
        weather={nextEventWeather}
        playerCount={players.length}
        isCoach={isUserCoach}
      />
      <div className="relative">

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* Show the push-permission banner first when the user has no
            FCM tokens. Self-hides when not needed. */}
        <NotificationsBanner />

        {/* Ambient cues right under the greeting — birthday pill,
            season countdown. Tiny, but they make the page feel alive. */}
        {(birthdayKids.length > 0 || seasonCountdown) && (
          <div className="flex items-center gap-2 flex-wrap -mt-3">
            {birthdayKids.map((k) => (
              <Link
                key={k.id}
                to={`/player/${k.id}`}
                className="inline-flex items-center gap-1.5 bg-gradient-to-r from-amber-100 to-pink-100 ring-1 ring-amber-300 text-amber-900 px-3 py-1 rounded-full text-xs font-bold shadow-sm hover:shadow transition active:scale-95"
              >
                <span className="text-base leading-none">🎂</span>
                <span>{k.name.split(' ')[0]} turns {k.turning} today</span>
              </Link>
            ))}
            {seasonCountdown && (
              <span className="inline-flex items-center gap-1.5 bg-white/80 ring-1 ring-gray-200 text-gray-700 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur">
                <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" d="M12 7v5l3 2" />
                </svg>
                {seasonCountdown}
              </span>
            )}
          </div>
        )}
        {/* The no-event empty state lives in DashboardHero now — no
            second card needed here. */}

        {/* Player card sits full-width when a user has a linked player
            on this team (parent OR coach-with-kid). */}
        {myPlayer && tonightGoal && (
          <Link
            to={`/development?expand=${encodeURIComponent(tonightGoal.planId)}`}
            className="block bg-gradient-to-br from-cyan-600 via-cyan-700 to-violet-700 text-white rounded-2xl shadow-lg hover:shadow-xl transition px-5 py-4"
          >
            <div className="flex items-center gap-3">
              <span className="flex-shrink-0 w-10 h-10 rounded-full bg-white/15 ring-1 ring-white/30 flex items-center justify-center">
                {tonightGoal.loggedToday ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">
                  {tonightGoal.loggedToday ? "Today's session logged" : "Tonight's session"}
                </div>
                <div className="text-base sm:text-lg font-bold leading-tight truncate">
                  {tonightGoal.goalTitle}
                </div>
                {tonightGoal.focus && (
                  <div className="text-xs opacity-90 mt-0.5 line-clamp-1">Focus: {tonightGoal.focus}</div>
                )}
              </div>
              <span className="flex-shrink-0 text-right">
                {tonightGoal.durationMinutes != null && (
                  <div className="text-xs font-bold opacity-90">{tonightGoal.durationMinutes} min</div>
                )}
                <svg className="w-5 h-5 ml-auto mt-1 opacity-80" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
              </span>
            </div>
          </Link>
        )}
        {myPlayer && (
          <MyPlayerCard player={myPlayer} latestThumb={featuredClip ? clipThumb(featuredClip) : undefined} />
        )}

        {/* ── TEAM WALL / ANNOUNCEMENTS ──────────────────────────────
            Pinned messages from any of the team's chat threads, sorted
            newest first. Surfaces here so a parent who only checks the
            dashboard still sees announcements coaches posted in chat.
            Tap a card → deep-links into the chat tab on that thread. */}
        {wallPosts.length > 0 && (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-fire-950 flex items-center gap-2">
                <svg className="w-4 h-4 text-cyan-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 2v6"/><path d="M12 8l-3 3h6z"/><rect x="3" y="11" width="18" height="11" rx="2"/></svg>
                Announcements
              </h3>
              <Link to="/wall" className="text-cyan-600 text-sm font-semibold">View all</Link>
            </div>
            <ul className="divide-y divide-gray-100">
              {wallPosts.map(p => (
                <li key={p.id}>
                  <Link
                    to="/wall"
                    className="block px-5 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-bold text-fire-950">{p.senderName}</span>
                      {p.senderRole === 'coach' && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Coach</span>
                      )}
                      <span className="text-[11px] text-gray-400 ml-auto">
                        {p.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 line-clamp-3">{p.content}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── RECENT CHATS + TEAM PULSE ──────────────────────────────
            Coaches and admins always see Team Pulse. Parents without a
            linked player also see Team Pulse (so non-staff still see
            who's leading the team). */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RecentChatsCard chats={recentChats} userUid={userData?.uid || ''} userPhotoMap={userPhotoMap} />
          {(isUserCoach || !myPlayer) && (
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

        {/* ── FOOTER STATS GRID ──────────────────────────────────
            4-up tiles with iconized accents. Match the design's
            people / soccer ball / field / video icons in tinted
            squares. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <FooterStat
            label="Players"
            value={players.length}
            tint="bg-slate-100 text-slate-600"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19a3 3 0 00-6 0M12 11a4 4 0 100-8 4 4 0 000 8zm6 0a3 3 0 100-6 3 3 0 000 6zm-12 0a3 3 0 100-6 3 3 0 000 6z" />
              </svg>
            }
          />
          <FooterStat
            label="Goals"
            value={totalGoals}
            tint="bg-emerald-50 text-emerald-700"
            icon={<span className="text-base">⚽</span>}
          />
          <FooterStat
            label="Games"
            value={totalGames}
            tint="bg-amber-50 text-amber-700"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect x="3" y="6" width="18" height="12" rx="2" />
                <line x1="12" y1="6" x2="12" y2="18" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            }
          />
          <FooterStat
            label="Clips"
            value={totalClips}
            tint="bg-violet-50 text-violet-700"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <rect x="3" y="5" width="14" height="14" rx="2" />
                <path d="M17 9l4-2v10l-4-2V9z" />
              </svg>
            }
          />
        </div>
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
  weather?: WeatherSummary | null;
  isGameDayToday?: boolean;
  rainAlert?: string | null;
}> = ({ event, whenText, isCoach, myRsvp, onRsvp, counts, weather, isGameDayToday, rainAlert }) => {
  const navigate = useNavigate();
  const goToCalendar = () => navigate(`/calendar?view=list&event=${event.id}`);
  const date = new Date(event.date);
  const month = date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  const day = date.getDate();
  const dow = date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fullDate = `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`;
  const tileGradient =
    event.type === 'game' ? 'from-rose-500 to-orange-600' :
    event.type === 'practice' ? 'from-cyan-500 to-blue-600' :
    'from-violet-500 to-fuchsia-600';
  return (
    <section
      onClick={goToCalendar}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') goToCalendar(); }}
      className={`relative overflow-hidden rounded-2xl bg-white shadow-sm cursor-pointer hover:shadow-md active:scale-[0.995] transition ${
        isGameDayToday
          ? 'ring-2 ring-rose-400 ring-offset-2 shadow-[0_0_30px_-8px_rgba(244,63,94,0.55)] animate-pulse-soft'
          : 'ring-1 ring-gray-200'
      }`}
      style={{ borderLeft: `4px solid ${isGameDayToday ? '#f43f5e' : '#06b6d4'}` }}
    >
      {/* GAME DAY ribbon — pulses subtly when today's event is a game */}
      {isGameDayToday && (
        <span className="absolute top-2.5 right-3 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-rose-700 bg-rose-50 ring-1 ring-rose-300 px-2 py-0.5 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
          Game day
        </span>
      )}
      <div className="p-4 sm:p-5 flex items-stretch gap-4">
        {/* Date tile */}
        <div className={`flex-shrink-0 w-16 sm:w-20 rounded-xl bg-gradient-to-br ${tileGradient} text-white text-center flex flex-col justify-center shadow-sm`}>
          <div className="text-[10px] font-bold uppercase tracking-wider opacity-90">{month}</div>
          <div className="text-2xl sm:text-3xl font-black leading-none">{day}</div>
          <div className="text-[10px] font-bold uppercase tracking-wider opacity-90">{dow}</div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-600 mb-0.5">Next event</p>
          <h2 className="text-lg sm:text-xl font-black text-gray-900 leading-tight truncate">{event.title}</h2>
          <p className="text-sm text-gray-600 mt-1 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="truncate">{fullDate}</span>
          </p>
          {event.location && (
            <p className="text-sm text-gray-600 mt-0.5 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="truncate">{event.location}</span>
            </p>
          )}
          {/* Weather forecast pill (subtle) + optional louder rain alert
              if precip is heavy. Both pull from the same Open-Meteo
              lookup; rain alert takes priority when it's worth flagging. */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {weather && (
              <span className="text-xs text-gray-500 inline-flex items-center gap-1 bg-gray-50 ring-1 ring-gray-200 px-2 py-0.5 rounded-full">
                <span>{weather.icon}</span>
                <span className="font-semibold">{Math.round(weather.tempMaxF)}°</span>
                <span className="text-gray-400">/</span>
                <span>{Math.round(weather.tempMinF)}°</span>
              </span>
            )}
            {rainAlert && (
              <span className="text-xs inline-flex items-center gap-1 bg-sky-50 text-sky-800 ring-1 ring-sky-300 px-2 py-0.5 rounded-full font-bold">
                <span>☔</span>
                <span>{rainAlert}</span>
              </span>
            )}
          </div>
        </div>

        {/* Right rail: status + action */}
        <div className="flex flex-col items-end justify-between gap-2 flex-shrink-0">
          {!isCoach && myRsvp === 'going' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 text-xs font-bold whitespace-nowrap">
              ✓ RSVP'd
            </span>
          )}
          {!isCoach && myRsvp === 'maybe' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 text-xs font-bold whitespace-nowrap">
              ? Maybe
            </span>
          )}
          {!isCoach && myRsvp === 'no' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 ring-1 ring-rose-200 text-xs font-bold whitespace-nowrap">
              ✕ Can't
            </span>
          )}
          {isCoach && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 text-xs font-bold whitespace-nowrap">
              {counts.going} going
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); goToCalendar(); }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-cyan-50 hover:bg-cyan-100 text-cyan-700 ring-1 ring-cyan-200 text-xs font-bold whitespace-nowrap transition"
          >
            View details
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Inline RSVP buttons (parent only) — render below the main row
          when the parent hasn't RSVP'd yet, so they can do it in one
          tap without leaving the dashboard. */}
      {!isCoach && !myRsvp && (
        <div className="px-4 sm:px-5 pb-4 -mt-1" onClick={(e) => e.stopPropagation()}>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Will you be there?</p>
          <div className="flex gap-1.5">
            {[
              { k: 'going' as const, label: '✓ Going', bg: 'bg-emerald-600 hover:bg-emerald-700' },
              { k: 'maybe' as const, label: '? Maybe', bg: 'bg-amber-500 hover:bg-amber-600' },
              { k: 'no' as const, label: '✕ Can\'t', bg: 'bg-rose-600 hover:bg-rose-700' },
            ].map((b) => (
              <button
                key={b.k}
                onClick={(e) => { e.stopPropagation(); onRsvp(b.k); }}
                className={`flex-1 px-3 py-1.5 rounded-full text-xs font-bold text-white shadow-sm transition active:scale-95 ${b.bg}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

const AttendancePill: React.FC<{ label: string; value: number; dim?: boolean }> = ({ label, value, dim }) => (
  <div className={`rounded-xl px-3 py-2 text-center ${dim ? 'bg-white/5 ring-1 ring-white/10' : 'bg-white/15 ring-1 ring-white/20'}`}>
    <div className="text-xl font-black leading-tight">{value}</div>
    <div className="text-[10px] uppercase tracking-wider font-bold text-white/80">{label}</div>
  </div>
);

const RecentChatsCard: React.FC<{ chats: ChatThread[]; userUid: string; userPhotoMap?: Record<string, string> }> = ({ chats, userUid, userPhotoMap }) => {
  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-bold text-fire-950 flex items-center gap-2">
          <svg className="w-4 h-4 text-cyan-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Recent chats
        </h3>
        <Link to="/chat" className="text-cyan-600 text-sm font-semibold">View all</Link>
      </div>
      {chats.length === 0 ? (
        <div className="p-5 text-center">
          <p className="text-sm font-semibold text-slate-700">No conversations yet</p>
          <p className="text-xs text-slate-500 mt-0.5">DMs and group chats will show up here.</p>
        </div>
      ) : (
        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {chats.slice(0, 2).map((thread: any) => {
            const isDM = thread.isDM === true;
            const otherUid = isDM ? (thread.participants || []).find((u: string) => u !== userUid) : null;
            const displayTitle = isDM
              ? (thread.dmParticipantNames?.[otherUid] || thread.title.replace(/^DM:\s*/, ''))
              : thread.title;
            const initial = (displayTitle || '?').charAt(0).toUpperCase();
            let hash = 0;
            for (let i = 0; i < (displayTitle || '').length; i++) hash = (hash * 31 + displayTitle.charCodeAt(i)) >>> 0;
            // Brand-coherent two-tone fallback — cyan for DMs you've
            // got a photo for and slate for everyone else. No rainbow.
            const palette = ['bg-cyan-600', 'bg-slate-600'];
            const avatarBg = palette[hash % palette.length];
            // For DMs, show the other participant's real photo when we have it.
            const dmPhotoUrl = isDM && otherUid ? userPhotoMap?.[otherUid] : undefined;
            const last = thread.lastMessage;
            // Unread indicator: anyone sent something more recently than us
            // having seen it. Without proper read-tracking we approximate
            // by "the last message wasn't from me".
            const unread = !!(last && last.senderName && last.senderName !== '');
            return (
              <Link
                key={thread.id}
                to={`/chat?thread=${thread.id}`}
                className="flex items-start gap-2.5 p-2.5 rounded-xl hover:bg-gray-50 active:bg-gray-100 transition"
              >
                {dmPhotoUrl ? (
                  <img
                    src={dmPhotoUrl}
                    alt={displayTitle}
                    className="flex-shrink-0 w-9 h-9 rounded-full object-cover shadow-sm ring-1 ring-black/5"
                    onError={(e) => {
                      // 404'd photo → swap to the colored-initial sibling.
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                      const sib = (e.currentTarget as HTMLImageElement).nextElementSibling as HTMLElement | null;
                      if (sib) sib.style.display = 'flex';
                    }}
                  />
                ) : null}
                <div
                  className={`flex-shrink-0 w-9 h-9 rounded-full text-white font-bold text-sm flex items-center justify-center shadow-sm ${avatarBg}`}
                  style={dmPhotoUrl ? { display: 'none' } : undefined}
                >
                  {initial}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-1.5">
                    <p className="font-semibold text-gray-900 text-sm truncate">{displayTitle}</p>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{relativeTime(new Date(thread.lastActivity))}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <p className="text-xs text-gray-500 truncate flex-1">
                      {last?.senderName ? <span className="font-medium text-gray-700">{last.senderName}: </span> : null}
                      {last?.content || (isDM ? 'Tap to start chatting' : 'No messages yet')}
                    </p>
                    {unread && <span className="flex-shrink-0 w-2 h-2 rounded-full bg-cyan-500" />}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};

const MyPlayerCard: React.FC<{ player: Player; latestThumb?: string }> = ({ player, latestThumb }) => {
  const p: any = player;
  const position = p.positions?.[0] || p.position || 'Player';
  return (
    <Link
      to={`/player/${player.id}`}
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-fire-950 via-navy-900 to-fire-950 text-white shadow-lg hover:shadow-xl active:scale-[0.995] transition flex"
    >
      {/* Subtle Fire FC logo watermark on the right */}
      <img
        src="/images/logo.png"
        alt=""
        className="absolute -right-6 top-1/2 -translate-y-1/2 w-40 h-40 opacity-[0.08] pointer-events-none"
        aria-hidden
      />
      <div className="relative p-4 sm:p-5 flex items-center gap-4 w-full">
        {/* Avatar */}
        <div className="relative flex-shrink-0">
          {p.profilePhotoUrl ? (
            <img
              src={p.profilePhotoUrl}
              alt={player.name}
              className="w-20 h-20 rounded-full object-cover ring-2 ring-white/20 shadow"
              loading="lazy"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-cyan-400 to-blue-700 flex items-center justify-center text-white text-3xl font-black ring-2 ring-white/20 shadow">
              {player.name.charAt(0)}
            </div>
          )}
        </div>

        {/* Name + stats */}
        <div className="flex-1 min-w-0">
          <p className="text-xl sm:text-2xl font-black leading-tight truncate">{player.name}</p>
          <p className="text-xs text-white/70 mb-3">
            {player.jerseyNumber != null ? `#${player.jerseyNumber} · ` : ''}{position}
          </p>
          <div className="flex items-end gap-4 sm:gap-6">
            <div>
              <p className="text-2xl font-black leading-none">{player.stats?.goals || 0}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/60 mt-0.5">Goals</p>
            </div>
            <div>
              <p className="text-2xl font-black leading-none">{player.stats?.assists || 0}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/60 mt-0.5">Assists</p>
            </div>
            <div>
              <p className="text-2xl font-black leading-none">{player.stats?.gamesPlayed || 0}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/60 mt-0.5">Games</p>
            </div>
          </div>
        </div>

        {/* View profile pill */}
        <div className="flex-shrink-0 self-center">
          <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-white text-fire-950 text-xs font-bold whitespace-nowrap shadow">
            View profile
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
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
    <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-bold text-fire-950 flex items-center gap-2">
          <span>📊</span> Team pulse
        </h3>
        <Link to="/stats" className="text-cyan-600 text-sm font-semibold">Season stats</Link>
      </div>

      {/* Live game tracker entry point — coach can start a session
          without needing a scheduled game on the calendar. */}
      <Link
        to={`/game-day/quick_${Date.now()}`}
        className="mx-4 mt-4 p-3 rounded-xl bg-gradient-to-r from-emerald-50 to-cyan-50 ring-1 ring-emerald-200 flex items-center gap-3 hover:from-emerald-100 hover:to-cyan-100 transition active:scale-[0.99]"
      >
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 text-white flex items-center justify-center text-lg shadow-sm flex-shrink-0">
          🎯
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-fire-950 text-sm">Live game tracker</p>
          <p className="text-xs text-gray-600">Scores, goals &amp; subs · works on any game</p>
        </div>
        <svg className="w-4 h-4 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </Link>

      {/* Top scorer + assister — side by side */}
      {(topScorer || topAssister) && (
        <div className="p-4 grid grid-cols-2 gap-3">
          {topScorer && (
            <Link to={`/player/${topScorer.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-emerald-50/60 transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-amber-300 to-yellow-500 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ts.profilePhotoUrl ? (
                  <img src={ts.profilePhotoUrl} alt={topScorer.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topScorer.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Top scorer</p>
                <p className="font-bold text-fire-950 text-sm truncate">{topScorer.name}</p>
                <p className="text-xs text-emerald-700 font-bold">
                  <span className="font-black">{topScorer.stats?.goals || 0}</span>{' '}
                  <span className="text-gray-500 font-medium uppercase tracking-wider text-[10px]">goals</span>
                </p>
              </div>
            </Link>
          )}
          {topAssister && topAssister.id !== topScorer?.id && (
            <Link to={`/player/${topAssister.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-cyan-50/60 transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ta.profilePhotoUrl ? (
                  <img src={ta.profilePhotoUrl} alt={topAssister.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topAssister.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Top assister</p>
                <p className="font-bold text-fire-950 text-sm truncate">{topAssister.name}</p>
                <p className="text-xs text-cyan-700 font-bold">
                  <span className="font-black">{topAssister.stats?.assists || 0}</span>{' '}
                  <span className="text-gray-500 font-medium uppercase tracking-wider text-[10px]">assists</span>
                </p>
              </div>
            </Link>
          )}
        </div>
      )}
      {!topScorer && !topAssister && (
        <p className="p-5 text-sm text-gray-500 text-center">Log a game to see who's leading the team.</p>
      )}
    </div>
  );
};

const FeaturedHighlight: React.FC<{ clip: any }> = ({ clip }) => {
  const thumb = clipThumb(clip);
  const duration = clip.durationSeconds || clip.duration;
  const formatDuration = (s: number) => {
    if (!s || isNaN(s)) return null;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };
  const durText = typeof duration === 'number' ? formatDuration(duration) : null;
  // Opponent context for games: "vs <opponent>" or fall back to player name.
  const ctxLine = clip.opponent ? `vs ${clip.opponent}` : (clip.playerName && clip.caption ? clip.playerName : null);
  const headline = clip.caption || clip.playerName || 'Team highlight';
  return (
    <Link
      to={`/player-media?clip=${clip.id}`}
      className="block relative overflow-hidden rounded-2xl ring-1 ring-gray-200 bg-gray-900 group shadow-sm"
    >
      <div className="aspect-[16/9] sm:aspect-[16/8]">
        {thumb ? (
          <img src={thumb} alt={headline} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-6xl">🎬</div>
        )}
      </div>
      {/* Dim overlay so text stays readable on bright thumbnails */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 to-black/40" />

      {/* Top-left: label + headline */}
      <div className="absolute top-4 sm:top-5 left-4 sm:left-5 right-32 text-white">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-cyan-300 mb-1">Latest highlight</p>
        <p className="text-2xl sm:text-3xl font-black leading-tight drop-shadow">{headline}</p>
        {ctxLine && (
          <p className="text-sm text-white/85 mt-0.5 drop-shadow">{ctxLine}</p>
        )}
      </div>

      {/* Center play button */}
      {clip.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-cyan-500/95 ring-2 ring-white/80 shadow-2xl flex items-center justify-center">
            <svg className="w-6 h-6 sm:w-7 sm:h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Bottom-left: Watch clip link */}
      <div className="absolute bottom-4 left-4 sm:bottom-5 sm:left-5">
        <span className="inline-flex items-center gap-1.5 text-cyan-300 font-bold text-sm drop-shadow">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
            <path d="M10 8l6 4-6 4V8z" />
          </svg>
          Watch clip
        </span>
      </div>

      {/* Bottom-right: duration */}
      {durText && (
        <div className="absolute bottom-4 right-4 sm:bottom-5 sm:right-5">
          <span className="text-white font-mono font-bold text-sm bg-black/40 px-2 py-0.5 rounded">{durText}</span>
        </div>
      )}
    </Link>
  );
};

const FooterStat: React.FC<{
  label: string;
  value: number;
  icon?: React.ReactNode;
  tint?: string;
}> = ({ label, value, icon, tint = 'bg-gray-100 text-gray-600' }) => (
  <div className="bg-white rounded-xl ring-1 ring-gray-200 px-3 py-2.5 flex items-center gap-2.5">
    {icon && (
      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
        {icon}
      </div>
    )}
    <div className="min-w-0">
      <div className="text-xl font-black text-fire-950 leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500 mt-0.5">{label}</div>
    </div>
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
