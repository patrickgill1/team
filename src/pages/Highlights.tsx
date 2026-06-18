import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player, PlayerMedia as PlayerMediaType } from '../types';
import { formatDate } from '../utils/helpers';
import StreamPlayer from '../components/common/StreamPlayer';
import { streamThumbnailUrl } from '../utils/streamUpload';
import { getShareOrigin } from '../utils/origin';

const ACTIVITY_TAGS = ['Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];

function posterFor(clip: PlayerMediaType): string | undefined {
  if (clip.streamUid) {
    return streamThumbnailUrl(clip.streamUid, {
      height: 1080,
      time: clip.posterTimeSeconds != null ? `${clip.posterTimeSeconds}s` : undefined,
    });
  }
  return clip.thumbnailUrl;
}

const Highlights: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const { getDocuments, getPlayerMediaByTeam } = useFirestore();
  const [searchParams, setSearchParams] = useSearchParams();

  const [players, setPlayers] = useState<Player[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [loading, setLoading] = useState(true);
  const [playerFilter, setPlayerFilter] = useState<string>(searchParams.get('player') || 'all');
  const [tagFilter, setTagFilter] = useState<string>(searchParams.get('tag') || 'all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(true);

  const reelRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Array<HTMLElement | null>>([]);

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
        const videos = (mediaData as PlayerMediaType[]).filter(m => m.type === 'video' && m.url);
        setMedia(videos);
        setActiveIndex(0);
      } catch (e) {
        console.error('[Highlights] load failed', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments, getPlayerMediaByTeam]);

  const filtered = useMemo(() => {
    return media.filter(m => {
      if (playerFilter !== 'all' && m.playerId !== playerFilter) return false;
      if (tagFilter !== 'all') {
        if (!m.tags || !m.tags.includes(tagFilter)) return false;
      }
      return true;
    });
  }, [media, playerFilter, tagFilter]);

  // Reset to top whenever filters change
  useEffect(() => {
    setActiveIndex(0);
    reelRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [playerFilter, tagFilter]);

  // Sync URL with filters
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (playerFilter === 'all') next.delete('player'); else next.set('player', playerFilter);
    if (tagFilter === 'all') next.delete('tag'); else next.set('tag', tagFilter);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerFilter, tagFilter]);

  // Watch which slot is centered on screen — that's the active clip.
  useEffect(() => {
    const root = reelRef.current;
    if (!root || filtered.length === 0) return;
    const observer = new IntersectionObserver(
      entries => {
        // Pick the entry with the largest intersection ratio.
        const best = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!best) return;
        const idx = slotRefs.current.findIndex(el => el === best.target);
        if (idx !== -1) setActiveIndex(idx);
      },
      { root, threshold: [0.55, 0.7, 0.85] }
    );
    slotRefs.current.forEach(el => { if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, [filtered.length]);

  const scrollToIndex = useCallback((i: number) => {
    const target = slotRefs.current[i];
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const goNext = useCallback(() => {
    if (filtered.length === 0) return;
    scrollToIndex(Math.min(activeIndex + 1, filtered.length - 1));
  }, [activeIndex, filtered.length, scrollToIndex]);

  const share = async (clip: PlayerMediaType) => {
    const url = `${getShareOrigin()}/player-media?id=${clip.id}`;
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: `${clip.playerName} highlight`, text: clip.caption || '', url });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied!');
      }
    } catch { /* user cancelled */ }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-black">
        <div className="text-white text-lg">Loading highlight reel…</div>
      </div>
    );
  }

  if (!selectedTeamId) {
    return (
      <div className="p-6 text-center text-gray-600">Select a team to see highlights.</div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="min-h-[100dvh] bg-black text-white flex flex-col items-center justify-center px-6 text-center">
        <div className="text-6xl mb-3">🎥</div>
        <div className="text-lg font-semibold mb-1">No video highlights yet</div>
        <div className="text-white/60 text-sm max-w-sm">
          {playerFilter !== 'all' || tagFilter !== 'all'
            ? 'Try removing filters, or upload some clips on the Media page.'
            : 'Upload some clips on the Media page to start your highlight reel.'}
        </div>
        <div className="flex gap-2 mt-4">
          {(playerFilter !== 'all' || tagFilter !== 'all') && (
            <button
              onClick={() => { setPlayerFilter('all'); setTagFilter('all'); }}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm"
            >
              Clear filters
            </button>
          )}
          <Link to="/player-media" className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium">
            Go to Media
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative bg-black text-white">
      {/* Sticky filter / nav overlay — sits on top of the reel */}
      <div className="fixed top-0 left-0 right-0 lg:left-64 z-30 pointer-events-none">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 bg-gradient-to-b from-black/80 via-black/40 to-transparent pointer-events-auto">
          <h1 className="text-base sm:text-lg font-bold mr-auto truncate">🎬 Highlights</h1>
          <select
            value={playerFilter}
            onChange={e => setPlayerFilter(e.target.value)}
            className="bg-black/60 backdrop-blur border border-white/20 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-white/50"
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
            className="bg-black/60 backdrop-blur border border-white/20 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-white/50"
          >
            <option value="all" className="text-black">All tags</option>
            {ACTIVITY_TAGS.map(t => (
              <option key={t} value={t} className="text-black">{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* The scroll-snap reel itself. Each child fills the viewport and snaps. */}
      <div
        ref={reelRef}
        className="h-[100dvh] overflow-y-scroll snap-y snap-mandatory bg-black"
        style={{
          // Enables momentum scrolling on iOS Safari + keeps the snap behavior crisp.
          WebkitOverflowScrolling: 'touch' as any,
          overscrollBehavior: 'contain',
        }}
      >
        {filtered.map((clip, i) => {
          const isActive = i === activeIndex;
          const isNeighbor = Math.abs(i - activeIndex) <= 1; // preload one ahead / behind
          const poster = posterFor(clip);
          return (
            <section
              key={clip.id}
              ref={el => { slotRefs.current[i] = el; }}
              className="h-[100dvh] w-full snap-start relative flex items-center justify-center bg-black"
            >
              {/* Poster (always rendered — instant visual on scroll) */}
              {poster && (
                <img
                  src={poster}
                  alt=""
                  className="absolute inset-0 w-full h-full object-contain opacity-90"
                  loading={isNeighbor ? 'eager' : 'lazy'}
                />
              )}

              {/* Player — only the active clip gets a real iframe to keep
                  bandwidth + CPU sane. Stream's iframe auto-plays once mounted. */}
              {isActive && clip.streamUid && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-full max-h-[100dvh] aspect-video">
                    <StreamPlayer
                      // `muted` is reactive — flipping the toggle re-keys the
                      // iframe via the query string, so the player picks up
                      // the new state. Always autoplay when active.
                      key={`${clip.id}-${muted ? 'm' : 'u'}`}
                      uid={clip.streamUid}
                      autoplay
                      muted={muted}
                      title={clip.caption || clip.playerName}
                      className="w-full h-full"
                      onEnded={goNext}
                    />
                  </div>
                </div>
              )}
              {isActive && !clip.streamUid && clip.url && (
                <video
                  src={clip.url}
                  poster={clip.thumbnailUrl}
                  className="absolute inset-0 w-full h-full object-contain bg-black"
                  autoPlay
                  playsInline
                  muted={muted}
                  onEnded={goNext}
                />
              )}

              {/* Bottom overlay — player name, caption, tags */}
              <div className="absolute bottom-0 left-0 right-0 p-4 pb-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent pointer-events-none">
                <div className="flex items-end justify-between gap-3 max-w-xl mx-auto">
                  <div className="min-w-0">
                    <div className="text-lg font-bold truncate">{clip.playerName}</div>
                    {clip.caption && (
                      <div className="text-sm text-white/90 line-clamp-2 mt-0.5">{clip.caption}</div>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 text-[11px] text-white/60">
                      <span>{i + 1} / {filtered.length}</span>
                      {clip.createdAt && <span>· {formatDate(clip.createdAt)}</span>}
                    </div>
                    {clip.tags && clip.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {clip.tags.slice(0, 4).map(t => (
                          <span key={t} className="px-2 py-0.5 bg-white/15 backdrop-blur rounded-full text-[11px] font-medium">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 shrink-0 pointer-events-auto">
                    <button
                      onClick={() => setMuted(m => !m)}
                      className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur flex items-center justify-center"
                      aria-label={muted ? 'Unmute' : 'Mute'}
                    >
                      {muted ? '🔇' : '🔊'}
                    </button>
                    <button
                      onClick={() => share(clip)}
                      className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur flex items-center justify-center"
                      aria-label="Share"
                    >
                      📤
                    </button>
                  </div>
                </div>

                {/* Hint on the first clip */}
                {i === 0 && (
                  <div className="text-center text-[11px] text-white/50 mt-3 animate-pulse">
                    Swipe up for the next clip
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default Highlights;
