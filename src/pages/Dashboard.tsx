// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, CalendarEvent, PlayerMedia as PlayerMediaType } from '../types';
import { formatDateTime, isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import { RichContent } from './Wall';
import NextEventPoster from '../components/common/NextEventPoster';
import InThePoolHero from '../components/dashboard/InThePoolHero';
import NotificationsBanner from '../components/common/NotificationsBanner';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { streamThumbnailUrl } from '../utils/streamUpload';
import { ChatThread } from '../types';
import CoachAccordionBar from '../components/coach/CoachAccordionBar';
import CoachTonightCard from '../components/coach/CoachTonightCard';
import CoachTeamHealthCard from '../components/coach/CoachTeamHealthCard';
import { useViewMode } from '../contexts/ViewModeContext';
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
  // Coach-mode view collapses the dashboard to team/coach context
  // and hides kid-specific cards (practice-week strip + MyPlayerCard).
  // Parent mode keeps the kid cards and skips the coach cards. Patrick
  // 2026-06-21: 'in coach mode it still show my son and his development
  // tracking bar.'
  const { viewMode } = useViewMode();
  const isCoachMode = viewMode === 'coach';
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
  // ATOMIC RENDER: track whether the goal-fetch effect has resolved
  // (success OR explicit-null) so we can reserve placeholder space
  // during the in-flight window and avoid a layout shift when the
  // card finally pops in. Pattern source: feedback memory
  // 'atomic-render-over-skeletons.md'. Set true at the end of the
  // useEffect that calls setTonightGoal.
  const [goalLoaded, setGoalLoaded] = useState(false);
  const [tonightGoal, setTonightGoal] = useState<{
    planId: string;
    goalId: string;
    planTitle: string;
    goalTitle: string;
    focus?: string;
    durationMinutes?: number;
    loggedToday: boolean;
    /** Current calendar work week (Mon–Sat, 6 entries, oldest first).
     *  Sunday is intentionally omitted — computeStreakDays skips it
     *  entirely, so showing 7 dots created an unfillable 7th slot for
     *  LDS families and overstated the denominator ("X of 7 days"
     *  when only 6 ever count). Each entry also flags isFuture so the
     *  card can render upcoming days as dim outlines. */
    thisWeek: { date: Date; logged: boolean; isFuture: boolean }[];
    /** Streak recomputed from the freshly-fetched active plans, NOT
     *  the cached myPlayer.currentStreakDays denormalized field. The
     *  cached field can lag behind reality if a prior streak persist
     *  raced with the Dashboard fetch (Patrick: "i did it 3 days
     *  now, it stays at one"). Reading from here ensures the strip
     *  always shows the truth, and the self-heal in the same effect
     *  writes the corrected value back to Firestore. */
    streakDays: number;
  } | null>(null);
  // Wall posts = docs in the wall_posts collection (its own surface,
  // separate from chat). The dashboard surfaces the 5 most recent.
  const [wallPosts, setWallPosts] = useState<Array<{ id: string; threadId: string; content: string; senderName: string; senderRole?: string; timestamp: Date; category?: string }>>([]);
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
          // Google sign-up users have profilePhotoUrl (OAuth avatar)
          // but no photoURL (no manual Settings upload). Fall back so
          // their photos render in Recent Chats DM rows.
          const photo = u?.photoURL || u?.profilePhotoUrl;
          if (uid && photo) map[uid] = photo;
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
              category: (data.category as string) || 'announcement',
            };
          })
          // Dashboard surface is the "Announcements" card — only
          // category=announcement posts show here. Game results,
          // spotlights, practice notes belong on their own surfaces
          // (game tab, player cards). Posts that predate the category
          // field default to 'announcement' in the snapshot mapper so
          // they still appear.
          .filter(p => p.category === 'announcement');
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

  // Quick-tile badge values. Wall: unread posts since localStorage
  // lastSeen for this team (same lookup the megaphone uses); cap at
  // 9+. Plan: cached streak from the player doc.
  const wallUnreadBadge = useMemo(() => {
    if (wallPosts.length === 0 || !selectedTeamId) return null;
    try {
      const raw = localStorage.getItem(`wall.lastSeen.${selectedTeamId}`);
      const lastSeen = raw ? parseInt(raw, 10) : 0;
      const n = wallPosts.filter(p => p.timestamp.getTime() > lastSeen).length;
      if (n <= 0) return null;
      return n > 9 ? '9+' : n;
    } catch { return null; }
  }, [wallPosts, selectedTeamId]);
  const planStreakBadge = useMemo(() => {
    const s = (myPlayer as any)?.currentStreakDays || 0;
    return s > 0 ? s : null;
  }, [myPlayer]);

  // Load the next-up development goal for my player. Picks the first
  // unfinished goal of the most recent active plan. The hero card
  // reads streak days directly from player.currentStreakDays (the
  // denormalized field PlayerCard uses too) — no need to compute it
  // here a second time.
  useEffect(() => {
    if (!myPlayer) { setTonightGoal(null); setGoalLoaded(false); return; }
    setGoalLoaded(false);
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

        // STREAK SELF-HEAL — runs UNCONDITIONALLY on every dashboard
        // mount so the cached currentStreakDays is corrected even
        // when there's no 'next' goal to surface (e.g., all goals
        // coach-verified). Was previously nested inside the
        // for(plan of plans) loop's if(next) branch, which skipped
        // the recompute whenever the player had no unfinished goals
        // — bug Patrick hit: 'he only has one, and he clicked it
        // today, yesterday, and the day before' but the streak
        // stayed at 1. Hunter's lone goal may already be verified,
        // so the old code path never even attempted the heal.
        try {
          const { computeStreakDays, recomputeAndPersistPlayerStreak } = await import('../utils/devPlanActions');
          const freshStreak = computeStreakDays(plans as any);
          const cachedStreak: number = (myPlayer as any)?.currentStreakDays || 0;
          if (process.env.NODE_ENV !== 'production') {
            const dayKeys: string[] = [];
            for (const p of plans) {
              for (const g of (p.goals || [])) {
                for (const l of (g.practiceLog || [])) {
                  const dt = l.date?.toDate ? l.date.toDate() : new Date(l.date);
                  dayKeys.push(`${dt.getFullYear()}-${dt.getMonth()+1}-${dt.getDate()}`);
                }
              }
            }
            // eslint-disable-next-line no-console
            console.debug('[dashboard streak]', { playerId: myPlayer.id, activePlans: plans.length, dayKeys, freshStreak, cachedStreak });
          }
          if (freshStreak !== cachedStreak) {
            await recomputeAndPersistPlayerStreak(myPlayer.id, plans as any);
            setPlayers((prev) => prev.map((p: any) =>
              p.id === myPlayer.id ? { ...p, currentStreakDays: freshStreak } : p
            ));
          }
        } catch (err) {
          console.warn('[dashboard] streak self-heal failed', err);
        }

        const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
        for (const plan of plans) {
          const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
          const next = goals.find(g => !g.coachVerified);
          if (next) {
            // Build dayKeys via the shared coerceLogDate helper so
            // legacy {seconds, nanoseconds}-shape entries (corrupted
            // by the pre-v3.2.57 cleanFirestoreData bug) auto-heal
            // here too — not just in the streak chip. Without this,
            // Patrick's screenshot showed the chip at 3 but the
            // week-dots row still at 1 because this path used the
            // old narrow coercion (toDate || new Date()) that
            // produces Invalid Date on the corrupted shape.
            const { coerceLogDate } = await import('../utils/devPlanActions');
            const dayKeys = new Set<string>();
            for (const pl of plans) {
              for (const g of (pl.goals || [])) {
                for (const l of (g.practiceLog || [])) {
                  const d = coerceLogDate(l.date);
                  if (!d) continue;
                  dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
                }
              }
            }
            const loggedToday = (next.practiceLog || []).some((l: any) => {
              const d = coerceLogDate(l.date);
              return d ? d.getTime() >= todayStart : false;
            });
            // Find this week's Monday (treat Sunday as the END of last
            // week, not the start of this one — week runs Mon→Sat).
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayDow = today.getDay(); // 0=Sun, 1=Mon ... 6=Sat
            const offsetToMonday = todayDow === 0 ? 6 : todayDow - 1; // Sun→6, Mon→0, Sat→5
            const monday = new Date(today);
            monday.setDate(today.getDate() - offsetToMonday);
            const todayTime = today.getTime();
            const thisWeek: { date: Date; logged: boolean; isFuture: boolean }[] = [];
            for (let i = 0; i < 6; i++) {
              const d = new Date(monday);
              d.setDate(monday.getDate() + i);
              const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
              thisWeek.push({
                date: d,
                logged: dayKeys.has(k),
                isFuture: d.getTime() > todayTime,
              });
            }
            // Streak self-heal moved OUT of this branch (above the
            // for-loop) so it runs even when there's no unfinished
            // goal to surface. Use the same recomputed value here.
            const { computeStreakDays: csd } = await import('../utils/devPlanActions');
            const freshStreak = csd(plans as any);
            setTonightGoal({
              planId: plan.id,
              goalId: next.id,
              planTitle: plan.title || 'Plan',
              goalTitle: next.title || 'Practice goal',
              focus: next.focus,
              durationMinutes: next.targetMinutes,
              loggedToday,
              thisWeek,
              streakDays: freshStreak,
            });
            return;
          }
        }
        setTonightGoal(null);
      } catch (err) {
        console.warn('tonight goal load failed', err);
      } finally {
        if (!cancelled) setGoalLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [myPlayer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Is my player the current Player of the Match for this week? If a
  // match_votings doc closed in the last 7 days has my player in its
  // winners[], the dashboard hero card goes GOLD. Patrick: "this is
  // also the profile i want to turn gold when the player gets player
  // of the match for the week".
  const [isPotmThisWeek, setIsPotmThisWeek] = useState(false);
  useEffect(() => {
    if (!myPlayer) { setIsPotmThisWeek(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection: fsColl, query, where, getDocs, orderBy, limit } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          fsColl(db, 'match_votings'),
          where('teamId', '==', myPlayer.teamId),
          orderBy('closedAt', 'desc'),
          limit(3),
        ));
        if (cancelled) return;
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const won = snap.docs.some(d => {
          const v = d.data() as any;
          const closed = v.closedAt?.toDate ? v.closedAt.toDate().getTime() : 0;
          if (!closed || closed < weekAgo) return false;
          const winners: any[] = Array.isArray(v.winners) ? v.winners : [];
          const winner = v.winner;
          return winners.some(w => w.playerId === myPlayer.id) || winner?.playerId === myPlayer.id;
        });
        setIsPotmThisWeek(won);
      } catch (err) {
        console.warn('potm check failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [myPlayer?.id, myPlayer?.teamId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Linked players for the current parent user, so the dashboard
  // poster can RSVP THE KID(S) on a tap instead of the parent. Same
  // query as EventDetail uses; runs for everyone but only matters
  // when the user is a non-coach parent with linked kids. Skipped
  // entirely if there's no next event to RSVP for.
  const [myLinkedPlayers, setMyLinkedPlayers] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!userData?.uid || !nextEvent?.teamId) { setMyLinkedPlayers([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection: c, getDocs: gd, query: q, where: w } = await import('firebase/firestore');
        const { db: d } = await import('../utils/firebase');
        const snap = await gd(q(
          c(d, 'players'),
          w('parentIds', 'array-contains', userData.uid),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(doc => ({ id: doc.id, ...(doc.data() as any) }))
          .filter((p: any) => p.isActive !== false)
          .filter((p: any) => Array.isArray(p.teamIds) ? p.teamIds.includes(nextEvent.teamId) : true)
          .map((p: any) => ({ id: p.id, name: p.name as string }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setMyLinkedPlayers(list);
      } catch (err) {
        console.warn('[dashboard] linked players load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, nextEvent?.teamId]);

  // Dashboard RSVP — when the user is a parent with linked kids,
  // tapping Going/Maybe/Can't RSVPs the KID(S), matching the
  // EventDetail "Quick Actions" behavior. Coaches and parents-
  // without-linked-kids RSVP themselves.
  const useKidQuickRsvp = !isUserCoach && myLinkedPlayers.length > 0;
  const quickRsvp = async (status: 'going' | 'maybe' | 'no') => {
    if (!nextEvent) return;
    if (useKidQuickRsvp && userData?.uid) {
      const nextMap: Record<string, any> = { ...(((nextEvent as any).playerRsvps) || {}) };
      for (const p of myLinkedPlayers) {
        nextMap[p.id] = {
          status,
          playerName: p.name,
          byUid: userData.uid,
          byName: userData.name || undefined,
          respondedAt: new Date(),
        };
      }
      setUpcomingEvents((prev) =>
        prev.map((e) => (e.id === nextEvent.id ? ({ ...e, playerRsvps: nextMap } as any) : e))
      );
      try {
        await updateDocument('events', nextEvent.id, { playerRsvps: nextMap });
      } catch (err) {
        console.error('[dashboard] quick kid rsvp failed', err);
      }
      return;
    }
    await setMyRsvp(status);
  };

  // Current RSVP status to show as "active" on the poster buttons.
  // Kid mode: only highlight when all linked kids share the same
  // status (otherwise it'd be misleading). Adult mode: the user's
  // own rsvp.
  const posterCurrentStatus = (() => {
    if (!nextEvent) return null;
    if (useKidQuickRsvp) {
      const playerR = ((nextEvent as any).playerRsvps || {}) as Record<string, { status: string }>;
      const statuses = myLinkedPlayers.map(p => playerR[p.id]?.status);
      if (statuses.length > 0 && statuses.every(s => s === 'going')) return 'going' as const;
      if (statuses.length > 0 && statuses.every(s => s === 'maybe')) return 'maybe' as const;
      if (statuses.length > 0 && statuses.every(s => s === 'no')) return 'no' as const;
      return null;
    }
    return (myRsvp?.status as 'going' | 'maybe' | 'no' | null) || null;
  })();

  // Button labels — adjust copy when RSVPing a kid so the parent
  // knows who they're marking going. "Hunter going" / "All going"
  // / "I'm going" / etc.
  const posterGoingLabel = (() => {
    if (useKidQuickRsvp) {
      return myLinkedPlayers.length === 1
        ? `${myLinkedPlayers[0].name.split(' ')[0]} going`
        : 'All going';
    }
    return "I'm going";
  })();
  const posterNoLabel = useKidQuickRsvp
    ? (myLinkedPlayers.length === 1 ? "Can't go" : "None going")
    : "Can't go";

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
      : t === 'practice' ? 'from-crimson-500 to-charcoal-600'
      : 'from-violet-500 to-fuchsia-500';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-crimson-200 border-t-cyan-500" />
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
    <div className="relative min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-800 to-charcoal-950">
      {/* Stadium hero — navy scene with floodlights that toggle on
          at dusk/night, a faint pitch silhouette, and the day's
          most important glance-able info (next-event RSVP count,
          unread chats, fresh photos). Replaces the standalone
          greeting + the Next Event card. */}
      <NextEventPoster
        greeting={greeting}
        firstName={firstName}
        nextEvent={nextEvent}
        whenText={nextEvent ? friendlyWhen(new Date(nextEvent.date)) : ''}
        weather={nextEventWeather}
        goingCount={rsvpCounts.going}
        pendingCount={rsvpCounts.pending}
        playerCount={players.length}
        isCoach={isUserCoach}
        currentStatus={posterCurrentStatus}
        goingLabel={posterGoingLabel}
        noLabel={posterNoLabel}
        onRsvp={quickRsvp}
      />
      {/* Coach accordion bar — slim color-coded status indicator that
          surfaces only when there's actionable coach work (RSVPs
          missing, game today, recent messages). Sits BELOW the hero
          photo and ABOVE the page content per the agreed shape: no
          chrome competing with the photo above. Hidden entirely when
          there's nothing to show. Patrick 2026-06-21 dialogue. */}
      <CoachAccordionBar />
      <div className="relative">

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* Show the push-permission banner first when the user has no
            FCM tokens. Self-hides when not needed. */}
        <NotificationsBanner />

        {/* AdminCockpit moved to /club (ClubOverview) per Patrick:
            'this option exists as part of the main dashboard, but only
            happens once a year. it needs to be in the club section
            only.' Dashboard stays purely the coach/parent surface.
            Admins reach club ops via the 'Club' tab in the bottom nav. */}

        {/* Ambient cues right under the greeting — birthday pill only.
            Season countdown ("20 weeks left in Fall 2026") was removed
            per Patrick's call: it took up space without driving any
            action, and the season name is already visible elsewhere. */}
        {birthdayKids.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap -mt-3">
            {birthdayKids.map((k) => (
              <Link
                key={k.id}
                to={`/player/${k.id}`}
                className="inline-flex items-center gap-1.5 bg-gradient-to-r from-amber-500/25 to-pink-500/20 ring-1 ring-amber-300/40 text-amber-100 px-3 py-1 rounded-full text-xs font-bold shadow hover:shadow-md transition active:scale-95"
              >
                <span className="text-base leading-none">🎂</span>
                <span>{k.name.split(' ')[0]} turns {k.turning} today</span>
              </Link>
            ))}
          </div>
        )}
        {/* Smart 'tonight' card — coach-only, renders only when the
            next event is within 36h. Sits between birthday strip and
            the practice-streak ribbon so it lands in the coach's
            scan path without crowding parent context. Patrick
            2026-06-21 dialogue idea #2: 'a "what i'm doing tonight"
            smart card... shifts based on what's actually happening.' */}
        <CoachTonightCard />

        {/* The no-event empty state lives in DashboardHero now — no
            second card needed here. */}

        {/* Practice-week strip — Patrick: the icon-card "doesn't offer
            enough to be there." Replaced with a week-at-a-glance
            ribbon: tonight's focus on the left, streak count on the
            right, 7 dots underneath showing the last seven days.
            Sunday rendered with a dash so it reads as "rest day" not
            "missed" (the streak algo skips Sundays).

            ATOMIC RENDER: while goalLoaded=false (the fetch is in
            flight), reserve a placeholder slot of approximately the
            card's height so the layout doesn't shift when the card
            arrives. Once the fetch resolves, smoothly transition the
            slot's max-height to either the real card (if a tonightGoal
            exists) or 0 (if the kid has no active plan). Avoids
            Patrick's 'development card pops in later' complaint
            without showing a skeleton. */}
        {!isCoachMode && myPlayer && (
          <div
            className="transition-all duration-500 ease-out overflow-hidden"
            style={{
              maxHeight: !goalLoaded ? '94px' : (tonightGoal ? '240px' : '0px'),
              opacity: !goalLoaded ? 0 : (tonightGoal ? 1 : 0),
            }}
          >
        {tonightGoal && (() => {
          // Streak source of truth = the value computed in
          // tonightGoal's effect from the freshly-fetched plans. The
          // cached myPlayer.currentStreakDays can lag if a prior
          // persist write raced with the dashboard fetch.
          const streak = tonightGoal.streakDays;
          const loggedCount = tonightGoal.thisWeek.filter(d => d.logged).length;
          const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
          return (
            <Link
              to={`/development?expand=${encodeURIComponent(tonightGoal.planId)}`}
              className="block group relative overflow-hidden rounded-2xl bg-charcoal-900 ring-1 ring-white/5 hover:ring-crimson-500/40 transition shadow-lg"
            >
              <div className="absolute -top-12 -right-12 w-40 h-40 bg-crimson-500/10 blur-3xl pointer-events-none" aria-hidden />

              <div className="relative px-4 pt-3 pb-3.5">
                {/* Row 1: focus on left, streak chip on right */}
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400">
                      {tonightGoal.loggedToday ? 'Logged today' : 'This week'}
                      <span className="text-charcoal-500"> · </span>
                      <span className="text-charcoal-300 normal-case tracking-normal font-bold">{tonightGoal.planTitle}</span>
                    </div>
                    <div className="text-[13.5px] text-bone leading-snug mt-1 line-clamp-2">
                      {tonightGoal.focus || tonightGoal.goalTitle}
                    </div>
                  </div>
                  {streak > 0 && (
                    <div className="flex-shrink-0 inline-flex flex-col items-center justify-center px-2.5 py-1 rounded-lg bg-gradient-to-b from-amber-400/20 to-amber-600/20 ring-1 ring-amber-400/40">
                      <div className="text-[18px] font-black text-amber-300 leading-none tabular-nums">{streak}</div>
                      <div className="text-[8px] font-extrabold tracking-widest uppercase text-amber-200/80 mt-0.5">Day streak</div>
                    </div>
                  )}
                </div>

                {/* Row 2: 7 dots + summary count */}
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    {tonightGoal.thisWeek.map((d, i) => (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <span className="text-[8px] font-bold tracking-wider text-charcoal-500">
                          {DAY_LETTER[d.date.getDay()]}
                        </span>
                        {d.logged ? (
                          <span className="w-2 h-2 rounded-full bg-crimson-500 shadow-sm shadow-crimson-500/50" aria-label="logged" />
                        ) : d.isFuture ? (
                          <span className="w-2 h-2 rounded-full ring-1 ring-charcoal-700" aria-label="upcoming" />
                        ) : (
                          <span className="w-2 h-2 rounded-full ring-1 ring-charcoal-500" aria-label="not logged" />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex-1 text-[11px] text-charcoal-400 truncate">
                    <span className="text-bone font-bold tabular-nums">{loggedCount}</span> of 6 days
                  </div>
                  <svg
                    className="w-4 h-4 text-charcoal-500 group-hover:text-crimson-400 transition-colors flex-shrink-0"
                    fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
                  >
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </div>
            </Link>
          );
        })()}
          </div>
        )}
        {/* Coach team-health roll-up — visible to coaches only,
            renders only when the team has at least one player who
            hasn't logged practice this week. Lives below the
            practice-streak ribbon since they're related surfaces.
            Patrick 2026-06-21 dialogue idea #3. */}
        <CoachTeamHealthCard />
        {!isCoachMode && myPlayer && (
          <MyPlayerCard
            player={myPlayer}
            latestThumb={featuredClip ? clipThumb(featuredClip) : undefined}
            isPotm={isPotmThisWeek}
          />
        )}

        {/* 6-tile quick-action launcher removed in v3.2.50 — three
            of the six (Events, Media, Chat) duplicate the bottom tab
            bar, the other three (Wall, Roster, Plan) are reachable
            via the More menu and the player card. The dashboard is
            for "what's next + what do I need to do," not a launcher
            grid. Patrick: realignment toward communication + events
            as the core. */}

        {/* ── TEAM WALL / ANNOUNCEMENTS ──────────────────────────────
            Pinned messages from any of the team's chat threads, sorted
            newest first. Surfaces here so a parent who only checks the
            dashboard still sees announcements coaches posted in chat.
            Tap a card → deep-links into the chat tab on that thread. */}
        {wallPosts.length > 0 && (
          <div className="bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 rounded-2xl ring-1 ring-white/10 overflow-hidden shadow-lg">
            <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
              <h3 className="font-bold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-bone/45" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 2v6"/><path d="M12 8l-3 3h6z"/><rect x="3" y="11" width="18" height="11" rx="2"/></svg>
                Announcements
              </h3>
              <Link to="/wall" className="text-bone/60 text-sm font-semibold hover:text-bone">View all</Link>
            </div>
            {/* Single-row preview per announcement: sender, date, and
                one-line content snippet. Patrick: "show only a title
                or something so it takes up less room." Full markdown,
                images, and replies live on /wall — tap to expand.
                Plain-text strip on content so markdown markers like
                ** or # don't leak into the preview. */}
            <ul className="divide-y divide-white/5">
              {wallPosts.map(p => {
                const snippet = p.content
                  .replace(/[*_#>`~]/g, '')
                  .replace(/\s+/g, ' ')
                  .trim();
                return (
                  <li key={p.id}>
                    <Link
                      to="/wall"
                      className="flex items-center gap-2 px-5 py-2.5 hover:bg-white/[0.04] transition-colors"
                    >
                      <span className="text-xs font-semibold text-white shrink-0">{p.senderName}</span>
                      <span className="text-[11px] text-white/40 shrink-0">
                        {p.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                      <span className="text-white/25 shrink-0" aria-hidden>·</span>
                      <span className="text-xs text-white/60 truncate flex-1 min-w-0">
                        {snippet}
                      </span>
                      <svg className="w-3 h-3 text-white/30 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* RecentChatsCard removed in v3.2.50 — Patrick: "I don't use
            recent chats as I thought I would." Chat tab is one tap
            away on the bottom bar with its own unread badge. Team
            Pulse stays for coaches / non-parent viewers since it
            surfaces team-wide leaderboard context that isn't visible
            anywhere else. */}
        {(isUserCoach || !myPlayer) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TeamPulseCard
              topScorer={topScorers[0]}
              topAssister={topAssists[0]}
              totalGoals={totalGoals}
              totalAssists={totalAssists}
              totalGames={totalGames}
              playerCount={players.length}
            />
          </div>
        )}

        {/* ── FEATURED HIGHLIGHT (one big tile) ─────────────────── */}
        {featuredClip && (
          <FeaturedHighlight clip={featuredClip} />
        )}

        {/* Footer stats grid removed in v3.2.50 — Patrick's half-
            empty critique flagged it as below-the-fold noise that
            duplicated info available on the roster + media surfaces.
            Will reintroduce purposefully if a season-totals view
            proves desirable, but not as ambient dashboard chrome. */}
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
    event.type === 'practice' ? 'from-crimson-500 to-charcoal-600' :
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
          <p className="text-[10px] font-bold uppercase tracking-wider text-crimson-600 mb-0.5">Next event</p>
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
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-crimson-50 text-crimson-700 ring-1 ring-crimson-200 text-xs font-bold whitespace-nowrap">
              {counts.going} going
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); goToCalendar(); }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-crimson-50 hover:bg-crimson-100 text-crimson-700 ring-1 ring-crimson-200 text-xs font-bold whitespace-nowrap transition"
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
    <div className="bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 rounded-2xl ring-1 ring-white/10 overflow-hidden shadow-lg">
      <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
        <h3 className="font-bold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-bone/45" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Recent chats
        </h3>
        <Link to="/chat" className="text-bone/60 text-sm font-semibold hover:text-bone">View all</Link>
      </div>
      {chats.length === 0 ? (
        <div className="p-5 text-center">
          <p className="text-sm font-semibold text-white/85">No conversations yet</p>
          <p className="text-xs text-white/60 mt-0.5">DMs and group chats will show up here.</p>
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
            const palette = ['bg-crimson-600', 'bg-slate-600'];
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
                className="flex items-start gap-2.5 p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] active:bg-white/[0.12] ring-1 ring-white/10 transition"
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
                    <p className="font-semibold text-white text-sm truncate">{displayTitle}</p>
                    <span className="text-[10px] text-white/40 flex-shrink-0">{relativeTime(new Date(thread.lastActivity))}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <p className="text-xs text-white/60 truncate flex-1">
                      {last?.senderName ? <span className="font-medium text-white/80">{last.senderName}: </span> : null}
                      {last?.content || (isDM ? 'Tap to start chatting' : 'No messages yet')}
                    </p>
                    {unread && <span className="flex-shrink-0 w-2 h-2 rounded-full bg-crimson-400" />}
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

const MyPlayerCard: React.FC<{
  player: Player;
  latestThumb?: string;
  isPotm: boolean;
}> = ({ player, isPotm }) => {
  const p: any = player;
  const position = p.positions?.[0] || p.position || 'Player';
  // Same denormalized source PlayerCard reads — keeps the streak in
  // sync across surfaces (no two-source divergence). Updated whenever
  // a parent logs practice via devPlanActions.
  const streakDays: number = p.currentStreakDays || 0;
  // Position pill colour — mirrors PlayerCard's positionDotColor map.
  const positionDot = (() => {
    switch (position) {
      case 'Goalkeeper': return 'bg-amber-400';
      case 'Defender': return 'bg-sky-400';
      case 'Midfielder': return 'bg-emerald-400';
      case 'Forward':
      case 'Striker': return 'bg-rose-400';
      case 'Winger': return 'bg-orange-400';
      default: return 'bg-slate-400';
    }
  })();
  // Brand-themed accent for non-POTM cards. Every player card
  // gets the same crimson aura so it reads as a GoalKickr card,
  // not a generic dark surface. Role is communicated via the
  // position pill DOT below (which keeps its position-specific
  // color), so role-info isn't lost — it just lives in the right
  // place. Cohesion across players matters more than per-player
  // color identity for brand consistency.
  const brandAccent = {
    ring: 'ring-crimson-500/35',
    shadow: 'shadow-crimson-600/25',
    blob: 'bg-crimson-500/20',
  };
  // POTM-of-the-week treatment — the whole card goes gold. Bright
  // saturated gradient, thick gold ring, glow shadow, animated
  // shimmer stripe, and a "PLAYER OF THE MATCH" banner across the
  // top. Should be impossible to miss. Patrick: "i want the whole
  // profile on the dashboard in gold when they get POTM."
  const cardBg = isPotm
    ? 'bg-gradient-to-br from-yellow-300 via-amber-500 to-orange-500 ring-4 ring-amber-300/80 shadow-2xl shadow-amber-500/50'
    : `bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 ring-1 ${brandAccent.ring}`;
  const accentText = isPotm ? 'text-amber-50' : 'text-white/70';
  const subText = isPotm ? 'text-amber-100/80' : 'text-white/60';
  return (
    <Link
      to={`/player/${player.id}`}
      className={`relative overflow-hidden rounded-2xl text-white shadow-xl ${isPotm ? '' : brandAccent.shadow} hover:shadow-2xl active:scale-[0.995] transition flex ${cardBg}`}
    >
      {/* POTM banner across the very top of the card. Black text on
          a deeper amber strip keeps it readable against the bright
          gradient body below. */}
      {isPotm && (
        <div className="absolute top-0 inset-x-0 z-10 bg-gradient-to-r from-amber-700 via-amber-800 to-amber-700 px-4 py-1.5 flex items-center justify-center gap-2 border-b border-amber-900/40">
          <svg className="w-4 h-4 text-amber-100 drop-shadow" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
          </svg>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-100 drop-shadow">
            Player of the Match
          </span>
          <svg className="w-4 h-4 text-amber-100 drop-shadow" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
          </svg>
        </div>
      )}
      {/* Animated shimmer — a thin band of brighter gold sweeps
          diagonally across the card every few seconds. CSS keyframe
          'potm-shimmer' defined in index.css. */}
      {isPotm && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
        >
          <div className="absolute -inset-y-2 -inset-x-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent rotate-12 potm-shimmer" />
        </div>
      )}
      {/* Brand aura blob — soft blurred crimson in the top-left
          corner that bleeds into the card. Reads as ambient
          GoalKickr color, not a sharp accent. Role still shows
          via the position pill DOT below. Skipped for POTM since
          the gold gradient is already plenty. */}
      {!isPotm && (
        <div
          aria-hidden
          className={`absolute -top-16 -left-16 w-48 h-48 rounded-full blur-3xl pointer-events-none ${brandAccent.blob}`}
        />
      )}
      {/* Subtle Fire FC logo watermark on the right */}
      <img
        src="/images/logo.png"
        alt=""
        className="absolute -right-6 top-1/2 -translate-y-1/2 w-40 h-40 opacity-[0.08] pointer-events-none"
        aria-hidden
      />
      <div className={`relative ${isPotm ? 'pt-12 pb-4 px-4 sm:pt-14 sm:pb-5 sm:px-5' : 'p-4 sm:p-5'} flex items-center gap-4 w-full`}>
        {/* Avatar with jersey-number chip (matches PlayerCard pattern
            used elsewhere — Patrick: "everywhere else it shows the
            10 in the other way"). Optional POTW crown sits on top. */}
        <div className="relative flex-shrink-0">
          {p.profilePhotoUrl ? (
            <img
              src={p.profilePhotoUrl}
              alt={player.name}
              className={`w-20 h-20 rounded-full object-cover shadow ${isPotm ? 'ring-4 ring-amber-300' : 'ring-2 ring-white/20'}`}
              loading="lazy"
            />
          ) : (
            <div className={`w-20 h-20 rounded-full bg-gradient-to-br from-crimson-400 to-charcoal-700 flex items-center justify-center text-white text-3xl font-black shadow ${isPotm ? 'ring-4 ring-amber-300' : 'ring-2 ring-white/20'}`}>
              {player.jerseyNumber != null ? `#${player.jerseyNumber}` : player.name.charAt(0)}
            </div>
          )}
          {p.profilePhotoUrl && player.jerseyNumber != null && (
            <span className="absolute -bottom-1 -right-1 bg-white text-charcoal-800 rounded-full min-w-[28px] h-7 px-1.5 flex items-center justify-center text-xs font-black shadow-lg ring-2 ring-charcoal-900">
              #{player.jerseyNumber}
            </span>
          )}
          {/* Practice streak chip — bottom-LEFT of avatar (matches
              PlayerCard placement so the two surfaces feel like one
              system). Fire-themed at 3+ days. */}
          {streakDays > 0 && (
            <span
              title={`${streakDays}-day practice streak`}
              className={`absolute -bottom-1 -left-1 z-10 inline-flex items-center justify-center min-w-[28px] h-7 px-1.5 rounded-full text-[11px] font-black tabular-nums shadow-lg ring-2 ring-charcoal-900 ${
                streakDays >= 3
                  ? 'bg-gradient-to-br from-rose-500 to-orange-500 text-white'
                  : 'bg-crimson-500 text-white'
              }`}
            >
              {streakDays >= 3 ? '🔥' : ''}{streakDays}
            </span>
          )}
          {isPotm && (
            <span
              className="absolute -top-1 -right-1 w-8 h-8 rounded-full bg-amber-300 ring-2 ring-amber-700 flex items-center justify-center shadow-lg"
              aria-label="Player of the Match"
            >
              <svg className="w-4 h-4 text-amber-900" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
              </svg>
            </span>
          )}
        </div>

        {/* Name + meta + stats */}
        <div className="flex-1 min-w-0">
          <p className={`text-xl sm:text-2xl font-black leading-tight truncate ${isPotm ? 'text-white drop-shadow' : ''}`}>{player.name}</p>
          {/* The small "POTW" chip next to the name was redundant with
              the big banner at the top of the card. Removed. */}
          <div className="flex items-center gap-1.5 mb-2">
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest ${
              isPotm ? 'bg-amber-900/40 text-amber-100' : 'bg-white/10 text-white/85'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${positionDot}`} aria-hidden />
              {position}
            </span>
          </div>
          {/* (Streak pill removed — the flame chip on the avatar's
              bottom-left already shows the count; a second pill under
              the name was duplication. PlayerCard pattern keeps the
              streak as the avatar accent only.) */}
          {/* Stat row hides itself when every stat is zero —
              advertising 0/0/0 was worse than empty state because
              it implied "this app shows no stats." Patrick (half-
              empty critique): "0 GOALS · 0 ASSISTS · 0 GAMES is
              three big zeros taking real estate to say no data."
              Replaced with a quiet "Season starts soon" cue when
              the player has zero numbers across the board, so the
              card still has visible content beneath the position
              pill but doesn't proudly display zeros. */}
          {(() => {
            const goals  = player.stats?.goals || 0;
            const assists = player.stats?.assists || 0;
            const games  = player.stats?.gamesPlayed || 0;
            const saves  = (player as any).stats?.saves || 0;
            const anyStat = goals > 0 || assists > 0 || games > 0 || saves > 0;
            if (!anyStat) {
              return (
                <p className={`text-[11px] font-semibold uppercase tracking-widest ${subText}`}>
                  Season starts soon
                </p>
              );
            }
            return (
              <div className="flex items-end gap-4 sm:gap-6">
                <div>
                  <p className="text-2xl font-black leading-none">{goals}</p>
                  <p className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${subText}`}>Goals</p>
                </div>
                <div>
                  <p className="text-2xl font-black leading-none">{assists}</p>
                  <p className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${subText}`}>Assists</p>
                </div>
                {/* Saves only renders for goalkeepers — same logic
                    as the full PlayerCard. Outfielders get
                    Goals/Assists/Games. */}
                {position === 'Goalkeeper' && (
                  <div>
                    <p className="text-2xl font-black leading-none">{saves}</p>
                    <p className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${subText}`}>Saves</p>
                  </div>
                )}
                <div>
                  <p className="text-2xl font-black leading-none">{games}</p>
                  <p className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${subText}`}>Games</p>
                </div>
              </div>
            );
          })()}
        </div>

        {/* View profile pill */}
        <div className="flex-shrink-0 self-center">
          <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap shadow ${isPotm ? 'bg-amber-900 text-amber-100' : 'bg-white text-charcoal-950'}`}>
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
    <div className="bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 rounded-2xl ring-1 ring-white/10 overflow-hidden shadow-lg">
      <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
        <h3 className="font-bold text-white flex items-center gap-2">
          <svg className="w-4 h-4 text-bone/45" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          Team pulse
        </h3>
        <Link to="/stats" className="text-bone/60 text-sm font-semibold hover:text-bone">Season stats</Link>
      </div>

      {/* Live game tracker entry point — coach can start a session
          without needing a scheduled game on the calendar. */}
      <Link
        to={`/game-day/quick_${Date.now()}`}
        className="mx-4 mt-4 p-3 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 flex items-center gap-3 hover:bg-emerald-500/20 transition active:scale-[0.99]"
      >
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-crimson-600 text-white flex items-center justify-center shadow flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white text-sm">Live game tracker</p>
          <p className="text-xs text-white/70">Scores, goals &amp; subs · works on any game</p>
        </div>
        <svg className="w-4 h-4 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </Link>

      {/* Top scorer + assister — side by side */}
      {(topScorer || topAssister) && (
        <div className="p-4 grid grid-cols-2 gap-3">
          {topScorer && (
            <Link to={`/player/${topScorer.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-white/[0.05] transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-amber-300 to-yellow-500 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ts.profilePhotoUrl ? (
                  <img src={ts.profilePhotoUrl} alt={topScorer.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topScorer.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-bone/60">Top scorer</p>
                <p className="font-bold text-white text-sm truncate">{topScorer.name}</p>
                <p className="text-xs text-emerald-300 font-bold">
                  <span className="font-black">{topScorer.stats?.goals || 0}</span>{' '}
                  <span className="text-white/40 font-medium uppercase tracking-wider text-[10px]">goals</span>
                </p>
              </div>
            </Link>
          )}
          {topAssister && topAssister.id !== topScorer?.id && (
            <Link to={`/player/${topAssister.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-white/[0.05] transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-crimson-500 to-charcoal-700 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ta.profilePhotoUrl ? (
                  <img src={ta.profilePhotoUrl} alt={topAssister.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topAssister.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-bone/60">Top assister</p>
                <p className="font-bold text-white text-sm truncate">{topAssister.name}</p>
                <p className="text-xs text-crimson-400 font-bold">
                  <span className="font-black">{topAssister.stats?.assists || 0}</span>{' '}
                  <span className="text-white/40 font-medium uppercase tracking-wider text-[10px]">assists</span>
                </p>
              </div>
            </Link>
          )}
        </div>
      )}
      {!topScorer && !topAssister && (
        <p className="p-5 text-sm text-white/60 text-center">Log a game to see who's leading the team.</p>
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
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-crimson-400 mb-1">Latest highlight</p>
        <p className="text-2xl sm:text-3xl font-black leading-tight drop-shadow">{headline}</p>
        {ctxLine && (
          <p className="text-sm text-white/85 mt-0.5 drop-shadow">{ctxLine}</p>
        )}
      </div>

      {/* Center play button */}
      {clip.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-crimson-500/95 ring-2 ring-white/80 shadow-2xl flex items-center justify-center">
            <svg className="w-6 h-6 sm:w-7 sm:h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Bottom-left: Watch clip link */}
      <div className="absolute bottom-4 left-4 sm:bottom-5 sm:left-5">
        <span className="inline-flex items-center gap-1.5 text-crimson-400 font-bold text-sm drop-shadow">
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

// Compact dark-navy quick-action tile for the dashboard's 6-up grid.
// Icon stacked over label, with an optional notification badge in
// the top-right (rose for unreads, cyan for chat, amber for streak).
const DashTile: React.FC<{
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: number | string | null;
  badgeTone?: 'rose' | 'cyan' | 'amber';
}> = ({ to, label, icon, badge, badgeTone = 'rose' }) => {
  const badgeColor = {
    rose: 'bg-rose-500 text-white',
    cyan: 'bg-crimson-500 text-white',
    amber: 'bg-orange-500 text-white',
  }[badgeTone];
  return (
    <Link
      to={to}
      className="relative bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 ring-1 ring-white/10 rounded-2xl py-3 flex flex-col items-center gap-1.5 text-white hover:ring-white/20 hover:bg-white/[0.03] active:scale-[0.97] transition shadow"
    >
      <span className="text-crimson-400">{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-widest text-white/85">{label}</span>
      {badge != null && badge !== 0 && badge !== '' && (
        <span className={`absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold flex items-center justify-center ring-2 ring-charcoal-950 ${badgeColor}`}>
          {badge}
        </span>
      )}
    </Link>
  );
};

const FooterStat: React.FC<{
  label: string;
  value: number;
  icon?: React.ReactNode;
  tint?: string;
}> = ({ label, value, icon, tint = 'bg-white/10 text-bone' }) => (
  <div className="bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-charcoal-950 rounded-xl ring-1 ring-white/10 px-3 py-2.5 flex items-center gap-2.5 shadow">
    {icon && (
      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
        {icon}
      </div>
    )}
    <div className="min-w-0">
      <div className="text-xl font-black text-white leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-bone/70 mt-0.5">{label}</div>
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
