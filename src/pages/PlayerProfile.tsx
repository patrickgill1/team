import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Player, PlayerMedia, DevelopmentPlan, Season } from '../types';
import { isCoach, formatDate, isGoalkeeper, getPlayerPositionsLabel } from '../utils/helpers';
import { where } from 'firebase/firestore';
import ParentWhisperModal from '../components/coach/ParentWhisperModal';
import { getPlayerStats, getPlayerLifetimeStats, getAllSeasonsForTeam, getActiveSeasonForTeam } from '../utils/seasons';
import { getShareOrigin } from '../utils/origin';
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
  const { selectedTeamId } = useTeam();
  const { getDocuments, getPlayerMediaByPlayer, getDevelopmentPlansByPlayer, getTeamPlayerStatsMap, updateDocument } = useFirestore();

  const [player, setPlayer] = useState<Player | null>(null);
  const [media, setMedia] = useState<PlayerMedia[]>([]);
  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [votingWins, setVotingWins] = useState<MatchVoting[]>([]);
  const [allPlayerVotings, setAllPlayerVotings] = useState<{ voting: MatchVoting; playerVotes: { voterName: string; reason?: string }[] }[]>([]);
  const [votingNominations, setVotingNominations] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'media' | 'development' | 'awards'>('overview');
  // Equipment editor state — coach-only modal for recording issued
  // gear sizes + return status.
  const [equipEditOpen, setEquipEditOpen] = useState(false);
  // Juggle log state — anyone who can see the profile (coach OR the
  // player's parents) can record an attempt.
  const [juggleOpen, setJuggleOpen] = useState(false);
  const [juggleDraft, setJuggleDraft] = useState<string>('');
  const [equipDraft, setEquipDraft] = useState<{
    jerseyHomeSize: string;
    jerseyAwaySize: string;
    shortsSize: string;
    socksSize: string;
    trainingTopSize: string;
    notes: string;
    returned: boolean;
  } | null>(null);
  // Memberships for this player across every team/season they're on.
  // Drives the per-team / per-season stats display (no more bleed).
  const [memberships, setMemberships] = useState<any[]>([]);
  // Which scope the Season Stats card is showing: this team this
  // season (default), this team's career, or all-time across teams.
  const [statsScope, setStatsScope] = useState<'team_season' | 'team_career' | 'all_time'>('team_season');
  const [lightboxItem, setLightboxItem] = useState<PlayerMedia | null>(null);
  const [showWhisper, setShowWhisper] = useState(false);
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

  const loadProfile = async () => {
    if (!playerId || !selectedTeamId) return;
    setLoading(true);

    // Load player first (needed to render header)
    try {
      const [playersData, statsMap] = await Promise.all([
        getDocuments('players', []),
        getTeamPlayerStatsMap(selectedTeamId).catch(() => ({} as any)),
      ]);
      const found = playersData.find((p: any) => p.id === playerId) as any;
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
      getDevelopmentPlansByPlayer(playerId),
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

      const wins = teamVotings.filter(v =>
        v.winners?.some(w => w.playerId === playerId) || v.winner?.playerId === playerId
      );
      setVotingWins(wins);

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
      case 'technical': return 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100';
      case 'tactical': return 'bg-navy-700/10 text-navy-800 ring-1 ring-navy-700/10';
      case 'physical': return 'bg-fire-50 text-fire-800 ring-1 ring-fire-100';
      case 'mental': return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100';
      default: return 'bg-gray-50 text-gray-700 ring-1 ring-gray-100';
    }
  };

  // Position dot — kept colorful for at-a-glance scanning but stays
  // away from the most off-brand tones (amber, orange) where possible.
  const positionDot = (pos?: string): string => {
    switch (pos) {
      case 'Goalkeeper': return 'bg-fire-400';
      case 'Defender': return 'bg-navy-700';
      case 'Midfielder': return 'bg-emerald-500';
      case 'Forward':
      case 'Striker': return 'bg-rose-500';
      case 'Winger': return 'bg-cyan-500';
      default: return 'bg-gray-400';
    }
  };

  const handleShareProfile = async () => {
    if (!player) return;
    const url = `${getShareOrigin()}/player/${player.id}`;
    const data = { title: `${player.name} · Fire FC`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(url); alert('Profile link copied!'); }
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        try { await navigator.clipboard.writeText(url); alert('Profile link copied!'); } catch {}
      }
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <h2 className="text-xl font-bold text-gray-900">Player Not Found</h2>
          <Link to="/players" className="text-cyan-600 hover:underline mt-2 inline-block">← Back to Roster</Link>
        </div>
      </div>
    );
  }

  const age = calculateAge(player.dateOfBirth);
  const activePlans = plans.filter(p => p.status === 'active');
  const completedPlans = plans.filter(p => p.status === 'completed');
  const recentMedia = media.slice(0, 6);
  const totalGoalsInPlans = plans.reduce((sum, p) => sum + p.goals.length, 0);
  const verifiedGoals = plans.reduce((sum, p) => sum + p.goals.filter(g => g.coachVerified).length, 0);
  const playerCompletedGoals = plans.reduce((sum, p) => sum + p.goals.filter(g => g.playerCompleted).length, 0);
  const totalPracticeMinutes = plans.reduce(
    (sum, p) => sum + p.goals.reduce((s, g) => s + (g.practiceLog || []).reduce((m, l) => m + (l.minutes || 0), 0), 0),
    0
  );
  const totalPracticeSessions = plans.reduce(
    (sum, p) => sum + p.goals.reduce((s, g) => s + (g.practiceLog || []).length, 0),
    0
  );
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ───── HERO ───── */}
      <div className="relative overflow-hidden bg-gradient-to-br from-fire-700 via-fire-800 to-navy-900 text-white">
        <div className="absolute -top-20 -right-20 w-80 h-80 bg-cyan-500/25 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-12 w-80 h-80 bg-rose-500/25 rounded-full blur-3xl pointer-events-none" />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
          {/* Top row: back + share */}
          <div className="flex items-center justify-between mb-5">
            <Link
              to="/players"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 ring-1 ring-white/20 text-white text-xs font-semibold hover:bg-white/20 transition backdrop-blur"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              Roster
            </Link>
            <button
              onClick={handleShareProfile}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 ring-1 ring-white/20 text-white text-xs font-semibold hover:bg-white/20 transition backdrop-blur"
              title="Share profile"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
              Share
            </button>
          </div>

          {/* Status pill */}
          {(player.position || (player.positions && player.positions.length > 0)) && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[10px] font-bold uppercase tracking-wider mb-3 backdrop-blur">
              <span className={`w-2 h-2 rounded-full ${positionDot(player.positions?.[0] || player.position || '')} animate-pulse`} />
              {getPlayerPositionsLabel(player)}{age ? ` · Age ${age}` : ''}
            </div>
          )}

          {/* Avatar + name */}
          <div className="flex items-center gap-4 sm:gap-6 mb-5">
            <div className="relative flex-shrink-0">
              {/* Gold ring + amber glow when this player is the current
                  POTM. Stays until a new POTM is finalized or a coach
                  clears it on the Vote page. */}
              {(player as any).isCurrentPotm && (
                <span aria-hidden className="absolute -top-2 -right-2 z-10 inline-flex items-center justify-center w-9 h-9 rounded-full bg-amber-400 text-amber-950 shadow-lg ring-2 ring-white">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z"/></svg>
                </span>
              )}
              {player.profilePhotoUrl ? (
                <img
                  src={player.profilePhotoUrl}
                  alt={player.name}
                  className={`w-24 h-24 sm:w-32 sm:h-32 rounded-full object-cover ring-4 shadow-2xl ${
                    (player as any).isCurrentPotm
                      ? 'ring-amber-300 shadow-amber-400/40'
                      : 'ring-white/25'
                  }`}
                />
              ) : (
                <div className={`w-24 h-24 sm:w-32 sm:h-32 rounded-full bg-white/10 ring-4 shadow-2xl flex items-center justify-center backdrop-blur ${
                  (player as any).isCurrentPotm ? 'ring-amber-300 shadow-amber-400/40' : 'ring-white/25'
                }`}>
                  <span className="text-3xl sm:text-4xl font-black text-white">
                    {player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              {player.profilePhotoUrl && player.jerseyNumber != null && (
                <span className="absolute -bottom-1 -right-1 bg-white text-fire-800 rounded-full min-w-[32px] h-8 px-2 flex items-center justify-center text-sm font-black shadow-xl ring-2 ring-fire-900">
                  #{player.jerseyNumber}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-3xl sm:text-5xl font-black tracking-tight leading-none truncate">{player.name}</h1>
              {(media.length > 0 || votingWins.length > 0) && (
                <p className="text-white/70 text-sm sm:text-base font-medium mt-2">
                  {votingWins.length > 0 && `${votingWins.length} POTM ${votingWins.length === 1 ? 'win' : 'wins'}`}
                  {votingWins.length > 0 && media.length > 0 && ' · '}
                  {media.length > 0 && `${media.length} ${media.length === 1 ? 'clip' : 'clips'}`}
                </p>
              )}
              {userData && isCoach(userData.role) && (
                <button
                  onClick={() => setShowWhisper(true)}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 text-white text-xs font-semibold ring-1 ring-white/20 transition backdrop-blur"
                  title="Send a private note to this player's parents"
                >
                  💬 Parent Whisper
                </button>
              )}
            </div>
          </div>

          {/* Season toggle — keep it simple. Two primary options: "This
              Season" and "Overall". Past seasons hide inside the dropdown
              for the curious; most coaches/parents just want now-vs-ever. */}
          {(allSeasons.length > 1 || activeSeason) && (
            <div className="mb-3 inline-flex items-center rounded-full bg-white/10 ring-1 ring-white/20 backdrop-blur p-0.5">
              <button
                onClick={() => setSelectedSeasonId('current')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  (selectedSeasonId === 'current' || (activeSeason && selectedSeasonId === activeSeason.id))
                    ? 'bg-white text-fire-900 shadow'
                    : 'text-white/80 hover:text-white'
                }`}
              >
                This Season
              </button>
              <button
                onClick={() => setSelectedSeasonId('lifetime')}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  selectedSeasonId === 'lifetime'
                    ? 'bg-white text-fire-900 shadow'
                    : 'text-white/80 hover:text-white'
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
                        ? 'bg-white text-fire-900 shadow'
                        : 'text-white/80 hover:text-white'
                    }`}
                    aria-label="Pick another season"
                  >
                    •••
                  </button>
                  {seasonMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 z-30 min-w-[180px] rounded-xl bg-slate-900/95 backdrop-blur ring-1 ring-white/15 shadow-xl py-1">
                      {allSeasons.filter(s => !s.isActive).map(s => (
                        <button
                          key={s.id}
                          onClick={() => { setSelectedSeasonId(s.id); setSeasonMenuOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-white/5 ${selectedSeasonId === s.id ? 'text-cyan-300 font-semibold' : 'text-white/85'}`}
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
            return (
              <>
                <div className="grid grid-cols-4 gap-2 sm:gap-3">
                  <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-emerald-300">{s.goals || 0}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-white/70 font-bold">Goals</div>
                  </div>
                  <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-cyan-300">{s.assists || 0}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-white/70 font-bold">Assists</div>
                  </div>
                  <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-fire-300">{votingWins.length}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-white/70 font-bold">POTM</div>
                  </div>
                  <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-2.5 sm:p-3 text-center">
                    <div className="text-2xl sm:text-3xl font-black text-white">{media.length}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-white/70 font-bold">Clips</div>
                  </div>
                </div>
                {showCareerStrip && (
                  <p className="mt-3 text-[11px] text-white/60 font-medium tracking-wide">
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
      <div className="bg-white border-b border-gray-100 sticky top-0 z-20 shadow-sm">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 py-3">
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide -mx-1 px-1">
            {(['overview', 'media', 'development', 'awards'] as const).map(tab => {
              const count =
                tab === 'media' ? media.length :
                tab === 'development' ? activePlans.length :
                tab === 'awards' ? votingWins.length : null;
              const label =
                tab === 'overview' ? 'Overview' :
                tab === 'media' ? 'Media' :
                tab === 'development' ? 'Development' : 'Awards';
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition ${
                    isActive
                      ? 'bg-fire-900 text-white shadow'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  <span>{label}</span>
                  {count !== null && count > 0 && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                      isActive ? 'bg-white/20 text-white' : 'bg-white text-gray-500'
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
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-6">

        {/* ─── OVERVIEW TAB ──────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="space-y-4 sm:space-y-6">

            {/* WHAT PEOPLE ARE SAYING — kids love this */}
            {latestQuote && (
              <button
                type="button"
                onClick={() => setActiveTab('awards')}
                className="w-full text-left relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 p-5 text-white shadow-xl hover:scale-[1.01] transition group"
              >
                <div className="absolute -top-8 -right-8 w-40 h-40 bg-white/10 rounded-full blur-2xl pointer-events-none" />
                <div className="relative">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xl">💬</span>
                    <span className="text-[10px] uppercase tracking-widest font-black opacity-90">What people said</span>
                  </div>
                  <p className="text-base sm:text-lg font-bold italic leading-snug">"{latestQuote.reason}"</p>
                  <p className="text-xs opacity-90 mt-2 font-semibold">— {latestQuote.voterName} · {latestQuote.gameTitle}</p>
                </div>
              </button>
            )}

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
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs font-extrabold tracking-widest uppercase text-slate-600">Stats</h2>
                    <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{scopeLabel}</span>
                  </div>
                  {/* Scope toggle */}
                  <div className="flex gap-1 mb-3">
                    {([
                      { k: 'team_season', label: 'Season' },
                      { k: 'team_career', label: 'Career here' },
                      { k: 'all_time', label: 'All-time' },
                    ] as const).map(({ k, label }) => (
                      <button
                        key={k}
                        onClick={() => setStatsScope(k)}
                        className={`flex-1 px-2 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase border ${
                          statsScope === k
                            ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                            : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="rounded-lg bg-cyan-50 border border-cyan-200 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-cyan-700">{scoped.gamesPlayed || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-cyan-700/70 font-bold mt-0.5">Games</div>
                    </div>
                    <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-emerald-700">{scoped.goals || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-emerald-700/70 font-bold mt-0.5">Goals</div>
                    </div>
                    <div className="rounded-lg bg-violet-50 border border-violet-200 p-2.5 text-center">
                      <div className="text-2xl sm:text-3xl font-black text-violet-700">{scoped.assists || 0}</div>
                      <div className="text-[9px] uppercase tracking-widest text-violet-700/70 font-bold mt-0.5">Assists</div>
                    </div>
                    {isGoalkeeper(player) ? (
                      <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-center">
                        <div className="text-2xl sm:text-3xl font-black text-amber-700">{scoped.saves || 0}</div>
                        <div className="text-[9px] uppercase tracking-widest text-amber-700/70 font-bold mt-0.5">Saves</div>
                      </div>
                    ) : (
                      <div className="rounded-lg bg-rose-50 border border-rose-200 p-2.5 text-center">
                        <div className="text-2xl sm:text-3xl font-black text-rose-700">{(scoped.goals || 0) + (scoped.assists || 0)}</div>
                        <div className="text-[9px] uppercase tracking-widest text-rose-700/70 font-bold mt-0.5">G+A</div>
                      </div>
                    )}
                  </div>
                  {statsScope === 'all_time' && memberships.length > 1 && (
                    <p className="mt-2 text-[10px] text-slate-400 tracking-wide">Combined across {memberships.length} team-season{memberships.length === 1 ? '' : 's'}.</p>
                  )}
                </div>
              );
            })()}

            {/* PRACTICE EFFORT — when there is any */}
            {totalPracticeMinutes > 0 && (
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-orange-500 via-rose-500 to-rose-600 text-white p-5 sm:p-6 shadow-xl">
                <div className="absolute -top-12 -right-12 w-48 h-48 bg-white/15 rounded-full blur-2xl pointer-events-none" />
                <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-amber-400/30 rounded-full blur-2xl pointer-events-none" />
                <div className="relative flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest font-black opacity-90 mb-1">🔥 Practice Effort</div>
                    <div className="text-4xl sm:text-5xl font-black tracking-tight leading-none">{formatMinutes(totalPracticeMinutes)}</div>
                    <div className="text-xs sm:text-sm font-semibold opacity-90 mt-1.5">across {totalPracticeSessions} session{totalPracticeSessions === 1 ? '' : 's'} · keep it up</div>
                  </div>
                  <div className="text-5xl sm:text-7xl drop-shadow-lg">💪</div>
                </div>
              </div>
            )}

            {/* DEVELOPMENT SUMMARY */}
            {plans.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-black text-gray-900">Development</h2>
                  <button onClick={() => setActiveTab('development')} className="text-sm text-cyan-600 hover:text-cyan-700 font-bold">View All →</button>
                </div>

                <div className="grid grid-cols-4 gap-2 mb-4">
                  <div className="rounded-xl bg-cyan-50 ring-1 ring-cyan-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-cyan-700">{activePlans.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-700/70 font-bold">Active</div>
                  </div>
                  <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-emerald-700">{completedPlans.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-700/70 font-bold">Done</div>
                  </div>
                  <div className="rounded-xl bg-amber-50 ring-1 ring-amber-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-amber-700">{playerCompletedGoals}<span className="text-sm text-amber-700/60">/{totalGoalsInPlans}</span></div>
                    <div className="text-[10px] uppercase tracking-wider text-amber-700/70 font-bold">Goals</div>
                  </div>
                  <div className="rounded-xl bg-violet-50 ring-1 ring-violet-100 p-3 text-center">
                    <div className="text-xl sm:text-2xl font-black text-violet-700">{totalGoalsInPlans > 0 ? Math.round((verifiedGoals / totalGoalsInPlans) * 100) : 0}%</div>
                    <div className="text-[10px] uppercase tracking-wider text-violet-700/70 font-bold">Verified</div>
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
                          <span className="font-bold text-sm text-gray-900 truncate">{plan.title}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${getCategoryColor(plan.category)}`}>{plan.category}</span>
                        </div>
                        {planMins > 0 && (
                          <span className="text-xs font-bold text-orange-600 whitespace-nowrap">🔥 {formatMinutes(planMins)}{planTarget > 0 ? ` / ${formatMinutes(planTarget)}` : ''}</span>
                        )}
                      </div>
                      <div className="mt-2.5 space-y-1.5">
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-500 font-semibold uppercase tracking-wider"><span>You</span><span>{playerPct}%</span></div>
                          <div className="w-full bg-gray-100 rounded-full h-1.5"><div className="bg-amber-400 h-1.5 rounded-full transition-all" style={{ width: `${playerPct}%` }} /></div>
                        </div>
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-500 font-semibold uppercase tracking-wider"><span>Coach Verified</span><span>{verified}%</span></div>
                          <div className="w-full bg-gray-100 rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all ${verified === 100 ? 'bg-emerald-500' : 'bg-cyan-500'}`} style={{ width: `${verified}%` }} /></div>
                        </div>
                        {planTarget > 0 && (
                          <div>
                            <div className="flex justify-between text-[10px] text-gray-500 font-semibold uppercase tracking-wider"><span>🔥 Minutes</span><span>{Math.min(100, Math.round((planMins / planTarget) * 100))}%</span></div>
                            <div className="w-full bg-gray-100 rounded-full h-1.5"><div className="bg-orange-500 h-1.5 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round((planMins / planTarget) * 100))}%` }} /></div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* RECENT HIGHLIGHTS */}
            {recentMedia.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-black text-gray-900">Recent Highlights</h2>
                  <button onClick={() => setActiveTab('media')} className="text-sm text-cyan-600 hover:text-cyan-700 font-bold">View All →</button>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  {recentMedia.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLightboxItem(item)}
                      className="group relative aspect-square bg-gradient-to-br from-gray-800 to-gray-950 rounded-xl overflow-hidden ring-1 ring-gray-100 hover:shadow-lg hover:-translate-y-0.5 transition"
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
                            <div className="w-9 h-9 bg-black/60 rounded-full flex items-center justify-center backdrop-blur">
                              <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                            </div>
                          </div>
                        </>
                      ) : (
                        <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover group-hover:scale-105 transition" loading="lazy" />
                      )}
                      {item.likeCount && item.likeCount > 0 ? (
                        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full bg-black/70 text-white text-[10px] font-bold backdrop-blur">❤ {item.likeCount}</div>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* AWARDS PEEK */}
            {(votingWins.length > 0 || votingNominations > 0) && (
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-black text-gray-900">Player of the Match</h2>
                  <button onClick={() => setActiveTab('awards')} className="text-sm text-cyan-600 hover:text-cyan-700 font-bold">View All →</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-white p-5 shadow-md">
                    <div className="absolute -top-4 -right-4 w-20 h-20 bg-white/20 rounded-full blur-xl pointer-events-none" />
                    <div className="relative">
                      <div className="text-3xl mb-1">🏆</div>
                      <div className="text-3xl sm:text-4xl font-black leading-none">{votingWins.length}</div>
                      <div className="text-[10px] uppercase tracking-wider font-bold opacity-90 mt-1">Wins</div>
                    </div>
                  </div>
                  <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-cyan-400 via-cyan-500 to-sky-600 text-white p-5 shadow-md">
                    <div className="absolute -top-4 -right-4 w-20 h-20 bg-white/20 rounded-full blur-xl pointer-events-none" />
                    <div className="relative">
                      <div className="text-3xl mb-1">⭐</div>
                      <div className="text-3xl sm:text-4xl font-black leading-none">{votingNominations}</div>
                      <div className="text-[10px] uppercase tracking-wider font-bold opacity-90 mt-1">Nominated</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* PRACTICE STREAK — consecutive days the player (or their
                parent) has tapped "I did it" across any goal on any
                active plan. Patrick: "maybe a hot streak when they do
                more than one day and it showcases in their profile".
                Visible to coach + the kid's parents. */}
            {userData && (isCoach(userData.role) || (player.parentIds || []).includes(userData.uid)) && (() => {
              // Aggregate all practice-log dates across every active
              // plan's goals, dedupe to day buckets, then count
              // consecutive days back from today (or yesterday if they
              // haven't tapped yet today — so a missed-by-one-day
              // streak isn't broken until midnight rolls).
              const dayKeys = new Set<string>();
              for (const p of plans) {
                if (p.status !== 'active') continue;
                for (const g of (p.goals || [])) {
                  for (const l of ((g as any).practiceLog || [])) {
                    const d = l.date?.toDate ? l.date.toDate() : new Date(l.date);
                    dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
                  }
                }
              }
              if (dayKeys.size === 0) return null;
              const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; })();
              const today = dayKeys.has(todayKey);
              const cursor = new Date();
              cursor.setHours(0, 0, 0, 0);
              if (!today) cursor.setDate(cursor.getDate() - 1);
              let streak = 0;
              for (;;) {
                const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
                if (dayKeys.has(key)) {
                  streak++;
                  cursor.setDate(cursor.getDate() - 1);
                } else break;
              }
              if (streak === 0) return null;
              const hot = streak >= 3;
              return (
                <div className={`rounded-2xl px-5 py-4 text-white shadow-md ${
                  hot
                    ? 'bg-gradient-to-br from-rose-500 via-orange-500 to-amber-500'
                    : 'bg-gradient-to-br from-cyan-500 to-cyan-600'
                }`}>
                  <div className="flex items-center gap-3">
                    <span className="flex-shrink-0 w-12 h-12 rounded-full bg-white/20 ring-2 ring-white/30 flex items-center justify-center text-2xl">
                      {hot ? '🔥' : '⚡'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">
                        {hot ? "Hot streak" : "Practice streak"}
                      </div>
                      <div className="text-2xl font-black leading-tight">
                        {streak} {streak === 1 ? 'day' : 'days'} {today ? 'and counting' : '— log today to keep it'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* JUGGLE COUNTER — parent-entered. Visible to coach + the
                kid's parents. PR is the headline; recent attempts feed
                a 7-day streak. No camera/CV — purely self-reported,
                per Patrick. */}
            {userData && (isCoach(userData.role) || (player.parentIds || []).includes(userData.uid)) && (() => {
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
                <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-bold text-fire-950 flex items-center gap-2">
                      <span className="text-2xl">⚽</span>
                      Juggle counter
                    </h3>
                    <button
                      onClick={() => { setJuggleDraft(''); setJuggleOpen(true); }}
                      className="text-xs font-bold uppercase tracking-widest text-cyan-700 hover:text-cyan-900"
                    >
                      + Log
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-amber-800">PR</div>
                      <div className="text-2xl font-black text-amber-900 tabular-nums leading-tight">{best}</div>
                    </div>
                    <div className="rounded-xl bg-cyan-50 ring-1 ring-cyan-200 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-800">7-day attempts</div>
                      <div className="text-2xl font-black text-cyan-900 tabular-nums leading-tight">{lastWeek.length}</div>
                    </div>
                    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2.5">
                      <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-700">Last</div>
                      <div className="text-2xl font-black text-slate-900 tabular-nums leading-tight">{last?.count ?? '—'}</div>
                    </div>
                  </div>
                  {history.length === 0 && (
                    <p className="text-xs text-slate-500 mt-3">No attempts yet. Tap "+ Log" to record one.</p>
                  )}
                </div>
              );
            })()}

            {/* EQUIPMENT — coach edits, parents of this kid view. The
                "/equipment" page is the coach's outstanding-gear view
                across the whole team. */}
            {userData && (isCoach(userData.role) || (player.parentIds || []).includes(userData.uid)) && (() => {
              const eq = (player as any).equipment || {};
              const anyField = !!(eq.jerseyHomeSize || eq.jerseyAwaySize || eq.shortsSize || eq.socksSize || eq.trainingTopSize || eq.notes);
              const userIsCoach = isCoach(userData.role);
              return (
                <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-bold text-fire-950 flex items-center gap-2">
                      <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>
                      Team gear
                    </h3>
                    {userIsCoach && (
                      <button
                        onClick={() => {
                          setEquipDraft({
                            jerseyHomeSize: eq.jerseyHomeSize || '',
                            jerseyAwaySize: eq.jerseyAwaySize || '',
                            shortsSize: eq.shortsSize || '',
                            socksSize: eq.socksSize || '',
                            trainingTopSize: eq.trainingTopSize || '',
                            notes: eq.notes || '',
                            returned: !!eq.returned,
                          });
                          setEquipEditOpen(true);
                        }}
                        className="text-xs font-bold uppercase tracking-widest text-cyan-700 hover:text-cyan-900"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {!anyField ? (
                    <p className="text-sm text-slate-500">
                      {userIsCoach ? 'Nothing recorded yet. Tap Edit to log issued sizes.' : 'No team gear recorded yet.'}
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                        {eq.jerseyHomeSize && <Field label="Jersey (home)" value={eq.jerseyHomeSize} />}
                        {eq.jerseyAwaySize && <Field label="Jersey (away)" value={eq.jerseyAwaySize} />}
                        {eq.shortsSize && <Field label="Shorts" value={eq.shortsSize} />}
                        {eq.socksSize && <Field label="Socks" value={eq.socksSize} />}
                        {eq.trainingTopSize && <Field label="Training top" value={eq.trainingTopSize} />}
                        {player.jerseyNumber != null && <Field label="Jersey #" value={`#${player.jerseyNumber}`} />}
                      </div>
                      {eq.notes && (
                        <p className="text-xs text-slate-600 mt-3 italic">{eq.notes}</p>
                      )}
                      <div className="mt-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-extrabold tracking-widest uppercase">
                        {eq.returned ? (
                          <span className="bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 px-2 py-0.5 rounded">Returned</span>
                        ) : (
                          <span className="bg-amber-100 text-amber-800 ring-1 ring-amber-300 px-2 py-0.5 rounded">Outstanding</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}

            {/* EMPTY STATE */}
            {plans.length === 0 && recentMedia.length === 0 && votingWins.length === 0 && (
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 p-8 text-center">
                <div className="text-5xl mb-3">⚽</div>
                <h3 className="text-lg font-bold text-gray-900 mb-1">{player.name.split(' ')[0]}'s journey starts here</h3>
                <p className="text-sm text-gray-500">Stats, clips, and awards will show up as the season unfolds.</p>
              </div>
            )}
          </div>
        )}

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
                    className="group relative aspect-square bg-gradient-to-br from-gray-800 to-gray-950 rounded-2xl overflow-hidden text-left shadow-sm ring-1 ring-gray-100 hover:shadow-lg hover:-translate-y-0.5 transition"
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
                            <span key={tag} className="px-1.5 py-0.5 bg-white/20 text-white rounded text-[9px] font-bold uppercase tracking-wider backdrop-blur">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 bg-white rounded-2xl shadow-sm ring-1 ring-gray-100">
                <div className="text-5xl mb-3">📸</div>
                <h3 className="text-lg font-bold text-gray-900">No Highlights Yet</h3>
                <p className="text-gray-500 text-sm mt-1">Photos and videos will live here.</p>
                <Link to="/player-media" className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-full bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-bold transition">Go to Gallery →</Link>
              </div>
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
                    <h2 className="text-lg font-black text-gray-900 px-1">Active Plans</h2>
                    {activePlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
                {completedPlans.length > 0 && (
                  <>
                    <h2 className="text-lg font-black text-gray-900 px-1 mt-6">✅ Completed Plans</h2>
                    {completedPlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="text-center py-12 bg-white rounded-2xl shadow-sm ring-1 ring-gray-100">
                <div className="text-5xl mb-3">📋</div>
                <h3 className="text-lg font-bold text-gray-900">No Development Plans</h3>
                <p className="text-gray-500 text-sm mt-1">Plans from coaches will show up here.</p>
                <Link to="/development" className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-full bg-cyan-600 hover:bg-cyan-700 text-white text-sm font-bold transition">Open Development →</Link>
              </div>
            )}
          </div>
        )}

        {/* ─── AWARDS TAB ────────────────────────────────────────── */}
        {activeTab === 'awards' && (
          <div className="space-y-4 sm:space-y-6">
            {/* Big trophy hero */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-white p-5 sm:p-6 text-center shadow-xl">
                <div className="absolute -top-6 -right-6 w-32 h-32 bg-white/20 rounded-full blur-2xl pointer-events-none" />
                <div className="relative">
                  <div className="text-5xl sm:text-6xl mb-2 drop-shadow-lg">🏆</div>
                  <div className="text-4xl sm:text-5xl font-black leading-none">{votingWins.length}</div>
                  <div className="text-[10px] sm:text-xs uppercase tracking-widest font-bold opacity-90 mt-1.5">POTM Wins</div>
                </div>
              </div>
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-cyan-400 via-cyan-500 to-sky-600 text-white p-5 sm:p-6 text-center shadow-xl">
                <div className="absolute -top-6 -right-6 w-32 h-32 bg-white/20 rounded-full blur-2xl pointer-events-none" />
                <div className="relative">
                  <div className="text-5xl sm:text-6xl mb-2 drop-shadow-lg">⭐</div>
                  <div className="text-4xl sm:text-5xl font-black leading-none">{votingNominations}</div>
                  <div className="text-[10px] sm:text-xs uppercase tracking-widest font-bold opacity-90 mt-1.5">Nominations</div>
                </div>
              </div>
            </div>

            {allPlayerVotings.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-lg font-black text-gray-900 px-1">Vote History</h2>
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
                          : 'bg-white ring-1 ring-gray-100'
                      }`}
                    >
                      {isWin && (
                        <div className="absolute -top-8 -right-8 w-32 h-32 bg-amber-300/30 rounded-full blur-2xl pointer-events-none" />
                      )}
                      <div className="relative p-4 sm:p-5">
                        <div className="flex items-start gap-3">
                          <div className={`flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-md ${
                            isWin ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-white' : 'bg-gray-100'
                          }`}>
                            {isWin ? '🏆' : '⭐'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-bold text-gray-900 truncate">{voting.gameTitle}</p>
                              {isWin && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500 text-white">
                                  {isCoWin ? `Co-Winner ×${voting.winners!.length}` : 'Winner'}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 font-medium mt-0.5">
                              {voting.gameDate instanceof Date ? formatDate(voting.gameDate) : ''}
                              {' · '}
                              <span className={isWin ? 'text-amber-700' : ''}>{playerVotes.length} vote{playerVotes.length !== 1 ? 's' : ''}</span>
                            </p>
                          </div>
                        </div>
                        {reasons.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {reasons.map((v, i) => (
                              <div key={i} className={`rounded-xl px-3 py-2.5 ${isWin ? 'bg-white/70' : 'bg-gray-50'}`}>
                                <p className="text-sm text-gray-800 italic font-medium">"{v.reason}"</p>
                                <p className="text-xs text-gray-500 mt-1 font-semibold">— {v.voterName}</p>
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
              <div className="text-center py-12 bg-white rounded-2xl shadow-sm ring-1 ring-gray-100">
                <div className="text-5xl mb-3">🏆</div>
                <h3 className="text-lg font-bold text-gray-900">No Awards Yet</h3>
                <p className="text-gray-500 text-sm mt-1">Player of the Match wins will land here.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Equipment Edit Modal ────────────────────────────────── */}
      {juggleOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setJuggleOpen(false)}>
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Log a juggle attempt</h3>
              <p className="text-xs text-slate-500 mt-0.5">Best wins so far: <b className="text-slate-700">{((player as any).juggles?.best) ?? 0}</b></p>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">How many juggles?</label>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={juggleDraft}
                  onChange={(e) => setJuggleDraft(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-3 text-2xl font-black text-center border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                  placeholder="0"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => setJuggleOpen(false)} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg">
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
                  try {
                    await updateDocument('players', player.id, { juggles: next, updatedAt: new Date() });
                    (player as any).juggles = next;
                    setJuggleOpen(false);
                  } catch (err) {
                    console.error('save juggle failed', err);
                    alert('Save failed — try again.');
                  }
                }}
                className="px-4 py-2 text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {equipEditOpen && equipDraft && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEquipEditOpen(false)}>
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Team gear — {player.name}</h3>
              <button onClick={() => setEquipEditOpen(false)} className="text-slate-400 hover:text-slate-700">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['jerseyHomeSize', 'Jersey (home)'],
                  ['jerseyAwaySize', 'Jersey (away)'],
                  ['shortsSize', 'Shorts'],
                  ['socksSize', 'Socks'],
                  ['trainingTopSize', 'Training top'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">{label}</label>
                    <input
                      type="text"
                      value={equipDraft[key]}
                      onChange={(e) => setEquipDraft({ ...equipDraft, [key]: e.target.value })}
                      placeholder="YM / AS / etc."
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                    />
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Notes</label>
                <textarea
                  value={equipDraft.notes}
                  onChange={(e) => setEquipDraft({ ...equipDraft, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={equipDraft.returned}
                  onChange={(e) => setEquipDraft({ ...equipDraft, returned: e.target.checked })}
                />
                <span>Gear returned (end of season)</span>
              </label>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2">
              <button
                onClick={async () => {
                  if (!window.confirm('Clear all equipment fields? Use this between seasons after gear is returned.')) return;
                  try {
                    await updateDocument('players', player.id, { equipment: null, updatedAt: new Date() });
                    setEquipEditOpen(false);
                    // Optimistic refresh — set local player.equipment to undefined
                    (player as any).equipment = undefined;
                  } catch (err) {
                    console.error('clear equipment failed', err);
                    alert('Clear failed — try again.');
                  }
                }}
                className="text-xs font-bold uppercase tracking-widest text-rose-600 hover:text-rose-800"
              >
                Reset for next season
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => setEquipEditOpen(false)} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg">
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    try {
                      const next: any = {
                        ...(player as any).equipment,
                        jerseyHomeSize: equipDraft.jerseyHomeSize || null,
                        jerseyAwaySize: equipDraft.jerseyAwaySize || null,
                        shortsSize: equipDraft.shortsSize || null,
                        socksSize: equipDraft.socksSize || null,
                        trainingTopSize: equipDraft.trainingTopSize || null,
                        notes: equipDraft.notes || null,
                        returned: equipDraft.returned,
                        issuedAt: ((player as any).equipment?.issuedAt) || new Date(),
                        returnedAt: equipDraft.returned ? new Date() : null,
                      };
                      await updateDocument('players', player.id, { equipment: next, updatedAt: new Date() });
                      (player as any).equipment = next;
                      setEquipEditOpen(false);
                    } catch (err) {
                      console.error('save equipment failed', err);
                      alert('Save failed — try again.');
                    }
                  }}
                  className="px-4 py-2 text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg"
                >
                  Save
                </button>
              </div>
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
                  <span key={tag} className="px-2 py-0.5 bg-white/20 text-white rounded text-xs">{tag}</span>
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
                className="flex items-center space-x-1.5 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                <span>Share</span>
              </button>
              <button
                onClick={() => handleDownload(lightboxItem)}
                disabled={downloading}
                className="flex items-center space-x-1.5 px-4 py-2 bg-white/10 hover:bg-white/20 disabled:bg-white/10 disabled:cursor-wait text-white rounded-lg text-sm font-medium transition-colors"
              >
                {downloading ? (
                  <>
                    <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
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
  const { userData } = useAuth();
  const { updateDevelopmentPlan } = useFirestore();
  const progress = getProgressPercent(plan);

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
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full p-4 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span>{getCategoryIcon(plan.category)}</span>
            <span className="font-medium text-gray-900">{plan.title}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs ${getCategoryColor(plan.category)}`}>{plan.category}</span>
          </div>
          <div className="flex items-center space-x-3">
            <span className="text-sm font-medium text-gray-600">{progress}%</span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
          </div>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-1.5 mt-3">
          <div className={`h-1.5 rounded-full transition-all ${plan.status === 'completed' ? 'bg-emerald-500' : 'bg-cyan-500'}`} style={{ width: `${progress}%` }} />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4">
          {plan.description && <p className="text-sm text-gray-600 mt-3 mb-3">{plan.description}</p>}
          <div className="space-y-2">
            {plan.goals.map(goal => {
              const logs = goal.practiceLog || [];
              const totalMins = logs.reduce((s: number, e: any) => s + (e.minutes || 0), 0);
              const hours = Math.floor(totalMins / 60);
              const mins = totalMins % 60;
              return (
              <div key={goal.id} className="p-2 rounded-lg bg-gray-50">
                <div className="flex items-start space-x-3">
                <div className="mt-0.5">
                  {goal.coachVerified ? (
                    <span className="text-green-500 text-lg">✅</span>
                  ) : goal.playerCompleted ? (
                    <span className="text-yellow-500 text-lg">⏳</span>
                  ) : (
                    <span className="text-gray-300 text-lg">○</span>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <p className={`text-sm font-medium ${goal.coachVerified ? 'text-emerald-700 line-through' : 'text-gray-900'}`}>{goal.title}</p>
                    {totalMins > 0 && (
                      <span className="text-xs font-medium text-cyan-600 bg-cyan-50 px-2 py-0.5 rounded-full">
                        ⏱️ {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
                      </span>
                    )}
                  </div>
                  {goal.description && <p className="text-xs text-gray-500 mt-0.5">{goal.description}</p>}
                  {goal.notes && <p className="text-xs text-cyan-600 mt-1 italic">Coach: {goal.notes}</p>}
                  <div className="flex gap-2 mt-1">
                    {goal.playerCompleted && <span className="text-[10px] text-gray-400">Marked done by player</span>}
                    {goal.coachVerified && goal.coachVerifiedByName && <span className="text-[10px] text-emerald-600">Verified by {goal.coachVerifiedByName}</span>}
                  </div>

                  {/* Practice Log entries */}
                  {logs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Practice Log</p>
                      {logs.slice().reverse().slice(0, showAllLogs === goal.id ? undefined : 3).map((entry: any) => (
                        <div key={entry.id} className="text-xs text-gray-600 bg-white rounded px-2 py-1 border border-gray-100">
                          <span className="text-gray-400">
                            {entry.date?.toDate ? entry.date.toDate().toLocaleDateString() : new Date(entry.date).toLocaleDateString()}
                          </span>
                          {entry.minutes && <span className="text-cyan-600 font-medium ml-1">({entry.minutes} min)</span>}
                          {' — '}{entry.note}
                          {entry.loggedByName && <span className="text-gray-400 ml-1">— {entry.loggedByName}</span>}
                        </div>
                      ))}
                      {logs.length > 3 && showAllLogs !== goal.id && (
                        <button onClick={() => setShowAllLogs(goal.id)} className="text-xs text-cyan-600 hover:text-cyan-700">
                          Show all {logs.length} entries
                        </button>
                      )}
                      {showAllLogs === goal.id && logs.length > 3 && (
                        <button onClick={() => setShowAllLogs(null)} className="text-xs text-gray-500 hover:text-gray-700">
                          Show less
                        </button>
                      )}
                    </div>
                  )}

                  {/* Log Practice button */}
                  {plan.status === 'active' && !goal.coachVerified && (
                    <div className="mt-2">
                      {logGoalId === goal.id ? (
                        <div className="bg-cyan-50 border border-cyan-100 rounded-lg p-3 space-y-2">
                          <p className="text-xs font-medium text-cyan-700">Log a practice session</p>
                          <input
                            type="text"
                            value={logNote}
                            onChange={e => setLogNote(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSubmitLog(); }}
                            className="w-full text-sm px-3 py-2 border border-cyan-100 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                            placeholder="What did you work on?"
                            autoFocus
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600 whitespace-nowrap">Duration:</span>
                            <input
                              type="number"
                              value={logMinutes}
                              onChange={e => setLogMinutes(e.target.value)}
                              className="flex-1 min-w-0 text-sm px-2 py-1.5 border border-cyan-100 rounded-lg focus:ring-2 focus:ring-cyan-500"
                              placeholder="Min"
                              min="1"
                            />
                            <span className="text-xs text-gray-500 whitespace-nowrap">min</span>
                          </div>
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button onClick={() => { setLogGoalId(null); setLogNote(''); setLogMinutes(''); }} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
                            <button onClick={handleSubmitLog} disabled={!logNote.trim()} className="text-sm bg-cyan-600 text-white px-4 py-1.5 rounded-lg hover:bg-cyan-700 disabled:opacity-50 font-medium">Save</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setLogGoalId(goal.id)}
                          className="inline-flex items-center space-x-1.5 text-sm bg-cyan-50 text-cyan-700 hover:bg-cyan-50 px-3 py-1.5 rounded-lg font-medium transition-colors border border-cyan-100"
                        >
                          <span>📝</span>
                          <span>Log Practice</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
                </div>
              </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-400 mt-3">Created by {plan.createdByName} • {formatDate(plan.createdAt)}</p>
        </div>
      )}
    </div>
  );
};

// Tiny label/value pair used by the equipment card. Kept inline since
// it's only used in one place and isn't worth a separate file.
const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    <div className="text-sm font-semibold text-slate-900">{value}</div>
  </div>
);

export default PlayerProfile;
