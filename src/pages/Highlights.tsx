import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { useAuth } from '../hooks/useAuth';
import { Player, PlayerMedia as PlayerMediaType } from '../types';
import { formatDate } from '../utils/helpers';
import StreamPlayer from '../components/common/StreamPlayer';
import DataGate from '../components/common/DataGate';
import { getShareOrigin } from '../utils/origin';
import { posterFor } from '../utils/mediaPoster';

const ACTIVITY_TAGS = ['Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];

const Highlights: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const { getPlayerMediaByTeam, getPlayersByTeam, updateDocument } = useFirestore();
  const { userData } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [players, setPlayers] = useState<Player[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [loading, setLoading] = useState(true);
  const [playerFilter, setPlayerFilter] = useState<string>(searchParams.get('player') || 'all');
  const [tagFilter, setTagFilter] = useState<string>(searchParams.get('tag') || 'all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  // Per-clip "video finished playing" latch. Used to (a) subtly pulse
  // the Next-clip affordance and (b) show a 3-second "Loved it? Tap
  // the heart" nudge pointing at the like button. Keyed by clip id so
  // scrolling to another clip doesn't retrigger and dismiss resets on
  // the current clip only.
  const [endedClipId, setEndedClipId] = useState<string | null>(null);
  const [nudgeVisibleFor, setNudgeVisibleFor] = useState<string | null>(null);
  const nudgeTimerRef = useRef<number | null>(null);

  const reelRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Array<HTMLElement | null>>([]);
  // Deep-link: ?clip=<id> lands directly on that clip. Consumed once so
  // subsequent scrolls don't get yanked back to it. Mirrors the same
  // idiom PlayerMediaPage uses for its lightbox deep-link.
  const clipDeepLinkConsumedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!selectedTeamId) { setLoading(false); return; }
      setLoading(true);
      try {
        const [playersData, mediaData] = await Promise.all([
          getPlayersByTeam(selectedTeamId).catch(() => [] as Player[]),
          getPlayerMediaByTeam(selectedTeamId),
        ]);
        if (cancelled) return;
        setPlayers(playersData as Player[]);
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
  }, [selectedTeamId, getPlayersByTeam, getPlayerMediaByTeam]);

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

  // Deep-link jump: honor ?clip=<id> once media has loaded. Waits a
  // frame so the slot refs have been assigned; if the id isn't found
  // (deleted / different team), the param is silently dropped and the
  // reel opens at the top like normal.
  useEffect(() => {
    const clipId = searchParams.get('clip');
    if (!clipId || filtered.length === 0) return;
    if (clipDeepLinkConsumedRef.current === clipId) return;
    const idx = filtered.findIndex(c => c.id === clipId);
    if (idx === -1) return;
    clipDeepLinkConsumedRef.current = clipId;
    setActiveIndex(idx);
    requestAnimationFrame(() => {
      const target = slotRefs.current[idx];
      if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
    const next = new URLSearchParams(searchParams);
    next.delete('clip');
    setSearchParams(next, { replace: true });
  }, [searchParams, filtered, setSearchParams]);

  const goNext = useCallback(() => {
    if (filtered.length === 0) return;
    scrollToIndex(Math.min(activeIndex + 1, filtered.length - 1));
  }, [activeIndex, filtered.length, scrollToIndex]);

  // Reset the "ended" state whenever the user scrolls to a new clip -
  // the pulse and heart-nudge only ever belong to the clip that just
  // finished, not the one now in view.
  useEffect(() => {
    setEndedClipId(null);
    setNudgeVisibleFor(null);
    if (nudgeTimerRef.current) {
      window.clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
  }, [activeIndex]);

  useEffect(() => {
    return () => {
      if (nudgeTimerRef.current) window.clearTimeout(nudgeTimerRef.current);
    };
  }, []);

  // Video-ended handler: NO auto-advance (Patrick 2026-07-26 - "people
  // will get lost"). Instead we pulse the Next-clip affordance and
  // pop the "Loved it? Tap the heart" nudge for 3s so the user gets
  // an obvious next-step cue.
  const handleVideoEnded = useCallback((clipId: string) => {
    setEndedClipId(clipId);
    setNudgeVisibleFor(clipId);
    if (nudgeTimerRef.current) window.clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = window.setTimeout(() => {
      setNudgeVisibleFor(prev => (prev === clipId ? null : prev));
      nudgeTimerRef.current = null;
    }, 3000);
  }, []);

  // Optimistic like toggle (mirrors PlayerMediaPage.handleLike). The
  // heart flips instantly; on failure we revert. player_media only -
  // the reel never shows gallery items.
  const handleLike = useCallback(async (clip: PlayerMediaType) => {
    if (!userData?.uid) return;
    const uid = userData.uid;
    const likes = clip.likes || [];
    const already = likes.includes(uid);
    const nextLikes = already ? likes.filter(id => id !== uid) : [...likes, uid];
    setMedia(prev => prev.map(m => (
      m.id === clip.id ? { ...m, likes: nextLikes, likeCount: nextLikes.length } : m
    )));
    try {
      await updateDocument('player_media', clip.id, {
        likes: nextLikes,
        likeCount: nextLikes.length,
      });
    } catch (err) {
      console.error('[Highlights] like toggle failed', err);
      setMedia(prev => prev.map(m => (
        m.id === clip.id ? { ...m, likes, likeCount: likes.length } : m
      )));
    }
  }, [userData?.uid, updateDocument]);

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
      <div className="min-h-[100dvh] bg-black">
        <DataGate when="loading" />
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
              className="px-4 py-2 bg-line-default/10 hover:bg-line-default/20 rounded-lg text-sm"
            >
              Clear filters
            </button>
          )}
          <Link to="/player-media" className="px-4 py-2 bg-brand-primary hover:bg-brand-primary rounded-lg text-sm font-medium">
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
            className="bg-black/60 backdrop-blur border border-line-default/20 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-line-default/50"
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
            className="bg-black/60 backdrop-blur border border-line-default/20 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-line-default/50"
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
              className="h-[100dvh] w-full snap-start relative flex flex-col bg-black"
            >
              {/* Top stage — the actual clip in its native aspect. 60%
                  of the viewport so landscape (16:9, most coach videos)
                  has real room, and so the text/meta block below isn't
                  fighting the video for attention. */}
              <div className="relative flex-[3] min-h-0 bg-black flex items-center justify-center overflow-hidden">
                {poster && (
                  <img
                    src={poster}
                    alt=""
                    className="absolute inset-0 w-full h-full object-contain opacity-90"
                    loading={isNeighbor ? 'eager' : 'lazy'}
                  />
                )}
                {isActive && clip.streamUid && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <StreamPlayer
                      key={`${clip.id}-${muted ? 'm' : 'u'}`}
                      uid={clip.streamUid}
                      autoplay
                      muted={muted}
                      title={clip.caption || clip.playerName}
                      className="w-full h-full"
                      onEnded={() => handleVideoEnded(clip.id)}
                    />
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
                    onEnded={() => handleVideoEnded(clip.id)}
                  />
                )}

                {/* Floating action stack - sits on top-right of the
                    video so it's reachable without covering the
                    important pixels in the middle of the frame. Heart
                    lives at the top of the stack because "did you love
                    it" is the primary post-watch ask. */}
                <div className="absolute top-3 right-3 flex flex-col gap-2.5 z-10">
                  {(() => {
                    const liked = !!(userData?.uid && (clip.likes || []).includes(userData.uid));
                    const nudging = nudgeVisibleFor === clip.id && !liked;
                    return (
                      <div className="relative">
                        {nudging && (
                          <div
                            className="absolute right-full mr-2 top-1/2 -translate-y-1/2 pointer-events-none animate-fade-in whitespace-nowrap"
                            aria-live="polite"
                          >
                            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white text-slate-900 shadow-lg text-xs font-bold">
                              Loved it? Tap the heart
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
                                <line x1="5" y1="12" x2="19" y2="12" />
                                <polyline points="12 5 19 12 12 19" />
                              </svg>
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => { handleLike(clip); setNudgeVisibleFor(null); }}
                          className={`relative w-12 h-12 rounded-full ring-1 ring-line-default/20 backdrop-blur flex items-center justify-center transition ${liked ? 'bg-rose-600/85 hover:bg-rose-600' : 'bg-black/55 hover:bg-black/75'} ${nudging ? 'animate-heart-pulse ring-2 ring-rose-400/80' : ''}`}
                          aria-label={liked ? 'Unlike' : 'Like'}
                          aria-pressed={liked}
                        >
                          <svg
                            className="w-6 h-6 text-white"
                            viewBox="0 0 24 24"
                            fill={liked ? 'currentColor' : 'none'}
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                          </svg>
                          {(clip.likeCount || 0) > 0 && (
                            <span className="absolute -bottom-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-slate-900 text-[10px] font-black flex items-center justify-center ring-2 ring-black/70">
                              {(clip.likeCount || 0) > 99 ? '99+' : clip.likeCount}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => share(clip)}
                    className="w-12 h-12 rounded-full bg-black/55 hover:bg-black/75 ring-1 ring-line-default/20 backdrop-blur flex items-center justify-center"
                    aria-label="Share"
                  >
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMuted(m => !m)}
                    className="w-10 h-10 rounded-full bg-black/55 hover:bg-black/75 ring-1 ring-line-default/20 backdrop-blur flex items-center justify-center"
                    aria-label={muted ? 'Unmute' : 'Mute'}
                  >
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      {muted ? (
                        <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>
                      ) : (
                        <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></>
                      )}
                    </svg>
                  </button>
                </div>
              </div>

              {/* Bottom info panel — NOT an overlay. Solid black band
                  with clear typography. Player name, caption, tags,
                  position, and a visible "Next clip" CTA so families
                  who've never seen a TikTok-style reel know the
                  vertical scroll is the navigation. */}
              <div className="flex-[2] min-h-0 bg-surface-base border-t border-line-default/10 overflow-y-auto">
                <div className="max-w-xl mx-auto px-5 py-4">
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">
                    Clip {i + 1} of {filtered.length}
                    {clip.createdAt && <span className="text-ink-primary/50 font-bold ml-1">· {formatDate(clip.createdAt)}</span>}
                  </div>
                  <h2 className="text-xl font-black text-ink-primary leading-tight">{clip.playerName}</h2>
                  {clip.caption && (
                    <p className="text-sm text-ink-primary/85 leading-snug mt-2">{clip.caption}</p>
                  )}
                  {clip.tags && clip.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {clip.tags.slice(0, 6).map(t => (
                        <span key={t} className="px-2 py-0.5 bg-line-default/10 ring-1 ring-line-default/15 rounded-full text-[11px] font-bold text-ink-primary/85">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {i < filtered.length - 1 && (() => {
                    const justEnded = endedClipId === clip.id;
                    return (
                      <button
                        type="button"
                        onClick={goNext}
                        className={`mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-extrabold tracking-widest uppercase transition ${justEnded
                          ? 'bg-brand-primary text-brand-primary-fg animate-next-pulse'
                          : 'text-ink-primary/65 hover:text-ink-primary'}`}
                      >
                        Next clip
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* Scroll affordance — visible chevron between clips so
                  users who never figured out "swipe up" on the first
                  clip see the gesture explicitly. Only renders when
                  there's a clip below this one. */}
              {i < filtered.length - 1 && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
                  <div className="px-3 py-1.5 rounded-full bg-black/60 ring-1 ring-line-default/15 backdrop-blur text-white text-[10px] font-extrabold tracking-widest uppercase flex items-center gap-1.5 animate-bounce">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                    Swipe up
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default Highlights;
