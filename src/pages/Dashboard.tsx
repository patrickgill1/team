// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, CalendarEvent, PlayerMedia as PlayerMediaType } from '../types';
import { formatDateTime, isCoachOfTeam } from '../utils/helpers';
import { computeXpLevel } from '../utils/xpLevel';
import Header from '../components/common/Header';
import EmailVerifyBanner from '../components/common/EmailVerifyBanner';
import { RichContent } from './Wall';
import NextEventPoster from '../components/common/NextEventPoster';
import UpcomingEventsList from '../components/dashboard/UpcomingEventsList';
import SnackAssignmentBanner from '../components/dashboard/SnackAssignmentBanner';
import TodaysDevelopmentCard from '../components/dashboard/TodaysDevelopmentCard';
import FamilyFeed from '../components/dashboard/FamilyFeed';
import WeeklySpotlightCard, { type SpotlightPotm, type SpotlightPick } from '../components/dashboard/WeeklySpotlightCard';
import InThePoolHero from '../components/dashboard/InThePoolHero';
import NotificationsBanner from '../components/common/NotificationsBanner';
import SubscribeBanner from '../components/dashboard/SubscribeBanner';
import TrialCountdownBanner from '../components/dashboard/TrialCountdownBanner';
import GettingStartedCard from '../components/dashboard/GettingStartedCard';
import SmartDiscoveryPrompts from '../components/dashboard/SmartDiscoveryPrompts';
import DataGate from '../components/common/DataGate';
import Walkthrough, { shouldShowWalkthrough } from '../components/onboarding/Walkthrough';
import { useActiveSeason } from '../hooks/useActiveSeason';
import { streamThumbnailUrl } from '../utils/streamUpload';
import { ChatThread } from '../types';
import CoachAccordionBar from '../components/coach/CoachAccordionBar';
import CoachTonightCard from '../components/coach/CoachTonightCard';
import CoachTeamHealthCard from '../components/coach/CoachTeamHealthCard';
import DashboardDigestSheet, { DigestItem } from '../components/dashboard/DashboardDigestSheet';
import { useDashboardActivity } from '../hooks/useDashboardActivity';
import { useViewMode } from '../contexts/ViewModeContext';
import AdminCockpit from '../components/admin/AdminCockpit';
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
  // FamilyHome preview retired 2026-07-08 — its best ideas (multi-kid
  // strip, cross-team next event) will be folded into this Dashboard
  // itself rather than a parallel route.
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  // Coach-mode view collapses the dashboard to team/coach context
  // and hides kid-specific cards (practice-week strip + MyPlayerCard).
  // Parent mode keeps the kid cards and skips the coach cards. Patrick
  // 2026-06-21: 'in coach mode it still show my son and his development
  // tracking bar.'
  const { viewMode } = useViewMode();
  const isCoachMode = viewMode === 'coach';
  const isAdminMode = viewMode === 'admin';
  // Convenience: cards that are 'kid-specific' (practice-week strip,
  // MyPlayerCard) render only in parent mode. Coach cards render only
  // in coach mode. Admin cockpit renders only in admin mode. Universal
  // cards (hero, wall, announcements) render always.
  const isParentMode = viewMode === 'parent';
  const {
    getPlayersByTeam,
    getUsersByTeam,
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
  // First-launch walkthrough — 5 slides shown once per device. Patrick
  // 2026-06-26: 'when i tell people all of the features, there are so
  // many good ones, I find it hard to communicate to someone before
  // I feel like I am talking too much.' Tour does the showing instead.
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  // Busy-parent digest sheet — opens from the hero strip when the
  // parent taps "N things need you." Silent when nothing's pending;
  // strip auto-hides in that case so the button is never dead.
  const [digestSheetOpen, setDigestSheetOpen] = useState(false);
  const activity = useDashboardActivity(selectedTeamId, userData?.uid);
  useEffect(() => {
    // Defer one tick so the dashboard paints first, then the
    // walkthrough fades over it — feels less like a forced gate.
    const t = window.setTimeout(() => {
      if (shouldShowWalkthrough(viewMode)) setWalkthroughOpen(true);
    }, 600);
    return () => window.clearTimeout(t);
  }, [viewMode]);
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
  const [wallPosts, setWallPosts] = useState<Array<{ id: string; threadId: string; content: string; senderName: string; senderRole?: string; timestamp: Date; category?: string; postedFrom?: string }>>([]);
  // uid → photoURL map used by the Recent Chats card to render real
  // avatars on DMs (and any future thread types that want a per-user
  // photo). Built once from the users collection per team selection.
  const [userPhotoMap, setUserPhotoMap] = useState<Record<string, string>>({});

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);
  const { season: activeSeason } = useActiveSeason();

  useEffect(() => {
    const load = async () => {
      // Hold loading=true while TeamContext resolves selectedTeamId
      // on cold app open. Flipping loading=false here caused the
      // empty-state cards to flash for a beat before the team-scoped
      // data query fired. GettingStartedCard + SmartDiscoveryPrompts
      // both bail on !selectedTeamId anyway, so keeping loading
      // "sticky" until real data is fetched is safe.
      if (!selectedTeamId) return;
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
        const teamUsers = await getUsersByTeam(selectedTeamId);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const u of teamUsers as any[]) {
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

  // Subscribe to team threads AND DMs — same shape / different
  // queries. Team threads use subscribeToChatThreads which filters
  // by teamId; DMs have teamId:'' and would be missed. Same bug
  // NotificationsHeaderBar hit before 3.9.151. Merging both into
  // the one chatThreads array so downstream (newMessagesCount,
  // UnreadMessagesCard, LatestChatsCard) sees the full picture.
  useEffect(() => {
    if (!selectedTeamId || !userData?.uid) return;
    let teamList: any[] = [];
    let dmList: any[] = [];
    const publish = () => {
      const merged = [...teamList, ...dmList]
        .filter((t: any) => {
          if (t.isPrivate && !isUserCoach) return false;
          return true;
        })
        .map((t: any) => ({
          ...t,
          lastActivity: t.lastActivity instanceof Date ? t.lastActivity : new Date(t.lastActivity || Date.now()),
        }))
        .sort((a: any, b: any) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
      setChatThreads(merged);
    };
    const unsubTeam = subscribeToChatThreads(selectedTeamId, (threads) => {
      teamList = threads;
      publish();
    });
    // DM subscription — mirrors what NotificationsHeaderBar does.
    // Fires whenever DM unreadCount or lastActivity mutates.
    let unsubDm: (() => void) | undefined;
    (async () => {
      const { onSnapshot: os, collection: c, query: q, where: w } = await import('firebase/firestore');
      const { db: d } = await import('../utils/firebase');
      const dmQ = q(
        c(d, 'chat_threads'),
        w('isDM', '==', true),
        w('participants', 'array-contains', userData.uid),
      );
      unsubDm = os(dmQ, (snap) => {
        dmList = snap.docs.map(x => ({ id: x.id, ...(x.data() as any) }));
        publish();
      });
    })();
    return () => {
      if (unsubTeam) unsubTeam();
      if (unsubDm) unsubDm();
    };
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
          limit(30),
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
              postedFrom: (data.postedFrom as string) || 'wall',
            };
          });
          // Dashboard splits the Team Wall feed into two derived
          // surfaces: 'Announcements' (coach category posts) and
          // 'New for you' (recognition-flavored auto-posts about
          // the user's kids). We hold the full page-1 set in state
          // and let the useMemos below carve their own slices out.
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

  // For the compact "new messages" card at the top of the dashboard.
  // We surface the freshest unread thread as a preview so the user
  // knows WHICH conversation lit up, not just that something did.
  // Sorted DESC by lastActivity (chatThreads is already sorted).
  const freshestUnreadThread = useMemo(() => {
    if (!userData?.uid || newMessagesCount === 0) return null;
    return chatThreads.find((t: any) => {
      const u = t?.unreadCount?.[userData.uid];
      return typeof u === 'number' && u > 0;
    }) || null;
  }, [chatThreads, userData?.uid, newMessagesCount]);


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

  // The parent's linked players on this team (their kids). Multi-kid
  // households (siblings on the same team) get all of theirs here;
  // the render loop below wraps 2+ in a swipeable carousel.
  // Coaches with a kid on the team count too — parentIds is the
  // source of truth regardless of the user's role.
  const myPlayers = useMemo(() => {
    if (!userData) return [] as any[];
    return players.filter((p: any) =>
      (Array.isArray(p.parentIds) && p.parentIds.includes(userData.uid)) ||
      p.parentId === userData.uid
    );
  }, [players, userData]);
  // Back-compat: many downstream hooks still read a singular
  // myPlayer (streak, POTM, tonight's goal). They target the FIRST
  // linked kid; siblings surface in the carousel UI but the hooks
  // don't need to fan out.
  const myPlayer = myPlayers[0] || null;

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
  // 'Announcements' surface — the coach's manual News posts + any
  // pre-category legacy posts. Same slice the card has always shown.
  const announcementPosts = useMemo(() => {
    return wallPosts.filter(p => (p.category || 'announcement') === 'announcement').slice(0, 5);
  }, [wallPosts]);
  // 'New for you' surface — recognition-flavored Team Wall posts
  // about the user's kids. POTM crowns, tagged clips, dev-plan
  // milestones, juggle PRs. Shows whenever the user has ANY linked
  // players (previously gated to isParentMode, which hid it from
  // coaches who ALSO have a kid on the team — Patrick's own case).
  // Matched to the user's linked players by first-name substring
  // against the post content. Time-bounded to 24 hours so the strip
  // is a "today" signal, not a rolling two-week nostalgia scroll.
  const newForYouPosts = useMemo(() => {
    if (myPlayers.length === 0) return [];
    const RECOGNITION_KINDS = new Set(['potm', 'juggle', 'devplan', 'video']);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const firstNames = myPlayers.map(p => (p.name || '').trim().split(/\s+/)[0].toLowerCase()).filter(Boolean);
    return wallPosts
      .filter(p => RECOGNITION_KINDS.has(p.postedFrom || ''))
      .filter(p => p.timestamp.getTime() >= cutoff)
      .filter(p => {
        const body = (p.content || '').toLowerCase();
        return firstNames.some(fn => fn && body.includes(fn));
      })
      .slice(0, 3);
  }, [wallPosts, myPlayers]);
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
    // Cache-first render: if the Dashboard has already computed
    // tonightGoal for this player in this session, paint the last
    // value INSTANTLY and refetch in the background. Kills the
    // "quick verifying" flash Patrick reported on every home visit.
    // Cache lives in src/utils/queryCache.ts.
    const cacheKey = `dashboard:tonightGoal:${myPlayer.id}`;
    // Dynamic import so a first-load Dashboard doesn't pay a bundle
    // hit for a module a parent already loaded.
    let cancelled = false;
    (async () => {
      const { readCache, writeCache } = await import('../utils/queryCache');
      const cached = readCache<any>(cacheKey);
      if (cached !== undefined && !cancelled) {
        setTonightGoal(cached);
        setGoalLoaded(true);
      } else {
        setGoalLoaded(false);
      }
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
            const goal = {
              planId: plan.id,
              goalId: next.id,
              planTitle: plan.title || 'Plan',
              goalTitle: next.title || 'Practice goal',
              focus: next.focus,
              durationMinutes: next.targetMinutes,
              loggedToday,
              thisWeek,
              streakDays: freshStreak,
            };
            setTonightGoal(goal);
            writeCache(cacheKey, goal);
            return;
          }
        }
        setTonightGoal(null);
        writeCache(cacheKey, null);
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
  //
  // Same effect also populates `spotlightPotm` — the payload the
  // WeeklySpotlightCard renders. We widen the cutoff to 14 days for
  // the Spotlight (matches the neighboring "New for you" window and
  // avoids a hollow-card week after a bye), while the gold-hero
  // toggle keeps its stricter 7-day window.
  const [isPotmThisWeek, setIsPotmThisWeek] = useState(false);
  const [spotlightPotm, setSpotlightPotm] = useState<SpotlightPotm | null>(null);
  useEffect(() => {
    if (!selectedTeamId) { setIsPotmThisWeek(false); setSpotlightPotm(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const { collection: fsColl, query, where, getDocs, orderBy, limit } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          fsColl(db, 'match_votings'),
          where('teamId', '==', selectedTeamId),
          orderBy('closedAt', 'desc'),
          limit(3),
        ));
        if (cancelled) return;
        const now = Date.now();
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

        // Gold-hero toggle: still 7-day window, still keyed on my
        // player (coach viewer never gets the gold treatment).
        const won = myPlayer ? snap.docs.some(d => {
          const v = d.data() as any;
          const closed = v.closedAt?.toDate ? v.closedAt.toDate().getTime() : 0;
          if (!closed || closed < weekAgo) return false;
          const winners: any[] = Array.isArray(v.winners) ? v.winners : [];
          const winner = v.winner;
          return winners.some(w => w.playerId === myPlayer.id) || winner?.playerId === myPlayer.id;
        }) : false;
        setIsPotmThisWeek(won);

        // Spotlight: newest closed voting within 14 days. Prefer
        // winners[0] over the legacy singular winner; render null if
        // neither is set.
        let spotlight: SpotlightPotm | null = null;
        for (const d of snap.docs) {
          const v = d.data() as any;
          const closed = v.closedAt?.toDate ? v.closedAt.toDate().getTime() : 0;
          if (!closed || closed < twoWeeksAgo) continue;
          const winners: any[] = Array.isArray(v.winners) ? v.winners : [];
          const w = winners[0] || v.winner;
          if (!w?.playerId) continue;
          // Prefer the fresh player doc's photo if we have it (roster
          // is already loaded), fall back to the winner payload's
          // stamped photoUrl if present.
          const p = players.find(pl => pl.id === w.playerId);
          spotlight = {
            playerId: w.playerId,
            playerName: w.playerName || p?.name || 'Player',
            playerPhotoUrl: (p as any)?.profilePhotoUrl || w.playerPhotoUrl || null,
            gameTitle: v.gameTitle || undefined,
            isCoWin: winners.length > 1,
            closedAt: new Date(closed),
          };
          break;
        }
        setSpotlightPotm(spotlight);
      } catch (err) {
        console.warn('potm check failed', err);
      }
    })();
    return () => { cancelled = true; };
    // players is intentionally included so the photo binds correctly
    // once the roster resolves — the query itself doesn't depend on
    // it, but the render payload does.
  }, [selectedTeamId, myPlayer?.id, players]); // eslint-disable-line react-hooks/exhaustive-deps

  // Spotlight: most recent coach's-pick across the roster within
  // 14 days. Pure in-memory scan against the already-loaded
  // `players` state — no extra Firestore reads. The raw coach note
  // is intentionally NOT surfaced here (Phase-1 recognitions are
  // private whispers; the note stays on the honoree family's
  // Whispers tab). The card renders a generic "Coach recognized X's
  // effort" celebration line instead.
  const [spotlightPick, setSpotlightPick] = useState<SpotlightPick | null>(null);
  useEffect(() => {
    if (!Array.isArray(players) || players.length === 0) { setSpotlightPick(null); return; }
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let best: SpotlightPick | null = null;
    let bestMs = 0;
    for (const p of players) {
      const cp: any = (p as any).badges?.coach_pick;
      if (!cp?.earnedAt) continue;
      const ms = cp.earnedAt?.toDate ? cp.earnedAt.toDate().getTime()
        : (cp.earnedAt instanceof Date ? cp.earnedAt.getTime() : new Date(cp.earnedAt).getTime());
      if (!Number.isFinite(ms) || ms < twoWeeksAgo) continue;
      if (ms <= bestMs) continue;
      bestMs = ms;
      best = {
        playerId: p.id,
        playerName: p.name || 'Player',
        playerPhotoUrl: (p as any).profilePhotoUrl || null,
        earnedAt: new Date(ms),
      };
    }
    setSpotlightPick(best);
  }, [players]);

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
        const w = await getWeatherForEvent(nextEvent.location, new Date(nextEvent.date), (nextEvent as any).locationCoords);
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
        name: userData.name || (isUserCoach ? 'Coach' : 'Member'),
        // Tag the role so the display layer can show this as a
        // STAFF / COACH entry rather than a generic guest. Patrick
        // 2026-06-21 attribution rework.
        role: isUserCoach ? 'coach' : undefined,
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

  // Dashboard RSVP — Patrick 2026-06-21: 'i am going to need to also
  // be able to rsvp and show coach is going separate from my son.'
  //
  // New attribution rules:
  //   - Anyone with linked kids on this team → primary RSVP writes
  //     PLAYER RSVPs for those kids (writes to playerRsvps[playerId]).
  //     This includes coaches who are also parents. The previous
  //     `!isUserCoach` gate meant Patrick-the-coach got stamped in
  //     `event.rsvps` with his own name instead of writing Hunter's
  //     kid RSVP. Now removed — having a kid on the roster always
  //     writes a kid RSVP for them when the parent taps Going.
  //   - Users with NO linked kids → primary RSVP writes to
  //     event.rsvps[uid] (existing behavior; their attendance as
  //     themselves). Role tagged 'coach' if isUserCoach.
  //   - Coaches who are ALSO parents → can OPTIONALLY also stamp
  //     their own coach attendance via a separate toggle (see
  //     coachQuickRsvp below). Two RSVPs, two records:
  //       playerRsvps[hunterId] → Hunter going (kid attendance)
  //       rsvps[patrickUid]     → Patrick going (coach attendance)
  const useKidQuickRsvp = myLinkedPlayers.length > 0;
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
      const prevPlayerRsvps = ((nextEvent as any).playerRsvps) || {};
      setUpcomingEvents((prev) =>
        prev.map((e) => (e.id === nextEvent.id ? ({ ...e, playerRsvps: nextMap } as any) : e))
      );
      try {
        await updateDocument('events', nextEvent.id, { playerRsvps: nextMap });
      } catch (err) {
        console.error('[dashboard] quick kid rsvp failed', err);
        setUpcomingEvents((prev) =>
          prev.map((e) => (e.id === nextEvent.id ? ({ ...e, playerRsvps: prevPlayerRsvps } as any) : e))
        );
        alert("Couldn't save your RSVP. Check your connection and try again.");
      }
      return;
    }
    // No kids on the roster — RSVP as self (existing path), tagged
    // with coach role when applicable.
    await setMyRsvp(status);
  };

  // Generic per-event RSVP — used by the UpcomingEventsList tiles
  // where the user can RSVP for events beyond the next one. Mirrors
  // the kid-vs-self dispatch in quickRsvp but takes an explicit
  // eventId instead of implicitly targeting nextEvent.
  const rsvpForEvent = async (eventId: string, status: 'going' | 'maybe' | 'no') => {
    const target = upcomingEvents.find((e) => e.id === eventId);
    if (!target || !userData?.uid) return;
    if (useKidQuickRsvp) {
      const nextMap: Record<string, any> = { ...(((target as any).playerRsvps) || {}) };
      for (const p of myLinkedPlayers) {
        nextMap[p.id] = {
          status,
          playerName: p.name,
          byUid: userData.uid,
          byName: userData.name || undefined,
          respondedAt: new Date(),
        };
      }
      const prev = ((target as any).playerRsvps) || {};
      setUpcomingEvents((all) =>
        all.map((e) => (e.id === eventId ? ({ ...e, playerRsvps: nextMap } as any) : e))
      );
      try {
        await updateDocument('events', eventId, { playerRsvps: nextMap });
      } catch (err) {
        console.error('[dashboard] rsvpForEvent kid failed', err);
        setUpcomingEvents((all) =>
          all.map((e) => (e.id === eventId ? ({ ...e, playerRsvps: prev } as any) : e))
        );
      }
      return;
    }
    // Self path
    const next = {
      ...(target.rsvps || {}),
      [userData.uid]: {
        status,
        name: userData.name || (isUserCoach ? 'Coach' : 'Member'),
        role: isUserCoach ? 'coach' : undefined,
        respondedAt: new Date(),
      },
    };
    setUpcomingEvents((all) =>
      all.map((e) => (e.id === eventId ? ({ ...e, rsvps: next } as CalendarEvent) : e))
    );
    try {
      await updateDocument('events', eventId, { rsvps: next });
    } catch (err) {
      console.error('[dashboard] rsvpForEvent self failed', err);
    }
  };

  // Coach attendance toggle moved off the dashboard hero per Patrick
  // 2026-06-21 ('i want to clean up the header'). The toggle now
  // lives on the EventDetail page (visible to coaches with linked
  // kids). Dashboard-level coachStatus/coachQuickRsvp removed.

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

  // Button labels — Going / Maybe / Can't go uniformly. Multi-kid
  // parents see 'All going' / 'None going' since the all-kids action
  // is the interesting variant. Single-kid + adult-only stays the
  // verb form. Patrick 2026-06-25: 'the "going" switched to the
  // player name instead of just saying going when can't go or maybe
  // is selected.' Removed the single-kid player-name prefix because
  // it created asymmetric labels (only the going button got the
  // name, maybe / can't-go didn't) and read as confusing state.
  const posterGoingLabel = useKidQuickRsvp && myLinkedPlayers.length > 1
    ? 'All going'
    : 'Going';
  const posterNoLabel = useKidQuickRsvp && myLinkedPlayers.length > 1
    ? 'None going'
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

  const friendlyEventWhen = (event: CalendarEvent): string => {
    const start = new Date(event.date);
    const offset = Number((event as any).arriveOffsetMinutes || 0);
    if (offset <= 0) return friendlyWhen(start);
    const arrive = new Date(start.getTime() - offset * 60_000);
    const arriveText = friendlyWhen(arrive);
    const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (arrive.getTime() > Date.now()) {
      if (arriveText.startsWith('In ')) return `Arrive ${arriveText.toLowerCase()} · starts ${startTime}`;
      if (arriveText.startsWith('Today at ')) return `Arrive by ${arriveText.replace('Today at ', '')} · starts ${startTime}`;
      if (arriveText.startsWith('Tomorrow at ')) return `Arrive tomorrow at ${arriveText.replace('Tomorrow at ', '')}`;
      return `Arrive ${arriveText.toLowerCase()}`;
    }
    return `Arrive by ${arrive.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  };

  // Aggregate RSVP counts for the next event. Players only — public
  // share-link RSVPs were removed 2026-06-24 (parents are on the app now;
  // extended family invite as parents with relationship='grandparent'
  // etc., so their RSVPs come through playerRsvps too).
  const rsvpCounts = useMemo(() => {
    const playerR = ((nextEvent as any)?.playerRsvps || {}) as Record<string, { status: string }>;
    let going = 0, maybe = 0, no = 0;
    Object.values(playerR).forEach((v) => {
      if (v.status === 'going') going++;
      else if (v.status === 'maybe') maybe++;
      else if (v.status === 'no') no++;
    });
    const respondedPlayers = Object.keys(playerR).length;
    const pending = Math.max(0, players.length - respondedPlayers);
    return { going, maybe, no, pending };
  }, [nextEvent, players.length]);

  // Busy-parent digest — count of upcoming events where the parent's
  // linked kid(s) have no RSVP recorded yet. Skips the empty-team
  // case (no linked kid → nothing to answer). Kept tight to the
  // parent path since coaches don't RSVP the same way.
  const upcomingRsvpPending = useMemo(() => {
    if (!isParentMode) return 0;
    const myPlayerIds = new Set(myPlayers.map(p => p.id));
    if (myPlayerIds.size === 0) return 0;
    let count = 0;
    for (const ev of upcomingEvents) {
      const playerR = ((ev as any)?.playerRsvps || {}) as Record<string, { status: string }>;
      // If ANY of the parent's kids has no RSVP on this event, it
      // counts as one item ("this event needs you"). Not per-kid
      // multiplied — that would over-inflate the digest for
      // multi-kid families.
      const anyUnanswered = Array.from(myPlayerIds).some(id => !playerR[id]);
      if (anyUnanswered) count++;
    }
    return count;
  }, [isParentMode, upcomingEvents, myPlayers]);

  // Compose the digest items array. Only categories with count > 0
  // survive into the sheet (silent-empty rule) — but the total is
  // summed here so the hero strip has the number to show.
  const digestItems: DigestItem[] = useMemo(() => ([
    {
      key: 'chat', label: activity.chat === 1 ? 'unread message' : 'unread messages',
      count: activity.chat, href: '/chat', tone: 'brand',
    },
    {
      key: 'wall', label: activity.wall === 1 ? 'new team post' : 'new team posts',
      count: activity.wall, href: '/wall', tone: 'amber',
    },
    {
      key: 'events', label: activity.events === 1 ? 'event update' : 'event updates',
      count: activity.events, href: '/calendar', tone: 'sky',
    },
    {
      key: 'rsvp', label: upcomingRsvpPending === 1 ? 'event to answer' : 'events to answer',
      count: upcomingRsvpPending, href: '/calendar', tone: 'emerald',
    },
    {
      key: 'highlights',
      label: newForYouPosts.length === 1 ? 'new highlight' : 'new highlights',
      detail: myPlayer ? `About ${myPlayer.name.split(' ')[0]}` : undefined,
      count: newForYouPosts.length, href: '/wall', tone: 'violet',
    },
  ]), [activity.chat, activity.wall, activity.events, upcomingRsvpPending, newForYouPosts.length, myPlayer]);

  const digestTotal = digestItems.reduce((sum, i) => sum + (i.count > 0 ? i.count : 0), 0);

  const eventEmoji = (t: string) => t === 'game' ? '⚽' : t === 'practice' ? '🏃' : '📅';
  const eventGradient = (t: string) =>
    t === 'game' ? 'from-rose-500 to-orange-500'
      : t === 'practice' ? 'from-brand-primary to-surface-tint'
      : 'from-violet-500 to-fuchsia-500';

  // Atomic-render gate: render nothing for the first ~400ms of the
  // load (per atomic-render rule), then a subtle progress hint, then
  // the full dashboard fades in atomically. Replaces the loud spinner
  // + 'Loading...' label that landed first on every cold start.
  if (loading) return <DataGate when="loading" />;

  const firstName = userData?.name?.split(' ')[0] || (isUserCoach ? 'Coach' : 'Friend');

  const subtitle = `Here's what's happening with your team.`;

  // "In the pool" is reserved for PARENTS who registered through the
  // auth-gated /register flow but haven't been rostered yet — that's
  // a real product state (the parent is waiting for the club to place
  // their kid on a team). It is NOT the right empty state for a
  // brand-new user who downloaded the app — they should be in the
  // onboarding wizard creating their team, not staring at a "you're
  // in the pool" screen.
  //
  // ProtectedRoute already redirects no-team coaches to /onboarding.
  // This guard exists for the case where the redirect hasn't fired
  // yet (transient null teamIds) or the user is explicitly role=parent
  // without a team.
  const userTeamIds: string[] = Array.isArray((userData as any)?.teamIds) ? (userData as any).teamIds : [];
  const hasAnyTeam = userTeamIds.length > 0 || !!(userData as any)?.teamId;
  const isUnrosteredParent = (userData as any)?.role === 'parent' && !hasAnyTeam;
  // Belt-and-suspenders: if the user IS on teams but the currently
  // selected team isn't one of them (stale state), also fall back.
  const selectedTeamIsMine = selectedTeamId
    ? (userTeamIds.includes(selectedTeamId) || (userData as any)?.teamId === selectedTeamId)
    : false;
  if (isUnrosteredParent) {
    return <InThePoolHero firstName={firstName} email={userData?.email} />;
  }
  if (hasAnyTeam && selectedTeamId && !selectedTeamIsMine) {
    // User has teams but the wrong one is selected — show a neutral
    // loading state while TeamContext catches up rather than rendering
    // any other team's data.
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center text-charcoal-400 text-sm">
        Loading your team…
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base">
      <EmailVerifyBanner />
      {/* Stadium hero — navy scene with floodlights that toggle on
          at dusk/night, a faint pitch silhouette, and the day's
          most important glance-able info (next-event RSVP count,
          unread chats, fresh photos). Replaces the standalone
          greeting + the Next Event card. */}
      <NextEventPoster
        greeting={greeting}
        firstName={firstName}
        nextEvent={nextEvent}
        whenText={nextEvent ? friendlyEventWhen(nextEvent) : ''}
        weather={nextEventWeather}
        goingCount={rsvpCounts.going}
        pendingCount={rsvpCounts.pending}
        playerCount={players.length}
        isCoach={isUserCoach}
        currentStatus={posterCurrentStatus}
        goingLabel={posterGoingLabel}
        noLabel={posterNoLabel}
        onRsvp={quickRsvp}
        digestTotal={digestTotal}
        onOpenDigest={() => setDigestSheetOpen(true)}
      />
      <DashboardDigestSheet
        open={digestSheetOpen}
        onClose={() => setDigestSheetOpen(false)}
        items={digestItems}
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
        {/* Parent-mode emotional lead. Patrick 2026-07-13: "the
            player profile should be first. that is the most
            important thing." Promoted from below the coach cards
            to right below the hero — every open should reward a
            parent with a look at their kid before any chrome.
            Coach-mode leaves this null (their equivalent hero is
            CoachTonightCard further down). */}
        {isParentMode && myPlayers.length > 0 && (
          myPlayers.length === 1 ? (
            <MyPlayerCard
              player={myPlayers[0]}
              latestThumb={featuredClip ? clipThumb(featuredClip) : undefined}
              isPotm={isPotmThisWeek}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />
          ) : (
            <SiblingCarousel
              players={myPlayers}
              latestThumb={featuredClip ? clipThumb(featuredClip) : undefined}
              isPotmForPrimary={isPotmThisWeek}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />
          )
        )}

        {/* TodaysDevelopmentCard — sits directly under MyPlayerCard
            for parent-mode users, matching Patrick's 2026-07-13
            approved mockup order (MyPlayerCard → Today's Development
            → This Week). Hidden entirely for coaches and for parents
            without an active dev plan. */}
        {isParentMode && myPlayer && (
          <div
            className="transition-all duration-500 ease-out overflow-hidden"
            style={{
              maxHeight: !goalLoaded ? '94px' : (tonightGoal ? '260px' : '0px'),
              opacity: !goalLoaded ? 0 : (tonightGoal ? 1 : 0),
            }}
          >
            {tonightGoal && (
              <TodaysDevelopmentCard
                goal={tonightGoal}
                playerId={myPlayer.id}
                teamId={selectedTeamId || (myPlayer as any).teamId || ''}
                onLogged={(updated) => setTonightGoal(updated)}
              />
            )}
          </div>
        )}

        {/* This Week — up to 3 upcoming events with inline RSVP. */}
        <UpcomingEventsList
          events={upcomingEvents}
          max={3}
          myLinkedPlayers={myLinkedPlayers as any}
          currentUid={userData?.uid}
          isCoach={isUserCoach}
          onRsvp={rsvpForEvent}
        />

        {/* Welcome grace period — hide the promotional stack for the
            first 45 min after signup so a brand-new coach gets a
            peaceful first look at their populated dashboard instead
            of a wall of 'do this, do that' prompts. Patrick called
            this the make-or-break moment: 'awesome that by the time
            they get to the beautiful dashboard, they already have
            an event waiting to be seen.'
            After 45 min, the normal Getting Started + Subscribe +
            Notifications + Smart Discovery stack surfaces as usual. */}
        {(() => {
          const createdAt = (userData as any)?.createdAt;
          const createdMs = createdAt?.toDate ? createdAt.toDate().getTime()
            : createdAt instanceof Date ? createdAt.getTime()
            : (typeof createdAt === 'number' ? createdAt : 0);
          const graceMs = 45 * 60 * 1000;
          const inWelcomeGrace = createdMs && (Date.now() - createdMs) < graceMs;
          if (inWelcomeGrace) return null;
          return (
            <>
              {/* UnreadMessagesCard removed 3.9.163 — replaced by the
                  busy-parent digest strip inside the hero (under the
                  greeting). Chat-only banner over-promised "you have
                  stuff" but only surfaced chat, leaving the parent
                  wondering if the wall / RSVP / form activity was
                  represented. Digest folds all five in and opens a
                  bottom sheet on tap. */}
              <NotificationsBanner />
              <TrialCountdownBanner />
              <SnackAssignmentBanner
                events={upcomingEvents}
                myPlayerIds={myPlayers.map((p) => p.id)}
              />
              <GettingStartedCard players={players} events={upcomingEvents} dataLoading={loading} />
              <SubscribeBanner />
              <SmartDiscoveryPrompts
                players={players}
                events={upcomingEvents}
                isCoach={isUserCoach}
                dataLoading={loading}
              />
            </>
          );
        })()}

        {/* UpcomingEventsList moved into the parent-mode
            emotional-lead block above (right after
            TodaysDevelopmentCard) — matches the approved mockup
            order: MyPlayerCard → Today's Development → This Week. */}

        {/* Admin cockpit returns to the dashboard when the user is
            in 'admin' view mode (Patrick 2026-06-21: 'shouldn't admin
            be the same option? when they login... it has to be club
            related things'). It still lives on /club as well; this is
            the dashboard-surface mirror that activates when admin is
            the user's selected view. Parent + coach modes hide it.
            Pure admins land here by default (their only available
            mode), so the dashboard immediately shows their pending
            registrations, payments, and team activation count. */}
        {isAdminMode && <AdminCockpit />}

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
        {/* TodaysDevelopmentCard + UpcomingEventsList moved into the
            parent-mode emotional-lead block above (right after
            MyPlayerCard) — matches the approved mockup order. This
            block used to render TodaysDevelopmentCard here. */}
        {/* Coach team-health roll-up — visible to coaches only,
            renders only when the team has at least one player who
            hasn't logged practice this week. Lives below the
            practice-streak ribbon since they're related surfaces.
            Patrick 2026-06-21 dialogue idea #3. */}
        <CoachTeamHealthCard />
        {/* MyPlayerCard / SiblingCarousel moved to top-of-content
            in the parent-mode emotional-lead block above. Left this
            comment as an anchor in case anyone greps for the old
            position. */}

        {/* FamilyFeed — cross-team summary for multi-team families.
            Sits BELOW the player card so a parent's kid stays the
            emotional core of Home; family-week context is a helper,
            not the headline. Returns null internally for solo-team
            users so single-team dashboards are unaffected. */}
        <FamilyFeed />

        {/* Weekly Spotlight — two-row amber Awards card surfacing the
            team's most-recent POTM (row 1) + most-recent coach's-pick
            (row 2). Silent empty: returns null when neither slot is
            set inside the 14-day window, so byes and quiet weeks
            don't pin a hollow card to the dashboard. Sits ABOVE the
            "New for you" strip so it acts as the headline and "New
            for you" is the follow-through list. */}
        <WeeklySpotlightCard potm={spotlightPotm} pick={spotlightPick} />

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
        {/* 'New for you' — recognition posts about the user's kid(s)
            from the last 14 days. First surface a parent sees after
            the hero, so the emotional payoff loop (POTM crown, tagged
            clip, streak milestone, dev-plan win) leads the app rather
            than getting buried in the Team Wall feed. */}
        {newForYouPosts.length > 0 && (
          <div className="bg-gradient-to-br from-brand-primary/10 via-surface-elevated to-surface-base rounded-2xl ring-1 ring-brand-primary/25 overflow-hidden shadow-lg">
            <div className="px-5 py-3 border-b border-brand-primary/10 flex items-center justify-between">
              <h3 className="font-bold text-ink-primary flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-300" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
                </svg>
                New for {myPlayer?.name?.split(' ')[0] || 'you'}
              </h3>
              <Link to="/wall" className="text-brand-primary-soft text-sm font-semibold hover:text-brand-primary">Team Wall</Link>
            </div>
            <ul className="divide-y divide-line-default/5">
              {newForYouPosts.map(p => {
                const badge =
                  p.postedFrom === 'potm' ? 'Player of the Match'
                  : p.postedFrom === 'juggle' ? 'Personal best'
                  : p.postedFrom === 'devplan' ? 'Plan milestone'
                  : 'New clip';
                const badgeColor =
                  p.postedFrom === 'potm' ? 'text-amber-300 bg-amber-500/15 ring-amber-400/30'
                  : p.postedFrom === 'juggle' ? 'text-violet-300 bg-violet-500/15 ring-violet-400/30'
                  : p.postedFrom === 'devplan' ? 'text-emerald-300 bg-emerald-500/15 ring-emerald-400/30'
                  : 'text-brand-primary-soft bg-brand-primary/15 ring-brand-primary-soft/30';
                const snippet = p.content
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/[*_#>`~]/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 90);
                return (
                  <li key={p.id}>
                    <Link
                      to="/wall"
                      className="flex items-center gap-2 px-5 py-3 hover:bg-line-default/[0.04] transition-colors"
                    >
                      <span className={`shrink-0 text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded ring-1 ${badgeColor}`}>
                        {badge}
                      </span>
                      <span className="flex-1 min-w-0 text-xs text-ink-primary/85 truncate">{snippet}</span>
                      <span className="shrink-0 text-[10px] text-ink-primary/40 tabular-nums">
                        {p.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Dashboard announcements card removed 2026-07-09. Wall now
            has its own bottom-tab AND the header notification bar
            shows a red dot when there are unread wall posts, so
            duplicating the feed here was starting to feel like a
            wall of juggling-post previews. New signal lives at the
            top of the chrome. */}

        {/* Latest chats. Compact 3-row list, silent when nothing
            has activity in the last 14 days. Unread rows lead the
            sort + get emphasis so a new DM pops without needing to
            scroll into /chat. Restores the "latest messages" glance
            surface Patrick asked for after 3.9.149. */}
        {userData?.uid && (
          <LatestChatsCard chats={chatThreads} userUid={userData.uid} userPhotoMap={userPhotoMap} />
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

      {/* First-launch walkthrough — shows once per device, 600ms
          after the dashboard paints. localStorage flag inside the
          component prevents re-shows. */}
      <Walkthrough open={walkthroughOpen} onClose={() => setWalkthroughOpen(false)} role={viewMode} />
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
    event.type === 'practice' ? 'from-brand-primary to-surface-tint' :
    'from-violet-500 to-fuchsia-600';
  return (
    <section
      onClick={goToCalendar}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') goToCalendar(); }}
      className={`relative overflow-hidden rounded-2xl bg-surface-elevated shadow-sm cursor-pointer hover:shadow-md active:scale-[0.995] transition ${
        isGameDayToday
          ? 'ring-2 ring-rose-400 ring-offset-2 shadow-[0_0_30px_-8px_rgba(244,63,94,0.55)] animate-pulse-soft'
          : 'ring-1 ring-line-default/10'
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
          <p className="text-[10px] font-bold uppercase tracking-wider text-brand-primary mb-0.5">Next event</p>
          <h2 className="text-lg sm:text-xl font-black text-ink-primary leading-tight truncate">{event.title}</h2>
          <p className="text-sm text-ink-primary/65 mt-1 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-ink-primary/45 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="truncate">{fullDate}</span>
          </p>
          {event.location && (
            <p className="text-sm text-ink-primary/65 mt-0.5 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-ink-primary/45 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
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
              <span className="text-xs text-ink-primary/65 inline-flex items-center gap-1 bg-line-default/5 ring-1 ring-line-default/10 px-2 py-0.5 rounded-full">
                <span>{weather.icon}</span>
                <span className="font-semibold">{Math.round(weather.tempMaxF)}°</span>
                <span className="text-ink-primary/40">/</span>
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
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand-primary-soft text-brand-primary ring-1 ring-brand-primary-soft text-xs font-bold whitespace-nowrap">
              {counts.going} going
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); goToCalendar(); }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand-primary-soft hover:bg-brand-primary-soft text-brand-primary ring-1 ring-brand-primary-soft text-xs font-bold whitespace-nowrap transition"
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
          <p className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/55 mb-2">Will you be there?</p>
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
  <div className={`rounded-xl px-3 py-2 text-center ${dim ? 'bg-line-default/5 ring-1 ring-line-default/10' : 'bg-line-default/15 ring-1 ring-line-default/20'}`}>
    <div className="text-xl font-black leading-tight">{value}</div>
    <div className="text-[10px] uppercase tracking-wider font-bold text-ink-primary/70">{label}</div>
  </div>
);

// Compact "you have new messages" nudge shown at the top of the
// dashboard content. Single row, ~44px tall. Only renders when
// count > 0 so we never occupy space to say "nothing new." Tap
// takes you straight to the freshest unread thread if we know
// which one, else the chat index.
const UnreadMessagesCard: React.FC<{ count: number; thread: any | null }> = ({ count, thread }) => {
  if (count <= 0) return null;
  const href = thread?.id ? `/chat?thread=${thread.id}` : '/chat';
  const title = thread?.isDM
    ? (thread?.dmParticipantNames && Object.values(thread.dmParticipantNames)[0]) || (thread?.title || '').replace(/^DM:\s*/, '') || 'Direct message'
    : thread?.title || 'Team chat';
  const lastSender = thread?.lastMessage?.senderName;
  return (
    <Link
      to={href}
      className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-brand-primary/15 via-brand-primary/8 to-transparent ring-1 ring-brand-primary/25 px-4 py-3 hover:from-brand-primary/20 hover:via-brand-primary/12 active:scale-[0.99] transition-all animate-fade-in"
    >
      <span className="relative flex-shrink-0 w-9 h-9 rounded-full bg-brand-primary-soft/25 ring-1 ring-brand-primary-soft/40 flex items-center justify-center">
        <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center ring-2 ring-surface-base">
          {count > 99 ? '99+' : count}
        </span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-ink-primary leading-tight truncate">
          {count === 1 ? 'New message' : `${count} new messages`} <span className="text-ink-primary/50 font-medium">· {title}</span>
        </p>
        {lastSender && (
          <p className="text-[11px] text-ink-primary/55 leading-snug truncate mt-0.5">
            Latest from <span className="font-semibold text-ink-primary/70">{lastSender}</span>
          </p>
        )}
      </div>
      <svg className="w-4 h-4 text-brand-primary-soft flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </Link>
  );
};

// Compact "Recent chats" card that replaces the announcements slot
// removed in 3.9.149. Density rules:
//   - Silent when there are zero recent threads. No "no messages"
//     empty state.
//   - Cap at 3 rows. Anything beyond lives on /chat.
//   - Only threads with lastActivity in the last 14 days show up —
//     stale channels don't clutter the dashboard.
//   - Unread rows lead with a red dot + brand-tinted background so
//     they pop against the read rows behind them.
//   - Tap deep-links to the exact thread, not the /chat index.
//
// Data source: dashboard's chatThreads state, which now includes
// team threads AND DMs (fixed 3.9.153 with the two-subscription
// merge above). Sort priority: unread first, then most recent.
const LatestChatsCard: React.FC<{ chats: any[]; userUid: string; userPhotoMap?: Record<string, string> }> = ({ chats, userUid, userPhotoMap }) => {
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const scored = chats
    .filter((t: any) => t?.lastActivity && (now - new Date(t.lastActivity).getTime()) < FOURTEEN_DAYS)
    .map((t: any) => {
      const unread = typeof t?.unreadCount?.[userUid] === 'number' ? t.unreadCount[userUid] : 0;
      return { t, unread, at: new Date(t.lastActivity).getTime() };
    })
    .sort((a, b) => {
      // Unread first, then by most recent activity within each bucket.
      if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
      return b.at - a.at;
    })
    .slice(0, 3);
  if (scored.length === 0) return null;
  return (
    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 overflow-hidden shadow-lg">
      <div className="px-4 py-2.5 border-b border-line-default/10 flex items-center justify-between">
        <h3 className="text-[11px] font-black tracking-widest uppercase text-ink-primary/60">
          Recent chats
        </h3>
        <Link to="/chat" className="text-[11px] font-bold text-ink-primary/55 hover:text-ink-primary transition">
          View all →
        </Link>
      </div>
      <ul className="divide-y divide-line-default/5">
        {scored.map(({ t, unread }) => {
          const isDM = t.isDM === true;
          const otherUid = isDM ? (t.participants || []).find((u: string) => u !== userUid) : null;
          const displayTitle = isDM
            ? (t.dmParticipantNames?.[otherUid] || String(t.title || '').replace(/^DM:\s*/, '') || 'Direct message')
            : (t.title || 'Team chat');
          const dmPhotoUrl = isDM && otherUid ? userPhotoMap?.[otherUid] : undefined;
          const initial = (displayTitle || '?').charAt(0).toUpperCase();
          const last = t.lastMessage;
          const snippet = last?.content
            ? String(last.content).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
            : last?.senderName
              ? '(new message)'
              : '';
          return (
            <li key={t.id}>
              <Link
                to={`/chat?thread=${t.id}`}
                className={`flex items-center gap-3 px-4 py-2.5 hover:bg-line-default/[0.04] transition-colors ${unread > 0 ? 'bg-brand-primary/[0.04]' : ''}`}
              >
                {/* Avatar / initial. DMs prefer the other participant
                    photo when we have it; group threads use the
                    initial on a slate tile. */}
                {dmPhotoUrl ? (
                  <img src={dmPhotoUrl} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0 ring-1 ring-line-default/10" />
                ) : (
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs flex-shrink-0 ${isDM ? 'bg-brand-primary' : 'bg-slate-600'}`}>
                    {initial}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    {unread > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0" aria-hidden />
                    )}
                    <p className={`truncate text-sm ${unread > 0 ? 'font-black text-ink-primary' : 'font-semibold text-ink-primary/85'}`}>
                      {displayTitle}
                    </p>
                    <span className="ml-auto text-[10px] text-ink-primary/45 flex-shrink-0">
                      {relativeTime(new Date(t.lastActivity))}
                    </span>
                  </div>
                  {snippet && (
                    <p className={`truncate text-xs mt-0.5 ${unread > 0 ? 'text-ink-primary/80' : 'text-ink-primary/50'}`}>
                      {last?.senderName ? <span className="font-semibold">{last.senderName}: </span> : null}
                      {snippet}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const RecentChatsCard: React.FC<{ chats: ChatThread[]; userUid: string; userPhotoMap?: Record<string, string> }> = ({ chats, userUid, userPhotoMap }) => {
  return (
    <div className="bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base rounded-2xl ring-1 ring-line-default/10 overflow-hidden shadow-lg">
      <div className="px-5 py-3 border-b border-line-default/10 flex items-center justify-between">
        <h3 className="font-bold text-ink-primary flex items-center gap-2">
          <svg className="w-4 h-4 text-ink-primary/45" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Recent chats
        </h3>
        <Link to="/chat" className="text-ink-primary/60 text-sm font-semibold hover:text-ink-primary">View all</Link>
      </div>
      {chats.length === 0 ? (
        <div className="p-5 text-center">
          <p className="text-sm font-semibold text-ink-primary/85">No conversations yet</p>
          <p className="text-xs text-ink-primary/60 mt-0.5">DMs and group chats will show up here.</p>
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
            const palette = ['bg-brand-primary', 'bg-slate-600'];
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
                className="flex items-start gap-2.5 p-2.5 rounded-xl bg-line-default/[0.04] hover:bg-line-default/[0.08] active:bg-line-default/[0.12] ring-1 ring-line-default/10 transition"
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
                    <p className="font-semibold text-ink-primary text-sm truncate">{displayTitle}</p>
                    <span className="text-[10px] text-ink-primary/45 flex-shrink-0">{relativeTime(new Date(thread.lastActivity))}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <p className="text-xs text-ink-primary/60 truncate flex-1">
                      {last?.senderName ? <span className="font-medium text-ink-primary/80">{last.senderName}: </span> : null}
                      {last?.content || (isDM ? 'Tap to start chatting' : 'No messages yet')}
                    </p>
                    {unread && <span className="flex-shrink-0 w-2 h-2 rounded-full bg-brand-primary-soft" />}
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

// Sibling carousel — renders one MyPlayerCard per linked player
// with a horizontal-scroll snap so the parent can swipe between
// kids. Kept dead simple (native CSS scroll-snap, no gesture lib)
// because iOS Safari handles this without a JS lib. Includes dot
// indicators so parents can tell at a glance how many kids are in
// the stack.
const SiblingCarousel: React.FC<{
  players: Player[];
  latestThumb?: string;
  isPotmForPrimary: boolean;
  xpEnabled?: boolean;
}> = ({ players, latestThumb, isPotmForPrimary, xpEnabled = false }) => {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== activeIdx) setActiveIdx(idx);
  };

  const goTo = (idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
  };

  return (
    <div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide -mx-3 sm:-mx-6 px-3 sm:px-6 gap-3"
        style={{ scrollbarWidth: 'none' }}
      >
        {players.map((p, i) => (
          <div key={p.id} className="snap-center flex-shrink-0 w-full">
            <MyPlayerCard
              player={p}
              // Latest thumb + POTM are computed against the primary
              // kid on the Dashboard. Applying them to sibling cards
              // could be misleading (they'd show the wrong clip or
              // announce a POTM for the wrong kid), so we only pass
              // through for the first card.
              latestThumb={i === 0 ? latestThumb : undefined}
              isPotm={i === 0 ? isPotmForPrimary : false}
              xpEnabled={xpEnabled}
            />
          </div>
        ))}
      </div>
      {/* Dot indicators. Tapping a dot jumps to that kid. */}
      <div className="flex justify-center items-center gap-1.5 mt-2">
        {players.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => goTo(i)}
            className={`h-1.5 rounded-full transition-all ${
              i === activeIdx
                ? 'w-6 bg-brand-primary'
                : 'w-1.5 bg-ink-primary/25 hover:bg-ink-primary/45'
            }`}
            aria-label={`View ${p.name || 'sibling ' + (i + 1)}`}
          />
        ))}
      </div>
    </div>
  );
};

const MyPlayerCard: React.FC<{
  player: Player;
  latestThumb?: string;
  isPotm: boolean;
  /** Team has team.xpConfig.enabled === true. When false we swap the
   *  Level+XP row and the badge chip for a plain stats row (goals /
   *  assists / games), so the card still feels substantial for
   *  teams that haven't opted into XP. Streak still shows either
   *  way — practice streaks are dev-plan-driven, not XP-driven. */
  xpEnabled?: boolean;
}> = ({ player, isPotm, xpEnabled = false }) => {
  const p: any = player;
  const position = p.positions?.[0] || p.position || 'Player';
  const streakDays: number = p.currentStreakDays || 0;
  const xp = Number(p.xp) || 0;
  const level = computeXpLevel(xp);
  const badgeCount = p.badges && typeof p.badges === 'object' ? Object.keys(p.badges).length : 0;
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

  // Card background: POTM stays gold (the "whole card goes gold" rule
  // Patrick set on POTM week); everything else uses the dark surface
  // with a subtle crimson aura in the corner.
  const cardBg = isPotm
    ? 'bg-gradient-to-br from-yellow-300 via-amber-500 to-orange-500 ring-4 ring-amber-300/80 shadow-2xl shadow-amber-500/50'
    : 'bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base ring-1 ring-brand-primary/10 dark:ring-brand-primary/35 shadow-brand-primary/10 dark:shadow-brand-primary/25';

  const xpPct = Math.min(100, Math.max(0, Math.round((level.xpIntoLevel / Math.max(1, level.nextLevelThreshold - level.currentLevelThreshold)) * 100)));

  return (
    <Link
      to={`/player/${player.id}`}
      className={`relative overflow-hidden rounded-2xl ${isPotm ? 'text-white' : 'text-ink-primary'} shadow-xl hover:shadow-2xl active:scale-[0.995] transition block ${cardBg}`}
    >
      {/* POTM banner across the top when applicable. */}
      {isPotm && (
        <div className="absolute top-0 inset-x-0 z-10 bg-gradient-to-r from-amber-700 via-amber-800 to-amber-700 px-4 py-1.5 flex items-center justify-center gap-2 border-b border-amber-900/40">
          <svg className="w-4 h-4 text-amber-100 drop-shadow" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
          </svg>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-100 drop-shadow">Player of the Match</span>
          <svg className="w-4 h-4 text-amber-100 drop-shadow" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
          </svg>
        </div>
      )}
      {isPotm && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className="absolute -inset-y-2 -inset-x-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent rotate-12 potm-shimmer" />
        </div>
      )}
      {/* Subtle crimson aura blob (non-POTM only). */}
      {!isPotm && (
        <div
          aria-hidden
          className="absolute -top-16 -left-16 w-48 h-48 rounded-full blur-3xl pointer-events-none bg-brand-primary/[0.03] dark:bg-brand-primary/20"
        />
      )}
      {/* GK logo watermark on the right. */}
      <img
        src="/images/logo.png"
        alt=""
        className="absolute -right-6 top-1/2 -translate-y-1/2 w-40 h-40 opacity-[0.08] pointer-events-none"
        aria-hidden
      />

      <div className={`relative ${isPotm ? 'pt-9 pb-3 px-3 sm:pt-10 sm:pb-4 sm:px-4' : 'p-3 sm:p-4'} flex items-center gap-3 sm:gap-4 w-full`}>
        {/* Photo — crimson ring + #10 jersey pill on the bottom-left,
            matching the mockup. Shrunk from 96 → 80 to give the
            info column room without sacrificing the hero medallion. */}
        <div className="relative flex-shrink-0">
          {/* Outer soft crimson glow — reads as premium, on-brand. */}
          {!isPotm && (
            <div aria-hidden className="absolute -inset-1 rounded-full bg-brand-primary/25 blur-md pointer-events-none" />
          )}
          {p.profilePhotoUrl ? (
            <img
              src={p.profilePhotoUrl}
              alt={player.name}
              className={`relative w-20 h-20 rounded-full object-cover shadow-lg ring-[2.5px] ${isPotm ? 'ring-amber-300' : 'ring-brand-primary'}`}
              loading="lazy"
            />
          ) : (
            <div className={`relative w-20 h-20 rounded-full bg-gradient-to-br from-brand-primary-soft to-surface-raised flex items-center justify-center text-white text-2xl font-black shadow-lg ring-[2.5px] ${isPotm ? 'ring-amber-300' : 'ring-brand-primary'}`}>
              {player.jerseyNumber != null ? `#${player.jerseyNumber}` : player.name.charAt(0)}
            </div>
          )}
          {player.jerseyNumber != null && (
            <span
              className={`absolute -bottom-0.5 -left-1 z-10 inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-black tabular-nums shadow-md ring-1 ${
                isPotm
                  ? 'bg-amber-50 text-amber-950 ring-amber-200'
                  : 'bg-charcoal-900 text-white ring-brand-primary'
              }`}
            >
              #{player.jerseyNumber}
            </span>
          )}
          {isPotm && (
            <span
              className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-amber-300 ring-2 ring-amber-700 flex items-center justify-center shadow-lg"
              aria-label="Player of the Match"
            >
              <svg className="w-3.5 h-3.5 text-amber-900" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z" />
              </svg>
            </span>
          )}
        </div>

        {/* Info column: name, position, level+XP row, streak+badge row */}
        <div className="flex-1 min-w-0">
          <p className={`text-lg sm:text-xl font-black leading-tight truncate ${isPotm ? 'text-white drop-shadow' : 'text-ink-primary'}`}>{player.name}</p>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 mt-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
            isPotm ? 'bg-amber-900/40 text-amber-100' : 'bg-line-default/10 text-ink-primary/85'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${positionDot}`} aria-hidden />
            {position}
          </span>

          {xpEnabled ? (
            <>
              {/* Row: LEVEL badge + XP progress bar + count. Compact. */}
              <div className="flex items-center gap-2 mt-2">
                <div className={`inline-flex items-center gap-1 flex-shrink-0 ${isPotm ? 'text-amber-100' : 'text-brand-primary-soft'}`}>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <polygon points="12 2 15 9 22 9 17 14 19 22 12 18 5 22 7 14 2 9 9 9 12 2" />
                  </svg>
                  <span className="text-[10px] font-black uppercase tracking-[0.2em]">Lvl {level.level}</span>
                </div>
                <div className={`flex-1 h-1.5 rounded-full overflow-hidden min-w-[40px] ${isPotm ? 'bg-amber-900/40' : 'bg-line-default/15'}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isPotm ? 'bg-amber-100' : 'bg-gradient-to-r from-brand-primary to-brand-primary-soft'}`}
                    style={{ width: `${xpPct}%` }}
                    aria-hidden
                  />
                </div>
                <span className={`text-[9.5px] font-bold tabular-nums flex-shrink-0 ${isPotm ? 'text-amber-100/80' : 'text-ink-primary/55'}`}>
                  {level.xpIntoLevel}/{level.nextLevelThreshold - level.currentLevelThreshold}
                  <span className={`ml-0.5 ${isPotm ? 'text-amber-100/55' : 'text-ink-primary/35'}`}>XP</span>
                </span>
              </div>

              {/* Row: streak + badge on ONE line. */}
              {(streakDays > 0 || badgeCount > 0) && (
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {streakDays > 0 && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.18em] ${isPotm ? 'text-amber-100' : 'text-orange-300'}`}>
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
                      </svg>
                      <span className="tabular-nums">{streakDays}</span> Day Streak
                    </span>
                  )}
                  {badgeCount > 0 && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.18em] ${isPotm ? 'text-amber-100' : 'text-amber-300'}`}>
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
                      </svg>
                      <span className="tabular-nums">{badgeCount}</span> {badgeCount === 1 ? 'Badge' : 'Badges'}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            /* XP-disabled fallback: stats row (Goals · Assists · Games)
               + optional streak chip inline. Keeps the card informative
               for teams that haven't opted into XP without shipping an
               empty-looking hero. Season-starts-soon fallback preserved
               from the pre-XP variant when every stat is zero. */
            (() => {
              const goals   = player.stats?.goals || 0;
              const assists = player.stats?.assists || 0;
              const games   = player.stats?.gamesPlayed || 0;
              const saves   = (player as any).stats?.saves || 0;
              const anyStat = goals > 0 || assists > 0 || games > 0 || saves > 0;
              return (
                <div className="mt-2 space-y-1.5">
                  {anyStat ? (
                    <div className={`flex items-end gap-4 sm:gap-5 ${isPotm ? 'text-white' : 'text-ink-primary'}`}>
                      <div>
                        <p className="text-lg font-black leading-none tabular-nums">{goals}</p>
                        <p className={`text-[9px] font-black uppercase tracking-[0.18em] mt-0.5 ${isPotm ? 'text-amber-100/80' : 'text-ink-primary/50'}`}>Goals</p>
                      </div>
                      <div>
                        <p className="text-lg font-black leading-none tabular-nums">{assists}</p>
                        <p className={`text-[9px] font-black uppercase tracking-[0.18em] mt-0.5 ${isPotm ? 'text-amber-100/80' : 'text-ink-primary/50'}`}>Assists</p>
                      </div>
                      {position === 'Goalkeeper' && (
                        <div>
                          <p className="text-lg font-black leading-none tabular-nums">{saves}</p>
                          <p className={`text-[9px] font-black uppercase tracking-[0.18em] mt-0.5 ${isPotm ? 'text-amber-100/80' : 'text-ink-primary/50'}`}>Saves</p>
                        </div>
                      )}
                      <div>
                        <p className="text-lg font-black leading-none tabular-nums">{games}</p>
                        <p className={`text-[9px] font-black uppercase tracking-[0.18em] mt-0.5 ${isPotm ? 'text-amber-100/80' : 'text-ink-primary/50'}`}>Games</p>
                      </div>
                    </div>
                  ) : (
                    <p className={`text-[10px] font-black uppercase tracking-[0.2em] ${isPotm ? 'text-amber-100/85' : 'text-ink-primary/55'}`}>
                      Season starts soon
                    </p>
                  )}
                  {streakDays > 0 && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.18em] ${isPotm ? 'text-amber-100' : 'text-orange-300'}`}>
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
                      </svg>
                      <span className="tabular-nums">{streakDays}</span> Day Streak
                    </span>
                  )}
                </div>
              );
            })()
          )}
        </div>

        {/* VIEW PROFILE — small vertical pill on the far right, always
            visible. Rotated text keeps it compact on mobile. */}
        <div className="flex-shrink-0 self-stretch flex items-center pr-0.5">
          <span
            className={`inline-flex items-center justify-center px-1.5 py-2.5 rounded-full text-[8.5px] font-black tracking-[0.35em] uppercase whitespace-nowrap transition writing-mode-vertical ${
              isPotm
                ? 'ring-1 ring-amber-100 text-amber-50 bg-amber-900/25'
                : 'ring-1 ring-white/60 text-white/95 hover:bg-white/10'
            }`}
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            View Profile
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
    <div className="bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base rounded-2xl ring-1 ring-line-default/10 overflow-hidden shadow-lg">
      <div className="px-5 py-3 border-b border-line-default/10 flex items-center justify-between">
        <h3 className="font-bold text-ink-primary flex items-center gap-2">
          <svg className="w-4 h-4 text-ink-primary/45" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          Team pulse
        </h3>
        <Link to="/stats" className="text-ink-primary/60 text-sm font-semibold hover:text-ink-primary">Season stats</Link>
      </div>

      {/* Live game tracker entry point — coach can start a session
          without needing a scheduled game on the calendar. */}
      <Link
        to={`/game-day/quick_${Date.now()}`}
        className="mx-4 mt-4 p-3 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 flex items-center gap-3 hover:bg-emerald-500/20 transition active:scale-[0.99]"
      >
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-brand-primary text-white flex items-center justify-center shadow flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-ink-primary text-sm">Live game tracker</p>
          <p className="text-xs text-ink-primary/60">Scores, goals &amp; subs · works on any game</p>
        </div>
        <svg className="w-4 h-4 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </Link>

      {/* Top scorer + assister — side by side */}
      {(topScorer || topAssister) && (
        <div className="p-4 grid grid-cols-2 gap-3">
          {topScorer && (
            <Link to={`/player/${topScorer.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-line-default/[0.05] transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-amber-300 to-yellow-500 flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ts.profilePhotoUrl ? (
                  <img src={ts.profilePhotoUrl} alt={topScorer.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topScorer.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/60">Top scorer</p>
                <p className="font-bold text-ink-primary text-sm truncate">{topScorer.name}</p>
                <p className="text-xs text-emerald-300 font-bold">
                  <span className="font-black">{topScorer.stats?.goals || 0}</span>{' '}
                  <span className="text-ink-primary/45 font-medium uppercase tracking-wider text-[10px]">goals</span>
                </p>
              </div>
            </Link>
          )}
          {topAssister && topAssister.id !== topScorer?.id && (
            <Link to={`/player/${topAssister.id}`} className="flex items-center gap-2.5 -m-1 p-1 rounded-xl hover:bg-line-default/[0.05] transition">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-brand-primary to-surface-raised flex items-center justify-center text-white font-black shadow-sm flex-shrink-0">
                {ta.profilePhotoUrl ? (
                  <img src={ta.profilePhotoUrl} alt={topAssister.name} className="w-full h-full object-cover" />
                ) : (
                  <span>{topAssister.name.charAt(0)}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/60">Top assister</p>
                <p className="font-bold text-ink-primary text-sm truncate">{topAssister.name}</p>
                <p className="text-xs text-brand-primary-soft font-bold">
                  <span className="font-black">{topAssister.stats?.assists || 0}</span>{' '}
                  <span className="text-ink-primary/45 font-medium uppercase tracking-wider text-[10px]">assists</span>
                </p>
              </div>
            </Link>
          )}
        </div>
      )}
      {!topScorer && !topAssister && (
        <p className="p-5 text-sm text-ink-primary/60 text-center">Log a game to see who's leading the team.</p>
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
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-brand-primary-soft mb-1">Latest highlight</p>
        <p className="text-2xl sm:text-3xl font-black leading-tight drop-shadow">{headline}</p>
        {ctxLine && (
          <p className="text-sm text-white/85 mt-0.5 drop-shadow">{ctxLine}</p>
        )}
      </div>

      {/* Center play button */}
      {clip.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-brand-primary/95 ring-2 ring-line-default/80 shadow-2xl flex items-center justify-center">
            <svg className="w-6 h-6 sm:w-7 sm:h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Bottom-left: Watch clip link */}
      <div className="absolute bottom-4 left-4 sm:bottom-5 sm:left-5">
        <span className="inline-flex items-center gap-1.5 text-brand-primary-soft font-bold text-sm drop-shadow">
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
    cyan: 'bg-brand-primary text-white',
    amber: 'bg-orange-500 text-white',
  }[badgeTone];
  return (
    <Link
      to={to}
      className="relative bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base ring-1 ring-line-default/10 rounded-2xl py-3 flex flex-col items-center gap-1.5 text-ink-primary hover:ring-line-default/20 hover:bg-line-default/[0.03] active:scale-[0.97] transition shadow"
    >
      <span className="text-brand-primary-soft">{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/85">{label}</span>
      {badge != null && badge !== 0 && badge !== '' && (
        <span className={`absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold flex items-center justify-center ring-2 ring-surface-base ${badgeColor}`}>
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
}> = ({ label, value, icon, tint = 'bg-line-default/10 text-ink-primary' }) => (
  <div className="bg-gradient-to-br from-surface-base via-surface-elevated to-surface-base rounded-xl ring-1 ring-line-default/10 px-3 py-2.5 flex items-center gap-2.5 shadow">
    {icon && (
      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
        {icon}
      </div>
    )}
    <div className="min-w-0">
      <div className="text-xl font-black text-ink-primary leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-ink-primary/70 mt-0.5">{label}</div>
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
