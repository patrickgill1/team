import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { useTeamAudience } from '../hooks/useTeamAudience';
import { Player, PlayerMedia, DevelopmentPlan, Season } from '../types';
import { isCoachOfTeam } from '../utils/helpers';
import { where } from 'firebase/firestore';
import ParentWhisperModal from '../components/coach/ParentWhisperModal';
import KudosComposerModal from '../components/kudos/KudosComposerModal';
import ProfileHero from '../components/player/ProfileHero';
import ProfileStatsStrip from '../components/player/ProfileStatsStrip';
import ProfileCard from '../components/player/ProfileCard';
import PlayerXpCard from '../components/player/PlayerXpCard';
import LevelProgressBar from '../components/player/LevelProgressBar';
import BadgeCollection from '../components/player/BadgeCollection';
import CoachGrantXpModal from '../components/coach/CoachGrantXpModal';
import PlayerInfoCard from '../components/player/PlayerInfoCard';
import PlayerCircleCard from '../components/player/PlayerCircleCard';
import CoachRecognitionsArchive from '../components/player/CoachRecognitionsArchive';
import PhotoTape from '../components/player/PhotoTape';
import SeasonTimeline from '../components/player/SeasonTimeline';
import PersonalRecords from '../components/player/PersonalRecords';
import RecognitionCenter from '../components/player/RecognitionCenter';
import DevelopmentPlanCard from '../components/player/DevelopmentPlanCard';
import { filterMediaForSeason } from '../utils/mediaFilters';
import SeasonStatsCard from '../components/player/SeasonStatsCard';
import AddPlayer from '../components/player/AddPlayer';
import EmptyState from '../components/common/EmptyState';
import DataGate from '../components/common/DataGate';
import { computeStreakDays } from '../utils/devPlanActions';
import { computePlayerAttendance } from '../utils/attendance';
import { getAllSeasonsForTeam, getActiveSeasonForTeam } from '../utils/seasons';
import { getShareOrigin } from '../utils/origin';
import { publicPlayerCardUrl } from './PublicPlayerCard';
import { downloadFile } from '../utils/downloadFile';
import { streamIframeUrl, streamThumbnailUrl, getStreamDownloadUrl } from '../utils/streamUpload';

interface MatchVoting {
  id: string;
  gameTitle: string;
  gameDate: any;
  isActive: boolean;
  votes: { voterId: string; voterName: string; playerId: string; playerName: string; reason?: string; timestamp: any }[];
  winner?: { playerId: string; playerName: string; voteCount: number };
  winners?: Array<{ playerId: string; playerName: string; voteCount: number }>;
  closedAt?: any;
}

const PlayerProfile: React.FC = () => {
  const { playerId } = useParams<{ playerId: string }>();
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  // Adult vs youth flavor of this profile — hides Player Circle
  // (parent guardians layer) + related family surfaces when the
  // team is adult.
  const { isAdult: isAdultTeam } = useTeamAudience(selectedTeam);
  const { getDocuments, getDocument, getPlayerMediaByPlayer, getDevelopmentPlansByPlayer, getTeamPlayerStatsMap, updateDocument } = useFirestore();

  const [player, setPlayer] = useState<Player | null>(null);
  const [media, setMedia] = useState<PlayerMedia[]>([]);
  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [votingWins, setVotingWins] = useState<MatchVoting[]>([]);
  // Parent Whispers — coach-to-parent private notes about this player.
  // Email is the delivery channel; this list is the in-app history so
  // parents can re-read past notes without scrolling through Gmail.
  const [whispers, setWhispers] = useState<Array<{
    id: string;
    coachUid: string;
    message: string;
    coachName: string;
    coachAvatarUrl?: string | null;
    devPlanTitle?: string | null;
    clipUrl?: string | null;
    clipCaption?: string | null;
    createdAt: Date;
    /** Stamped on the whisper doc at write time; carried through so
     *  RecognitionCenter can drop cross-team whispers in Season mode. */
    teamId?: string;
    // Extended fields for kind-branched rendering (recognition,
    // coach_verify, did_it, level_up). Absent kind falls back to the
    // legacy bare-note render.
    kind?: 'whisper' | 'recognition' | 'coach_verify' | 'did_it' | 'level_up';
    xp?: number;
    badgeSlug?: string;
    badgeCount?: number;
    planId?: string;
    goalId?: string;
    goalTitle?: string;
    logId?: string;
    level?: number;
  }>>([]);
  // Kudos — Circle-member notes on this player (2026-07-14). Live on
  // the whispers tab as their own section, chronological. Coach can
  // one-tap convert any un-converted kudos to +N XP via worker
  // /xp/convert-kudos. See project_player_circle_mission memory.
  const [kudosList, setKudosList] = useState<Array<{
    id: string;
    senderUid: string;
    senderName: string;
    senderAvatarUrl?: string | null;
    note: string;
    presetKind?: string | null;
    createdAt: Date;
    /** teamId at write time (worker /kudos/create stamps it). Carried
     *  through so RecognitionCenter can scope kudos to selectedTeamId
     *  in Season mode. */
    teamId?: string;
    xpAwarded?: number;
    xpAwardedByName?: string;
    xpAwardedAt?: Date | null;
  }>>([]);
  // XP events for this player, loaded to power Sideline Shouts.
  // Filtered client-side to those with `note` set + coach-authored
  // source (see utils/sidelineShouts.ts for the filter contract).
  const [xpEvents, setXpEvents] = useState<Array<{
    id: string;
    xp: number;
    source: string;
    note?: string | null;
    awardedByName?: string | null;
    awardedBy?: string;
    createdAt: Date;
    /** teamId when the event was recorded. Used by RecognitionCenter
     *  to drop cross-team XP notes when the viewer is in Season mode
     *  for a specific team. */
    teamId?: string;
  }>>([]);
  const [allPlayerVotings, setAllPlayerVotings] = useState<{ voting: MatchVoting; playerVotes: { voterName: string; reason?: string }[] }[]>([]);
  const [votingNominations, setVotingNominations] = useState<number>(0);
  const [attendance, setAttendance] = useState<{ percent: number | null; totalEvents: number; attendedEvents: number }>({ percent: null, totalEvents: 0, attendedEvents: 0 });
  const [loading, setLoading] = useState(true);
  // Direction B (2026-07-15): 3-tab structure — Story / Stats / Media.
  // Legacy pushes still use ?tab=whispers / ?tab=awards / ?tab=overview /
  // ?tab=development — those redirect to the new landing tab AND stamp
  // a scroll target so the section that used to be a whole tab still
  // lands the eye in the same spot.
  //   ?tab=overview    → story (top)
  //   ?tab=whispers    → story  + scroll to Sideline Shouts section
  //   ?tab=awards      → story  + scroll to Awards section
  //   ?tab=development → story  + scroll to Dev Plans section
  //     (2026-07-15 Direction B moved DevelopmentPlanCard from Stats to
  //      Story; the initial-tab map has to follow or push notifications
  //      linking to ?tab=development land on Stats with no dev card.)
  //   ?tab=media       → media
  const [activeTab, setActiveTab] = useState<'story' | 'stats' | 'media'>(
    () => {
      try {
        const t = new URLSearchParams(window.location.search).get('tab');
        if (t === 'media') return 'media';
        if (t === 'development') return 'story';
        if (t === 'stats') return 'stats';
        if (t === 'story') return 'story';
        // Legacy: 'whispers', 'awards', 'overview' → story.
      } catch { /* SSR-safe noop */ }
      return 'story';
    }
  );
  // Pending anchor scroll from the legacy ?tab= mapping. Cleared once
  // the section mounts and we scroll into view (see useEffect below).
  // 'xpcard' anchor is used by the top-of-Story LevelProgressBar +
  // BadgeCollection "See all" jumps to land the eye on PlayerXpCard
  // inside the Stats tab.
  const [pendingScrollAnchor, setPendingScrollAnchor] = useState<null | 'shouts' | 'awards' | 'devplans' | 'xpcard'>(
    () => {
      try {
        const t = new URLSearchParams(window.location.search).get('tab');
        if (t === 'whispers') return 'shouts';
        if (t === 'awards') return 'awards';
        // 2026-07-15 Direction B: Dev Plans moved into Story; anchor
        // still 'devplans' but expectedTab flipped to 'story' below.
        if (t === 'development') return 'devplans';
      } catch { /* SSR-safe noop */ }
      return null;
    }
  );
  // Section refs for scrollIntoView from the legacy deep-link redirects
  // above AND for the pill-bar clicks to jump to a section on the same
  // tab. Fine for these to be undefined; the effect handles missing.
  const shoutsSectionRef = useRef<HTMLElement | null>(null);
  const awardsSectionRef = useRef<HTMLElement | null>(null);
  const devPlansSectionRef = useRef<HTMLElement | null>(null);
  const xpCardSectionRef = useRef<HTMLDivElement | null>(null);
  // Sentinel + sticky-detection for the mini-hero. When the sentinel
  // (placed just below the hero + stats strip) leaves the viewport
  // top, we stamp isHeroStuck=true and the sticky pill row grows to
  // include a compact avatar + first name + team.
  const stickySentinelRef = useRef<HTMLDivElement | null>(null);
  const [isHeroStuck, setIsHeroStuck] = useState(false);
  // 2026-07-15 Direction B: shoutFilter state moved INTO
  // RecognitionCenter (owns its own filter). Legacy deep-links land on
  // the whole card via sectionRef; no external chip-preselect needed.
  // Juggle log state — anyone who can see the profile (coach OR the
  // player's parents) can record an attempt.
  const [juggleOpen, setJuggleOpen] = useState(false);
  const [juggleDraft, setJuggleDraft] = useState<string>('');
  // Edit modal (hero pencil opens this)
  const [editOpen, setEditOpen] = useState(false);
  // Memberships for this player across every team/season they're on.
  // Drives the per-team / per-season stats display (no more bleed).
  const [memberships, setMemberships] = useState<any[]>([]);
  // Team name lookup for cross-team memberships, so Career mode
  // section headers / Past Seasons buckets read as
  // "Fire FC U12 · Fall 2025" instead of the generic "Team · …" fallback.
  const [teamNameById, setTeamNameById] = useState<Record<string, string>>({});
  // Which scope the Season Stats card is showing: this team this
  // season (default), this team's career, or all-time across teams.
  const [statsScope, setStatsScope] = useState<'team_season' | 'team_career' | 'all_time'>('team_season');
  const [lightboxItem, setLightboxItem] = useState<PlayerMedia | null>(null);
  const [showWhisper, setShowWhisper] = useState(false);
  const [showKudos, setShowKudos] = useState(false);
  const [kudosBumpKey, setKudosBumpKey] = useState(0); // force reload on send
  const [showGrantXp, setShowGrantXp] = useState(false);
  // Roster for the CoachGrantXpModal — deferred until the coach
  // taps Give XP so a parent-view profile doesn't waste a Firestore
  // read on the roster query.
  const [grantXpRoster, setGrantXpRoster] = useState<Player[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);

  const handleDownload = async (item: PlayerMedia) => {
    if (downloading) return;
    const filename = item.fileName || `${item.playerName}-${item.type}.${item.type === 'video' ? 'mp4' : 'jpg'}`;
    setDownloading(true);
    setDownloadPercent(0);

    // Stream-hosted videos: ask Cloudflare for the real MP4 URL first.
    let sourceUrl = item.url;
    if (item.streamUid) {
      try {
        const dl = await getStreamDownloadUrl(item.streamUid);
        if (dl.ready) {
          sourceUrl = dl.url;
        } else {
          setDownloading(false);
          alert(`Your high-quality download is still being prepared (${dl.percent}% rendered). Try again in ~30 seconds.`);
          return;
        }
      } catch (err) {
        console.error('Stream download URL failed, falling back:', err);
      }
    }

    const result = await downloadFile(sourceUrl, filename, {
      onProgress: p => setDownloadPercent(p.percent),
    });
    setDownloading(false);
    setDownloadPercent(0);
    if (result.ok === false && result.reason === 'fetch-failed') {
      alert("Your browser couldn't save this directly. The file opened in a new tab — long-press (mobile) or right-click (desktop) to save it.");
    }
  };

  // Season selector — null = current/active season; 'lifetime' = career; otherwise specific seasonId
  const [allSeasons, setAllSeasons] = useState<Season[]>([]);
  const [activeSeason, setActiveSeason] = useState<Season | null>(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | 'lifetime'>('current');
  const [seasonMenuOpen, setSeasonMenuOpen] = useState(false);

  useEffect(() => {
    if (!selectedTeamId) return;
    let cancelled = false;
    Promise.all([
      getActiveSeasonForTeam(selectedTeamId),
      getAllSeasonsForTeam(selectedTeamId),
    ]).then(([active, all]) => {
      if (cancelled) return;
      setActiveSeason(active);
      setAllSeasons(all);
    });
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  useEffect(() => {
    if (playerId && selectedTeamId) loadProfile();
  }, [playerId, selectedTeamId]);

  // Tab-change URL writeback (2026-07-15): so the profile's back
  // button returns to the previous tab, not out of the profile
  // entirely. Only replaces state, never pushes — the profile itself
  // is one history entry, tab switches are lateral moves within it.
  // Also handles the scroll-anchor jump from legacy ?tab= redirects
  // (?tab=whispers → story + shouts anchor).
  const handleTabChange = useCallback((next: 'story' | 'stats' | 'media', anchor?: 'shouts' | 'awards' | 'devplans' | 'xpcard') => {
    setActiveTab(next);
    if (anchor) setPendingScrollAnchor(anchor);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch { /* SSR-safe noop */ }
  }, []);

  // 2026-07-15 fix: normalize legacy ?tab= URLs on mount. If a
  // parent lands from an old push notification with ?tab=whispers,
  // we've already remapped to the story tab in state above, but
  // the URL bar still says ?tab=whispers. Rewrite via replaceState
  // so hard-reload and any URL scraper sees the canonical value.
  // Scroll anchor is preserved separately via pendingScrollAnchor.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get('tab');
      const canonical: Record<string, 'story' | 'stats' | 'media'> = {
        whispers:    'story',
        awards:      'story',
        overview:    'story',
        // 2026-07-15 Direction B: Dev Plans moved into Story, so this
        // now lands on the Story tab and scrolls to DevelopmentPlanCard.
        development: 'story',
      };
      const target = t && canonical[t];
      if (target) {
        url.searchParams.set('tab', target);
        window.history.replaceState(window.history.state, '', url.toString());
      }
    } catch { /* SSR-safe noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sticky-hero sentinel: an IntersectionObserver watches an invisible
  // element placed at the end of the hero band. When it exits the top
  // of the viewport, the pill bar row above sprouts a compact
  // avatar + first-name + team so the user always knows which player
  // they're inside of. See feedback dashboard-density: single-line
  // preview treatment.
  useEffect(() => {
    const sentinel = stickySentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        // Sentinel is above the sticky pill bar. When it's fully out
        // of view, the pill bar is stuck at the top.
        setIsHeroStuck(!e.isIntersecting);
      },
      { threshold: 0, rootMargin: '0px 0px 0px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  // Scroll-to-anchor after tab body mount. If a legacy ?tab= redirect
  // (or a manual jump via setActiveTab+setPendingScrollAnchor) has
  // asked us to land inside a specific section, wait a beat for the
  // tab body to render then scrollIntoView on the ref. Guarded so we
  // only try when the requested tab actually matches the anchor.
  useEffect(() => {
    if (!pendingScrollAnchor || loading) return;
    let ref: React.RefObject<HTMLElement | HTMLDivElement> | null = null;
    let expectedTab: 'story' | 'stats' | 'media' | null = null;
    if (pendingScrollAnchor === 'shouts')   { ref = shoutsSectionRef;   expectedTab = 'story'; }
    if (pendingScrollAnchor === 'awards')   { ref = awardsSectionRef;   expectedTab = 'story'; }
    // 2026-07-15 Direction B: DevelopmentPlanCard moved from Stats to
    // Story, so the ?tab=development redirect now lands on Story with
    // the devplans anchor.
    if (pendingScrollAnchor === 'devplans') { ref = devPlansSectionRef; expectedTab = 'story'; }
    if (pendingScrollAnchor === 'xpcard')   { ref = xpCardSectionRef;   expectedTab = 'stats'; }
    if (!ref || expectedTab !== activeTab) return;
    // requestAnimationFrame gives the just-rendered section a beat to
    // paint before we ask for its position. Two frames is a hedge for
    // slow Android WebViews (Patrick's onboarding target).
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const el = ref?.current;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setPendingScrollAnchor(null);
      });
      // Cleanup handle stored so we can cancel if unmount races.
      (raf1 as any)._nested = raf2;
    });
    return () => {
      cancelAnimationFrame(raf1);
      if ((raf1 as any)._nested) cancelAnimationFrame((raf1 as any)._nested);
    };
  }, [pendingScrollAnchor, loading, activeTab]);

  // Roster load for Give XP modal — deferred until the coach opens it.
  useEffect(() => {
    if (!showGrantXp || !selectedTeamId) return;
    if (grantXpRoster.length > 0) return; // one-shot per profile session
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', selectedTeamId),
        ));
        if (cancelled) return;
        setGrantXpRoster(
          snap.docs
            .map(d => ({ id: d.id, ...(d.data() as any) }))
            .filter((p: any) => p.isActive !== false) as Player[]
        );
      } catch (err) {
        console.warn('[player-profile] grant-xp roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [showGrantXp, selectedTeamId, grantXpRoster.length]);

  const loadProfile = async () => {
    if (!playerId || !selectedTeamId) return;
    setLoading(true);

    // Load player first (needed to render header). Direct getDocument
    // by id — the previous "load all + client-find" pattern silently
    // 403'd against the tightened callerCanReadPlayer LIST rule the
    // moment any cross-tenant player was in the DB.
    try {
      const [found, statsMap] = await Promise.all([
        getDocument('players', playerId) as Promise<any>,
        getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
      ]);
      if (found) {
        const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
        const isShared = Array.isArray(found.teamIds) && found.teamIds.length > 1;
        const teamScoped = (statsMap as any)[playerId];
        setPlayer({
          ...found,
          createdAt: found.createdAt?.toDate ? found.createdAt.toDate() : new Date(found.createdAt),
          dateOfBirth: found.dateOfBirth?.toDate ? found.dateOfBirth.toDate() : found.dateOfBirth ? new Date(found.dateOfBirth) : undefined,
          // Override aggregate with per-team stats so SHARED players (rostered
          // on multiple teams) only show stats for the currently selected team.
          // Never fall back to the combined aggregate when shared.
          stats: teamScoped || (isShared ? empty : (found.stats || empty)),
        } as Player);
      }
    } catch (err) {
      console.error('Error loading player:', err);
    }

    // Load this player's memberships (player × team × season rows)
    // for the team-scoped / career / all-time stats tabs.
    try {
      const memDocs = await getDocuments('player_memberships', [where('playerId', '==', playerId)]);
      setMemberships(memDocs as any[]);
      const uniqueTeamIds = Array.from(new Set(
        (memDocs as any[])
          .map(m => m?.teamId as string | undefined)
          .filter((t): t is string => !!t && t !== selectedTeamId)
      ));
      if (uniqueTeamIds.length > 0) {
        const teamDocs = await Promise.allSettled(
          uniqueTeamIds.map(tid => getDocument('teams', tid) as Promise<any>)
        );
        const nextMap: Record<string, string> = {};
        teamDocs.forEach((res, i) => {
          if (res.status === 'fulfilled' && res.value?.name) {
            nextMap[uniqueTeamIds[i]] = res.value.name;
          }
        });
        if (Object.keys(nextMap).length > 0) setTeamNameById(nextMap);
      }
    } catch (err) {
      // Memberships may not exist for this player if the migration didn't
      // run for them — fall back to the legacy player.stats behavior.
      console.warn('memberships load failed', err);
    }

    // Load media, plans, and votings independently so one failure doesn't block others
    const [mediaResult, taggedMediaResult, plansResult, votingsResult] = await Promise.allSettled([
      getPlayerMediaByPlayer(playerId),
      getDocuments('player_media', [
        where('taggedPlayerIds', 'array-contains', playerId),
      ]),
      // Scope to selectedTeamId so a Team B coach viewing a player
      // who was on Team A does NOT see Team A's plans. Founder-
      // reported bug 2026-07-14: "i have one player that has old
      // development plans showing up from our last team". Plans
      // stamp teamId at write time; the LIST rule was allowing
      // cross-team reads.
      getDevelopmentPlansByPlayer(playerId, selectedTeamId),
      getDocuments('match_votings', []),
    ]);

    if (mediaResult.status === 'fulfilled' || taggedMediaResult.status === 'fulfilled') {
      const directMedia = mediaResult.status === 'fulfilled' ? mediaResult.value : [];
      const taggedMedia = taggedMediaResult.status === 'fulfilled' ? taggedMediaResult.value : [];
      // Merge and deduplicate by id
      const allMedia = [...directMedia, ...taggedMedia];
      const seen = new Set<string>();
      const dedupedMedia = allMedia.filter((m: any) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      setMedia(dedupedMedia.map((m: any) => ({
        ...m,
        createdAt: m.createdAt?.toDate ? m.createdAt.toDate() : new Date(m.createdAt),
      })).sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime()) as PlayerMedia[]);
    } else {
      console.error('Error loading media:', mediaResult.status === 'rejected' ? mediaResult.reason : taggedMediaResult.status === 'rejected' ? (taggedMediaResult as PromiseRejectedResult).reason : 'unknown');
    }

    if (plansResult.status === 'fulfilled') {
      setPlans(plansResult.value.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
        completedAt: p.completedAt?.toDate ? p.completedAt.toDate() : undefined,
        // seasonId is optional per DevelopmentPlan interface; carry
        // through when present so DevelopmentPlanCard can filter
        // Earlier plans by the active season with a null grace clause.
        seasonId: (p as any).seasonId || undefined,
      })) as DevelopmentPlan[]);
    } else {
      console.error('Error loading development plans:', plansResult.reason);
    }

    if (votingsResult.status === 'fulfilled') {
      // 2026-07-15 Direction B: the old `teamVotings` local was dead
      // (only powered a votingWins count derived below), so it's gone.
      // RecognitionCenter builds its own team+season scoped views from
      // `allPlayerVotings` via useMemo, and career surfaces read from
      // the same source unfiltered.

      // Career POTM wins — NOT scoped by selectedTeamId so a kid who
      // played on a renamed / recreated team, or was moved between
      // teams across seasons, still gets credit for every past win.
      // The winner match on playerId is unique enough that we don't
      // need the teamId narrowing here. Patrick 2026-07-12: "my son
      // did get POTM awards last season but it is not showing under
      // overall" — root cause was this teamId filter dropping votings
      // whose team key had drifted.
      const allWins = (votingsResult.value as any[])
        .filter(v =>
          (Array.isArray(v.winners) && v.winners.some((w: any) => w?.playerId === playerId))
          || v.winner?.playerId === playerId
        )
        .map(v => ({
          ...v,
          gameDate: v.gameDate?.toDate ? v.gameDate.toDate() : new Date(v.gameDate),
          closedAt: v.closedAt?.toDate ? v.closedAt.toDate() : undefined,
        })) as MatchVoting[];
      setVotingWins(allWins);

      // Whispers for this player — coach private notes archived in
      // /parent_whispers. One-shot read on load; if Patrick later wants
      // live updates we'd swap for onSnapshot.
      try {
        const { collection, getDocs, query, where, orderBy } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const wSnap = await getDocs(query(
          collection(db, 'parent_whispers'),
          where('playerId', '==', playerId),
          orderBy('createdAt', 'desc'),
        ));
        setWhispers(wSnap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            coachUid: data.coachUid || '',
            message: data.message || '',
            coachName: data.coachName || 'Coach',
            coachAvatarUrl: data.coachAvatarUrl || null,
            devPlanTitle: data.devPlanTitle || null,
            clipUrl: data.clipUrl || null,
            clipCaption: data.clipCaption || null,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
            teamId: data.teamId || undefined,
            kind: data.kind,
            xp: data.xp,
            badgeSlug: data.badgeSlug,
            badgeCount: data.badgeCount,
            planId: data.planId,
            goalId: data.goalId,
            goalTitle: data.goalTitle,
            logId: data.logId,
            level: data.level,
          };
        }));
      } catch (err) {
        // Index might not exist yet — fall back to unordered query.
        try {
          const { collection, getDocs, query, where } = await import('firebase/firestore');
          const { db } = await import('../utils/firebase');
          const wSnap = await getDocs(query(
            collection(db, 'parent_whispers'),
            where('playerId', '==', playerId),
          ));
          const list = wSnap.docs.map(d => {
            const data: any = d.data();
            return {
              id: d.id,
              coachUid: data.coachUid || '',
              message: data.message || '',
              coachName: data.coachName || 'Coach',
              coachAvatarUrl: data.coachAvatarUrl || null,
              devPlanTitle: data.devPlanTitle || null,
              clipUrl: data.clipUrl || null,
              clipCaption: data.clipCaption || null,
              createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
              teamId: data.teamId || undefined,
            };
          });
          list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          setWhispers(list);
        } catch { /* whispers absent on this profile is fine */ }
      }

      // Kudos — Circle-member notes tied to this player. Same read
      // scope as whispers (rule callerCanReadWhisper). Fire-and-forget;
      // failure is fine (no kudos yet is the common case).
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db: kdb } = await import('../utils/firebase');
        const kSnap = await getDocs(query(
          collection(kdb, 'kudos'),
          where('playerId', '==', playerId),
        ));
        const kList = kSnap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            senderUid: data.senderUid || '',
            senderName: data.senderName || 'A Circle member',
            senderAvatarUrl: data.senderAvatarUrl || null,
            note: data.note || '',
            presetKind: data.presetKind || null,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
            teamId: data.teamId || undefined,
            xpAwarded: typeof data.xpAwarded === 'number' ? data.xpAwarded : undefined,
            xpAwardedByName: data.xpAwardedByName || null,
            xpAwardedAt: data.xpAwardedAt?.toDate?.() || null,
          };
        });
        kList.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        setKudosList(kList);
      } catch { /* no kudos yet is fine */ }

      // XP events — powers Sideline Shouts. Read scope same as
      // whispers (rule callerCanReadWhisper). Only interested in
      // events with a note; filter client-side rather than adding
      // an index. Cap at 200 so a long-tenured player doesn't drag
      // the read.
      try {
        const { collection, getDocs, query, where, orderBy, limit } = await import('firebase/firestore');
        const { db: xdb } = await import('../utils/firebase');
        const eSnap = await getDocs(query(
          collection(xdb, 'player_xp_events'),
          where('playerId', '==', playerId),
          orderBy('createdAt', 'desc'),
          limit(200),
        ));
        const eList = eSnap.docs.map(d => {
          const data: any = d.data();
          return {
            id: d.id,
            xp: Number(data.xp) || 0,
            source: String(data.source || ''),
            note: data.note ? String(data.note) : null,
            awardedByName: data.awardedByName || null,
            awardedBy: data.awardedBy || undefined,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
            teamId: data.teamId || undefined,
          };
        });
        setXpEvents(eList);
      } catch { /* no events yet is fine */ }


      // Collect all votings where this player received votes (with
      // reasons). Deriving from votingsResult.value directly (NOT the
      // teamVotings-scoped list) so a kid who was nominated on a
      // renamed / recreated team, or across seasons on a different
      // team doc, still gets credit. Same fix pattern as the 2026-07-12
      // `allWins` treatment above — teamId drift silently dropped
      // nominations from the count, the Vote History list, and
      // PersonalRecords' votingNominations prop. Patrick 2026-07-15:
      // "his son has POTM nominations that aren't showing in the
      // trophy case" — root cause was this teamId filter.
      const playerVotings = (votingsResult.value as any[])
        .filter((v: any) => Array.isArray(v.votes) && v.votes.some((vote: any) => vote.playerId === playerId))
        .map((v: any) => ({
          voting: {
            ...v,
            gameDate: v.gameDate?.toDate ? v.gameDate.toDate() : new Date(v.gameDate),
            closedAt: v.closedAt?.toDate ? v.closedAt.toDate() : undefined,
          } as MatchVoting,
          playerVotes: v.votes.filter((vote: any) => vote.playerId === playerId).map((vote: any) => ({
            voterName: vote.voterName,
            reason: vote.reason,
          })),
        }))
        .sort((a, b) => {
          const da = a.voting.gameDate instanceof Date ? a.voting.gameDate.getTime() : 0;
          const db = b.voting.gameDate instanceof Date ? b.voting.gameDate.getTime() : 0;
          return db - da;
        });
      setAllPlayerVotings(playerVotings);
      setVotingNominations(playerVotings.length);
    } else {
      console.error('Error loading voting history:', votingsResult.reason);
    }

    setLoading(false);

    // Practice attendance — separate (slower) query so the rest of
    // the page lights up first. No big deal if this lags behind.
    // 2026-07-14 scoping rule ([[stats-scoping-model]]): scope
    // attendance to the CURRENTLY VIEWED team only. Prior code
    // passed every teamId the player was on, which polluted the
    // hero "PRACTICE ATTENDANCE" cell with old-team events for
    // transferred/shared players.
    void (async () => {
      try {
        if (!selectedTeamId) return;
        const r = await computePlayerAttendance(playerId, [selectedTeamId], { lookback: 10 });
        setAttendance(r);
      } catch (err) {
        console.warn('attendance load failed', err);
      }
    })();
  };

  // 2026-07-15 Direction B: getProgressPercent/getCategoryColor/
  // getCategoryIcon and the local PlanDetail component were dropped
  // when Dev Plans moved out of the Stats tab into
  // DevelopmentPlanCard on Story. Per-goal practice log detail is
  // reachable from the "Open plan" button in the Story card.

  const handleShareProfile = async () => {
    if (!player) return;
    // Sharing requires publicShare.enabled — otherwise the link
    // would just hit the gated /player/<id> route and bounce
    // anyone not signed in to the auth wall (Patrick caught this
    // 2026-06-27). Walk the parent through enabling public share
    // before generating the URL.
    const isPublic = !!(player as any).publicShare?.enabled;
    if (!isPublic) {
      const ok = window.confirm(
        `Sharing ${player.name}'s card publicly?\n\n` +
        `Anyone with the link will see: photo, name, jersey, team, position, and Player of the Match count.\n\n` +
        `Never shared: parent contact info, chat, medical, RSVPs, family addresses.\n\n` +
        `You can turn sharing off any time.`,
      );
      if (!ok) return;
      try {
        const { updateDoc, doc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        await updateDoc(doc(db, 'players', player.id), {
          publicShare: {
            enabled: true,
            enabledAt: new Date(),
            enabledBy: userData?.uid || null,
          },
        });
        // Re-read into local state so the next share tap goes
        // straight to the URL flow without re-prompting.
        setPlayer({ ...(player as any), publicShare: { enabled: true, enabledAt: new Date(), enabledBy: userData?.uid || null } });
      } catch (err) {
        console.error('publicShare flip failed', err);
        alert("Couldn't enable sharing. Try again.");
        return;
      }
    }
    const url = publicPlayerCardUrl(player.id);
    const data = { title: `${player.name} · GoalKickr`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(url); alert('Profile link copied!'); }
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        try { await navigator.clipboard.writeText(url); alert('Profile link copied!'); } catch {}
      }
    }
  };

  // Parent-only action to turn public sharing off after they've
  // enabled it. Useful when a link gets out further than intended
  // or after a season ends. Reachable from the same share affordance.
  const disablePublicShare = async () => {
    if (!player) return;
    if (!window.confirm(`Turn off public sharing for ${player.name}? Existing links will stop working immediately.`)) return;
    try {
      const { updateDoc, doc } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      await updateDoc(doc(db, 'players', player.id), {
        publicShare: { enabled: false },
      });
      setPlayer({ ...(player as any), publicShare: { enabled: false } });
      alert('Public sharing is off.');
    } catch (err) {
      console.error('publicShare disable failed', err);
      alert("Couldn't turn off sharing. Try again.");
    }
  };

  // Story-tab pill count — season+team scoped so it matches the
  // Recognition wall the parent will actually see. Prior to this,
  // the pill summed raw kudosList/whispers/xpEvents (all-team, all-
  // time), which then contradicted the visible feed after the tab
  // opened. Uses the same truthy-guard grace clause that
  // RecognitionCenter applies so legacy no-teamId docs stay in.
  const storyPillCount = useMemo(() => {
    const seasonStart = activeSeason?.startDate ? new Date(activeSeason.startDate).getTime() : -Infinity;
    const seasonEnd = activeSeason?.endDate ? new Date(activeSeason.endDate).getTime() : Infinity;
    const inWindow = (t: Date | undefined): boolean => {
      if (!activeSeason) return true;
      if (!t) return false;
      const ms = t instanceof Date ? t.getTime() : new Date(t as any).getTime();
      return ms >= seasonStart && ms <= seasonEnd;
    };
    const k = kudosList.filter(x => {
      if ((x as any).teamId && (x as any).teamId !== selectedTeamId) return false;
      return inWindow(x.createdAt);
    }).length;
    const w = whispers.filter(x => {
      if ((x as any).teamId && (x as any).teamId !== selectedTeamId) return false;
      return inWindow(x.createdAt);
    }).length;
    const x = xpEvents.filter(e => {
      if (!e.note) return false;
      if ((e as any).teamId && (e as any).teamId !== selectedTeamId) return false;
      return inWindow(e.createdAt);
    }).length;
    return k + w + x;
  }, [kudosList, whispers, xpEvents, selectedTeamId, activeSeason]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-base">
        <DataGate when="loading" />
      </div>
    );
  }

  if (!player) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <h2 className="text-xl font-bold text-ink-primary">Player Not Found</h2>
          <Link to="/players" className="text-brand-primary hover:underline mt-2 inline-block">← Back to Roster</Link>
        </div>
      </div>
    );
  }

  const activePlans = plans.filter(p => p.status === 'active');
  const completedPlans = plans.filter(p => p.status === 'completed');
  // Recent clips strip is team-scoped — when viewing a player from a
  // team's roster, only show media tied to that team. Prior-team clips
  // still live on the player's Media page under the All-time view.
  const recentMedia = media
    .filter(m => !selectedTeamId || (m as any).teamId === selectedTeamId)
    .slice(0, 6);

  // Kudos gate — 2026-07-14: viewer must be in Circle AND NOT the
  // immediate parent. Kudos are meant to be from OTHER Circle members
  // (grandparent, aunt, guardian, etc.) cheering the kid on; a parent
  // giving Kudos to their own kid is self-congratulatory noise.
  //
  // Rule: user.uid ∈ player.parentIds AND user.relationship is set to
  // something OTHER than 'parent'. Legacy users with undefined
  // relationship default to 'parent' semantics (per FamilyRelationship
  // type comment) so they're also excluded — those users can update
  // their relationship in Settings > Profile to enable the button.
  const canGiveKudos = !!userData
    && Array.isArray((player as any)?.parentIds)
    && (player as any).parentIds.includes(userData.uid)
    && !!(userData as any)?.relationship
    && (userData as any).relationship !== 'parent';

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="mx-auto w-full max-w-6xl sm:px-4 lg:px-6 sm:py-5">
        <div className="overflow-hidden bg-surface-base text-ink-primary sm:rounded-2xl sm:ring-1 sm:ring-line-default/10">
        {/* ───── HERO (v2) ───── */}
      <ProfileHero
        player={player}
        teamName={selectedTeam?.name}
        canEdit={!!userData && (isCoachOfTeam(userData, selectedTeam) || (player.parentIds || []).includes(userData.uid))}
        isCurrentPotm={!!(player as any).isCurrentPotm}
        onBack={() => { window.history.length > 1 ? window.history.back() : (window.location.href = '/players'); }}
        onEdit={() => setEditOpen(true)}
        showKudos={canGiveKudos}
        onKudos={() => setShowKudos(true)}
        showWhisper={!!userData && isCoachOfTeam(userData, selectedTeam) && !isAdultTeam}
        onWhisper={() => setShowWhisper(true)}
        onShare={handleShareProfile}
        publicShareEnabled={!!(player as any)?.publicShare?.enabled}
        onStopShare={disablePublicShare}
      />

      {/* 2026-07-14 scoping rule ([[stats-scoping-model]]): hero cells
          show THIS team + THIS season. Career surfaces (Awards tab,
          Career section) still get the unscoped counts.
            - POTM: filter votingWins by seasonId equality OR closedAt
              inside the active season's window (legacy no-seasonId
              votings), AND teamId === selectedTeamId.
            - Streak: recompute from the team-scoped `plans` array
              instead of reading the possibly-stale
              player.currentStreakDays cache (that field self-heals
              on Dashboard mount, but PlayerProfile shouldn't rely on
              the parent having opened the Dashboard first).
            - Attendance: driven by the effect above; it's now scoped
              to [selectedTeamId] only, not player.teamIds.
            - Juggle: kept as lifetime PR — it's a self-set record,
              not a per-game stat, so cross-season is defensible. */}
      {(() => {
        // Season-scoped POTM count for this team.
        let heroPotmCount = 0;
        if (selectedTeamId) {
          const seasonObj = activeSeason || null;
          const startMs = seasonObj?.startDate ? new Date(seasonObj.startDate).getTime() : 0;
          const endMs = seasonObj?.endDate ? new Date(seasonObj.endDate).getTime() : Infinity;
          heroPotmCount = votingWins.filter((v: any) => {
            if (v?.teamId && v.teamId !== selectedTeamId) return false;
            if (!seasonObj) return true;
            if (v.seasonId === seasonObj.id) return true;
            if (!v.seasonId) {
              const closedMs = v.closedAt ? new Date(v.closedAt).getTime() : 0;
              return closedMs >= startMs && closedMs <= endMs;
            }
            return false;
          }).length;
        }
        const heroStreak = plans.length > 0
          ? computeStreakDays(plans as any)
          : ((player as any).currentStreakDays || 0);
        return (
          <ProfileStatsStrip
            potmWins={heroPotmCount}
            streakDays={heroStreak}
            attendancePct={attendance.percent}
            jugglesBest={(player as any).juggles?.best || 0}
          />
        );
      })()}

      {/* 2026-07-15 (Direction B): the blocks that used to sit here
          between the ProfileStatsStrip and the pill bar — FeaturedShoutCard,
          PlayerXpCard, the 4-button action row, the season toggle + 4-up
          career stats — are gone. FeaturedShoutCard + PlayerXpCard live
          inside the Story / Stats tabs now; the action row folded into
          ProfileHero's top-nav (Whisper + Share) and PlayerCircleCard
          overflow (Stop share); the 4-up career stats collapse into the
          Season Stats card in the Stats tab. */}

      {/* Sticky-hero sentinel. When this element exits the viewport,
          IntersectionObserver flips isHeroStuck=true and the sticky
          pill bar row below grows a compact avatar + first-name +
          team so the parent always knows which player they're in. */}
      <div ref={stickySentinelRef} aria-hidden className="h-px w-full" />

      {/* ───── STICKY MINI-HERO + PILL TABS ─────
          Direction B (2026-07-15): the pill row was reported as a
          trap — parents said "I can't get out of the pill." When the
          hero band scrolls out of view, this bar sprouts a compact
          identity strip above the pills so the player context (photo
          + first name + team) is always visible, and the parent can
          swipe/back with confidence. */}
      <div className="bg-surface-base sticky top-0 z-20 border-b border-line-default/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          {/* Mini-hero row — only visible when scrolled past the
              hero. Kept to ~40px vertical so it doesn't steal space
              from the tab body. */}
          <div
            className={`overflow-hidden transition-all duration-200 ${isHeroStuck ? 'max-h-14 opacity-100' : 'max-h-0 opacity-0'}`}
            aria-hidden={!isHeroStuck}
          >
            <div className="flex items-center gap-2.5 py-2">
              {player.profilePhotoUrl ? (
                <img
                  src={player.profilePhotoUrl}
                  alt=""
                  className="w-8 h-8 rounded-full object-cover ring-1 ring-brand-primary/40"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-brand-primary text-white flex items-center justify-center text-[11px] font-black ring-1 ring-line-default/20">
                  {(player.name || '?').charAt(0).toUpperCase()}
                </div>
              )}
              <span className="text-sm font-bold text-ink-primary truncate">
                {(player.name || 'Player').split(' ')[0]}
              </span>
              {selectedTeam?.name && (
                <>
                  <span className="text-ink-primary/25 text-xs">·</span>
                  <span className="text-[12px] font-semibold text-ink-primary/60 truncate">
                    {selectedTeam.name}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Wrap, never scroll. Sideways pill scrolling hides options
              behind the right edge and reads as "we ran out of room." */}
          <div className="flex flex-wrap gap-1.5 py-3">
            {(['story', 'stats', 'media'] as const).map(tab => {
              // 'stats' hosts the Development section for youth teams;
              // on adult teams the section is hidden but the tab
              // itself still exists (has other content). No tabs are
              // adult-hidden in the 3-tab structure.
              const count =
                tab === 'media' ? media.length :
                tab === 'story' ? storyPillCount :
                tab === 'stats' ? (isAdultTeam ? 0 : activePlans.length) :
                null;
              const label =
                tab === 'story' ? 'Story' :
                tab === 'stats' ? 'Stats' :
                'Media';
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition ${
                    isActive
                      ? 'bg-ink-primary text-surface-base shadow'
                      : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.1]'
                  }`}
                >
                  <span>{label}</span>
                  {count !== null && count > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                      isActive ? 'bg-surface-base/20 text-surface-base' : 'bg-surface-elevated text-ink-primary/50'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

        {/* ─── STORY TAB ──────────────────────────────────────────
            The people-and-narrative tab. Absorbs the old Overview
            (minus stats), the old Sideline Shouts tab (POTM quote +
            filterable feed inline), and the old Awards tab (trophy
            tiles + vote history). Section anchors let ?tab=whispers
            and ?tab=awards land on the same visual spot they used
            to. */}

      {/* 2026-07-15 fix: merged the previously-separate hero-card
          wrapper (line 786) and tab-body wrapper (was line 958) into
          one shared parent so `position: sticky` on the pill bar
          actually sticks through the tab bodies. Prior structure
          closed the parent right before the tab bodies opened,
          which capped sticky's stick-range at ~380px (hero + stats).
          The core UX promise ("can't get out of the pill") depends
          on sticky working, so this is a structural bug fix. */}
      {activeTab === 'story' && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
          <div className="flex flex-col gap-4 sm:gap-6">

            {/* LEVEL PROGRESS BAR — compact mini-card that surfaces
                the XP ladder without making parents discover the
                Stats tab first. Tap → jumps to PlayerXpCard in Stats.
                Renders null when team.xpConfig.enabled !== true so
                non-XP teams stay clean. 2026-07-15: Patrick's
                complaint "hidden in status" — parents open Story
                first and never saw progression. */}
            <LevelProgressBar
              player={player}
              team={selectedTeam}
              onSeeDetails={() => handleTabChange('stats', 'xpcard')}
            />

            {/* BADGE COLLECTION — top-6 most-recent badges as a
                preview strip. Hidden when the player has zero badges
                (avoids Swiss-cheese scroll on brand-new profiles).
                "See all" jumps to PlayerXpCard's Locker grid in Stats. */}
            <BadgeCollection
              player={player}
              activeSeason={activeSeason}
              onSeeAll={() => handleTabChange('stats', 'xpcard')}
            />

            {/* PLAYER CIRCLE — parents/guardians linked to this player.
                Sits at the top of Story so a parent lands where the
                invite-a-guardian path is discoverable. Hidden on
                adult teams since players there ARE the account. */}
            {userData && !isAdultTeam && (
              <PlayerCircleCard
                player={player}
                viewerUid={userData.uid}
                viewerEmail={userData.email || ''}
                viewerRole={userData.role || ''}
                publicShareEnabled={!!(player as any)?.publicShare?.enabled}
                onStopPublicShare={disablePublicShare}
              />
            )}

            {/* PLAYER INFO — bio card + Personalize entry point. */}
            <PlayerInfoCard
              player={player}
              canEdit={!!userData && (isCoachOfTeam(userData, selectedTeam) || (player.parentIds || []).includes(userData.uid))}
              onUpdated={loadProfile}
            />

            {/* DEVELOPMENT PLAN — promoted out of Stats into Story
                so a plan-in-motion reads as narrative, not a metric.
                Youth-only render gate (adult teams have no coach-
                driven dev plans). Grace clause on completedPlans:
                legacy plans with no seasonId still surface in the
                Earlier drawer so nothing silently drops. */}
            {!isAdultTeam && (
              <section ref={devPlansSectionRef} id="story-devplans" className="scroll-mt-32">
                <DevelopmentPlanCard
                  activePlans={activePlans}
                  completedPlans={completedPlans}
                  activeSeason={activeSeason}
                  playerId={playerId!}
                  player={player}
                  actor={userData ? { uid: userData.uid, name: userData.name || 'Family' } : null}
                  onUpdated={loadProfile}
                />
              </section>
            )}

            {/* RECOGNITION CENTER — one card that unifies the featured
                POTM quote, the Sideline Shouts feed with filter tabs,
                the trophy tiles, and the vote history drawer. Season
                vs Career toggle scopes every source client-side.
                sectionRef preserves the ?tab=whispers scroll anchor;
                awardsRef preserves the ?tab=awards scroll anchor
                (both land inside this card now). */}
            <RecognitionCenter
              sectionRef={shoutsSectionRef}
              awardsRef={awardsSectionRef}
              playerId={playerId!}
              player={player}
              selectedTeamId={selectedTeamId}
              selectedTeam={selectedTeam}
              activeSeason={activeSeason}
              availableSeasons={allSeasons}
              kudos={kudosList}
              whispers={whispers}
              xpEvents={xpEvents}
              allPlayerVotings={allPlayerVotings}
              memberships={memberships as any}
              teamNameById={teamNameById}
              userData={userData}
              canGiveKudos={canGiveKudos}
              isCoach={!!userData && isCoachOfTeam(userData, selectedTeam)}
              setKudosList={setKudosList}
            />

            {/* SEASON TIMELINE — narrative ribbon of every timestamped
                milestone this player earned in the active season
                (badges + player_xp_events). Silent-empty on legacy
                teams with xpConfig disabled. */}
            <SeasonTimeline
              playerId={playerId!}
              player={player}
              teamId={selectedTeamId}
              season={activeSeason}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />

            {/* EMPTY STATE — kept as a warm hint when the profile is
                genuinely blank across every Story surface. Preserved
                per feedback_atomic_render_over_skeletons + the
                design contract's "keep only if none of the three
                cards render" clause. */}
            {plans.length === 0 && recentMedia.length === 0 && votingWins.length === 0 && (
              <ProfileCard eyebrow="Starting line" title={`${player.name.split(' ')[0]}'s journey starts here`} centered>
                <p className="text-sm text-ink-primary/60 leading-snug">
                  Stats, clips, shouts, and awards will show up as the season unfolds.
                </p>
              </ProfileCard>
            )}
          </div>
        </div>
      )}

        {/* ─── STATS TAB ──────────────────────────────────────────
            The numbers-and-growth tab. Absorbs the old Overview
            stat cards, the old Development tab (active plans list),
            the old PlayerXpCard + CoachRecognitionsArchive. Section
            anchor lets ?tab=development scroll to the Dev Plans. */}
      {activeTab === 'stats' && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
          <div className="flex flex-col gap-4 sm:gap-6">

            {/* SEASON STATS — sole scope switcher for the whole page
                now (the deleted top-of-hero 4-up had its own toggle;
                consolidated here). */}
            <SeasonStatsCard
              player={player}
              memberships={memberships}
              selectedTeamId={selectedTeamId}
              scope={statsScope}
              onScopeChange={setStatsScope}
            />

            {/* PERSONAL RECORDS — number receipts pinned to the same
                season concept as the Season Stats card above. */}
            <PersonalRecords
              playerId={playerId!}
              player={player}
              seasonId={
                selectedSeasonId === 'lifetime' ? 'lifetime'
                : selectedSeasonId === 'current' ? (activeSeason?.id || 'lifetime')
                : selectedSeasonId
              }
              votingWins={votingWins}
              votingNominations={allPlayerVotings.map(v => v.voting)}
            />

            {/* JUGGLE COUNTER — self-reported personal best + last
                week's attempts. Coach + parents can log an attempt.
                Moved from Overview → Stats (numbers cluster). */}
            {userData && (isCoachOfTeam(userData, selectedTeam) || (player.parentIds || []).includes(userData.uid)) && (() => {
              const j = (player as any).juggles || {};
              const history: Array<{ count: number; date: any }> = Array.isArray(j.history) ? j.history : [];
              const best = typeof j.best === 'number' ? j.best : 0;
              const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
              const lastWeek = history.filter(h => {
                const t = h.date?.toDate ? h.date.toDate().getTime() : new Date(h.date).getTime();
                return t >= sevenDaysAgo;
              });
              const last = history[0];
              return (
                <ProfileCard
                  eyebrow="Juggle counter"
                  action={(
                    <button
                      type="button"
                      onClick={() => { setJuggleDraft(''); setJuggleOpen(true); }}
                      className="text-xs font-bold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary"
                    >
                      + Log
                    </button>
                  )}
                >
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl bg-surface-input/60 ring-1 ring-line-default/15 px-3 py-4 sm:py-5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-amber-500">PR</div>
                      <div className="text-2xl font-black text-ink-primary tabular-nums leading-tight mt-1">{best}</div>
                    </div>
                    <div className="rounded-xl bg-surface-input/60 ring-1 ring-line-default/15 px-3 py-4 sm:py-5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">7-day attempts</div>
                      <div className="text-2xl font-black text-ink-primary tabular-nums leading-tight mt-1">{lastWeek.length}</div>
                    </div>
                    <div className="rounded-xl bg-surface-input/60 ring-1 ring-line-default/15 px-3 py-4 sm:py-5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">Last</div>
                      <div className="text-2xl font-black text-ink-primary tabular-nums leading-tight mt-1">{last?.count ?? '-'}</div>
                    </div>
                  </div>
                  {history.length === 0 && (
                    <p className="mt-2 text-xs text-ink-primary/50">No attempts yet. Tap "+ Log" to record one.</p>
                  )}
                </ProfileCard>
              );
            })()}

            {/* PRACTICE EFFORT — consecutive days the player has tapped
                "I did it" across any goal on any active plan. Sundays
                are skipped so a religious day of rest doesn't break
                the streak. Silent-empty when streak is 0. */}
            {(() => {
              const activePlansOnly = plans.filter(p => p.status === 'active');
              const streakDays = computeStreakDays(activePlansOnly);
              if (streakDays === 0) return null;
              const hot = streakDays >= 3;
              return (
                <ProfileCard eyebrow="Practice Effort" title={`${streakDays} ${streakDays === 1 ? 'day' : 'days'} in a row`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-4xl sm:text-5xl font-black tracking-tight leading-none text-ink-primary tabular-nums">
                      {streakDays}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <div className={`w-11 h-11 rounded-full flex items-center justify-center ${hot ? 'bg-emerald-500/15 text-emerald-500' : 'bg-brand-primary/15 text-brand-primary-soft'}`}>
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                          {hot
                            ? <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14a8 8 0 0 0 16 0c0-4.07-1.95-7.7-5-9.93l-.49-.62z" />
                            : <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />}
                        </svg>
                      </div>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/55">
                        {hot ? "on fire" : 'keep it going'}
                      </div>
                    </div>
                  </div>
                </ProfileCard>
              );
            })()}

            {/* PLAYER XP CARD — private XP + badges. Renders only when
                team.xpConfig.enabled is true (or paused w/ history).
                Coach opt-in per team. Scroll target for the Story-tab
                LevelProgressBar and BadgeCollection jumps (id +
                xpCardSectionRef). */}
            {/* 2026-07-15: scroll-mt bumped from -20 (80px) to -32
                (128px) so the jump from LevelProgressBar/
                BadgeCollection lands cleanly BELOW the sticky
                header (mini-hero ~56 + pill row ~54 = ~110px).
                Verifier caught the eyebrow being clipped. */}
            <div ref={xpCardSectionRef} id="stats-xpcard" className="scroll-mt-32">
              <PlayerXpCard
                player={player}
                team={selectedTeam}
                isCoach={
                  !!userData?.uid
                  && Array.isArray((selectedTeam as any)?.coachIds)
                  && (selectedTeam as any).coachIds.includes(userData.uid)
                }
                onGiveXp={() => setShowGrantXp(true)}
              />
            </div>

            {/* COACH RECOGNITIONS ARCHIVE — every "I saw you do this"
                moment a coach has written for this kid. Silent-empty
                when xp is off or the kid has zero recognitions. */}
            <CoachRecognitionsArchive
              playerId={playerId!}
              teamId={selectedTeamId}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />

            {/* 2026-07-15 Direction B: Dev Plans section relocated to
                the Story tab as DevelopmentPlanCard so a plan-in-
                motion reads as narrative, not a metric. The
                ?tab=development legacy redirect now lands on Story
                (see the pending-anchor mapping in useEffect above). */}
          </div>
        </div>
      )}

        {/* ─── MEDIA TAB ──────────────────────────────────────────
            2026-07-15 Direction B: This Season / Past Seasons pill
            row + per-membership buckets. The bare `media` grid was
            leaking cross-team clips into a team-scoped view (design
            contract's line 1428 fix). */}
      {activeTab === 'media' && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-6 flex flex-col gap-4 sm:gap-6">
          <MediaSeasonView
            media={media}
            selectedTeamId={selectedTeamId}
            activeSeason={activeSeason}
            availableSeasons={allSeasons}
            memberships={memberships}
            selectedTeam={selectedTeam}
            teamNameById={teamNameById}
            playerId={playerId!}
            playerName={player.name}
            onOpenLightbox={setLightboxItem}
          />
        </div>
      )}

      </div>
      </div>

      {/* ─── Equipment Edit Modal ────────────────────────────────── */}
      {juggleOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in" onClick={() => setJuggleOpen(false)}>
          <div className="bg-surface-elevated w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line-default/10">
              <h3 className="text-lg font-bold text-ink-primary">Log a juggle attempt</h3>
              <p className="text-xs text-ink-primary/50 mt-0.5">Best wins so far: <b className="text-ink-primary/85">{((player as any).juggles?.best) ?? 0}</b></p>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-ink-primary/65 mb-1">How many juggles?</label>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={juggleDraft}
                  onChange={(e) => setJuggleDraft(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-3 text-2xl font-black text-center border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                  placeholder="0"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-line-default/10 flex items-center justify-end gap-2">
              <button onClick={() => setJuggleOpen(false)} className="px-4 py-2 text-sm font-bold text-ink-primary/85 hover:bg-line-default/[0.08] rounded-lg">
                Cancel
              </button>
              <button
                onClick={async () => {
                  const n = parseInt(juggleDraft, 10);
                  if (!Number.isFinite(n) || n < 0) { alert('Enter a number.'); return; }
                  const existing = ((player as any).juggles) || {};
                  const history: any[] = Array.isArray(existing.history) ? existing.history : [];
                  const next = {
                    best: Math.max(n, existing.best || 0),
                    bestAt: n > (existing.best || 0) ? new Date() : (existing.bestAt || null),
                    history: [{
                      count: n,
                      date: new Date(),
                      loggedBy: userData?.uid || null,
                      loggedByName: userData?.name || null,
                    }, ...history].slice(0, 30),
                  };
                  const oldPr = existing.best || 0;
                  try {
                    await updateDocument('players', player.id, { juggles: next, updatedAt: new Date() });
                    (player as any).juggles = next;
                    setJuggleOpen(false);
                    // Auto-post to the wall when this beats the prior best.
                    if (n > oldPr && player.teamId && userData) {
                      try {
                        const { autoPostJugglePrToWall } = await import('../utils/autoPostToWall');
                        void autoPostJugglePrToWall(
                          { name: player.name, teamId: player.teamId },
                          n,
                          oldPr,
                          { uid: userData.uid, name: userData.name || 'Coach', role: isCoachOfTeam(userData, selectedTeam) ? 'coach' : 'parent' },
                        );
                      } catch (e) { console.warn('juggle wall post failed', e); }
                    }
                  } catch (err) {
                    console.error('save juggle failed', err);
                    alert('Save failed — try again.');
                  }
                }}
                className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary rounded-lg"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ─── Media Lightbox ─────────────────────────────────────── */}
      {lightboxItem && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxItem(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxItem(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl w-10 h-10 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 z-10"
            aria-label="Close"
          >
            ×
          </button>
          <div
            className="max-w-4xl w-full max-h-full flex flex-col items-center"
            onClick={e => e.stopPropagation()}
          >
            {lightboxItem.type === 'video' ? (
              lightboxItem.streamUid ? (
                <div className="w-full max-w-[min(100%,calc(80vh*16/9))] aspect-video rounded-lg overflow-hidden bg-black">
                  <iframe
                    key={lightboxItem.streamUid}
                    src={streamIframeUrl(lightboxItem.streamUid, { autoplay: true })}
                    title={lightboxItem.caption || lightboxItem.playerName}
                    loading="lazy"
                    allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
                    allowFullScreen
                    className="w-full h-full block border-0"
                  />
                </div>
              ) : (
                <video
                  src={lightboxItem.url}
                  controls
                  autoPlay
                  playsInline
                  className="max-w-full max-h-[80vh] rounded-lg"
                />
              )
            ) : (
              <img
                src={lightboxItem.url}
                alt={lightboxItem.caption || ''}
                className="max-w-full max-h-[80vh] rounded-lg object-contain"
              />
            )}
            {lightboxItem.caption && (
              <p className="text-white text-sm mt-3 text-center">{lightboxItem.caption}</p>
            )}
            {lightboxItem.tags && lightboxItem.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-center mt-2">
                {lightboxItem.tags.map(tag => (
                  <span key={tag} className="px-2 py-0.5 bg-line-default/20 text-white rounded text-xs">{tag}</span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-center gap-3 mt-4">
              <button
                type="button"
                onClick={async () => {
                  const shareUrl = `${getShareOrigin()}/media/${encodeURIComponent(lightboxItem.id.replace(/^gallery_/, ''))}`;
                  const data = { title: lightboxItem.caption || `${lightboxItem.playerName} - ${lightboxItem.type}`, url: shareUrl };
                  try {
                    if (navigator.share) await navigator.share(data);
                    else { await navigator.clipboard.writeText(shareUrl); alert('Link copied to clipboard!'); }
                  } catch (err) {
                    if ((err as any)?.name !== 'AbortError') {
                      try { await navigator.clipboard.writeText(shareUrl); alert('Link copied to clipboard!'); } catch {}
                    }
                  }
                }}
                className="flex items-center space-x-1.5 px-4 py-2 bg-line-default/10 hover:bg-line-default/20 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                <span>Share</span>
              </button>
              <button
                onClick={() => handleDownload(lightboxItem)}
                disabled={downloading}
                className="flex items-center space-x-1.5 px-4 py-2 bg-line-default/10 hover:bg-line-default/20 disabled:bg-line-default/10 disabled:cursor-wait text-white rounded-lg text-sm font-medium transition-colors"
              >
                {downloading ? (
                  <>
                    <div className="w-4 h-4 rounded-full border-2 border-line-default/30 border-t-white animate-spin" />
                    <span className="tabular-nums">{downloadPercent > 0 ? `${downloadPercent}%` : 'Saving…'}</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    <span>Download</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showWhisper && (
        <ParentWhisperModal
          isOpen={showWhisper}
          onClose={() => setShowWhisper(false)}
          player={player}
          recentMedia={recentMedia}
          activePlans={activePlans}
        />
      )}

      {showKudos && player && (
        <KudosComposerModal
          isOpen={showKudos}
          onClose={() => setShowKudos(false)}
          player={player}
          onSent={() => setKudosBumpKey(k => k + 1)}
        />
      )}

      {showGrantXp && selectedTeam && (selectedTeam as any)?.xpConfig?.enabled === true && player && (
        <CoachGrantXpModal
          open={showGrantXp}
          onClose={() => { setShowGrantXp(false); void loadProfile(); }}
          team={selectedTeam}
          /* Fallback single-player roster so the modal opens instantly
             on tap. The useEffect above replaces this with the full
             team roster within a few hundred ms — coach can add other
             kids once it lands. */
          roster={grantXpRoster.length > 0 ? grantXpRoster : [player]}
          defaultSelectedIds={[player.id]}
        />
      )}

      <AddPlayer
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        editingPlayer={player}
        existingPlayers={[]}
        onPlayerAdded={() => { setEditOpen(false); void loadProfile(); }}
      />
    </div>
  );
};

// 2026-07-15 Direction B: the local PlanDetail card (expandable
// per-goal practice log) was deleted when Dev Plans moved from the
// Stats tab into DevelopmentPlanCard on Story. Per-goal detail is
// now reachable via the "Open plan" button that opens /development.
// See git log for the prior implementation if a reader wants the
// expandable-log affordance back.

// ─── Media Season View ─────────────────────────────────────────────
// Media tab body — This Season / Past Seasons pill row + per-season
// buckets. Extracted from the Media tab render so the season logic
// stays testable and the JSX inside PlayerProfile stays flat.
interface MediaSeasonViewProps {
  media: PlayerMedia[];
  selectedTeamId: string;
  activeSeason: Season | null;
  availableSeasons: Season[];
  memberships: any[];
  selectedTeam: any;
  teamNameById: Record<string, string>;
  playerId: string;
  playerName: string;
  onOpenLightbox: (item: PlayerMedia) => void;
}

const MediaSeasonView: React.FC<MediaSeasonViewProps> = ({
  media,
  selectedTeamId,
  activeSeason,
  availableSeasons,
  memberships,
  selectedTeam,
  teamNameById,
  playerId,
  playerName,
  onOpenLightbox,
}) => {
  const [scope, setScope] = React.useState<'season' | 'past'>('season');

  const thisSeason = React.useMemo(
    () => filterMediaForSeason(media, selectedTeamId, activeSeason),
    [media, selectedTeamId, activeSeason],
  );

  // Past-Seasons buckets — one section per membership (newest first).
  // We resolve the season doc from availableSeasons; if it isn't
  // present (legacy row) we fall back to a "membership window" bucket
  // labeled with just the team name and the joinedAt year.
  const pastBuckets = React.useMemo(() => {
    if (!memberships || memberships.length === 0) return [] as Array<{ key: string; label: string; items: PlayerMedia[] }>;
    const currentSeasonKey = `${selectedTeamId}:${activeSeason?.id || ''}`;
    const buckets: Array<{ key: string; label: string; items: PlayerMedia[]; sortMs: number }> = [];
    for (const m of memberships) {
      const teamId = (m as any).teamId;
      const seasonId = (m as any).seasonId;
      const key = `${teamId}:${seasonId || ''}`;
      if (key === currentSeasonKey) continue; // skip current view
      const season = seasonId ? availableSeasons.find(s => s.id === seasonId) || null : null;
      const items = filterMediaForSeason(media, teamId, season);
      if (items.length === 0) continue;
      const teamName = teamId === selectedTeamId
        ? (selectedTeam?.name || 'Team')
        : (teamNameById[teamId] || (m as any).teamName || 'Team');
      const label = season ? `${teamName} · ${season.name}` : `${teamName}`;
      const joinedAtRaw: any = (m as any).joinedAt;
      const joinedMs = joinedAtRaw?.toDate ? joinedAtRaw.toDate().getTime() : (joinedAtRaw ? new Date(joinedAtRaw).getTime() : 0);
      const sortMs = season?.startDate ? new Date(season.startDate).getTime() : joinedMs;
      buckets.push({ key, label, items, sortMs });
    }
    buckets.sort((a, b) => b.sortMs - a.sortMs);
    return buckets.map(({ key, label, items }) => ({ key, label, items }));
  }, [media, memberships, availableSeasons, selectedTeamId, activeSeason?.id, selectedTeam, teamNameById]);

  const totalPast = pastBuckets.reduce((s, b) => s + b.items.length, 0);

  return (
    <>
      {/* Scope pills — wrap, never scroll ([[no-horizontal-pills]]). */}
      <div className="flex flex-wrap gap-1.5">
        {([
          { key: 'season' as const, label: 'This Season', count: thisSeason.length },
          { key: 'past' as const,   label: 'Past Seasons', count: totalPast },
        ]).map(p => {
          const isActive = scope === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setScope(p.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition ${
                isActive
                  ? 'bg-ink-primary text-surface-base shadow'
                  : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.1]'
              }`}
            >
              <span>{p.label}</span>
              {p.count > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                  isActive ? 'bg-surface-base/20 text-surface-base' : 'bg-surface-elevated text-ink-primary/50'
                }`}>
                  {p.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {scope === 'season' && (
        <>
          {/* Photo tape at the top — same team scope. Hidden empty. */}
          {thisSeason.length > 0 && (
            <PhotoTape playerId={playerId} playerName={playerName} teamId={selectedTeamId} season={activeSeason} />
          )}
          {thisSeason.length > 0 ? (
            <MediaGrid items={thisSeason} onOpen={onOpenLightbox} />
          ) : (
            <EmptyState
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>}
              title="No photos or clips yet this season"
              description="Coaches and Circle can add them from the Match Center."
              cta={{ label: 'Go to Gallery', to: '/player-media' }}
            />
          )}
        </>
      )}

      {scope === 'past' && (
        pastBuckets.length === 0 ? (
          <EmptyState
            icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>}
            title="Nothing archived from earlier seasons"
            description="Older photos will land here as seasons wrap."
          />
        ) : (
          <div className="flex flex-col gap-6">
            {pastBuckets.map(b => (
              <section key={b.key} className="flex flex-col gap-3">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-ink-primary/55">{b.label}</h3>
                <MediaGrid items={b.items} onOpen={onOpenLightbox} />
              </section>
            ))}
          </div>
        )
      )}
    </>
  );
};

// Reusable media grid — same visual as the original inline grid, no
// behavior drift.
const MediaGrid: React.FC<{ items: PlayerMedia[]; onOpen: (i: PlayerMedia) => void }> = ({ items, onOpen }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 sm:gap-3">
    {items.map(item => (
      <button
        key={item.id}
        type="button"
        onClick={() => onOpen(item)}
        className="group relative aspect-square bg-surface-elevated rounded-2xl overflow-hidden text-left shadow-sm ring-1 ring-line-default/10 hover:shadow-lg hover:-translate-y-0.5 transition"
      >
        {item.type === 'video' ? (
          <>
            {item.streamUid ? (
              <img src={streamThumbnailUrl(item.streamUid, { height: 360, time: item.posterTimeSeconds != null ? `${item.posterTimeSeconds}s` : undefined })} alt="" className="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />
            ) : item.thumbnailUrl ? (
              <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />
            ) : (
              <video src={`${item.url}#t=0.5`} className="w-full h-full object-cover" preload="metadata" muted playsInline />
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-11 h-11 bg-black/60 rounded-full flex items-center justify-center backdrop-blur shadow-lg">
                <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
          </>
        ) : (
          <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />
        )}
        {item.likeCount && item.likeCount > 0 ? (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-white text-[10px] font-bold backdrop-blur">{item.likeCount}</div>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent pt-8 pb-2.5 px-2.5">
          {item.caption && <p className="text-white text-xs font-semibold truncate">{item.caption}</p>}
          {item.tags && item.tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {item.tags.slice(0, 2).map(tag => (
                <span key={tag} className="px-1.5 py-0.5 bg-line-default/20 text-white rounded text-[9px] font-bold uppercase tracking-wider backdrop-blur">{tag}</span>
              ))}
            </div>
          )}
        </div>
      </button>
    ))}
  </div>
);

export default PlayerProfile;
