import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Player, PlayerMedia, DevelopmentPlan } from '../types';
import { isCoach, formatDate } from '../utils/helpers';
import { where } from 'firebase/firestore';

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
  const { getDocuments, getPlayerMediaByPlayer, getDevelopmentPlansByPlayer } = useFirestore();

  const [player, setPlayer] = useState<Player | null>(null);
  const [media, setMedia] = useState<PlayerMedia[]>([]);
  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [votingWins, setVotingWins] = useState<MatchVoting[]>([]);
  const [allPlayerVotings, setAllPlayerVotings] = useState<{ voting: MatchVoting; playerVotes: { voterName: string; reason?: string }[] }[]>([]);
  const [votingNominations, setVotingNominations] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'media' | 'development' | 'awards'>('overview');
  const [lightboxItem, setLightboxItem] = useState<PlayerMedia | null>(null);

  useEffect(() => {
    if (playerId && selectedTeamId) loadProfile();
  }, [playerId, selectedTeamId]);

  const loadProfile = async () => {
    if (!playerId || !selectedTeamId) return;
    setLoading(true);

    // Load player first (needed to render header)
    try {
      const playersData = await getDocuments('players', []);
      const found = playersData.find((p: any) => p.id === playerId) as any;
      if (found) {
        setPlayer({
          ...found,
          createdAt: found.createdAt?.toDate ? found.createdAt.toDate() : new Date(found.createdAt),
          dateOfBirth: found.dateOfBirth?.toDate ? found.dateOfBirth.toDate() : found.dateOfBirth ? new Date(found.dateOfBirth) : undefined,
        } as Player);
      }
    } catch (err) {
      console.error('Error loading player:', err);
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

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'technical': return 'bg-blue-100 text-blue-700';
      case 'tactical': return 'bg-purple-100 text-purple-700';
      case 'physical': return 'bg-orange-100 text-orange-700';
      case 'mental': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <h2 className="text-xl font-bold text-gray-900">Player Not Found</h2>
          <Link to="/players" className="text-blue-600 hover:underline mt-2 inline-block">← Back to Roster</Link>
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <Link to="/players" className="text-blue-200 hover:text-white text-sm mb-4 inline-block">← Back to Roster</Link>
          <div className="flex items-center space-x-6">
            <div className="relative">
              {player.profilePhotoUrl ? (
                <img src={player.profilePhotoUrl} alt={player.name} className="w-24 h-24 sm:w-28 sm:h-28 rounded-full object-cover border-4 border-white/30" />
              ) : (
                <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-white/20 flex items-center justify-center border-4 border-white/30">
                  <span className="text-3xl font-bold">{player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0)}</span>
                </div>
              )}
              {player.profilePhotoUrl && player.jerseyNumber != null && (
                <span className="absolute -bottom-1 -right-1 bg-white text-blue-700 rounded-full min-w-[28px] h-7 px-1.5 flex items-center justify-center text-xs font-black shadow-lg ring-2 ring-blue-700">
                  #{player.jerseyNumber}
                </span>
              )}
            </div>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold">{player.name}</h1>
              <div className="flex flex-wrap items-center gap-3 mt-2">
                {player.jerseyNumber && <span className="bg-white/20 px-3 py-1 rounded-full text-sm font-medium">#{player.jerseyNumber}</span>}
                {player.position && <span className="bg-white/20 px-3 py-1 rounded-full text-sm font-medium">{player.position}</span>}
                {age && <span className="text-blue-200 text-sm">Age {age}</span>}
              </div>
            </div>
          </div>

          {/* Quick Stats Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{player.stats?.goals || 0}</div>
              <div className="text-xs text-blue-200">Goals</div>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{player.stats?.assists || 0}</div>
              <div className="text-xs text-blue-200">Assists</div>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{votingWins.length}</div>
              <div className="text-xs text-blue-200">POTM Wins</div>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{media.length}</div>
              <div className="text-xs text-blue-200">Media</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex space-x-1 overflow-x-auto">
            {(['overview', 'media', 'development', 'awards'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab === 'overview' && '📊 Overview'}
                {tab === 'media' && `📸 Media (${media.length})`}
                {tab === 'development' && `📋 Development (${activePlans.length})`}
                {tab === 'awards' && `🏆 Awards (${votingWins.length})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">

        {/* ─── OVERVIEW TAB ──────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Season Stats</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">{player.stats?.gamesPlayed || 0}</div>
                  <div className="text-sm text-gray-600">Games</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{player.stats?.goals || 0}</div>
                  <div className="text-sm text-gray-600">Goals</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="text-2xl font-bold text-purple-600">{player.stats?.assists || 0}</div>
                  <div className="text-sm text-gray-600">Assists</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="text-2xl font-bold text-yellow-600">{player.stats?.saves || 0}</div>
                  <div className="text-sm text-gray-600">Saves</div>
                </div>
              </div>
            </div>

            {/* Development Summary */}
            {plans.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">Development Progress</h2>
                  <button onClick={() => setActiveTab('development')} className="text-sm text-blue-600 hover:underline">View All →</button>
                </div>

                {/* Effort hero — celebrate practice time */}
                {totalPracticeMinutes > 0 && (
                  <div className="bg-gradient-to-r from-orange-500 to-red-500 text-white rounded-xl p-4 mb-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs uppercase tracking-wide font-semibold opacity-90">🔥 Practice Effort</div>
                        <div className="text-3xl font-bold mt-1">{formatMinutes(totalPracticeMinutes)}</div>
                        <div className="text-xs opacity-90 mt-0.5">across {totalPracticeSessions} session{totalPracticeSessions === 1 ? '' : 's'}</div>
                      </div>
                      <div className="text-5xl">💪</div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <div className="text-center p-3 bg-blue-50 rounded-lg">
                    <div className="text-2xl font-bold text-blue-600">{activePlans.length}</div>
                    <div className="text-xs text-gray-600">Active Plans</div>
                  </div>
                  <div className="text-center p-3 bg-green-50 rounded-lg">
                    <div className="text-2xl font-bold text-green-600">{completedPlans.length}</div>
                    <div className="text-xs text-gray-600">Completed</div>
                  </div>
                  <div className="text-center p-3 bg-yellow-50 rounded-lg">
                    <div className="text-2xl font-bold text-yellow-600">{playerCompletedGoals}/{totalGoalsInPlans}</div>
                    <div className="text-xs text-gray-600">Goals Done</div>
                  </div>
                  <div className="text-center p-3 bg-gray-50 rounded-lg">
                    <div className="text-2xl font-bold text-gray-700">{totalGoalsInPlans > 0 ? Math.round((verifiedGoals / totalGoalsInPlans) * 100) : 0}%</div>
                    <div className="text-xs text-gray-600">Coach Verified</div>
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
                    <div key={plan.id} className="border border-gray-100 rounded-lg p-3 mb-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center space-x-2">
                          <span>{getCategoryIcon(plan.category)}</span>
                          <span className="font-medium text-sm text-gray-900">{plan.title}</span>
                          <span className={`px-2 py-0.5 rounded-full text-xs ${getCategoryColor(plan.category)}`}>{plan.category}</span>
                        </div>
                        {planMins > 0 && (
                          <span className="text-xs font-semibold text-orange-600">🔥 {formatMinutes(planMins)}{planTarget > 0 ? ` / ${formatMinutes(planTarget)}` : ''}</span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1.5">
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-500">
                            <span>Player</span><span>{playerPct}%</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-1.5">
                            <div className="bg-yellow-400 h-1.5 rounded-full transition-all" style={{ width: `${playerPct}%` }} />
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-500">
                            <span>Coach Verified</span><span>{verified}%</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-1.5">
                            <div className={`h-1.5 rounded-full transition-all ${verified === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${verified}%` }} />
                          </div>
                        </div>
                        {planTarget > 0 && (
                          <div>
                            <div className="flex justify-between text-[10px] text-gray-500">
                              <span>🔥 Practice Minutes</span><span>{Math.min(100, Math.round((planMins / planTarget) * 100))}%</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                              <div className="bg-orange-500 h-1.5 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round((planMins / planTarget) * 100))}%` }} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recent Media */}
            {recentMedia.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">Recent Media</h2>
                  <button onClick={() => setActiveTab('media')} className="text-sm text-blue-600 hover:underline">View All →</button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {recentMedia.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLightboxItem(item)}
                      className="aspect-square bg-gray-100 rounded-lg overflow-hidden relative group"
                    >
                      {item.type === 'video' ? (
                        <>
                          {item.thumbnailUrl ? (
                            <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <video
                              src={`${item.url}#t=0.5`}
                              className="w-full h-full object-cover bg-gray-800"
                              preload="metadata"
                              muted
                              playsInline
                            />
                          )}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-8 h-8 bg-black/60 rounded-full flex items-center justify-center">
                              <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                            </div>
                          </div>
                        </>
                      ) : (
                        <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover" loading="lazy" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Awards */}
            {votingWins.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">Player of the Match</h2>
                  <button onClick={() => setActiveTab('awards')} className="text-sm text-blue-600 hover:underline">View All →</button>
                </div>
                <div className="flex items-center space-x-4 text-center mb-4">
                  <div className="bg-yellow-50 rounded-lg p-3 flex-1">
                    <div className="text-2xl font-bold text-yellow-600">🏆 {votingWins.length}</div>
                    <div className="text-xs text-gray-600">Wins</div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3 flex-1">
                    <div className="text-2xl font-bold text-blue-600">{votingNominations}</div>
                    <div className="text-xs text-gray-600">Times Nominated</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── MEDIA TAB ─────────────────────────────────────────── */}
        {activeTab === 'media' && (
          <div>
            {media.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {media.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLightboxItem(item)}
                    className="group relative aspect-square bg-gray-100 rounded-lg overflow-hidden text-left"
                  >
                    {item.type === 'video' ? (
                      <>
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <video
                            src={`${item.url}#t=0.5`}
                            className="w-full h-full object-cover bg-gray-800"
                            preload="metadata"
                            muted
                            playsInline
                          />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-10 h-10 bg-black/60 rounded-full flex items-center justify-center">
                            <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                          </div>
                        </div>
                      </>
                    ) : (
                      <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover" loading="lazy" />
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent pt-4 pb-2 px-2">
                      {item.caption && <p className="text-white text-xs truncate">{item.caption}</p>}
                      <div className="flex items-center space-x-2 mt-1">
                        {item.likeCount ? <span className="text-white/80 text-xs">❤️ {item.likeCount}</span> : null}
                        {item.tags && item.tags.length > 0 && (
                          <div className="flex gap-0.5">
                            {item.tags.slice(0, 2).map(tag => (
                              <span key={tag} className="px-1.5 py-0.5 bg-white/20 text-white rounded text-[9px]">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                <div className="text-5xl mb-4">📸</div>
                <h3 className="text-lg font-medium text-gray-900">No Media Yet</h3>
                <p className="text-gray-500 text-sm mt-1">Photos and videos will appear here.</p>
                <Link to="/player-media" className="text-blue-600 hover:underline text-sm mt-3 inline-block">Go to Gallery →</Link>
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
                    <h2 className="text-lg font-bold text-gray-900">Active Plans</h2>
                    {activePlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
                {completedPlans.length > 0 && (
                  <>
                    <h2 className="text-lg font-bold text-gray-900 mt-6">✅ Completed Plans</h2>
                    {completedPlans.map(plan => (
                      <PlanDetail key={plan.id} plan={plan} getCategoryColor={getCategoryColor} getCategoryIcon={getCategoryIcon} getProgressPercent={getProgressPercent} />
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                <div className="text-5xl mb-4">📋</div>
                <h3 className="text-lg font-medium text-gray-900">No Development Plans</h3>
                <p className="text-gray-500 text-sm mt-1">Development plans from coaches will show here.</p>
                <Link to="/development" className="text-blue-600 hover:underline text-sm mt-3 inline-block">Go to Development →</Link>
              </div>
            )}
          </div>
        )}

        {/* ─── AWARDS TAB ────────────────────────────────────────── */}
        {activeTab === 'awards' && (
          <div>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
                <div className="text-4xl mb-2">🏆</div>
                <div className="text-3xl font-bold text-yellow-600">{votingWins.length}</div>
                <div className="text-sm text-gray-600">Player of the Match</div>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
                <div className="text-4xl mb-2">⭐</div>
                <div className="text-3xl font-bold text-blue-600">{votingNominations}</div>
                <div className="text-sm text-gray-600">Times Nominated</div>
              </div>
            </div>

            {allPlayerVotings.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-lg font-bold text-gray-900">Vote History</h2>
                {allPlayerVotings.map(({ voting, playerVotes }) => {
                  const isWin = voting.winners?.some(w => w.playerId === playerId) || voting.winner?.playerId === playerId;
                  const isCoWin = isWin && (voting.winners?.length || 0) > 1;
                  return (
                    <div key={voting.id} className={`bg-white rounded-xl border ${isWin ? 'border-yellow-300' : 'border-gray-200'} p-4`}>
                      <div className="flex items-center space-x-3">
                        <div className="text-2xl">{isWin ? '🏆' : '⭐'}</div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-gray-900">{voting.gameTitle}</p>
                            {isWin && <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-xs font-medium">{isCoWin ? `Co-Winner (×${voting.winners!.length})` : 'Winner'}</span>}
                          </div>
                          <p className="text-sm text-gray-500">{voting.gameDate instanceof Date ? formatDate(voting.gameDate) : ''} • {playerVotes.length} vote{playerVotes.length !== 1 ? 's' : ''}</p>
                        </div>
                      </div>
                      {playerVotes.some(v => v.reason) && (
                        <div className="mt-3 space-y-2 pl-10">
                          {playerVotes.filter(v => v.reason).map((v, i) => (
                            <div key={i} className="bg-gray-50 rounded-lg px-3 py-2">
                              <p className="text-sm text-gray-700 italic">"{v.reason}"</p>
                              <p className="text-xs text-gray-400 mt-0.5">— {v.voterName}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                <div className="text-5xl mb-4">🏆</div>
                <h3 className="text-lg font-medium text-gray-900">No Awards Yet</h3>
                <p className="text-gray-500 text-sm mt-1">Player of the Match wins will appear here.</p>
              </div>
            )}
          </div>
        )}
      </div>

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
              <video
                src={lightboxItem.url}
                controls
                autoPlay
                playsInline
                className="max-w-full max-h-[80vh] rounded-lg"
              />
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
                  const shareUrl = `${window.location.origin}/media/${encodeURIComponent(lightboxItem.id.replace(/^gallery_/, ''))}`;
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
              <a
                href={lightboxItem.url}
                download={lightboxItem.fileName || `${lightboxItem.playerName}-${lightboxItem.type}.${lightboxItem.type === 'video' ? 'mp4' : 'jpg'}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-1.5 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                <span>Download</span>
              </a>
            </div>
          </div>
        </div>
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
          <div className={`h-1.5 rounded-full transition-all ${plan.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }} />
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
                    <p className={`text-sm font-medium ${goal.coachVerified ? 'text-green-700 line-through' : 'text-gray-900'}`}>{goal.title}</p>
                    {totalMins > 0 && (
                      <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                        ⏱️ {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}
                      </span>
                    )}
                  </div>
                  {goal.description && <p className="text-xs text-gray-500 mt-0.5">{goal.description}</p>}
                  {goal.notes && <p className="text-xs text-blue-600 mt-1 italic">Coach: {goal.notes}</p>}
                  <div className="flex gap-2 mt-1">
                    {goal.playerCompleted && <span className="text-[10px] text-gray-400">Marked done by player</span>}
                    {goal.coachVerified && goal.coachVerifiedByName && <span className="text-[10px] text-green-600">Verified by {goal.coachVerifiedByName}</span>}
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
                          {entry.minutes && <span className="text-blue-600 font-medium ml-1">({entry.minutes} min)</span>}
                          {' — '}{entry.note}
                          {entry.loggedByName && <span className="text-gray-400 ml-1">— {entry.loggedByName}</span>}
                        </div>
                      ))}
                      {logs.length > 3 && showAllLogs !== goal.id && (
                        <button onClick={() => setShowAllLogs(goal.id)} className="text-xs text-blue-600 hover:text-blue-700">
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
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
                          <p className="text-xs font-medium text-blue-800">Log a practice session</p>
                          <input
                            type="text"
                            value={logNote}
                            onChange={e => setLogNote(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSubmitLog(); }}
                            className="w-full text-sm px-3 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            placeholder="What did you work on?"
                            autoFocus
                          />
                          <div className="flex items-center space-x-3">
                            <div className="flex items-center space-x-1">
                              <span className="text-xs text-gray-600">Duration:</span>
                              <input
                                type="number"
                                value={logMinutes}
                                onChange={e => setLogMinutes(e.target.value)}
                                className="w-20 text-sm px-2 py-1.5 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500"
                                placeholder="Min"
                                min="1"
                              />
                              <span className="text-xs text-gray-500">minutes</span>
                            </div>
                            <div className="flex-1" />
                            <button onClick={() => { setLogGoalId(null); setLogNote(''); setLogMinutes(''); }} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
                            <button onClick={handleSubmitLog} disabled={!logNote.trim()} className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">Save</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setLogGoalId(goal.id)}
                          className="inline-flex items-center space-x-1.5 text-sm bg-blue-50 text-blue-700 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium transition-colors border border-blue-200"
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

export default PlayerProfile;
