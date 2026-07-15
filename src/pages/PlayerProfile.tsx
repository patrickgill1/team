import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { useTeamAudience } from '../hooks/useTeamAudience';
import { Player, PlayerMedia, DevelopmentPlan, Season } from '../types';
import { isCoachOfTeam, formatDate, isGoalkeeper, getPlayerPositionsLabel } from '../utils/helpers';
import { where } from 'firebase/firestore';
import ParentWhisperModal from '../components/coach/ParentWhisperModal';
import KudosComposerModal from '../components/kudos/KudosComposerModal';
import { buildSidelineShouts, SHOUT_TYPE_LABEL, shoutAccentClass } from '../utils/sidelineShouts';
import InlineDevPlanCard from '../components/player/InlineDevPlanCard';
import ProfileHero from '../components/player/ProfileHero';
import ProfileStatsStrip from '../components/player/ProfileStatsStrip';
import FeaturedShoutCard from '../components/player/FeaturedShoutCard';
import PlayerXpCard from '../components/player/PlayerXpCard';
import CoachGrantXpModal from '../components/coach/CoachGrantXpModal';
import PlayerInfoCard from '../components/player/PlayerInfoCard';
import PlayerCircleCard from '../components/player/PlayerCircleCard';
import PhotoTape from '../components/player/PhotoTape';
import CoachRecognitionsArchive from '../components/player/CoachRecognitionsArchive';
import SeasonTimeline from '../components/player/SeasonTimeline';
import PersonalRecords from '../components/player/PersonalRecords';
import AddPlayer from '../components/player/AddPlayer';
import EmptyState from '../components/common/EmptyState';
import DataGate from '../components/common/DataGate';
import { computeStreakDays, coachVerifyLogEntry } from '../utils/devPlanActions';
import CoachSawThisPill from '../components/coach/CoachSawThisPill';
import { computePlayerAttendance } from '../utils/attendance';
import { getPlayerStats, getPlayerLifetimeStats, getAllSeasonsForTeam, getActiveSeasonForTeam } from '../utils/seasons';
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
  }>>([]);
  const [allPlayerVotings, setAllPlayerVotings] = useState<{ voting: MatchVoting; playerVotes: { voterName: string; reason?: string }[] }[]>([]);
  const [votingNominations, setVotingNominations] = useState<number>(0);
  const [attendance, setAttendance] = useState<{ percent: number | null; totalEvents: number; attendedEvents: number }>({ percent: null, totalEvents: 0, attendedEvents: 0 });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'media' | 'development' | 'awards' | 'whispers'>(
    () => {
      // Push deep-link: /player/:id?tab=whispers lands on the whispers
      // tab directly (the new parent-whisper push uses this).
      try {
        const t = new URLSearchParams(window.location.search).get('tab');
        if (t === 'whispers' || t === 'media' || t === 'development' || t === 'awards') return t as any;
      } catch { /* SSR-safe noop */ }
      return 'overview';
    }
  );
  // Filter for the Sideline Shouts tab. 'all' | 'kudos' | 'whisper' |
  // 'xp_note' | 'badge' | 'potm_comment'. Kept in state (not URL) so
  // deep-links still land on the full stream; filter is UI-only.
  const [shoutFilter, setShoutFilter] = useState<'all' | 'kudos' | 'whisper' | 'xp_note' | 'badge' | 'potm_comment'>('all');
  // Juggle log state — anyone who can see the profile (coach OR the
  // player's parents) can record an attempt.
  const [juggleOpen, setJuggleOpen] = useState(false);
  const [juggleDraft, setJuggleDraft] = useState<string>('');
  // Edit modal (hero pencil opens this)
  const [editOpen, setEditOpen] = useState(false);
  // Memberships for this player across every team/season they're on.
  // Drives the per-team / per-season stats display (no more bleed).
  const [memberships, setMemberships] = useState<any[]>([]);
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
      })) as DevelopmentPlan[]);
    } else {
      console.error('Error loading development plans:', plansResult.reason);
    }

    if (votingsResult.status === 'fulfilled') {
      const teamVotings = votingsResult.value
        .filter((v: any) => v.teamId === selectedTeamId)
        .map((v: any) => ({
          ...v,
          gameDate: v.gameDate?.toDate ? v.gameDate.toDate() : new Date(v.gameDate),
          closedAt: v.closedAt?.toDate ? v.closedAt.toDate() : undefined,
        })) as MatchVoting[];

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
          };
        });
        setXpEvents(eList);
      } catch { /* no events yet is fine */ }


      // Collect all votings where this player received votes (with reasons)
      const playerVotings = teamVotings
        .filter(v => v.votes?.some(vote => vote.playerId === playerId))
        .map(v => ({
          voting: v,
          playerVotes: v.votes.filter(vote => vote.playerId === playerId).map(vote => ({
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

  const calculateAge = (dob?: Date) => {
    if (!dob) return null;
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
  };

  const getProgressPercent = (plan: DevelopmentPlan) => {
    if (!plan.goals.length) return 0;
    return Math.round((plan.goals.filter(g => g.coachVerified).length / plan.goals.length) * 100);
  };

  // Development-plan category chips. All stay inside the brand palette
  // (fire/cyan/navy + emerald for "growth"). No more violet/orange.
  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'technical': return 'bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft';
      case 'tactical': return 'bg-surface-raised/10 text-charcoal-800 ring-1 ring-charcoal-700/10';
      case 'physical': return 'bg-brand-primary/15 text-charcoal-800 ring-1 ring-brand-primary-soft';
      case 'mental': return 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-100';
      default: return 'bg-line-default/[0.04] text-ink-primary/85 ring-1 ring-gray-100';
    }
  };

  // Position dot — kept colorful for at-a-glance scanning but stays
  // away from the most off-brand tones (amber, orange) where possible.
  const positionDot = (pos?: string): string => {
    switch (pos) {
      case 'Goalkeeper': return 'bg-brand-primary-soft';
      case 'Defender': return 'bg-surface-raised';
      case 'Midfielder': return 'bg-emerald-500';
      case 'Forward':
      case 'Striker': return 'bg-rose-500';
      case 'Winger': return 'bg-brand-primary';
      default: return 'bg-line-default/40';
    }
  };

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

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'technical': return '⚽';
      case 'tactical': return '🧠';
      case 'physical': return '💪';
      case 'mental': return '🎯';
      default: return '📋';
    }
  };

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

  const age = calculateAge(player.dateOfBirth);
  const activePlans = plans.filter(p => p.status === 'active');
  const completedPlans = plans.filter(p => p.status === 'completed');
  // Recent clips strip is team-scoped — when viewing a player from a
  // team's roster, only show media tied to that team. Prior-team clips
  // still live on the player's Media page under the All-time view.
  const recentMedia = media
    .filter(m => !selectedTeamId || (m as any).teamId === selectedTeamId)
    .slice(0, 6);
  const totalGoalsInPlans = plans.reduce((sum, p) => sum + p.goals.length, 0);
  const verifiedGoals = plans.reduce((sum, p) => sum + p.goals.filter(g => g.coachVerified).length, 0);
  const playerCompletedGoals = plans.reduce((sum, p) => sum + p.goals.filter(g => g.playerCompleted).length, 0);
  const formatMinutes = (mins: number) => {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h} hr` : `${h}h ${m}m`;
  };

  // Latest vote-quote callout — kids LOVE seeing what people said about them
  const latestQuote = (() => {
    for (const { voting, playerVotes } of allPlayerVotings) {
      const withReason = playerVotes.find(v => v.reason && v.reason.trim().length > 0);
      if (withReason) {
        return { reason: withReason.reason!, voterName: withReason.voterName, gameTitle: voting.gameTitle, gameDate: voting.gameDate };
      }
    }
    return null;
  })();

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
      />

      {/* Featured POTM quote — moved 2026-07-14 to sit directly
          below the hero. Patrick: "the sideline is completely
          hidden." Second elevation pass. Prior placement (below
          stats + XP card) meant a parent had to scroll to see any
          Sideline Shouts signal; now the rotating POTM quote is
          the FIRST thing under the identity block, so the concept
          announces itself before stats. "All N" jumps into the
          full Sideline Shouts tab with POTM filter pre-applied. */}
      <FeaturedShoutCard
        playerName={player.name}
        votings={allPlayerVotings}
        onOpenAll={() => {
          setShoutFilter('potm_comment');
          setActiveTab('whispers');
        }}
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

      {/* Private XP + badges — renders only when team.xpConfig.enabled
          is true. Coach opt-in per team. See goalkickr-xp memo.
          Coach check is TEAM-SCOPED via team.coachIds (not the global
          user.role) per the coach-role-model memory: a coach on Team
          A viewing Team B where they're a parent shouldn't see the
          Recognize pill. */}
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

      {/* FeaturedShoutCard moved above (right under ProfileHero) —
          see the block up there. Sideline Shouts prominence pass
          2026-07-14. */}

      {/* PlayerXpHistoryFeed removed 2026-07-14 (Patrick:
          "get rid of the xp section showing the comments and have
          it live in the tab. it took me a while to find that
          section and I was looking for it"). XP grant history with
          notes now lives inside the Sideline Shouts tab under the
          "From coach" filter, alongside Kudos, Whispers, POTM
          comments, and Badges. Single home, discoverable via the
          new pill order + filter chips. */}

      {/* Recruitment funnel moved to PersonAdmin (admin CRM only).
          Patrick 2026-06-25: 'I don't know if the recruitment timeline
          needs to show in the player profile, just needs to show in
          their crm profile for club admins.' Kids + parents + coaches
          shouldn't see registration/offer/dues plumbing on the player
          card — that's an admin pipeline view. */}

      {/* Existing top-of-hero action row preserved for parity */}
      <div className="bg-surface-base px-4 sm:px-6 py-3 border-b border-line-default/10">
        <div className="max-w-6xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button
          type="button"
          onClick={() => { window.history.length > 1 ? window.history.back() : (window.location.href = '/dashboard'); }}
          className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-surface-elevated ring-1 ring-line-default/15 text-ink-primary text-xs font-bold hover:bg-surface-input transition"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
          Back
        </button>
          {userData && isCoachOfTeam(userData, selectedTeam) && !isAdultTeam && (
            <button
              onClick={() => setShowWhisper(true)}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-surface-elevated hover:bg-surface-input text-ink-primary text-xs font-bold ring-1 ring-line-default/15 transition"
              title="Send a private note to this player's parents"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              Whisper
            </button>
          )}
          {/* Kudos — see canGiveKudos gate at the top of render. */}
          {canGiveKudos && (
            <button
              onClick={() => setShowKudos(true)}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-surface-elevated hover:bg-surface-input text-ink-primary text-xs font-bold ring-1 ring-line-default/15 transition"
              title="Send a Kudos — a short note about something you noticed"
            >
              <svg className="w-3.5 h-3.5 text-brand-primary" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>
              Kudos
            </button>
          )}
          <button
            onClick={handleShareProfile}
            className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold ring-1 transition backdrop-blur ${
              (player as any)?.publicShare?.enabled
                ? 'bg-emerald-500/20 ring-emerald-400/40 text-emerald-200 hover:bg-emerald-500/30'
                : 'bg-surface-elevated ring-line-default/15 text-ink-primary hover:bg-surface-input'
            }`}
            title={(player as any)?.publicShare?.enabled ? 'Public card is live — tap to share the link again' : 'Share profile'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
            {(player as any)?.publicShare?.enabled ? 'Share on' : 'Share'}
          </button>
          {(player as any)?.publicShare?.enabled && (
            <button
              onClick={disablePublicShare}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-surface-elevated ring-1 ring-line-default/15 text-ink-primary/80 text-xs font-bold hover:bg-surface-input hover:text-ink-primary transition"
              title="Turn public sharing off — existing links stop working"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" />
              </svg>
              Stop share
            </button>
          )}
        </div>
      </div>

        {/* Season toggle + detailed 4-up career stats. */}
      <div className="relative overflow-visible bg-surface-base text-ink-primary border-b border-line-default/10">
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
          {/* Hidden legacy block kept for the season toggle + detailed stats; the new ProfileHero replaces the old photo + name top. */}
          {false && (
            <div className="flex items-center justify-between mb-5">
              <span />
            </div>
          )}

          {/* (legacy hero blocks removed — ProfileHero + ProfileStatsStrip + action row above replace them.) */}

          {/* Season toggle — keep it simple. Two primary options: "This
              Season" and "Overall". Past seasons hide inside the dropdown
              for the curious; most coaches/parents just want now-vs-ever. */}
          {(allSeasons.length > 1 || activeSeason) && (
            // relative z-30 lifts the season picker (and its ...
            // dropdown) above the 4-up stat tiles below, which
            // otherwise create their own stacking contexts via
            // backdrop-blur and swallow the dropdown even though it
            // sets z-50 internally.
            <div className="relative z-30 mb-3 inline-flex items-center rounded-full bg-line-default/10 ring-1 ring-line-default/20 backdrop-blur p-0.5">
              <button
                onClick={() => setSelectedSeasonId('current')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  (selectedSeasonId === 'current' || (activeSeason && selectedSeasonId === activeSeason.id))
                    ? 'bg-surface-elevated text-ink-primary/90 shadow'
                    : 'text-ink-primary/65 hover:text-ink-primary'
                }`}
              >
                This Season
              </button>
              <button
                onClick={() => setSelectedSeasonId('lifetime')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  selectedSeasonId === 'lifetime'
                    ? 'bg-surface-elevated text-ink-primary/90 shadow'
                    : 'text-ink-primary/65 hover:text-ink-primary'
                }`}
              >
                Overall
              </button>
              {/* Past-season picker tucked behind a small "..." menu so it
                  doesn't clutter the primary toggle. */}
              {allSeasons.filter(s => !s.isActive).length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setSeasonMenuOpen(v => !v)}
                    className={`px-2.5 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                      selectedSeasonId !== 'current' && selectedSeasonId !== 'lifetime' && (!activeSeason || selectedSeasonId !== activeSeason.id)
                        ? 'bg-surface-elevated text-ink-primary/90 shadow'
                        : 'text-ink-primary/65 hover:text-ink-primary'
                    }`}
                    aria-label="Pick another season"
                  >
                    •••
                  </button>
                  {seasonMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 z-50 min-w-[180px] rounded-xl bg-surface-elevated ring-1 ring-line-default/15 shadow-xl py-1">
                      {allSeasons.filter(s => !s.isActive).map(s => (
                        <button
                          key={s.id}
                          onClick={() => { setSelectedSeasonId(s.id); setSeasonMenuOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-line-default/[0.05] ${selectedSeasonId === s.id ? 'text-brand-primary-soft font-semibold' : 'text-ink-primary/85'}`}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 4-up stats — filtered by season chip */}
          {(() => {
            const lifetime = getPlayerLifetimeStats(player as any);
            const seasonForStats =
              selectedSeasonId === 'lifetime' ? null :
              selectedSeasonId === 'current' ? activeSeason?.id : selectedSeasonId;
            const s = seasonForStats === 'lifetime' || selectedSeasonId === 'lifetime'
              ? lifetime
              : getPlayerStats(player as any, seasonForStats);
            const showCareerStrip = selectedSeasonId !== 'lifetime' && (lifetime.goals > 0 || lifetime.assists > 0 || lifetime.gamesPlayed > 0);

            // POTM wins scoped by the same season chip so "This Season"
            // shows current-season crowns and "Overall" shows career.
            // Two-signal match: primary is v.seasonId equality; legacy
            // votings without a seasonId fall back to a closedAt window
            // check against the resolved season's [startDate, endDate].
            let potmCount = votingWins.length;
            if (selectedSeasonId !== 'lifetime' && seasonForStats) {
              const seasonObj = allSeasons.find(x => x.id === seasonForStats);
              const startMs = seasonObj?.startDate ? new Date(seasonObj.startDate).getTime() : 0;
              const endMs = seasonObj?.endDate ? new Date(seasonObj.endDate).getTime() : Infinity;
              potmCount = votingWins.filter(v => {
                if ((v as any).seasonId === seasonForStats) return true;
                if (!(v as any).seasonId && seasonObj) {
                  const closedMs = v.closedAt ? new Date(v.closedAt as any).getTime() : 0;
                  return closedMs >= startMs && closedMs <= endMs;
                }
                return false;
              }).length;
            }

            return (
              <>
                <div className="grid grid-cols-4 gap-2 sm:gap-3">
                  <div className="rounded-2xl bg-line-default/10 ring-1 ring-line-default/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-emerald-300">{s.goals || 0}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-ink-primary/60 font-bold">Goals</div>
                  </div>
                  <div className="rounded-2xl bg-line-default/10 ring-1 ring-line-default/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft">{s.assists || 0}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-ink-primary/60 font-bold">Assists</div>
                  </div>
                  <div className="rounded-2xl bg-line-default/10 ring-1 ring-line-default/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft">{potmCount}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-ink-primary/60 font-bold">POTM</div>
                  </div>
                  <div className="rounded-2xl bg-line-default/10 ring-1 ring-line-default/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-ink-primary">{media.length}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-ink-primary/60 font-bold">Clips</div>
                  </div>
                </div>
                {showCareerStrip && (
                  <p className="mt-3 text-[11px] text-ink-primary/60 font-medium tracking-wide">
                    Career: {lifetime.goals} goals · {lifetime.assists} assists
                    {lifetime.gamesPlayed > 0 ? ` · ${lifetime.gamesPlayed} games` : ''}
                    {allSeasons.length > 0 ? ` across ${allSeasons.length} season${allSeasons.length === 1 ? '' : 's'}` : ''}
                  </p>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {/* ───── PILL TABS (sticky) ───── */}
      <div className="bg-surface-base sticky top-0 z-20 border-b border-line-default/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3">
          {/* Wrap, never scroll. Sideways pill scrolling hides options
              behind the right edge and reads as "we ran out of room." */}
          <div className="flex flex-wrap gap-1.5">
            {/* 2026-07-14: pill order updated — Sideline Shouts moved
                right after Overview so it's the first thing scanned.
                Patrick: "it took me a while to find that section and
                I was looking for it." */}
            {(['overview', 'whispers', 'media', 'development', 'awards'] as const)
              // Youth-only tabs stay youth-only on adult teams.
              // 'development' is coach-side growth planning tied to a
              // youth pathway; 'whispers' is coach → parent messaging.
              // Neither maps onto adult teams.
              .filter(tab => isAdultTeam ? tab !== 'development' && tab !== 'whispers' : true)
              .map(tab => {
              const count =
                tab === 'media' ? media.length :
                tab === 'development' ? activePlans.length :
                tab === 'awards' ? votingWins.length :
                // 2026-07-14: tab id stays 'whispers' for deep-link
                // back-compat; label + count reflect the new Sideline
                // Shouts unified stream (kudos + whispers + xp notes +
                // badges + POTM comments).
                tab === 'whispers' ? (kudosList.length + whispers.length + xpEvents.filter(e => e.note).length) : null;
              const label =
                tab === 'overview' ? 'Overview' :
                tab === 'media' ? 'Media' :
                tab === 'development' ? 'Development' :
                tab === 'awards' ? 'Awards' : 'Sideline Shouts';
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
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

        {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="bg-surface-base">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
          <div className="space-y-4 sm:space-y-6">

            {/* PLAYER CIRCLE — parents/guardians linked to this player.
                Shown near the top of Overview so the invite-a-guardian
                path is discoverable at the exact spot a parent lands
                when they open their kid's page. Hidden on adult teams
                since players there ARE the account. */}
            {userData && !isAdultTeam && (
              <PlayerCircleCard
                player={player}
                viewerUid={userData.uid}
                viewerEmail={userData.email || ''}
                viewerRole={userData.role || ''}
              />
            )}

            {/* SEASON TIMELINE — narrative opener. Chronological ribbon
                of every timestamped milestone this player earned in the
                active season (badges + player_xp_events). Silent empty
                on legacy teams with xpConfig disabled — respects the
                no-retroactive-credit rule. */}
            <SeasonTimeline
              playerId={playerId!}
              player={player}
              teamId={selectedTeamId}
              season={activeSeason}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />

            {/* WHAT PEOPLE ARE SAYING — kids love this. Always render a
                card so the section never feels missing; show a friendly
                placeholder when there are no POTM quotes yet.
                2026-07-15: jumps to the Shouts tab with POTM filter
                (was jumping to Awards tab) so the click flows into
                the full shout stream, not a separate surface. */}
            <button
              type="button"
              onClick={() => { setShoutFilter('potm_comment'); setActiveTab('whispers'); }}
              className="w-full text-left relative overflow-hidden rounded-2xl bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 p-5 hover:bg-line-default/[0.06] transition"
            >
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <span className="text-[10px] uppercase tracking-widest font-black text-brand-primary-soft">What people said</span>
              </div>
              {latestQuote ? (
                <>
                  <p className="text-base sm:text-lg font-bold italic leading-snug text-ink-primary">"{latestQuote.reason}"</p>
                  <p className="text-xs text-ink-primary/60 mt-2 font-semibold">— {latestQuote.voterName} · {latestQuote.gameTitle}</p>
                </>
              ) : (
                <p className="text-sm text-ink-primary/70 leading-snug">
                  No shoutouts yet on this team — they'll show up here after the first match where {player.name.split(' ')[0]} gets a Player of the Match nod with a reason.
                </p>
              )}
            </button>

            {/* SIDELINE SHOUTS PREVIEW — 3 most recent shouts of any type
                (Kudos, coach whispers, XP notes, badges, POTM comments)
                so parents see the stream without a second tap.
                Patrick 2026-07-15: "still waiting on the sideline
                shouts to also have its own section in the profile."
                Renders alongside the tab (belt and suspenders) — tab
                still holds the full feed with filter chips. Hidden
                when there are no shouts yet. */}
            {(() => {
              const preview = buildSidelineShouts({
                player,
                kudosList,
                whispers,
                xpEvents,
                potmVotes: allPlayerVotings,
              });
              if (preview.length === 0) return null;
              const top = preview.slice(0, 3);
              const first = player.name?.split(' ')[0] || 'this player';
              return (
                <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 overflow-hidden">
                  <header className="flex items-center justify-between px-5 pt-4 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-primary/15 text-brand-primary-soft">
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
                        </svg>
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft">Sideline Shouts</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setShoutFilter('all'); setActiveTab('whispers'); }}
                      className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition px-2 py-1 rounded-md hover:bg-line-default/[0.06]"
                    >
                      See all {preview.length} →
                    </button>
                  </header>
                  <ul className="divide-y divide-line-default/8">
                    {top.map(s => (
                      <li key={s.id} className={`px-5 py-3.5 flex items-start gap-3 border-l-4 ${shoutAccentClass(s.type)}`}>
                        <div className="flex-shrink-0">
                          {s.type === 'badge' && s.badgeImage ? (
                            <img src={s.badgeImage} className="w-8 h-8 object-contain" alt="" />
                          ) : s.fromAvatarUrl ? (
                            <img src={s.fromAvatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center font-black text-xs">
                              {(s.fromName || '?').charAt(0)}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-bold text-ink-primary">{s.fromName}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/40">
                              {SHOUT_TYPE_LABEL[s.type]}
                            </span>
                          </div>
                          <p className="text-[13.5px] text-ink-primary/85 leading-snug mt-0.5 line-clamp-2">
                            {s.body}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <footer className="px-5 py-2.5 border-t border-line-default/10 text-[11px] text-ink-primary/50">
                    Everything kind {first}&rsquo;s people have said and done.
                  </footer>
                </section>
              );
            })()}

            {/* SEASON STATS — three-scope toggle (team-season, team-career,
                all-time across every team this player's been on). Reads
                from player_memberships (the migration's per-team-season
                stat rows) so a player on two teams shows clean splits. */}
            {(() => {
              const empty = { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0, saves: 0, cleanSheets: 0 };
              const sumStats = (rows: any[]) => rows.reduce((acc, m) => {
                const s = m.stats || {};
                acc.gamesPlayed += s.gamesPlayed || 0;
                acc.goals += s.goals || 0;
                acc.assists += s.assists || 0;
                acc.saves += s.saves || 0;
                acc.yellowCards += s.yellowCards || 0;
                acc.redCards += s.redCards || 0;
                acc.minutesPlayed += s.minutesPlayed || 0;
                acc.cleanSheets += s.cleanSheets || 0;
                return acc;
              }, { ...empty });

              const teamMems = memberships.filter((m: any) => m.teamId === selectedTeamId);
              const activeSeasonMem = teamMems.find((m: any) => m.isActive !== false);
              let scoped: any;
              if (statsScope === 'all_time') {
                scoped = memberships.length ? sumStats(memberships) : (player.stats || empty);
              } else if (statsScope === 'team_career') {
                scoped = teamMems.length ? sumStats(teamMems) : (player.stats || empty);
              } else {
                // team_season — prefer the most recent active membership on
                // this team, fall back to teamMems sum, fall back to the
                // legacy stats already on the player doc (team-scoped via
                // getTeamPlayerStatsMap at load time).
                scoped = (activeSeasonMem?.stats) || (teamMems.length ? sumStats(teamMems) : (player.stats || empty));
              }

              const scopeLabel =
                statsScope === 'all_time' ? 'ALL-TIME'
                : statsScope === 'team_career' ? 'THIS TEAM · CAREER'
                : 'THIS TEAM · SEASON';

              return (
                <div className="bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-extrabold uppercase tracking-widest text-brand-primary-soft">Stats</h2>
                    <span className="text-[10px] uppercase tracking-widest text-ink-primary/50 font-bold">{scopeLabel}</span>
                  </div>
                  {/* Scope toggle */}
                  <div className="flex gap-1 mb-3 rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-1">
                    {([
                      { k: 'team_season', label: 'Season' },
                      { k: 'team_career', label: 'Career here' },
                      { k: 'all_time', label: 'All-time' },
                    ] as const).map(({ k, label }) => (
                      <button
                        key={k}
                        onClick={() => setStatsScope(k)}
                        className={`flex-1 px-2 py-1 rounded-lg text-[10px] font-extrabold tracking-widest uppercase transition ${
                          statsScope === k
                            ? 'bg-brand-primary/20 text-ink-primary ring-1 ring-brand-primary-soft/40'
                            : 'text-ink-primary/60 hover:text-ink-primary'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft">{scoped.gamesPlayed || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Games</div>
                    </div>
                    <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-emerald-300">{scoped.goals || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Goals</div>
                    </div>
                    <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-brand-primary-soft">{scoped.assists || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Assists</div>
                    </div>
                    {isGoalkeeper(player) ? (
                      <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-2.5 text-center">
                        <div className="text-2xl sm:text-3xl font-black text-amber-300">{scoped.saves || 0}</div>
                        <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">Saves</div>
                      </div>
                    ) : (
                      <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 p-2.5 text-center">
                        <div className="text-2xl sm:text-3xl font-black text-amber-300">{(scoped.goals || 0) + (scoped.assists || 0)}</div>
                        <div className="text-[9px] uppercase tracking-widest text-ink-primary/60 font-bold mt-0.5">G+A</div>
                      </div>
                    )}
                  </div>
                  {statsScope === 'all_time' && memberships.length > 1 && (
                    <p className="mt-2 text-[10px] text-ink-primary/50 tracking-wide">Combined across {memberships.length} team-season{memberships.length === 1 ? '' : 's'}.</p>
                  )}
                </div>
              );
            })()}

            {/* PERSONAL RECORDS — number receipts. Mirrors the Season
                Stats scope prop above so the two cards read as a single
                unit. Client-side one-pass over already-fetched stat
                rows + votingWins + votingNominations; no extra queries.
                Silent-empty when the player has no computable
                records. */}
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

            {/* PRACTICE EFFORT — consecutive days the player has tapped
                "I did it" across any goal on any active plan. Sundays
                are skipped so a religious day of rest doesn't break the
                streak. */}
            {(() => {
              const activePlans = plans.filter(p => p.status === 'active');
              const streakDays = computeStreakDays(activePlans);
              if (streakDays === 0) return null;
              const hot = streakDays >= 3;
              return (
                <div className="bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className={`text-[10px] uppercase tracking-widest font-black mb-1 ${hot ? 'text-emerald-300' : 'text-brand-primary-soft'}`}>Practice Effort</div>
                      <div className="text-4xl sm:text-5xl font-black tracking-tight leading-none text-ink-primary">{streakDays}</div>
                      <div className="text-xs sm:text-sm font-semibold text-ink-primary/60 mt-1.5">{streakDays === 1 ? 'day' : 'days'} in a row · {hot ? "you're on fire" : 'keep it going'}</div>
                    </div>
                    <div className={`shrink-0 w-14 h-14 rounded-full flex items-center justify-center ${
                      hot
                        ? 'bg-emerald-500/15 ring-1 ring-emerald-400/30 text-emerald-300'
                        : 'bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft'
                    }`}>
                      <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                        {hot
                          ? <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14a8 8 0 0 0 16 0c0-4.07-1.95-7.7-5-9.93l-.49-.62z" />
                          : <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />}
                      </svg>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* DEVELOPMENT PLAN — inline card with the SAME "I did it
                today" action as the full /development page, so parents
                stop having two ways to mark practice. Open plan button
                routes to the full editor. */}
            {plans.length > 0 && (
              <InlineDevPlanCard
                plans={plans}
                playerId={player.id}
                actor={userData ? { uid: userData.uid, name: userData.name || 'Family' } : null}
                currentStreakDays={(player as any).currentStreakDays || 0}
                onUpdated={() => { void loadProfile(); }}
              />
            )}

            {/* COACH RECOGNITIONS ARCHIVE — every "I saw you do this"
                moment a coach has ever written for this kid. Sits with
                the human-moments cluster (dev plan above + player info
                below), not the stats cluster. Silent-empty when xp is
                off or the kid has zero recognitions. */}
            <CoachRecognitionsArchive
              playerId={playerId!}
              teamId={selectedTeamId}
              xpEnabled={(selectedTeam as any)?.xpConfig?.enabled === true}
            />

            {/* legacy stats summary kept for reference but disabled now;
                inline card above replaces it. */}
            {false && plans.length > 0 && (
              <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-gray-100 p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-black text-ink-primary">Player Pathway</h2>
                  <button onClick={() => setActiveTab('development')} className="text-sm text-brand-primary hover:text-brand-primary-soft font-bold">View All →</button>
                </div>

                <div className="grid grid-cols-4 gap-2 mb-4">
                  <div className="rounded-xl bg-brand-primary/15 ring-1 ring-brand-primary-soft p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-brand-primary-soft">{activePlans.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-brand-primary-soft/70 font-bold">Active</div>
                  </div>
                  <div className="rounded-xl bg-emerald-500/15 ring-1 ring-emerald-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-emerald-300">{completedPlans.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-300/70 font-bold">Done</div>
                  </div>
                  <div className="rounded-xl bg-amber-500/15 ring-1 ring-amber-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-amber-300">{playerCompletedGoals}<span className="text-sm text-amber-300/60">/{totalGoalsInPlans}</span></div>
                    <div className="text-[10px] uppercase tracking-wider text-amber-300/70 font-bold">Goals</div>
                  </div>
                  <div className="rounded-xl bg-violet-500/15 ring-1 ring-violet-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-violet-300">{totalGoalsInPlans > 0 ? Math.round((verifiedGoals / totalGoalsInPlans) * 100) : 0}%</div>
                    <div className="text-[10px] uppercase tracking-wider text-violet-300/70 font-bold">Verified</div>
                  </div>
                </div>

                {activePlans.slice(0, 2).map(plan => {
                  const verified = getProgressPercent(plan);
                  const playerPct = plan.goals.length
                    ? Math.round((plan.goals.filter(g => g.playerCompleted).length / plan.goals.length) * 100)
                    : 0;
                  const planMins = plan.goals.reduce((s, g) => s + (g.practiceLog || []).reduce((m, l) => m + (l.minutes || 0), 0), 0);
                  const planTarget = plan.goals.reduce((s, g) => s + (g.targetMinutes || 0), 0);
                  return (
                    <div key={plan.id} className="rounded-xl ring-1 ring-gray-100 p-3 mb-2 bg-gradient-to-br from-gray-50/50 to-white">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span>{getCategoryIcon(plan.category)}</span>
                          <span className="font-bold text-sm text-ink-primary truncate">{plan.title}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getCategoryColor(plan.category)}`}>{plan.category}</span>
                        </div>
                        {planMins > 0 && (
                          <span className="text-xs font-bold text-orange-600 whitespace-nowrap">🔥 {formatMinutes(planMins)}{planTarget > 0 ? ` / ${formatMinutes(planTarget)}` : ''}</span>
                        )}
                      </div>
                      <div className="mt-2.5 space-y-1.5">
                        <div>
                          <div className="flex justify-between text-[10px] text-ink-primary/50 font-semibold uppercase tracking-wider"><span>You</span><span>{playerPct}%</span></div>
                          <div className="w-full bg-line-default/[0.08] rounded-full h-1.5"><div className="bg-amber-400 h-1.5 rounded-full transition-all" style={{ width: `${playerPct}%` }} /></div>
                        </div>
                        <div>
                          <div className="flex justify-between text-[10px] text-ink-primary/50 font-semibold uppercase tracking-wider"><span>Coach Verified</span><span>{verified}%</span></div>
                          <div className="w-full bg-line-default/[0.08] rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all ${verified === 100 ? 'bg-emerald-500' : 'bg-brand-primary'}`} style={{ width: `${verified}%` }} /></div>
                        </div>
                        {planTarget > 0 && (
                          <div>
                            <div className="flex justify-between text-[10px] text-ink-primary/50 font-semibold uppercase tracking-wider"><span>🔥 Minutes</span><span>{Math.min(100, Math.round((planMins / planTarget) * 100))}%</span></div>
                            <div className="w-full bg-line-default/[0.08] rounded-full h-1.5"><div className="bg-orange-500 h-1.5 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round((planMins / planTarget) * 100))}%` }} /></div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* PLAYER INFO — small editable bio card. Optional fields
                stay clean with em-dashes when empty. */}
            <PlayerInfoCard
              player={player}
              canEdit={!!userData && (isCoachOfTeam(userData, selectedTeam) || (player.parentIds || []).includes(userData.uid))}
              onUpdated={loadProfile}
            />

            {/* PHOTO TAPE — horizontal-scroll ribbon of every photo
                this player is tagged in (gallery + player_media).
                Replaced the prior 3-tile Spotlight grid with a proper
                highlight-reel ribbon so parents can scroll through the
                full set instead of tapping through to the Media tab.
                Videos and recent clips still live on the Media tab and
                on the "New for you" strip on Team HQ. Silent-empty
                when the kid has no tagged photos. */}
            <PhotoTape
              playerId={playerId!}
              teamId={selectedTeamId}
              playerName={player.name}
            />

            {/* AWARDS PEEK */}
            {(votingWins.length > 0 || votingNominations > 0) && (
              <div className="bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-extrabold uppercase tracking-widest text-brand-primary-soft">Trophy Case</h2>
                  <button onClick={() => setActiveTab('awards')} className="text-xs font-bold text-brand-primary-soft hover:text-ink-primary">View All →</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl bg-amber-500/10 ring-1 ring-amber-400/30 p-5">
                    <div className="flex items-center gap-2 mb-2 text-amber-300">
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>
                    </div>
                    <div className="text-3xl sm:text-4xl font-black leading-none text-amber-200">{votingWins.length}</div>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-ink-primary/70 mt-1">Wins</div>
                  </div>
                  <div className="rounded-2xl bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 p-5">
                    <div className="flex items-center gap-2 mb-2 text-brand-primary-soft">
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                    </div>
                    <div className="text-3xl sm:text-4xl font-black leading-none text-ink-primary">{votingNominations}</div>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-ink-primary/70 mt-1">Nominated</div>
                  </div>
                </div>
              </div>
            )}

            {/* JUGGLE COUNTER — parent-entered. Visible to coach + the
                kid's parents. PR is the headline; recent attempts feed
                a 7-day streak. No camera/CV — purely self-reported,
                per Patrick. */}
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
                <div className="bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-extrabold uppercase tracking-widest text-ink-primary/55">Juggle counter</h2>
                    <button
                      onClick={() => { setJuggleDraft(''); setJuggleOpen(true); }}
                      className="text-xs font-bold uppercase tracking-widest text-ink-primary/65 hover:text-ink-primary"
                    >
                      + Log
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl bg-amber-500/10 ring-1 ring-amber-400/30 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300">PR</div>
                      <div className="text-2xl font-black text-amber-200 tabular-nums leading-tight">{best}</div>
                    </div>
                    <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">7-day attempts</div>
                      <div className="text-2xl font-black text-ink-primary tabular-nums leading-tight">{lastWeek.length}</div>
                    </div>
                    <div className="rounded-xl bg-line-default/[0.03] ring-1 ring-line-default/10 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">Last</div>
                      <div className="text-2xl font-black text-ink-primary tabular-nums leading-tight">{last?.count ?? '—'}</div>
                    </div>
                  </div>
                  {history.length === 0 && (
                    <p className="text-xs text-ink-primary/50 mt-3">No attempts yet. Tap "+ Log" to record one.</p>
                  )}
                </div>
              );
            })()}

            {/* EMPTY STATE */}
            {plans.length === 0 && recentMedia.length === 0 && votingWins.length === 0 && (
              <div className="bg-line-default/[0.04] backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-8 text-center">
                <div className="mx-auto w-14 h-14 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 flex items-center justify-center text-brand-primary-soft mb-3">
                  <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path fill="white" d="M12 6l2.5 2-.75 3h-3.5l-.75-3z" /></svg>
                </div>
                <h3 className="text-lg font-bold text-ink-primary mb-1">{player.name.split(' ')[0]}'s journey starts here</h3>
                <p className="text-sm text-ink-primary/60">Stats, clips, and awards will show up as the season unfolds.</p>
              </div>
            )}
          </div>
          </div>
        </div>
      )}

        </div>
      </div>

      {activeTab !== 'overview' && (
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-10 py-5 sm:py-6">

        {/* ─── MEDIA TAB ─────────────────────────────────────────── */}
        {activeTab === 'media' && (
          <div>
            {media.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 sm:gap-3">
                {media.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLightboxItem(item)}
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
                      <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-white text-[10px] font-bold backdrop-blur">❤ {item.likeCount}</div>
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
            ) : (
              <EmptyState
                icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>}
                title="No highlights yet"
                description="Photos and videos will live here."
                cta={{ label: 'Go to Gallery', to: '/player-media' }}
              />
            )}
          </div>
        )}

        {/* ─── DEVELOPMENT TAB ───────────────────────────────────── */}
        {activeTab === 'development' && (
          <div>
            {plans.length > 0 ? (
              <div className="space-y-4">
                {activePlans.length > 0 && (
                  <>
                    <h2 className="text-lg font-black text-ink-primary px-1">In Motion</h2>
                    {activePlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
                {completedPlans.length > 0 && (
                  <>
                    <h2 className="text-lg font-black text-ink-primary px-1 mt-6">Done & Dusted</h2>
                    {completedPlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>}
                title="No development plans"
                description="Plans from coaches will show up here."
                cta={{ label: 'Open Development', to: '/development' }}
              />
            )}
          </div>
        )}

        {/* ─── AWARDS TAB ────────────────────────────────────────── */}
        {activeTab === 'awards' && (
          <div className="space-y-4 sm:space-y-6">
            {/* Big trophy hero */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white p-5 sm:p-6 text-center shadow-xl">
                <div className="absolute -top-6 -right-6 w-32 h-32 bg-line-default/20 rounded-full blur-2xl pointer-events-none" />
                <div className="relative flex flex-col items-center">
                  <svg className="w-12 h-12 sm:w-14 sm:h-14 mb-2 drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>
                  <div className="text-4xl sm:text-5xl font-black leading-none">{votingWins.length}</div>
                  <div className="text-[10px] sm:text-xs uppercase tracking-widest font-bold opacity-90 mt-1.5">POTM Wins</div>
                </div>
              </div>
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-primary to-sky-600 text-white p-5 sm:p-6 text-center shadow-xl">
                <div className="absolute -top-6 -right-6 w-32 h-32 bg-line-default/20 rounded-full blur-2xl pointer-events-none" />
                <div className="relative flex flex-col items-center">
                  <svg className="w-12 h-12 sm:w-14 sm:h-14 mb-2 drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                  <div className="text-4xl sm:text-5xl font-black leading-none">{votingNominations}</div>
                  <div className="text-[10px] sm:text-xs uppercase tracking-widest font-bold opacity-90 mt-1.5">Nominations</div>
                </div>
              </div>
            </div>

            {allPlayerVotings.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-lg font-black text-ink-primary px-1">Vote History</h2>
                {allPlayerVotings.map(({ voting, playerVotes }) => {
                  const isWin = voting.winners?.some(w => w.playerId === playerId) || voting.winner?.playerId === playerId;
                  const isCoWin = isWin && (voting.winners?.length || 0) > 1;
                  const reasons = playerVotes.filter(v => v.reason);
                  return (
                    <div
                      key={voting.id}
                      className={`relative overflow-hidden rounded-2xl shadow-sm ${
                        isWin
                          ? 'bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 ring-2 ring-amber-300'
                          : 'bg-surface-elevated ring-1 ring-gray-100'
                      }`}
                    >
                      {isWin && (
                        <div className="absolute -top-8 -right-8 w-32 h-32 bg-amber-300/30 rounded-full blur-2xl pointer-events-none" />
                      )}
                      <div className="relative p-4 sm:p-5">
                        <div className="flex items-start gap-3">
                          <div className={`flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-md ${
                            isWin ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-white' : 'bg-line-default/[0.08]'
                          }`}>
                            {isWin ? '🏆' : '⭐'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-bold text-ink-primary truncate">{voting.gameTitle}</p>
                              {isWin && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500 text-white">
                                  {isCoWin ? `Co-Winner ×${voting.winners!.length}` : 'Winner'}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-ink-primary/50 font-medium mt-0.5">
                              {voting.gameDate instanceof Date ? formatDate(voting.gameDate) : ''}
                              {' · '}
                              <span className={isWin ? 'text-amber-300' : ''}>{playerVotes.length} vote{playerVotes.length !== 1 ? 's' : ''}</span>
                            </p>
                          </div>
                        </div>
                        {reasons.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {reasons.map((v, i) => (
                              <div key={i} className={`rounded-xl px-3 py-2.5 ${isWin ? 'bg-line-default/70' : 'bg-line-default/[0.04]'}`}>
                                <p className="text-sm text-ink-primary/90 italic font-medium">"{v.reason}"</p>
                                <p className="text-xs text-ink-primary/50 mt-1 font-semibold">— {v.voterName}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={<svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4h14v2h2v4a4 4 0 0 1-4 4h-.55A6 6 0 0 1 13 18v2h2v2H9v-2h2v-2a6 6 0 0 1-3.45-4H7a4 4 0 0 1-4-4V6h2zm0 4v2a2 2 0 0 0 2 2V8zm14 0v4a2 2 0 0 0 2-2V8z" /></svg>}
                title="No awards yet"
                description="Player of the Match wins will land here."
              />
            )}
          </div>
        )}

        {/* ─── SIDELINE SHOUTS TAB ─────────────────────────────────
            Unified stream of every positive moment on this player:
            Kudos from Circle, coach Whispers, coach live XP grants
            with a reason note, badges earned, POTM vote reasons.
            See project_sideline_shouts memory for the naming +
            intent. Tab id stays 'whispers' for deep-link back-compat
            (existing pushes deep-link to ?tab=whispers). */}
        {activeTab === 'whispers' && (() => {
          const allShouts = buildSidelineShouts({
            player,
            kudosList,
            whispers,
            xpEvents,
            potmVotes: allPlayerVotings,
          });
          const first = player.name?.split(' ')[0] || 'this player';
          // Per-type counts for the filter chip row.
          const countBy = (t: typeof shoutFilter) =>
            t === 'all' ? allShouts.length : allShouts.filter(s => s.type === t).length;
          const shouts = shoutFilter === 'all'
            ? allShouts
            : allShouts.filter(s => s.type === shoutFilter);
          // Filter chip labels. Copy per feedback_copy_voice: warm,
          // short. "From coach" bundles XP grant notes; that reads
          // more naturally than "XP grants" to a parent scanning.
          const FILTERS: Array<{ key: typeof shoutFilter; label: string }> = [
            { key: 'all',           label: 'All' },
            { key: 'kudos',         label: 'Kudos' },
            { key: 'potm_comment',  label: 'POTM' },
            { key: 'xp_note',       label: 'From coach' },
            { key: 'whisper',       label: 'Whispers' },
            { key: 'badge',         label: 'Badges' },
          ];
          return (
            <div className="space-y-4">
              <div>
                <h2 className="text-xl sm:text-2xl font-black text-ink-primary">Sideline Shouts</h2>
                <p className="text-[12.5px] text-ink-primary/60 mt-1">
                  Everything kind {first}&rsquo;s people have said and done.
                </p>
              </div>

              {/* Filter chip row. Wraps, never scrolls sideways
                  (per feedback_no_horizontal_pills). Chip shows a
                  count when there's at least one item of that type
                  so the row also acts as a shout inventory. Hidden
                  when there aren't any shouts yet — no filters to
                  offer on an empty stream. */}
              {allShouts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {FILTERS.map(f => {
                    const c = countBy(f.key);
                    if (f.key !== 'all' && c === 0) return null;
                    const isActive = shoutFilter === f.key;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => setShoutFilter(f.key)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition ${
                          isActive
                            ? 'bg-ink-primary text-surface-base shadow-sm'
                            : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.14]'
                        }`}
                      >
                        <span>{f.label}</span>
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
                          isActive ? 'bg-surface-base/20 text-surface-base' : 'bg-surface-elevated text-ink-primary/50'
                        }`}>
                          {c}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {shouts.length === 0 ? (
                <EmptyState
                  icon={<svg className="w-5 h-5 text-brand-primary" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>}
                  title={shoutFilter === 'all' ? 'No shouts yet' : `No ${(FILTERS.find(f => f.key === shoutFilter)?.label || '').toLowerCase()} yet`}
                  description={shoutFilter !== 'all'
                    ? `Nothing in this category yet. Try All to see the full stream.`
                    : (canGiveKudos
                      ? `Tap Give Kudos above to send ${first} the first shout.`
                      : `When someone in ${first}'s Circle sends Kudos or Coach whispers a note, it'll show up here.`)}
                />
              ) : (
                <ul className="space-y-3">
                  {shouts.map(s => {
                    // Coach convert-to-XP action for Kudos-type shouts
                    // that haven't been converted yet. Preserved from the
                    // Ship 1 Kudos section render. Ship 2b will replace
                    // the prompt() with a proper slider modal.
                    const isKudosShout = s.type === 'kudos';
                    const kudosId = isKudosShout ? s.id.replace(/^kudos-/, '') : null;
                    const kudosRaw = kudosId ? kudosList.find(k => k.id === kudosId) : null;
                    const kudosConverted = kudosRaw && typeof kudosRaw.xpAwarded === 'number' && kudosRaw.xpAwarded > 0;
                    const canConvertKudos = isKudosShout
                      && !!kudosRaw
                      && !kudosConverted
                      && !!userData
                      && isCoachOfTeam(userData, selectedTeam)
                      && (selectedTeam as any)?.xpConfig?.enabled === true;
                    const handleConvert = async () => {
                      if (!kudosRaw) return;
                      const teamIdForConvert = (player as any).teamId
                        || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '')
                        || '';
                      if (!teamIdForConvert) { alert('Missing team context — cannot convert.'); return; }
                      const raw = window.prompt(`Add XP for this Kudos from ${kudosRaw.senderName}? Enter amount 1–500.`, '25');
                      if (!raw) return;
                      const amount = parseInt(raw, 10);
                      if (!Number.isFinite(amount) || amount < 1 || amount > 500) { alert('Amount must be 1–500.'); return; }
                      try {
                        const { workerFetch } = await import('../utils/workerFetch');
                        const res = await workerFetch('/xp/convert-kudos', {
                          method: 'POST',
                          body: JSON.stringify({ teamId: teamIdForConvert, playerId: player.id, kudosId: kudosRaw.id, amount }),
                        });
                        const data: any = await res.json().catch(() => ({}));
                        if (!res.ok || !data?.ok) { alert(`Could not convert: ${data?.error || res.status}`); return; }
                        setKudosList(list => list.map(x => x.id === kudosRaw.id
                          ? { ...x, xpAwarded: amount, xpAwardedByName: userData?.name || 'Coach', xpAwardedAt: new Date() }
                          : x));
                        try {
                          const { tplKudosXpAwarded, sendEmailBatch, sendPushToPlayerParents, getParentEmailsForPlayer } = await import('../utils/notify');
                          sendPushToPlayerParents(player.id, {
                            title: `+${amount} XP for ${first}`,
                            body: `Coach agreed with ${kudosRaw.senderName}'s Kudos: "${kudosRaw.note.slice(0, 120)}"`,
                            url: `/player/${player.id}?tab=xp`,
                          }, 'devPlan').catch(() => {});
                          const parents = await getParentEmailsForPlayer(player.id, 'devPlan');
                          if (parents.length > 0) {
                            const { subject, html } = tplKudosXpAwarded({
                              playerName: player.name || 'the player',
                              senderName: kudosRaw.senderName,
                              coachName: userData?.name || 'Coach',
                              amount,
                              note: kudosRaw.note,
                              playerId: player.id,
                            });
                            await sendEmailBatch(parents.map(p => ({ to: p.email, subject, html })));
                          }
                        } catch { /* non-fatal */ }
                      } catch (err: any) {
                        alert(`Convert failed: ${err?.message || 'network error'}`);
                      }
                    };

                    return (
                      <li key={s.id} className={`p-3 sm:p-4 rounded-xl bg-surface-elevated ring-1 ring-line-default/15 border-l-4 ${shoutAccentClass(s.type)}`}>
                        <div className="flex items-start gap-3">
                          {s.type === 'badge' && s.badgeImage ? (
                            <img src={s.badgeImage} className="w-9 h-9 object-contain flex-shrink-0" alt="" />
                          ) : s.fromAvatarUrl ? (
                            <img src={s.fromAvatarUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-brand-primary/15 text-brand-primary flex items-center justify-center font-black text-sm flex-shrink-0">
                              {(s.fromName || '?').charAt(0)}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-bold text-ink-primary">{s.fromName}</span>
                              <span className="text-[9.5px] font-black uppercase tracking-[0.14em] text-ink-primary/50">
                                {SHOUT_TYPE_LABEL[s.type]}
                              </span>
                              {typeof s.xpAmount === 'number' && s.xpAmount > 0 && (
                                <span className="text-[10px] font-black uppercase tracking-widest text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full">
                                  +{s.xpAmount} XP
                                </span>
                              )}
                              <span className="text-[11px] text-ink-primary/50 ml-auto tabular-nums">
                                {s.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                              </span>
                            </div>
                            <p className="text-[14px] text-ink-primary/90 mt-1 whitespace-pre-wrap leading-relaxed">{s.body}</p>
                            {canConvertKudos && (
                              <button
                                type="button"
                                onClick={handleConvert}
                                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider bg-brand-primary/10 text-brand-primary ring-1 ring-brand-primary/30 hover:bg-brand-primary/20 transition"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
                                Convert to XP
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })()}
      </div>
      )}

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

// ─── Plan Detail Card ──────────────────────────────────────────────────────
interface PlanDetailProps {
  plan: DevelopmentPlan;
  getCategoryColor: (cat: string) => string;
  getCategoryIcon: (cat: string) => string;
  getProgressPercent: (plan: DevelopmentPlan) => number;
}

const PlanDetail: React.FC<PlanDetailProps> = ({ plan, getCategoryColor, getCategoryIcon, getProgressPercent }) => {
  const [expanded, setExpanded] = useState(false);
  const [logGoalId, setLogGoalId] = useState<string | null>(null);
  const [logNote, setLogNote] = useState('');
  const [logMinutes, setLogMinutes] = useState('');
  const [showAllLogs, setShowAllLogs] = useState<string | null>(null);
  // Optimistic verified-by cache. Bridges the gap between the worker
  // ack landing and the plan reload — coach taps "Saw this", we stamp
  // the entry locally so the pill flips state instantly, and the next
  // profile refresh replaces the optimistic value with the truthful
  // one from Firestore.
  const [verifiedOptimistic, setVerifiedOptimistic] = useState<Record<string, { uid: string; name: string; at: Date }>>({});
  const { userData } = useAuth();
  const { selectedTeam } = useTeam();
  const { updateDevelopmentPlan } = useFirestore();
  const progress = getProgressPercent(plan);
  const canVerifyLogs = isCoachOfTeam(userData, selectedTeam);

  const handleVerifyLog = async (goalId: string, logId: string) => {
    try {
      const result = await coachVerifyLogEntry({ plan, goalId, logId });
      setVerifiedOptimistic(prev => ({ ...prev, [logId]: result.verifiedBy }));
    } catch (err) {
      console.warn('[plan-detail] verify log failed', err);
      alert('Could not save. Try again.');
    }
  };

  const handleSubmitLog = async () => {
    if (!logGoalId || !logNote.trim() || !userData) return;
    const entry = {
      id: `log_${Date.now()}`,
      date: new Date(),
      note: logNote.trim(),
      minutes: logMinutes ? parseInt(logMinutes) : undefined,
      loggedBy: userData.uid,
      loggedByName: userData.name,
    };
    const updatedGoals = plan.goals.map(g =>
      g.id === logGoalId ? { ...g, practiceLog: [...(g.practiceLog || []), entry] } : g
    );
    await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
    // Update local state
    const goal = plan.goals.find(g => g.id === logGoalId);
    if (goal) goal.practiceLog = [...(goal.practiceLog || []), entry];
    setLogGoalId(null);
    setLogNote('');
    setLogMinutes('');
  };

  return (
    <div className="bg-surface-elevated rounded-xl border border-line-default/10 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-4 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span>{getCategoryIcon(plan.category)}</span>
            <span className="font-medium text-ink-primary">{plan.title}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs ${getCategoryColor(plan.category)}`}>{plan.category}</span>
          </div>
          <div className="flex items-center space-x-3">
            <span className="text-sm font-medium text-ink-primary/65">{progress}%</span>
            <svg className={`w-4 h-4 text-ink-primary/40 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
          </div>
        </div>
        <div className="w-full bg-line-default/15 rounded-full h-1.5 mt-3">
          <div className={`h-1.5 rounded-full transition-all ${plan.status === 'completed' ? 'bg-emerald-500' : 'bg-brand-primary'}`} style={{ width: `${progress}%` }} />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-line-default/5 px-4 pb-4">
          {plan.description && <p className="text-sm text-ink-primary/65 mt-3 mb-3">{plan.description}</p>}
          <div className="space-y-2">
            {plan.goals.map(goal => {
              const logs = goal.practiceLog || [];
              const totalMins = logs.reduce((s: number, e: any) => s + (e.minutes || 0), 0);
              const hours = Math.floor(totalMins / 60);
              const mins = totalMins % 60;
              return (
              <div key={goal.id} className="p-2 rounded-lg bg-line-default/[0.04]">
                <div className="flex items-start space-x-3">
                <div className="mt-0.5">
                  {goal.coachVerified ? (
                    <span className="text-green-500 text-lg">✅</span>
                  ) : goal.playerCompleted ? (
                    <span className="text-yellow-500 text-lg">⏳</span>
                  ) : (
                    <span className="text-ink-primary/35 text-lg">○</span>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <p className={`text-sm font-medium ${goal.coachVerified ? 'text-emerald-300 line-through' : 'text-ink-primary'}`}>{goal.title}</p>
                    {totalMins > 0 && (
                      <span className="text-xs font-medium text-brand-primary bg-brand-primary/15 px-2 py-0.5 rounded-full">
                        ⏱️ {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
                      </span>
                    )}
                  </div>
                  {goal.description && <p className="text-xs text-ink-primary/50 mt-0.5">{goal.description}</p>}
                  {goal.notes && <p className="text-xs text-brand-primary mt-1 italic">Coach: {goal.notes}</p>}
                  <div className="flex gap-2 mt-1">
                    {goal.playerCompleted && <span className="text-[10px] text-ink-primary/40">Marked done by player</span>}
                    {goal.coachVerified && goal.coachVerifiedByName && <span className="text-[10px] text-emerald-600">Verified by {goal.coachVerifiedByName}</span>}
                  </div>

                  {/* Practice Log entries */}
                  {logs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Practice Log</p>
                      {logs.slice().reverse().slice(0, showAllLogs === goal.id ? undefined : 3).map((entry: any) => {
                        // Merge server-truth with optimistic ack so
                        // the pill flips state instantly on coach tap.
                        const opt = verifiedOptimistic[entry.id];
                        const mergedEntry = opt ? { ...entry, verifiedBy: entry.verifiedBy || opt } : entry;
                        return (
                          <div key={entry.id} className="text-xs text-ink-primary/65 bg-surface-elevated rounded px-2 py-1.5 border border-line-default/5">
                            <div className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="text-ink-primary/40">
                                {entry.date?.toDate ? entry.date.toDate().toLocaleDateString() : new Date(entry.date).toLocaleDateString()}
                              </span>
                              {entry.minutes && <span className="text-brand-primary font-medium">({entry.minutes} min)</span>}
                              <span>: {entry.note}</span>
                              {entry.loggedByName && <span className="text-ink-primary/40">by {entry.loggedByName}</span>}
                            </div>
                            <div className="mt-1">
                              <CoachSawThisPill
                                entry={mergedEntry}
                                canVerify={canVerifyLogs}
                                onVerify={() => handleVerifyLog(goal.id, entry.id)}
                              />
                            </div>
                          </div>
                        );
                      })}
                      {logs.length > 3 && showAllLogs !== goal.id && (
                        <button onClick={() => setShowAllLogs(goal.id)} className="text-xs text-brand-primary hover:text-brand-primary-soft">
                          Show all {logs.length} entries
                        </button>
                      )}
                      {showAllLogs === goal.id && logs.length > 3 && (
                        <button onClick={() => setShowAllLogs(null)} className="text-xs text-ink-primary/50 hover:text-ink-primary/85">
                          Show less
                        </button>
                      )}
                    </div>
                  )}

                  {/* 'Log Practice' expanded form removed in v3.2.57
                      per Patrick: "we don't need [both] 'I did it' AND
                      'log practice.' The 'I did it' assumes they did
                      what they were supposed to do for as long as
                      they were supposed to do it." The 'I did it'
                      button on the InlineDevPlanCard already covers
                      the one-tap log path; the longer form with
                      duration + free-text note added friction without
                      collecting data anyone consumed. */}
                </div>
                </div>
              </div>
              );
            })}
          </div>
          <p className="text-xs text-ink-primary/40 mt-3">Created by {plan.createdByName} • {formatDate(plan.createdAt)}</p>
        </div>
      )}
    </div>
  );
};

export default PlayerProfile;
