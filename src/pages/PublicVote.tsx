import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { doc, onSnapshot, collection, getDocs, query, where, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { Player } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Vote {
  voterId: string;
  voterName: string;
  playerId: string;
  playerName: string;
  reason?: string;
  timestamp: Date;
  isPublicVote?: boolean;
}

interface MatchVoting {
  id: string;
  gameTitle: string;
  gameDate: any;
  isActive: boolean;
  votes: Vote[];
  winner?: { playerId: string; playerName: string; voteCount: number };
  winners?: Array<{ playerId: string; playerName: string; voteCount: number }>;
  teamId: string;
  location?: string;
  opponent?: string;
  homeAway?: 'home' | 'away';
  eligiblePlayerIds?: string[];
}

// ─── localStorage helpers ─────────────────────────────────────────────────────
const VOTER_TOKEN_KEY = 'potm_voter_token';
const VOTED_SESSIONS_KEY = 'potm_voted_sessions';

const getVoterToken = (): string => {
  let token = localStorage.getItem(VOTER_TOKEN_KEY);
  if (!token) {
    token = `anon_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    localStorage.setItem(VOTER_TOKEN_KEY, token);
  }
  return token;
};

const hasVotedInSession = (id: string): boolean => {
  const voted = JSON.parse(localStorage.getItem(VOTED_SESSIONS_KEY) || '[]');
  return voted.includes(id);
};

const markSessionAsVoted = (id: string) => {
  const voted = JSON.parse(localStorage.getItem(VOTED_SESSIONS_KEY) || '[]');
  voted.push(id);
  localStorage.setItem(VOTED_SESSIONS_KEY, JSON.stringify(voted));
};

// ─── Confetti ─────────────────────────────────────────────────────────────────
interface ConfettiParticle {
  x: number; y: number; vx: number; vy: number;
  color: string; size: number; angle: number; spin: number; alpha: number;
}

const CONFETTI_COLORS = ['#159BE3','#0d7bc4','#ffffff','#000000','#38bdf8','#7dd3fc','#bae6fd'];

const ConfettiCanvas: React.FC<{ active: boolean }> = React.memo(({ active }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<ConfettiParticle[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    // Render at 1x DPR — confetti is in motion, the pixelation isn't visible,
    // and 2x DPR quadruples per-frame pixel work which causes mobile chop.
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const COUNT = w < 640 ? 60 : 90;
    particles.current = [];
    for (let i = 0; i < COUNT; i++) {
      particles.current.push({
        x: w / 2 + (Math.random() - 0.5) * 240,
        y: h * 0.55,
        vx: (Math.random() - 0.5) * 18,
        vy: -Math.random() * 22 - 6,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        size: Math.random() * 8 + 4,
        angle: Math.random() * 360,
        spin: (Math.random() - 0.5) * 12,
        alpha: 1,
      });
    }

    const DEG2RAD = Math.PI / 180;
    const animate = () => {
      ctx.clearRect(0, 0, w, h);
      const arr = particles.current;
      let writeIdx = 0;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        p.x += p.vx;
        p.vy += 0.65;
        p.y += p.vy;
        p.angle += p.spin;
        p.alpha -= 0.022;
        p.vx *= 0.99;
        if (p.alpha <= 0.02 || p.y > h + 40) continue;
        // setTransform avoids the save/restore overhead per particle.
        const rad = p.angle * DEG2RAD;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        ctx.setTransform(cos, sin, -sin, cos, p.x, p.y);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        arr[writeIdx++] = p;
      }
      arr.length = writeIdx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (writeIdx > 0) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        ctx.clearRect(0, 0, w, h);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(rafRef.current); particles.current = []; };
  }, [active]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 9999,
      }}
    />
  );
});

// ─── Animated progress bar ────────────────────────────────────────────────────
const AnimatedBar: React.FC<{ percentage: number; isLeader: boolean }> = ({ percentage, isLeader }) => {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth(percentage), 80);
    return () => clearTimeout(t);
  }, [percentage]);
  return (
    <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
      <div
        className={`h-2 rounded-full transition-all duration-700 ease-out ${
          isLeader ? 'bg-[#159BE3]' : 'bg-gray-300'
        }`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
};

// ─── Position badge ───────────────────────────────────────────────────────────
const PositionBadge: React.FC<{ position?: string }> = ({ position }) => {
  if (!position) return null;
  const colours: Record<string, string> = {
    Goalkeeper: 'bg-amber-50 text-amber-700 border border-amber-200',
    Defender: 'bg-[#f0f9ff] text-[#159BE3] border border-[#159BE3] border-opacity-30',
    Midfielder: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    Forward: 'bg-red-50 text-red-600 border border-red-200',
    Striker: 'bg-red-50 text-red-600 border border-red-200',
    Winger: 'bg-orange-50 text-orange-600 border border-orange-200',
  };
  const colour = colours[position] || 'bg-gray-50 text-gray-600 border border-gray-200';
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${colour}`}>
      {position}
    </span>
  );
};

const PublicVote: React.FC = () => {
  const { votingId } = useParams<{ votingId: string }>();
  const [voting, setVoting] = useState<MatchVoting | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [myChildId, setMyChildId] = useState<string>('');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('');
  const [voteReason, setVoteReason] = useState<string>('');
  const [voterName, setVoterName] = useState<string>(() => localStorage.getItem('potm_voter_name') || '');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'identify' | 'vote' | 'results'>('identify');
  const [alreadyVoted, setAlreadyVoted] = useState(false);

  // ── Real-time listener ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!votingId) return;
    setLoading(true);
    const unsub = onSnapshot(
      doc(db, 'match_votings', votingId),
      (snap) => {
        if (!snap.exists()) {
          setError('This voting session could not be found or may have expired.');
          setLoading(false);
          return;
        }
        const data = snap.data();
        console.log('[PublicVote] voting data:', JSON.stringify({ eligiblePlayerIds: data.eligiblePlayerIds, id: snap.id }));
        const updated: MatchVoting = {
          id: snap.id,
          gameTitle: data.gameTitle,
          gameDate: data.gameDate?.toDate ? data.gameDate.toDate() : new Date(data.gameDate),
          isActive: data.isActive,
          votes: data.votes || [],
          winner: data.winner,
          teamId: data.teamId,
          location: data.location,
          opponent: data.opponent,
          homeAway: data.homeAway,
          eligiblePlayerIds: data.eligiblePlayerIds,
        };
        setVoting(updated);
        const voterToken = getVoterToken();
        const deviceVoted = (data.votes || []).some((v: Vote) => v.voterId === voterToken);
        const localVoted = hasVotedInSession(votingId);
        if (deviceVoted || localVoted) {
          setAlreadyVoted(true);
          setStep('results');
        } else if (!data.isActive) {
          setStep('results');
        }
        setLoading(false);
      },
      (err) => {
        console.error('Error loading voting data:', err);
        setError('Failed to load the voting session. Please try again.');
        setLoading(false);
      }
    );
    return () => unsub();
  }, [votingId]);

  // ── Load players once teamId is known (includes shared players) ──────────
  useEffect(() => {
    if (!voting?.teamId || players.length > 0) return;
    (async () => {
      const q = query(
        collection(db, 'players'),
        where('isActive', '==', true)
      );
      const snap = await getDocs(q);
      const teamId = voting.teamId;
      const sorted = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as Player))
        .filter(p => p.teamId === teamId || (p.teamIds && Array.isArray(p.teamIds) && p.teamIds.includes(teamId)))
        .sort((a, b) => (a.jerseyNumber || 999) - (b.jerseyNumber || 999));
      setPlayers(sorted);
    })();
  }, [voting?.teamId]);

  // \u2500\u2500 Handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const handleProceedToVote = () => {
    if (!voterName.trim()) { setError('Please enter your name.'); return; }
    if (!myChildId) { setError('Please select which player is your child.'); return; }
    // Check attendance eligibility
    if (voting?.eligiblePlayerIds && voting.eligiblePlayerIds.length > 0) {
      if (!voting.eligiblePlayerIds.includes(myChildId)) {
        setError('Your child was marked as absent for this match. Only parents of players who were present can vote.');
        return;
      }
    }
    setError(null);
    localStorage.setItem('potm_voter_name', voterName.trim());
    setStep('vote');
  };

  const handleSubmitVote = async () => {
    if (!voting || !selectedPlayerId || !votingId) return;
    const player = players.find(p => p.id === selectedPlayerId);
    if (!player) return;
    if (selectedPlayerId === myChildId) { setError("You cannot vote for your own child."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const voterToken = getVoterToken();
      const reason = voteReason.trim();
      const vote: Vote = {
        voterId: voterToken,
        voterName: voterName.trim() || 'Anonymous',
        playerId: selectedPlayerId,
        playerName: player.name,
        // Only include `reason` when set — Firestore rejects undefined in arrayUnion.
        ...(reason ? { reason } : {}),
        timestamp: new Date(),
        isPublicVote: true,
      } as Vote;
      await updateDoc(doc(db, 'match_votings', votingId), {
        votes: arrayUnion(vote),
      });
      markSessionAsVoted(votingId);
      setSubmitted(true);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2200);
      setStep('results');
    } catch (err: any) {
      console.error('Vote submission error:', err?.code, err?.message);
      setError('Failed to submit your vote. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const getVoteResults = useCallback(() => {
    if (!voting) return [];
    const counts: Record<string, { count: number; name: string; photoUrl?: string | null; position?: string }> = {};
    voting.votes.forEach(vote => {
      if (!counts[vote.playerId]) {
        const p = players.find(pl => pl.id === vote.playerId);
        counts[vote.playerId] = { count: 0, name: vote.playerName, photoUrl: p?.profilePhotoUrl, position: p?.position };
      }
      counts[vote.playerId].count++;
    });
    return Object.entries(counts)
      .map(([id, d]) => ({ playerId: id, ...d }))
      .sort((a, b) => b.count - a.count);
  }, [voting, players]);

  const getReasonsForPlayer = (playerId: string) =>
    (voting?.votes || []).filter(v => v.playerId === playerId && v.reason);

  const formatDate = (date: any) => {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  const votablePlayers = players.filter(p => {
    if (p.id === myChildId) return false;
    // Only show players marked as present (eligible)
    if (voting?.eligiblePlayerIds && voting.eligiblePlayerIds.length > 0) {
      return voting.eligiblePlayerIds.includes(p.id);
    }
    return true;
  });
  console.log('[PublicVote] filter:', JSON.stringify({
    totalPlayers: players.length,
    votable: votablePlayers.length,
    eligible: voting?.eligiblePlayerIds?.length,
    myChildId,
    allPlayerNames: players.map(p => p.name + '=' + p.id),
    votableNames: votablePlayers.map(p => p.name),
    filteredOut: players.filter(p => p.id !== myChildId && voting?.eligiblePlayerIds?.length && !voting.eligiblePlayerIds.includes(p.id)).map(p => p.name + '=' + p.id),
  }));
  const results = getVoteResults();
  const totalVotes = voting?.votes.length || 0;

  // \u2500\u2500 Loading / Error \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (loading) {
    return (
      <div className="min-h-screen bg-[#f0f4f8] flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#159BE3] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (error && !voting) {
    return (
      <div className="min-h-screen bg-[#f0f4f8] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full text-center border border-gray-100">
          <div className="w-14 h-14 rounded-full bg-[#f0f9ff] flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">🔥</span>
          </div>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Fire FC</p>
          <h1 className="text-xl font-black text-gray-900">Player of the Match</h1>
          <p className="text-red-500 mt-4 text-sm bg-red-50 border border-red-100 p-3 rounded-xl">{error}</p>
        </div>
      </div>
    );
  }

  // \u2500\u2500 Render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  return (
    <>
      <ConfettiCanvas active={showConfetti} />

      <div className="min-h-screen bg-[#f0f4f8] flex items-start justify-center p-4 pt-8 pb-16">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden border border-gray-100">

          {/* ── Header ── */}
          <div className="bg-black px-6 pt-8 pb-6 text-center relative overflow-hidden">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-72 h-28 bg-[#159BE3] opacity-10 rounded-full blur-3xl pointer-events-none" />
            <div className="relative">
              <div className="flex items-center justify-center gap-2 mb-4">
                <span className="text-[#159BE3] text-xl">🔥</span>
                <span className="text-white font-black text-lg tracking-[0.25em] uppercase">Fire FC</span>
              </div>
              <div className="h-px bg-gradient-to-r from-transparent via-[#159BE3] to-transparent mb-5" />
              <h1 className="text-white font-extrabold text-xl tracking-tight">Player of the Match</h1>
              {voting && (
                <>
                  <p className="text-gray-300 font-semibold mt-2 text-base">{voting.gameTitle}</p>
                  <p className="text-gray-500 text-sm mt-0.5">{formatDate(voting.gameDate)}</p>
                  <div className="flex flex-wrap justify-center gap-2 mt-4">
                    {voting.homeAway && (
                      <span className="bg-[#159BE3] bg-opacity-20 border border-[#159BE3] border-opacity-50 text-[#159BE3] text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                        {voting.homeAway === 'home' ? '🏠 Home' : '✈️ Away'}
                      </span>
                    )}
                    {voting.opponent && (
                      <span className="bg-white bg-opacity-10 border border-white border-opacity-20 text-gray-300 text-xs font-semibold px-3 py-1 rounded-full">
                        ⚔️ vs {voting.opponent}
                      </span>
                    )}
                    {voting.location && (
                      <span className="bg-white bg-opacity-10 border border-white border-opacity-20 text-gray-300 text-xs font-semibold px-3 py-1 rounded-full">
                        📍 {voting.location}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="p-6">
            {/* Closed banner */}
            {voting && !voting.isActive && (
              <div className="mb-5 rounded-xl overflow-hidden border border-gray-200">
                <div className="bg-gray-50 px-4 py-3 text-center">
                  <p className="text-gray-400 font-bold text-xs uppercase tracking-widest">Voting Closed</p>
                </div>
                {((voting.winners && voting.winners.length > 0) || voting.winner) && (
                  <div className="bg-[#f0f9ff] px-4 py-5 text-center border-t border-[#159BE3] border-opacity-20">
                    {voting.winners && voting.winners.length > 1 ? (
                      <>
                        <p className="text-[#159BE3] text-xs font-black uppercase tracking-widest mb-1">Co-Players of the Match</p>
                        <p className="text-xl font-black text-gray-900">🏆 {voting.winners.map(w => w.playerName).join(' · ')}</p>
                        <p className="text-gray-500 text-sm mt-1">{voting.winners[0].voteCount} vote{voting.winners[0].voteCount !== 1 ? 's' : ''} each</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[#159BE3] text-xs font-black uppercase tracking-widest mb-1">Winner</p>
                        <p className="text-2xl font-black text-gray-900">🏆 {(voting.winners?.[0] || voting.winner)!.playerName}</p>
                        <p className="text-gray-500 text-sm mt-1">{(voting.winners?.[0] || voting.winner)!.voteCount} vote{(voting.winners?.[0] || voting.winner)!.voteCount !== 1 ? 's' : ''}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Already voted */}
            {alreadyVoted && voting?.isActive && !submitted && (
              <div className="bg-[#f0f9ff] border border-[#159BE3] border-opacity-30 rounded-xl p-4 mb-5 text-center">
                <div className="text-3xl mb-1">✅</div>
                <p className="font-bold text-gray-900">You've already voted!</p>
                <p className="text-gray-500 text-sm mt-1">Your vote is locked in. Results will be revealed once voting closes.</p>
              </div>
            )}

            {/* Submitted */}
            {submitted && (
              <div className="bg-[#f0f9ff] border border-[#159BE3] border-opacity-40 rounded-xl p-5 mb-5 text-center">
                <div className="text-4xl mb-2">🎉</div>
                <p className="font-black text-gray-900 text-lg">Vote submitted!</p>
                <p className="text-gray-500 text-sm mt-1">Thanks, <strong>{voterName}</strong>! Results will be revealed once voting closes.</p>
              </div>
            )}

            {/* ── STEP 1: Identify ── */}
            {step === 'identify' && voting?.isActive && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Before you vote…</h2>
                  <p className="text-gray-400 text-sm">Two quick things and you're in.</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Your name <span className="text-[#159BE3]">*</span>
                  </label>
                  <input
                    type="text"
                    value={voterName}
                    onChange={e => setVoterName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleProceedToVote(); }}
                    placeholder="e.g. Sarah Jones"
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#159BE3] focus:border-transparent text-sm transition-shadow"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                    Your child on the team <span className="text-[#159BE3]">*</span>
                  </label>
                  <p className="text-xs text-gray-400 mb-2">They'll be excluded from your choices — keeping it fair.</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1 -mr-1">
                    {players.map(p => {
                      const isSelected = myChildId === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setMyChildId(p.id)}
                          className={`w-full flex items-center gap-3 p-2.5 rounded-xl border-2 transition-all duration-150 text-left ${
                            isSelected
                              ? 'border-[#159BE3] bg-[#f0f9ff] shadow-sm'
                              : 'border-gray-200 hover:border-[#159BE3] hover:border-opacity-40 hover:bg-gray-50'
                          }`}
                        >
                          {p.profilePhotoUrl ? (
                            <img
                              src={p.profilePhotoUrl}
                              alt={p.name}
                              className={`w-11 h-11 rounded-full object-cover flex-shrink-0 border-2 ${isSelected ? 'border-[#159BE3]' : 'border-gray-100'}`}
                            />
                          ) : (
                            <div className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm ${isSelected ? 'bg-[#159BE3]' : 'bg-gray-200'}`}>
                              <span className={`font-bold text-base ${isSelected ? 'text-white' : 'text-gray-500'}`}>
                                {p.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-gray-900 text-sm truncate">{p.name}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {p.jerseyNumber && (
                                <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full font-mono">
                                  #{p.jerseyNumber}
                                </span>
                              )}
                              {p.position && <PositionBadge position={p.position} />}
                            </div>
                          </div>
                          {isSelected && (
                            <div className="bg-[#159BE3] text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold flex-shrink-0">✓</div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {error && (
                  <p className="text-red-500 text-sm bg-red-50 border border-red-100 p-3 rounded-xl">{error}</p>
                )}

                <button
                  onClick={handleProceedToVote}
                  className="w-full bg-[#159BE3] hover:bg-[#1189cc] active:bg-[#0f78b5] text-white font-bold py-3.5 rounded-xl transition-colors duration-150 shadow-lg shadow-[#159BE3]/30 text-sm tracking-wide"
                >
                  Continue to Vote →
                </button>
              </div>
            )}

            {/* ── STEP 2: Vote ── */}
            {step === 'vote' && voting?.isActive && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Cast your vote</h2>
                  <p className="text-gray-400 text-sm">Who was the standout player? Your child is excluded.</p>
                  {voting.eligiblePlayerIds && voting.eligiblePlayerIds.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      {votablePlayers.length} eligible player{votablePlayers.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>

                {/* Player grid */}
                <div className="grid grid-cols-2 gap-3">
                  {votablePlayers.map(player => {
                    const isSelected = selectedPlayerId === player.id;
                    return (
                      <button
                        key={player.id}
                        onClick={() => setSelectedPlayerId(player.id)}
                        className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all duration-150 relative ${
                          isSelected
                            ? 'border-[#159BE3] bg-[#f0f9ff] shadow-md shadow-[#159BE3]/15'
                            : 'border-gray-200 hover:border-[#159BE3] hover:border-opacity-40 hover:bg-gray-50'
                        }`}
                      >
                        {isSelected && (
                          <div className="absolute top-2 right-2 bg-[#159BE3] text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">✓</div>
                        )}
                        {player.profilePhotoUrl ? (
                          <img
                            src={player.profilePhotoUrl}
                            alt={player.name}
                            className={`w-16 h-16 rounded-full object-cover mb-2 border-2 shadow-sm ${isSelected ? 'border-[#159BE3]' : 'border-gray-100'}`}
                          />
                        ) : (
                          <div className="w-16 h-16 rounded-full flex items-center justify-center mb-2 bg-[#159BE3] shadow-sm">
                            <span className="text-white font-black text-xl">
                              {player.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                        )}
                        <span className="font-bold text-gray-900 text-sm text-center leading-tight w-full">{player.name}</span>
                        <div className="flex flex-wrap justify-center gap-1 mt-1.5">
                          {player.jerseyNumber && (
                            <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full font-mono">
                              #{player.jerseyNumber}
                            </span>
                          )}
                          {player.position && <PositionBadge position={player.position} />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Reason textarea */}
                {selectedPlayerId && (
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                      Why did they stand out? <span className="text-gray-400 font-normal normal-case tracking-normal">(optional)</span>
                    </label>
                    <textarea
                      value={voteReason}
                      onChange={e => setVoteReason(e.target.value)}
                      rows={2}
                      placeholder="Great goal, fantastic defending, never gave up…"
                      className="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#159BE3] focus:border-transparent text-sm resize-none transition-shadow"
                    />
                  </div>
                )}

                {error && <p className="text-red-500 text-sm bg-red-50 border border-red-100 p-3 rounded-xl">{error}</p>}

                <div className="flex gap-3 pt-1">
                  <button
                    onClick={() => { setStep('identify'); setError(null); }}
                    className="px-4 py-3 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors text-sm font-semibold"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={handleSubmitVote}
                    disabled={!selectedPlayerId || submitting}
                    className="flex-1 bg-[#159BE3] hover:bg-[#1189cc] active:bg-[#0f78b5] text-white font-bold py-3 rounded-xl transition-colors duration-150 shadow-lg shadow-[#159BE3]/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none text-sm tracking-wide"
                  >
                    {submitting ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Submitting…
                      </span>
                    ) : '🏆 Submit Vote'}
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 3: Results (hidden while voting is active) ── */}
            {step === 'results' && voting?.isActive && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 text-center">
                <svg className="w-10 h-10 text-gray-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                </svg>
                <p className="font-bold text-gray-700">Results are hidden while voting is open</p>
                <p className="text-gray-500 text-sm mt-1">Check back once the coach closes voting to see the results!</p>
                <p className="text-gray-400 text-xs mt-3">{totalVotes} vote{totalVotes !== 1 ? 's' : ''} cast so far</p>
              </div>
            )}

            {step === 'results' && !voting?.isActive && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">Final Results</h2>
                </div>

                {results.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <div className="text-5xl mb-3">🗳️</div>
                    <p className="font-semibold">No votes yet</p>
                    <p className="text-sm mt-1">Be the first to vote!</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {results.map((result, index) => {
                      const percentage = totalVotes > 0 ? Math.round((result.count / totalVotes) * 100) : 0;
                      const medals = ['🥇', '🥈', '🥉'];
                      const isLeader = index === 0;
                      const reasons = getReasonsForPlayer(result.playerId);
                      return (
                        <div
                          key={result.playerId}
                          className={`rounded-xl border overflow-hidden ${
                            isLeader
                              ? 'border-[#159BE3] border-opacity-40 shadow-sm shadow-[#159BE3]/10'
                              : 'border-gray-200'
                          }`}
                        >
                          <div className={`p-3.5 ${isLeader ? 'bg-[#f0f9ff]' : 'bg-white'}`}>
                            <div className="flex items-center gap-3">
                              <span className="text-xl w-7 text-center flex-shrink-0">
                                {medals[index] || `${index + 1}.`}
                              </span>
                              {result.photoUrl ? (
                                <img
                                  src={result.photoUrl}
                                  alt={result.name}
                                  className="w-10 h-10 rounded-full object-cover flex-shrink-0 border-2 border-white shadow-sm"
                                />
                              ) : (
                                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-[#159BE3] shadow-sm">
                                  <span className="text-white font-bold text-sm">{result.name.charAt(0)}</span>
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="font-bold text-gray-900 truncate text-sm">{result.name}</p>
                                  {result.position && <PositionBadge position={result.position} />}
                                </div>
                                <div className="flex items-center gap-2 mt-1.5">
                                  <AnimatedBar percentage={percentage} isLeader={isLeader} />
                                  <span className="text-xs font-semibold whitespace-nowrap text-gray-500">
                                    {result.count} · {percentage}%
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Comments feed for this player */}
                          {reasons.length > 0 && (
                            <div className={`border-t px-3.5 py-2.5 space-y-1.5 ${
                              isLeader ? 'border-[#159BE3] border-opacity-20 bg-[#f7fbff]' : 'border-gray-100 bg-gray-50'
                            }`}>
                              {reasons.map((v, i) => (
                                <p key={i} className="text-xs text-gray-600 flex gap-1.5">
                                  <span className="flex-shrink-0 text-[#159BE3] font-bold">›</span>
                                  <span>
                                    <span className="font-semibold text-gray-700">{v.voterName}:</span> {v.reason}
                                  </span>
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <p className="text-center text-gray-400 text-xs mt-5">
                  {totalVotes} vote{totalVotes !== 1 ? 's' : ''} cast
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-6 py-3 flex items-center justify-center gap-2">
            <span className="text-[#159BE3] text-sm">🔥</span>
            <span className="text-xs text-gray-400 font-bold tracking-widest uppercase">Fire FC</span>
          </div>
        </div>
      </div>
    </>
  );
};

export default PublicVote;

