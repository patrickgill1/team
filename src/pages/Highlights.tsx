import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, PlayerMedia as PlayerMediaType } from '../types';
import { formatDate } from '../utils/helpers';

const ACTIVITY_TAGS = ['Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];

const Highlights: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const { getDocuments, getPlayerMediaByTeam } = useFirestore();
  const [searchParams, setSearchParams] = useSearchParams();

  const [players, setPlayers] = useState<Player[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [loading, setLoading] = useState(true);
  const [playerFilter, setPlayerFilter] = useState<string>(searchParams.get('player') || 'all');
  const [tagFilter, setTagFilter] = useState<string>(searchParams.get('tag') || 'all');
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!selectedTeamId) { setLoading(false); return; }
      setLoading(true);
      try {
        const [playersData, mediaData] = await Promise.all([
          getDocuments('players', []),
          getPlayerMediaByTeam(selectedTeamId),
        ]);
        if (cancelled) return;
        setPlayers((playersData as Player[]).filter(p => p.teamId === selectedTeamId));
        // Only videos. Filter out anything missing a URL.
        const videos = (mediaData as PlayerMediaType[]).filter(m => m.type === 'video' && m.url);
        setMedia(videos);
        setIndex(0);
      } catch (e) {
        console.error('[Highlights] load failed', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments, getPlayerMediaByTeam]);

  // Filtered list (recompute when filters change)
  const filtered = useMemo(() => {
    return media.filter(m => {
      if (playerFilter !== 'all' && m.playerId !== playerFilter) return false;
      if (tagFilter !== 'all') {
        if (!m.tags || !m.tags.includes(tagFilter)) return false;
      }
      return true;
    });
  }, [media, playerFilter, tagFilter]);

  // When filter changes, reset index
  useEffect(() => { setIndex(0); }, [playerFilter, tagFilter]);

  // Sync URL with filters
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (playerFilter === 'all') next.delete('player'); else next.set('player', playerFilter);
    if (tagFilter === 'all') next.delete('tag'); else next.set('tag', tagFilter);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerFilter, tagFilter]);

  const current = filtered[index];

  // Auto-play on switch
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !current) return;
    v.muted = muted;
    if (isPlaying) {
      v.play().catch(() => { /* autoplay blocked */ });
    }
  }, [current, isPlaying, muted]);

  const goNext = () => {
    if (filtered.length === 0) return;
    setIndex(i => (i + 1) % filtered.length);
  };
  const goPrev = () => {
    if (filtered.length === 0) return;
    setIndex(i => (i - 1 + filtered.length) % filtered.length);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  };

  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  };

  const share = async () => {
    if (!current) return;
    const url = `${window.location.origin}/player-media?id=${current.id}`;
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: `${current.playerName} highlight`, text: current.caption || '', url });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied!');
      }
    } catch { /* user cancelled */ }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="text-white text-lg">Loading highlight reel…</div>
      </div>
    );
  }

  if (!selectedTeamId) {
    return (
      <div className="p-6 text-center text-gray-600">Select a team to see highlights.</div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Filters */}
      <div className="px-4 pt-4 pb-3 flex flex-wrap items-center gap-2 bg-gradient-to-b from-black/90 to-transparent">
        <h1 className="text-xl font-bold mr-auto">🎬 Highlight Reel</h1>
        <select
          value={playerFilter}
          onChange={e => setPlayerFilter(e.target.value)}
          className="bg-white/10 border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/50"
        >
          <option value="all" className="text-black">All players</option>
          {players
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(p => (
              <option key={p.id} value={p.id} className="text-black">
                #{p.jerseyNumber} {p.name}
              </option>
            ))}
        </select>
        <select
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          className="bg-white/10 border border-white/20 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/50"
        >
          <option value="all" className="text-black">All tags</option>
          {ACTIVITY_TAGS.map(t => (
            <option key={t} value={t} className="text-black">{t}</option>
          ))}
        </select>
        <Link to="/player-media" className="text-sm text-cyan-300 hover:text-cyan-100 underline ml-1">
          ← all media
        </Link>
      </div>

      {/* Reel area */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-5xl mb-3">🎥</div>
          <div className="text-lg font-semibold mb-1">No video highlights yet</div>
          <div className="text-white/60 text-sm max-w-sm">
            {playerFilter !== 'all' || tagFilter !== 'all'
              ? 'Try removing filters, or upload some clips on the Media page.'
              : 'Upload some clips on the Media page to start your highlight reel.'}
          </div>
          <Link to="/player-media" className="mt-4 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium">
            Go to Media
          </Link>
        </div>
      ) : (
        <div className="relative max-w-3xl mx-auto px-3 py-3">
          <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl border border-white/10">
            <video
              key={current?.id}
              ref={videoRef}
              src={current?.url}
              poster={current?.thumbnailUrl}
              className="w-full max-h-[75vh] bg-black"
              autoPlay
              playsInline
              controls={false}
              onEnded={goNext}
              onClick={togglePlay}
            />

            {/* Top overlay: counter + progress */}
            <div className="absolute top-0 left-0 right-0 px-3 pt-2 pointer-events-none">
              <div className="flex items-center justify-between text-xs text-white/80 mb-1">
                <span>{index + 1} / {filtered.length}</span>
                <span>{current && current.createdAt ? formatDate(current.createdAt) : ''}</span>
              </div>
              <div className="flex gap-1">
                {filtered.map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-0.5 rounded ${i === index ? 'bg-white' : i < index ? 'bg-white/50' : 'bg-white/20'}`}
                  />
                ))}
              </div>
            </div>

            {/* Side tap zones for prev/next on mobile */}
            <button
              type="button"
              onClick={goPrev}
              className="absolute left-0 top-10 bottom-20 w-1/4 focus:outline-none"
              aria-label="Previous"
            />
            <button
              type="button"
              onClick={goNext}
              className="absolute right-0 top-10 bottom-20 w-1/4 focus:outline-none"
              aria-label="Next"
            />

            {/* Bottom overlay: title + tags */}
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-bold truncate">{current?.playerName}</div>
                  {current?.caption && (
                    <div className="text-sm text-white/90 line-clamp-2 mt-0.5">{current.caption}</div>
                  )}
                  {current?.tags && current.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {current.tags.map(t => (
                        <span key={t} className="px-2 py-0.5 bg-white/15 backdrop-blur rounded-full text-[11px] font-medium">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={toggleMute} className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur flex items-center justify-center" aria-label="Mute">
                    {muted ? '🔇' : '🔊'}
                  </button>
                  <button onClick={share} className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur flex items-center justify-center" aria-label="Share">
                    📤
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Desktop transport controls */}
          <div className="flex items-center justify-center gap-3 mt-3">
            <button onClick={goPrev} className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm">⏮ Prev</button>
            <button onClick={togglePlay} className="px-5 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-semibold">
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button onClick={goNext} className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm">Next ⏭</button>
          </div>

          {/* Up next strip */}
          {filtered.length > 1 && (
            <div className="mt-5">
              <div className="text-xs uppercase tracking-wide text-white/50 mb-2 px-1">Up next</div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {filtered.map((m, i) => {
                  if (i === index) return null;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setIndex(i)}
                      className="shrink-0 w-32 text-left bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg overflow-hidden"
                    >
                      <div className="aspect-video bg-black/60 flex items-center justify-center text-2xl">
                        {m.thumbnailUrl ? (
                          <img src={m.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                        ) : '🎬'}
                      </div>
                      <div className="px-2 py-1.5">
                        <div className="text-xs font-medium truncate">{m.playerName}</div>
                        {m.tags && m.tags[0] && (
                          <div className="text-[10px] text-white/60 truncate">{m.tags.join(' · ')}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Highlights;
