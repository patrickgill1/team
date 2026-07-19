import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { useStorage } from '../hooks/useStorage';
import { Player, PlayerMedia as PlayerMediaType, MomentType, MOMENT_TYPES } from '../types';
import { isCoachOfTeam, canManageTeamMedia, formatDate } from '../utils/helpers';
import { isXpSourceEnabled } from '../utils/xpSource';
import { useTeamAudience } from '../hooks/useTeamAudience';
import { autoPostVideoToWall } from '../utils/autoPostToWall';
import { useTrialGate } from '../hooks/useTrialGate';
import TrialGateModal from '../components/common/TrialGateModal';
import DataGate from '../components/common/DataGate';
import { compressVideo, canCompressVideo, CompressionProgress } from '../utils/videoCompression';
import { uploadToR2 } from '../utils/r2Upload';
import { uploadToStream, streamThumbnailUrl, getStreamDownloadUrl, checkVideoLimit } from '../utils/streamUpload';
import CloudflareStreamIframe from '../components/common/CloudflareStreamIframe';
import { checkUploadQuota, probeVideoDuration, incrementTeamVideoUsage, type QuotaCheck } from '../utils/videoQuota';
import VideoQuotaModal from '../components/common/VideoQuotaModal';
import { downloadFile } from '../utils/downloadFile';
import { getShareOrigin } from '../utils/origin';
import StreamPlayer, { loadStreamSdk, StreamSdkPlayer } from '../components/common/StreamPlayer';
import EmbedMediaModal from '../components/player/EmbedMediaModal';
import FullGames from './FullGames';
import PhotosTab from '../components/gallery/PhotosTab';
import { collection, query as fsQuery, where as fsWhere, getDocs as fsGetDocs } from 'firebase/firestore';
import { db } from '../utils/firebase';

const ACTIVITY_TAGS = ['Goal', 'Own Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];
const ITEMS_PER_PAGE = 20;

/** Monoline SVG icons for each momentType. 2px stroke, currentColor —
 *  matches the existing icon aesthetic throughout the upload modal. */
const MomentIcon: React.FC<{ kind: 'goal' | 'assist' | 'big_play'; className?: string }> = ({ kind, className = 'w-5 h-5' }) => {
  const stroke = { strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (kind === 'goal') {
    // Goal-mouth silhouette: crossbar + posts + a hint of net.
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke} aria-hidden>
        <path d="M3 6h18" />
        <path d="M5 6v14" />
        <path d="M19 6v14" />
        <path d="M5 10h14" />
        <path d="M5 14h14" />
        <path d="M5 20l14 0" />
      </svg>
    );
  }
  if (kind === 'assist') {
    // Curved arrow — the pass that made it.
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke} aria-hidden>
        <path d="M4 17 Q 12 4, 20 12" />
        <path d="M15 11 L 20 12 L 19 17" />
      </svg>
    );
  }
  // big_play — lightning bolt.
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke} aria-hidden>
      <path d="M13 3 L 4 14 L 11 14 L 10 21 L 19 10 L 13 10 Z" />
    </svg>
  );
};

/** Warm short label for a momentType — used on the pill overlay. */
function momentLabel(kind: 'goal' | 'assist' | 'big_play'): string {
  if (kind === 'goal') return 'Goal';
  if (kind === 'assist') return 'Assist';
  return 'Big play';
}

const PlayerMediaPage: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { isAdult: isAdultTeam } = useTeamAudience(selectedTeam);
  const navigate = useNavigate();
  const canManageMedia = canManageTeamMedia(userData, selectedTeam);
  const { getDocuments, addPlayerMedia, getPlayerMediaByPlayer, getPlayerMediaByTeam, getPhotosByTeam, getPlayersByTeam, getUsersByTeam, deleteDocument, updateDocument, updatePlayerStats, addGameStat } = useFirestore();
  const { uploadFile } = useStorage();

  const [players, setPlayers] = useState<Player[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('all');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const { gated: trialGated, reason: trialReason } = useTrialGate();
  const [trialGateOpen, setTrialGateOpen] = useState(false);
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // Storage quota modal — opens when an upload attempt hits the
  // team's video tier cap (clip count, per-clip duration, or
  // total storage). Phase 1 is informational; Phase 2 wires the
  // upgrade CTA to Stripe Checkout.
  const [quotaBlocked, setQuotaBlocked] = useState<QuotaCheck | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [compressionStatus, setCompressionStatus] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedMedia, setSelectedMedia] = useState<PlayerMediaType | null>(null);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [editingTags, setEditingTags] = useState<string[] | null>(null); // null = not editing
  const [editingGoalScorerId, setEditingGoalScorerId] = useState<string>('');
  const [editingAssistByIds, setEditingAssistByIds] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
  const [activeTab, setActiveTab] = useState<'highlights' | 'fullgames' | 'photos'>('highlights');
  const [searchQuery, setSearchQuery] = useState('');
  // Media-type split — All / Videos only / Photos only.
  const [mediaTypeFilter, setMediaTypeFilter] = useState<'all' | 'video' | 'photo' | 'highlight'>('all');
  // For parents — their linked player. Once loaded, the page auto-
  // selects that player so opening Media drops them straight onto their
  // kid's clips.
  const [parentLinkedPlayerId, setParentLinkedPlayerId] = useState<string | null>(null);
  const [hasAutoSelectedParent, setHasAutoSelectedParent] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceProgress, setReplaceProgress] = useState(0);
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({}); // uid -> display name
  const [showLikersFor, setShowLikersFor] = useState<PlayerMediaType | null>(null);
  const [showViewersFor, setShowViewersFor] = useState<PlayerMediaType | null>(null);
  const [showDownloadersFor, setShowDownloadersFor] = useState<PlayerMediaType | null>(null);
  const [showSharersFor, setShowSharersFor] = useState<PlayerMediaType | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState<number>(0);

  // Upload form
  const [uploadPlayerId, setUploadPlayerId] = useState('');
  const [uploadCaption, setUploadCaption] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadTags, setUploadTags] = useState<string[]>([]);
  // Coach-only display tag. NEVER a stat entry, NEVER an XP grant,
  // NEVER a badge trigger — the whole point of the feature.
  const [uploadMomentType, setUploadMomentType] = useState<MomentType | ''>('');
  const [uploadTaggedPlayers, setUploadTaggedPlayers] = useState<string[]>([]);
  const [uploadGoalScorerId, setUploadGoalScorerId] = useState<string>('');
  const [uploadAssistByIds, setUploadAssistByIds] = useState<string[]>([]);
  // Coach-only toggle. Default ON preserves prior behavior (every credited clip
  // bumped stats + XP + badges). When OFF, we still write goalScorerId +
  // assistByIds to the doc so highlight captions show who scored/assisted, but
  // skip applyStatsDiff, attachClipCreditsToGame, updatePlayerStats, and
  // maybeGrantFirstStatBadges. Practice-game / friendly / demo scenarios.
  const [uploadCountsForStats, setUploadCountsForStats] = useState<boolean>(true);
  const [uploadGameId, setUploadGameId] = useState<string>('');
  const [editingGameId, setEditingGameId] = useState<string>('');
  const [recentGames, setRecentGames] = useState<{ id: string; label: string }[]>([]);
  // All team events (games + practices + events) for the Photos tab's
  // "link to event" dropdown + filter. Populated from the same events
  // fetch below so we don't double-query.
  const [allTeamEvents, setAllTeamEvents] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clipsSectionRef = useRef<HTMLElement | null>(null);

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);

  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkConsumedRef = useRef<string | null>(null);
  // Stream player SDK plumbing — lets us read currentTime from the lightbox
  // iframe so the coach can pick the exact frame as a custom thumbnail.
  const lightboxIframeRef = useRef<HTMLIFrameElement | null>(null);
  const lightboxStreamPlayerRef = useRef<StreamSdkPlayer | null>(null);
  const [savingThumbnail, setSavingThumbnail] = useState(false);

  useEffect(() => {
    setVisibleCount(ITEMS_PER_PAGE);
    loadData();
  }, [selectedTeamId, selectedPlayerId]);

  // Lookup the parent's linked player on this team so we can auto-
  // select them when they open the page. Coaches skip this entirely.
  useEffect(() => {
    if (!userData?.uid || !selectedTeamId) return;
    if (isCoachOfTeam(userData, selectedTeam)) return;
    (async () => {
      try {
        const q = fsQuery(
          collection(db, 'players'),
          fsWhere('parentIds', 'array-contains', userData.uid),
          fsWhere('isActive', '==', true),
        );
        const snap = await fsGetDocs(q);
        const linked = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
          .find((p: any) =>
            (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) ||
            p.teamId === selectedTeamId
          );
        if (linked) setParentLinkedPlayerId(linked.id);
      } catch (err) {
        console.error('Linked player lookup failed:', err);
      }
    })();
  }, [userData?.uid, userData?.role, selectedTeamId]);

  // Once we know the parent's linked player AND the player roster has
  // loaded, drop them onto their kid's view automatically. Only happens
  // once per session so a parent who manually switches to "All" doesn't
  // get bounced back.
  useEffect(() => {
    if (hasAutoSelectedParent) return;
    if (!parentLinkedPlayerId) return;
    if (players.length === 0) return;
    if (!searchParams.get('clip') && selectedPlayerId === 'all') {
      setSelectedPlayerId(parentLinkedPlayerId);
    }
    setHasAutoSelectedParent(true);
  }, [parentLinkedPlayerId, players.length, hasAutoSelectedParent, selectedPlayerId, searchParams]);

  // Deep-link: open ?clip=<id> once media has loaded.
  useEffect(() => {
    const clipId = searchParams.get('clip');
    if (!clipId || media.length === 0 || deepLinkConsumedRef.current === clipId) return;
    const target = media.find(m => m.id === clipId);
    if (target) {
      setSelectedMedia(target);
      deepLinkConsumedRef.current = clipId;
      const next = new URLSearchParams(searchParams);
      next.delete('clip');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, media, setSearchParams]);

  // When the user picks a player from BROWSE BY PLAYER, scroll the clips
  // grid into view so it's obvious it loaded (otherwise the page stays
  // anchored on the player chip row and the clips appear below the fold).
  useEffect(() => {
    if (selectedPlayerId && selectedPlayerId !== 'all') {
      requestAnimationFrame(() => {
        clipsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [selectedPlayerId]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      setLoading(true);

      // Load all team media every time so the BROWSE BY PLAYER counts and
      // per-player views can include clips where the player is only a
      // *tagged* secondary player (not the subject). We filter client-side.
      const mediaPromise = getPlayerMediaByTeam(selectedTeamId);

      const galleryPromise = (!selectedPlayerId || selectedPlayerId === 'all')
        ? getPhotosByTeam(selectedTeamId).catch(err => { console.error('Error loading gallery photos:', err); return []; })
        : Promise.resolve([]);

      const [teamPlayersRaw, mediaData, galleryPhotos, usersData] = await Promise.all([
        getPlayersByTeam(selectedTeamId).catch(() => []),
        mediaPromise,
        galleryPromise,
        getUsersByTeam(selectedTeamId).catch(() => []),
      ]);

      // Build uid -> name lookup for likes/views display
      const uMap: Record<string, string> = {};
      (usersData as any[]).forEach((u: any) => {
        const uid = u.uid || u.id;
        if (uid) uMap[uid] = u.name || u.email || 'Unknown';
      });
      setUsersMap(uMap);

      const teamPlayers = teamPlayersRaw.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
      })) as Player[];
      setPlayers(teamPlayers);

      // Recent games for the optional "Link to game" dropdown (used to dedup
      // stat credits between coach live-tap and parent clip uploads).
      try {
        const allEvents = await getDocuments('events', []);
        const cutoffPast = Date.now() - 60 * 24 * 3600 * 1000;
        const cutoffFuture = Date.now() + 7 * 24 * 3600 * 1000;
        // Photos tab: give it every team-scoped GAME (+ non-recurring
        // 'event' entries — tournaments, banquets, etc). Practices are
        // omitted — coaches almost never link a photo to a specific
        // Monday practice, and including them buries the games under a
        // year of weekly noise (Patrick's report). Window trimmed to 6
        // months so last-season's practices don't leak into this-season's
        // list either.
        const photosWindowMs = 180 * 24 * 3600 * 1000;
        const teamEvents = (allEvents as any[])
          .filter(e => e.teamId === selectedTeamId)
          .filter(e => e.type === 'game' || e.type === 'event')
          .map(e => {
            const d: Date = e.date?.toDate ? e.date.toDate() : new Date(e.date);
            const rawTitle = String(e.title || '').trim();
            const opponent = String(e.opponent || '').trim();
            // Games without a title read as "vs {opponent}" so the picker
            // doesn't just show a bare "Event".
            const displayTitle = rawTitle
              || (e.type === 'game' && opponent ? `vs ${opponent}` : (opponent || 'Event'));
            return { id: e.id, title: displayTitle, date: d, type: e.type as any, opponent };
          })
          .filter(e => e.date instanceof Date && !isNaN(e.date.getTime()) && Math.abs(Date.now() - e.date.getTime()) <= photosWindowMs)
          .sort((a, b) => b.date.getTime() - a.date.getTime());
        setAllTeamEvents(teamEvents);
        const games = (allEvents as any[])
          .filter(e => e.teamId === selectedTeamId && e.type === 'game')
          .map(e => {
            const d: Date = e.date?.toDate ? e.date.toDate() : new Date(e.date);
            return { id: e.id, ts: d.getTime(), date: d, opponent: e.opponent || e.title || 'Game' };
          })
          .filter(g => g.ts >= cutoffPast && g.ts <= cutoffFuture)
          .sort((a, b) => b.ts - a.ts)
          .map(g => ({
            id: g.id,
            label: `${g.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} — vs ${g.opponent}`,
          }));
        setRecentGames(games);
      } catch (err) {
        console.warn('Could not load games for dedup link', err);
        setRecentGames([]);
      }

      const formattedMedia = mediaData.map((m: any) => ({
        ...m,
        createdAt: m.createdAt?.toDate ? m.createdAt.toDate() : new Date(m.createdAt),
      })) as PlayerMediaType[];

      // Merge gallery photos
      if (!selectedPlayerId || selectedPlayerId === 'all') {
        const convertedGallery = (galleryPhotos as any[]).map((g: any) => ({
          id: `gallery_${g.id}`,
          playerId: '',
          playerName: 'Team Gallery',
          teamId: g.teamId || selectedTeamId,
          url: g.url,
          type: 'photo' as const,
          caption: g.caption || g.title || g.description || '',
          uploadedBy: g.uploadedBy || '',
          uploadedByName: g.uploadedByName || 'Unknown',
          fileSize: g.fileSize || 0,
          fileName: g.fileName || '',
          contentType: g.contentType || 'image/jpeg',
          tags: g.tags || [],
          createdAt: g.createdAt?.toDate ? g.createdAt.toDate() : new Date(g.createdAt),
        } as PlayerMediaType));
        formattedMedia.push(...convertedGallery);
      }

      // Sort all media by date, newest first
      formattedMedia.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      setMedia(formattedMedia);
    } catch (error) {
      console.error('Error loading media:', error);
    } finally {
      setLoading(false);
    }
  };

  // Apply a stats credit diff: takes "before" and "after" credit fields and adjusts
  // the impacted players' stats.goals / stats.assists accordingly.
  // - On create:  oldCredits = {}            newCredits = filled-in
  // - On edit:    oldCredits = previous doc  newCredits = updated doc
  // - On delete:  oldCredits = stored doc    newCredits = {}
  const applyStatsDiff = async (
    oldCredits: { goalScorerId?: string; assistByIds?: string[] },
    newCredits: { goalScorerId?: string; assistByIds?: string[] },
  ) => {
    const delta = new Map<string, { goals: number; assists: number }>();
    const bump = (pid: string, key: 'goals' | 'assists', amount: number) => {
      const cur = delta.get(pid) || { goals: 0, assists: 0 };
      cur[key] += amount;
      delta.set(pid, cur);
    };
    if (oldCredits.goalScorerId) bump(oldCredits.goalScorerId, 'goals', -1);
    for (const a of oldCredits.assistByIds || []) bump(a, 'assists', -1);
    if (newCredits.goalScorerId) bump(newCredits.goalScorerId, 'goals', +1);
    for (const a of newCredits.assistByIds || []) bump(a, 'assists', +1);

    // Resolve tripId ONCE for this batch — every clip credit in a diff
    // shares the same tagging moment, so a single resolver hit covers
    // all pids. Trip-attributed clip credits skip the season aggregate
    // mirror and first-stat badges (same rule as GameDay endGame).
    let clipTripId: string | undefined;
    if (selectedTeamId) {
      try {
        const { resolveTripIdForGame } = await import('../utils/tripAttribution');
        const r = await resolveTripIdForGame({ teamId: selectedTeamId, gameDate: new Date() });
        clipTripId = r.tripId;
      } catch { /* non-fatal — stays season-scoped */ }
    }

    for (const [pid, d] of Array.from(delta.entries())) {
      if (d.goals === 0 && d.assists === 0) continue;
      const player = players.find(p => p.id === pid);
      if (!player) continue;
      const cur = player.stats || { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0 };
      const next = {
        ...cur,
        goals: Math.max(0, (cur.goals || 0) + d.goals),
        assists: Math.max(0, (cur.assists || 0) + d.assists),
      };
      try {
        // Skip the season-aggregate mirror + first-stat badge for
        // trip-scoped clip credits (kept for the regulation journey).
        if (!clipTripId) {
          await updatePlayerStats(pid, next as any);
          // Clip-credit can push a player across the 0→1 crossing on
          // goals/assists (a shared player's first credited goal comes
          // in via a tagged clip). Fire the same first-stat badge
          // grant used by GameDay + StatsTracker.
          try {
            const { maybeGrantFirstStatBadges } = await import('../utils/badgeGrants');
            void maybeGrantFirstStatBadges(
              pid,
              cur,
              next,
              {
                existingBadges: (player as any).badges,
                context: 'Clip credit',
                team: selectedTeam as any,
              },
            );
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        console.error('Failed to update stats for player', pid, err);
      }
      // Also write a team-scoped 'stats' collection record so the per-team
      // aggregator (getTeamPlayerStatsMap) sees clip-credited goals/assists
      // for SHARED players. Without this, shared players get +1 to the
      // global aggregate but 0 to the per-team total.
      // Trip-scoped credits still write the row (with tripId stamped)
      // so the Tournaments card sums them; they just skip the season
      // aggregate above.
      if (selectedTeamId && (d.goals !== 0 || d.assists !== 0)) {
        try {
          await addGameStat({
            playerId: pid,
            playerName: player.name,
            gameId: `clip_${Date.now()}_${pid}`,
            gameDate: new Date(),
            opponent: 'Clip credit',
            minutesPlayed: 0,
            goals: d.goals,
            assists: d.assists,
            yellowCards: 0,
            redCards: 0,
            saves: 0,
            recordedBy: userData?.uid,
            recordedByName: userData?.name || 'Coach',
            teamId: selectedTeamId,
            ...(clipTripId ? { tripId: clipTripId } : {}),
          } as any);
        } catch (err) {
          console.error('Failed to write per-team clip stat for player', pid, err);
        }
      }
    }
    // Update local players cache so subsequent diffs see fresh stats
    setPlayers(prev => prev.map(p => {
      const d = delta.get(p.id);
      if (!d) return p;
      const cur = p.stats || { gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, minutesPlayed: 0 };
      return {
        ...p,
        stats: {
          ...cur,
          goals: Math.max(0, (cur.goals || 0) + d.goals),
          assists: Math.max(0, (cur.assists || 0) + d.assists),
        },
      };
    }));
  };

  const handleUpload = async () => {
    if (!userData || !uploadPlayerId || uploadFiles.length === 0) return;
    if (!canManageMedia) {
      alert('Only staff can upload clips for this team. Ask your coach to grant you upload access.');
      return;
    }

    const player = players.find(p => p.id === uploadPlayerId);
    if (!player) return;

    // Stats-accuracy guard: if the clip carries credits (a goal
    // scorer, an assist, or the 'Goal' tag) BUT the user didn't
    // link it to a game, the upload path bumps player.stats
    // directly with a synthetic gameId — so if the coach also
    // tapped the same goal in Game Day, the player ends up +2.
    // Confirm the tradeoff explicitly. Not a block; just a nudge.
    const isOwnGoalTag = uploadTags.includes('Own Goal');
    const isGoalTag = uploadTags.includes('Goal') || isOwnGoalTag;
    const hasScorer = isGoalTag && !isOwnGoalTag && !!(uploadGoalScorerId || uploadPlayerId);
    const hasAssists = isGoalTag && uploadAssistByIds.length > 0;
    const hasCredits = hasScorer || hasAssists;
    if (hasCredits && !uploadGameId && recentGames.length > 0) {
      const scorerName = hasScorer
        ? (players.find(p => p.id === (uploadGoalScorerId || uploadPlayerId))?.name || 'a player')
        : null;
      const msg = hasScorer && hasAssists
        ? `This clip credits ${scorerName} with a goal plus ${uploadAssistByIds.length} assist${uploadAssistByIds.length === 1 ? '' : 's'} but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the goal was already tapped in GameDay. Upload anyway?`
        : hasScorer
          ? `This clip credits ${scorerName} with a goal but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the goal was already tapped in GameDay. Upload anyway?`
          : `This clip carries assist credits but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the play was already tapped in GameDay. Upload anyway?`;
      if (!window.confirm(msg)) return;
    }

    try {
      setUploading(true);
      const totalFiles = uploadFiles.length;

      for (let i = 0; i < uploadFiles.length; i++) {
        let file = uploadFiles[i];
        setUploadProgress(Math.round(((i) / totalFiles) * 100));

        const isVideo = file.type.startsWith('video/');
        
        // Compress videos before upload (reduces 50MB phone videos to ~5MB)
        if (isVideo && canCompressVideo()) {
          const originalSize = file.size;
          setCompressionStatus(`Compressing video ${i + 1}/${totalFiles}...`);
          file = await compressVideo(file, (p) => {
            if (p.phase === 'compressing') {
              setCompressionStatus(`Compressing video ${i + 1}/${totalFiles}... ${p.percent}%`);
            }
          });
          if (file.size < originalSize) {
            const saved = ((1 - file.size / originalSize) * 100).toFixed(0);
            console.log(`Video compressed: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(file.size / 1024 / 1024).toFixed(1)}MB (${saved}% smaller)`);
          }
          setCompressionStatus('');
        }
        
        // Compress images before upload
        if (!isVideo) {
          file = await compressImage(file);
        }

        // Videos go to Cloudflare Stream (adaptive bitrate HLS, smooth on
        // cellular). Photos stay on Firebase Storage.
        let url: string;
        let streamUid: string | undefined;
        let videoDurationSec: number | null = null;
        if (isVideo) {
          // Probe duration BEFORE uploading so we can reject over-cap
          // clips without burning bandwidth. Then check the team's
          // tier quota. Either failure pops the upgrade modal and
          // aborts the rest of the batch.
          videoDurationSec = await probeVideoDuration(file);
          const quota = await checkUploadQuota(selectedTeamId!, { durationSeconds: videoDurationSec ?? undefined });
          if (!quota.allowed) {
            setQuotaBlocked(quota);
            setUploading(false);
            setUploadProgress(0);
            return;
          }
          const result = await uploadToStream(
            file,
            { name: uploadCaption || file.name, playerId: uploadPlayerId, teamId: selectedTeamId },
            (pct) => {
              const overall = ((i + pct / 100) / totalFiles) * 100;
              setUploadProgress(Math.round(overall));
            }
          );
          streamUid = result.uid;
          // Keep a Stream HLS URL in `url` so existing players that just read
          // `m.url` still work (Safari will play HLS natively, and we render
          // the Stream iframe explicitly when streamUid is present).
          url = result.hlsUrl;
          // Bump the team's video usage counters. Drives the quota
          // gate on subsequent uploads + the admin Storage page.
          void incrementTeamVideoUsage(selectedTeamId!, videoDurationSec);
        } else {
          const storagePath = `player_media/${selectedTeamId}/${uploadPlayerId}/${Date.now()}_${file.name}`;
          url = await uploadFile(file, storagePath);
        }

        // Build tags: activity tags + tagged player names
        const taggedPlayerNames = uploadTaggedPlayers
          .map(pid => players.find(p => p.id === pid)?.name)
          .filter(Boolean) as string[];
        const allTags = [...uploadTags, ...taggedPlayerNames];

        // Determine stats credits — 'Goal' tag means we credit a scorer; 'Own Goal'
        // tag means the team scored but no player on our roster gets the goal
        // credit (assists may still apply to the kicker who forced it).
        const isOwnGoal = uploadTags.includes('Own Goal');
        const isGoalClip = uploadTags.includes('Goal') || isOwnGoal;
        const scorerId = (isGoalClip && !isOwnGoal) ? (uploadGoalScorerId || uploadPlayerId) : undefined;
        const assistIds = isGoalClip ? uploadAssistByIds.filter(id => id !== scorerId) : [];

        // We need the new media doc id BEFORE bumping stats so we can pass it
        // into the live-game dedup helper. Build the doc payload first, add it,
        // then apply credits.
        // Coach-only momentType. Parents can upload media but can't
        // classify it as a highlight — the tag is coach-authored
        // curation, not user-generated. If a non-coach ever reaches
        // this code path (they shouldn't; the picker is gated), the
        // value gets stripped here as belt-and-suspenders.
        const momentTypeToSave: MomentType | undefined =
          isUserCoach && uploadMomentType ? (uploadMomentType as MomentType) : undefined;

        // Attribution fields ride with the doc from the initial write. Even when
        // countsForStats is false, we want the scorer/assist chips to render on
        // the clip so highlight captions read correctly. Only the stat side
        // effects (applyStatsDiff / attach / updatePlayerStats / badges) get
        // skipped by the toggle below.
        const mediaPayload: any = {
          playerId: uploadPlayerId,
          playerName: player.name,
          teamId: selectedTeamId,
          url,
          type: isVideo ? 'video' : 'photo',
          caption: uploadCaption.trim() || undefined,
          uploadedBy: userData.uid,
          uploadedByName: userData.name,
          fileSize: file.size,
          fileName: file.name,
          contentType: file.type,
          tags: allTags.length > 0 ? allTags : undefined,
          taggedPlayerIds: uploadTaggedPlayers.length > 0 ? uploadTaggedPlayers : undefined,
          gameId: uploadGameId || undefined,
          isOwnGoal: isOwnGoal ? true : undefined,
          ...(isGoalClip && scorerId ? { goalScorerId: scorerId } : {}),
          ...(isGoalClip && assistIds.length > 0 ? { assistByIds: assistIds } : {}),
          ...(isGoalClip ? { countsForStats: uploadCountsForStats } : {}),
          ...(momentTypeToSave ? { momentType: momentTypeToSave } : {}),
          ...(streamUid ? { streamUid } : {}),
          updatedAt: new Date(),
        };

        // Stamp the active season so this clip filters into the right season bucket.
        const { withSeasonId } = await import('../utils/seasons');
        const stampedMedia = await withSeasonId(mediaPayload);

        const newMediaId = await addPlayerMedia(stampedMedia);

        // Auto-post videos to the team wall. Photos skipped silently
        // inside the helper — too high frequency to make sense pinned.
        // First-file-only to avoid spam when a coach drops in 5 angles.
        if (i === 0 && userData?.uid && stampedMedia.type === 'video') {
          void autoPostVideoToWall(
            { id: newMediaId, ...(stampedMedia as any) },
            { uid: userData.uid, name: userData.name || 'Coach', role: isCoachOfTeam(userData, selectedTeam) ? 'coach' : 'parent' }
          );
        }

        // We only credit the FIRST file of a multi-file upload to avoid double-
        // counting when a coach drops in 5 angles of the same goal.
        // Trigger when there's a scorer OR (own-goal case) when assists exist.
        // When countsForStats is false, we preserve attribution (goalScorerId +
        // assistByIds on the doc, written above in mediaPayload) so highlight
        // cards can still show who scored and assisted, but skip every stat
        // side effect: no attach, no season bump, no XP, no badges.
        if (i === 0 && (scorerId || assistIds.length > 0) && uploadCountsForStats) {
          let attachedScorer = false;
          let attachedAssistIds: string[] = [];
          let needsBumpScorer = true;
          let needsBumpAssistIds = [...assistIds];

          if (uploadGameId && newMediaId) {
            try {
              const { attachClipCreditsToGame } = await import('../utils/clipGameLink');
              const scorer = players.find(p => p.id === scorerId);
              const assistsById: Record<string, { name?: string; jersey?: number }> = {};
              for (const aid of assistIds) {
                const ap = players.find(pp => pp.id === aid);
                if (ap) assistsById[aid] = { name: ap.name, jersey: ap.jerseyNumber };
              }
              const res = await attachClipCreditsToGame({
                gameId: uploadGameId,
                mediaId: newMediaId,
                clipUrl: url,
                scorerId,
                scorerName: scorer?.name,
                scorerJersey: scorer?.jerseyNumber,
                assistIds,
                assistsById,
                recordedBy: userData.uid,
                recordedByName: userData.name,
              });
              attachedScorer = res.attachedScorer;
              attachedAssistIds = res.attachedAssistIds;
              if (res.status === 'final') {
                // Game already finalized — finalize won't re-run, so bump only the
                // credits we *added* (attached ones were already counted live).
                // But respect the game's countsToStats flag: scrimmages and demo
                // games opt out of rollup, so a clip linked to one of those never
                // bumps player.stats even after final.
                needsBumpScorer = res.addedScorer && res.countsToStats;
                needsBumpAssistIds = res.countsToStats ? res.addedAssistIds : [];
              } else if (res.status !== 'no-doc') {
                // Game is live/halftime/scheduled — finalize will pick everything
                // up (and will itself honor countsToStats). Skip the immediate bump.
                needsBumpScorer = false;
                needsBumpAssistIds = [];
              }
            } catch (err) {
              console.warn('clip-game dedup failed; falling back to direct stat bump', err);
            }
          }

          const willBumpScorer = needsBumpScorer && !attachedScorer;
          const willBumpAssistIds = needsBumpAssistIds.filter(a => !attachedAssistIds.includes(a));
          if (willBumpScorer || willBumpAssistIds.length > 0) {
            await applyStatsDiff({}, {
              goalScorerId: willBumpScorer ? scorerId : undefined,
              assistByIds: willBumpAssistIds,
            });
          }

          // Persist the credit-tracking fields on the media doc. statsCredited
          // reflects what *this clip* directly bumped (used to roll back on
          // delete/edit). goalScorerId + assistByIds already rode with the
          // initial write (mediaPayload above) so display attribution survives
          // when countsForStats is toggled off.
          try {
            await updateDocument('player_media', newMediaId, {
              statsCredited: !!(willBumpScorer && scorerId),
              statsCreditedAssistIds: willBumpAssistIds,
            } as any);
          } catch (e) { console.warn('failed to persist credit fields', e); }
        }
      }

      setUploadProgress(100);

      // Email + push parents of subject player + any tagged players
      try {
        const { getParentEmailsForPlayer, tplClipUploaded, sendEmailBatch, sendPushToPlayerParents } = await import('../utils/notify');
        const isVideo = Array.from(uploadFiles).some((f: File) => f.type.startsWith('video/'));
        const playerIdsToNotify = Array.from(new Set([uploadPlayerId, ...uploadTaggedPlayers]));
        const messages: any[] = [];
        const sentTo = new Set<string>();
        for (const pid of playerIdsToNotify) {
          const player = players.find(pp => pp.id === pid);
          if (!player) continue;
          const parents = await getParentEmailsForPlayer(pid, 'clip');
          const { subject, html } = tplClipUploaded({
            playerName: player.name,
            uploaderName: userData.name,
            isVideo,
            caption: uploadCaption.trim() || undefined,
            signature: {
              name: userData.name,
              role: isUserCoach ? ((userData as any).coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Coach') : undefined,
              teamName: selectedTeam?.name,
              email: userData.email,
              avatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl,
            },
          });
          for (const p of parents) {
            if (sentTo.has(p.email)) continue;
            sentTo.add(p.email);
            messages.push({ to: p.email, subject, html });
          }
          // Push to parents who have the app — silent for those who don't.
          sendPushToPlayerParents(pid, {
            title: `${player.name}: new ${isVideo ? 'clip' : 'photo'}`,
            body: uploadCaption.trim() || `Uploaded by ${userData.name}`,
            path: `/player/${pid}`,
          }, 'clip');
        }
        if (messages.length > 0) sendEmailBatch(messages);
      } catch (e) { console.warn('clip notify failed', e); }

      resetUploadForm();
      setShowUploadModal(false);
      loadData();
    } catch (error) {
      console.error('Error uploading media:', error);
      alert('Failed to upload. Please try again.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setCompressionStatus('');
    }
  };

  const handleDelete = async (mediaItem: PlayerMediaType) => {
    if (!window.confirm('Delete this media? This cannot be undone.')) return;
    try {
      const m = mediaItem as any;

      // If this clip was linked to a game, scrub our markers from the live
      // timeline. The detach result tells us which credits had been "added"
      // (vs merely attached) so we know what season-stat bumps are ours.
      let creditedAssistIds: string[] = m.statsCreditedAssistIds || (m.statsCredited ? (m.assistByIds || []) : []);
      let creditedScorer = !!(m.statsCredited && m.goalScorerId);
      if (m.gameId) {
        try {
          const { detachClipCreditsFromGame } = await import('../utils/clipGameLink');
          const det = await detachClipCreditsFromGame(m.gameId, mediaItem.id);
          // Trust the detach result over the stale doc fields.
          creditedScorer = det.removedScorer;
          creditedAssistIds = det.removedAssistIds;
        } catch (e) { console.warn('detachClipCreditsFromGame failed', e); }
      }

      if (creditedScorer || creditedAssistIds.length > 0) {
        await applyStatsDiff(
          {
            goalScorerId: creditedScorer ? m.goalScorerId : undefined,
            assistByIds: creditedAssistIds,
          },
          {},
        );
      }

      // Soft-delete pattern (memory: never hard-delete user-facing
      // records — PITR isn't on). Set isActive:false + deletedAt so the
      // doc stays reversible. Queries filter isActive===false so the
      // user sees the item disappear immediately. Prior shape hard-
      // deleted, which also violated the pattern.
      const now = new Date();
      const { updateDocument } = { updateDocument: async (col: string, docId: string, patch: any) => {
        const { doc: fsDoc, updateDoc: fsUpdate } = await import('firebase/firestore');
        const { db: fsDb } = await import('../utils/firebase');
        await fsUpdate(fsDoc(fsDb, col, docId), patch);
      }};
      if (mediaItem.id.startsWith('gallery_')) {
        await updateDocument('gallery', mediaItem.id.replace('gallery_', ''), {
          isActive: false,
          deletedAt: now,
          deletedBy: userData?.uid || null,
        });
      } else {
        await updateDocument('player_media', mediaItem.id, {
          isActive: false,
          deletedAt: now,
          deletedBy: userData?.uid || null,
        });
      }

      // Delete the underlying blobs too — prior shape left every
      // deleted clip's Stream video AND R2 file as paid orphans
      // indefinitely. Fire-and-forget so an API failure doesn't
      // strand the Firestore soft-delete.
      const streamUid = m.streamUid;
      if (streamUid) {
        void (async () => {
          try {
            const { deleteStreamVideo } = await import('../utils/streamUpload');
            const res = await deleteStreamVideo(streamUid);
            if (!res.ok) console.warn('[media] Stream delete failed', streamUid, res.error);
          } catch (err) {
            console.warn('[media] Stream delete threw', err);
          }
        })();
      }
      const r2Url = m.url || m.videoUrl || m.thumbnailUrl;
      if (r2Url && typeof r2Url === 'string' && /^https?:\/\//i.test(r2Url)) {
        void (async () => {
          try {
            const { deleteR2Object } = await import('../utils/r2Upload');
            const res = await deleteR2Object(r2Url);
            if (!res.ok) console.warn('[media] R2 delete failed', r2Url, res.error);
          } catch (err) {
            console.warn('[media] R2 delete threw', err);
          }
        })();
      }
      // Photos may have a separate thumbnail — clean that too.
      if (m.thumbnailUrl && m.thumbnailUrl !== r2Url && typeof m.thumbnailUrl === 'string' && /^https?:\/\//i.test(m.thumbnailUrl)) {
        void (async () => {
          try {
            const { deleteR2Object } = await import('../utils/r2Upload');
            await deleteR2Object(m.thumbnailUrl);
          } catch { /* non-fatal */ }
        })();
      }

      loadData();
    } catch (error) {
      console.error('Error deleting media:', error);
      alert("Couldn't delete that media. Try again.");
    }
  };

  const recordView = async (mediaItem: PlayerMediaType) => {
    if (!userData) return;
    const views = mediaItem.views || [];
    if (views.includes(userData.uid)) return; // already counted
    // Don't count the uploader's own views
    if (mediaItem.uploadedBy === userData.uid) return;
    const newViews = [...views, userData.uid];

    setMedia(prev => prev.map(m =>
      m.id === mediaItem.id ? { ...m, views: newViews, viewCount: newViews.length } : m
    ));
    setSelectedMedia(prev => prev && prev.id === mediaItem.id
      ? { ...prev, views: newViews, viewCount: newViews.length }
      : prev);

    try {
      const collection = mediaItem.id.startsWith('gallery_') ? 'gallery' : 'player_media';
      const docId = mediaItem.id.startsWith('gallery_') ? mediaItem.id.replace('gallery_', '') : mediaItem.id;
      await updateDocument(collection, docId, {
        views: newViews,
        viewCount: newViews.length,
      });
    } catch (error) {
      console.error('Error recording view:', error);
    }
  };

  // Record a view whenever the lightbox opens on a new item
  useEffect(() => {
    if (selectedMedia) recordView(selectedMedia);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMedia?.id]);

  // Generic counter bump for downloads / shares.
  // Counts every tap (so 3 downloads from the same person = 3) but also
  // tracks unique user IDs in an array so we can show *who* did it.
  const bumpEngagement = async (
    mediaItem: PlayerMediaType,
    field: 'downloads' | 'shares',
  ) => {
    if (!userData) return;
    const countField = field === 'downloads' ? 'downloadCount' : 'shareCount';
    const arr = (mediaItem[field] as string[] | undefined) || [];
    const newArr = arr.includes(userData.uid) ? arr : [...arr, userData.uid];
    const newCount = ((mediaItem[countField] as number | undefined) || 0) + 1;

    setMedia(prev => prev.map(m =>
      m.id === mediaItem.id ? { ...m, [field]: newArr, [countField]: newCount } : m
    ));
    setSelectedMedia(prev => prev && prev.id === mediaItem.id
      ? { ...prev, [field]: newArr, [countField]: newCount }
      : prev);

    try {
      const collection = mediaItem.id.startsWith('gallery_') ? 'gallery' : 'player_media';
      const docId = mediaItem.id.startsWith('gallery_') ? mediaItem.id.replace('gallery_', '') : mediaItem.id;
      await updateDocument(collection, docId, {
        [field]: newArr,
        [countField]: newCount,
      });
    } catch (error) {
      console.error(`Error recording ${field}:`, error);
    }
  };

  const handleDownload = async (m: PlayerMediaType) => {
    if (downloadingId) return; // one at a time
    const filename = m.fileName || `${m.playerName}-${m.type}.${m.type === 'video' ? 'mp4' : 'jpg'}`;
    setDownloadingId(m.id);
    setDownloadPercent(0);
    bumpEngagement(m, 'downloads');

    // Resolve the URL to download from.
    // - Stream videos: ask Stream to render an MP4 and grab that URL.
    // - Anything else (photos, legacy R2 videos): the existing `url` field.
    let sourceUrl = m.url;
    if (m.streamUid) {
      try {
        const dl = await getStreamDownloadUrl(m.streamUid);
        if (dl.ready) {
          sourceUrl = dl.url;
        } else {
          setDownloadingId(null);
          alert(`Your high-quality download is still being prepared (${dl.percent}% rendered). Try again in ~30 seconds.`);
          return;
        }
      } catch (err) {
        console.error('Stream download URL failed, falling back to HLS:', err);
        // Fall through with the HLS URL — useless as a download but at least
        // the helper will surface a clean error to the user.
      }
    }

    const result = await downloadFile(sourceUrl, filename, {
      onProgress: p => setDownloadPercent(p.percent),
    });
    setDownloadingId(null);
    setDownloadPercent(0);
    if (result.ok === false && result.reason === 'fetch-failed') {
      // Helper has already opened the file in a new tab as a fallback.
      // Let the user know why their save dialog didn't appear.
      alert("Your browser couldn't save this directly. The file opened in a new tab — long-press (mobile) or right-click (desktop) to save it.");
    }
  };

  // Attach the Cloudflare Stream SDK to the lightbox iframe so we can read
  // currentTime for the "set thumbnail to this frame" action. Re-runs whenever
  // the open clip changes.
  useEffect(() => {
    if (!selectedMedia?.streamUid || !lightboxIframeRef.current) {
      lightboxStreamPlayerRef.current = null;
      return;
    }
    let cancelled = false;
    loadStreamSdk()
      .then(() => {
        if (cancelled || !window.Stream || !lightboxIframeRef.current) return;
        lightboxStreamPlayerRef.current = window.Stream(lightboxIframeRef.current);
      })
      .catch(err => console.warn('Stream SDK load failed — Set Thumbnail disabled', err));
    return () => {
      cancelled = true;
      lightboxStreamPlayerRef.current = null;
    };
  }, [selectedMedia?.streamUid]);

  const handleSetThumbnailFromCurrentFrame = async () => {
    if (!selectedMedia?.streamUid) return;
    if (!canManageMedia) return;
    const player = lightboxStreamPlayerRef.current;
    if (!player) {
      alert('Player is still loading. Wait a moment, then try again.');
      return;
    }
    const t = Math.max(0, Math.floor(Number(player.currentTime) || 0));
    setSavingThumbnail(true);
    try {
      await updateDocument('player_media', selectedMedia.id, {
        posterTimeSeconds: t,
        updatedAt: new Date(),
      });
      // Optimistic local update so the UI flips immediately.
      setMedia(prev => prev.map(m => m.id === selectedMedia.id ? { ...m, posterTimeSeconds: t } : m));
      setSelectedMedia(prev => prev && prev.id === selectedMedia.id ? { ...prev, posterTimeSeconds: t } : prev);
      alert(`Thumbnail set to ${t}s into the clip.`);
    } catch (err) {
      console.error('Failed to set custom thumbnail', err);
      alert('Could not save the thumbnail. Please try again.');
    } finally {
      setSavingThumbnail(false);
    }
  };

  const handleLike = async (mediaItem: PlayerMediaType) => {
    if (!userData) return;
    const likes = mediaItem.likes || [];
    const alreadyLiked = likes.includes(userData.uid);
    const newLikes = alreadyLiked
      ? likes.filter(id => id !== userData.uid)
      : [...likes, userData.uid];

    // Optimistic update
    setMedia(prev => prev.map(m =>
      m.id === mediaItem.id ? { ...m, likes: newLikes, likeCount: newLikes.length } : m
    ));
    if (selectedMedia?.id === mediaItem.id) {
      setSelectedMedia({ ...mediaItem, likes: newLikes, likeCount: newLikes.length });
    }

    try {
      const collection = mediaItem.id.startsWith('gallery_') ? 'gallery' : 'player_media';
      const docId = mediaItem.id.startsWith('gallery_') ? mediaItem.id.replace('gallery_', '') : mediaItem.id;
      await updateDocument(collection, docId, {
        likes: newLikes,
        likeCount: newLikes.length,
      });
    } catch (error) {
      console.error('Error toggling like:', error);
      // Revert on error
      setMedia(prev => prev.map(m =>
        m.id === mediaItem.id ? { ...m, likes, likeCount: likes.length } : m
      ));
    }
  };

  const handleShare = async (mediaItem: PlayerMediaType) => {
    // Use the real Firestore doc ID (strip gallery_ prefix for gallery items)
    const docId = mediaItem.id.startsWith('gallery_') ? mediaItem.id.replace('gallery_', '') : mediaItem.id;
    const shareUrl = `${getShareOrigin()}/media/${encodeURIComponent(docId)}`;
    const shareData = {
      title: mediaItem.caption || `${mediaItem.playerName} - ${mediaItem.type}`,
      url: shareUrl,
    };
    let shared = false;
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        shared = true;
      } else {
        await navigator.clipboard.writeText(shareUrl);
        alert('Link copied to clipboard!');
        shared = true;
      }
    } catch (error) {
      // User cancelled share or error
      if ((error as any)?.name !== 'AbortError') {
        try {
          await navigator.clipboard.writeText(shareUrl);
          alert('Link copied to clipboard!');
          shared = true;
        } catch {
          console.error('Error sharing:', error);
        }
      }
    }
    if (shared) bumpEngagement(mediaItem, 'shares');
  };

  const resetUploadForm = () => {
    setUploadPlayerId('');
    setUploadCaption('');
    setUploadFiles([]);
    setUploadTags([]);
    setUploadTaggedPlayers([]);
    setUploadGoalScorerId('');
    setUploadAssistByIds([]);
    setUploadGameId('');
    setUploadMomentType('');
    setUploadCountsForStats(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Replace a video in-place: keeps Firestore doc ID, likes, tags, caption — only swaps the URL.
  // Works for migrating old Firebase videos to R2 AND for swapping in a re-edited cut later.
  const handleReplaceVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedMedia) return;
    if (!canManageMedia) {
      alert('Only staff can replace clips for this team.');
      return;
    }
    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file.');
      return;
    }
    const decision = checkVideoLimit(file);
    if (!decision.ok) {
      alert(decision.message);
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = '';
      return;
    }
    // Warm-warn zone: mention the size once, up front. The confirm below
    // still fires with the replace-specific "likes/tags preserved" wording,
    // so we don't double-prompt if the file is under the warn threshold.
    if (decision.warn && decision.message) {
      if (!window.confirm(decision.message)) {
        if (replaceFileInputRef.current) replaceFileInputRef.current.value = '';
        return;
      }
    }

    const ok = window.confirm(
      `Replace this video with "${file.name}"?\n\nLikes, tags, and caption will be preserved.`
    );
    if (!ok) {
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = '';
      return;
    }

    try {
      setReplacing(true);
      setReplaceProgress(0);
      const result = await uploadToStream(
        file,
        { name: selectedMedia.caption || file.name, playerId: selectedMedia.playerId, teamId: selectedMedia.teamId },
        (pct) => setReplaceProgress(pct),
      );

      const collection = selectedMedia.id.startsWith('gallery_') ? 'gallery' : 'player_media';
      const docId = selectedMedia.id.startsWith('gallery_') ? selectedMedia.id.replace('gallery_', '') : selectedMedia.id;
      await updateDocument(collection, docId, {
        url: result.hlsUrl,
        streamUid: result.uid,
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
        storageProvider: 'stream',
        previousUrl: selectedMedia.url,
        replacedAt: new Date(),
      });

      // Update local state so lightbox + grid reflect new URL immediately
      const updated = { ...selectedMedia, url: result.hlsUrl, streamUid: result.uid, fileName: file.name, fileSize: file.size, contentType: file.type } as PlayerMediaType;
      setSelectedMedia(updated);
      setMedia(prev => prev.map(m => m.id === selectedMedia.id ? updated : m));
      alert('Video replaced.');
    } catch (err: any) {
      console.error('Replace failed:', err);
      alert(`Replace failed: ${err.message || err}`);
    } finally {
      setReplacing(false);
      setReplaceProgress(0);
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = '';
    }
  };

  const toggleUploadTag = (tag: string) => {
    setUploadTags(prev => {
      if (prev.includes(tag)) return prev.filter(t => t !== tag);
      // Goal and Own Goal are mutually exclusive
      const without = (tag === 'Goal' || tag === 'Own Goal')
        ? prev.filter(t => t !== 'Goal' && t !== 'Own Goal')
        : prev;
      return [...without, tag];
    });
  };

  const toggleTaggedPlayer = (playerId: string) => {
    setUploadTaggedPlayers(prev => prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]);
  };

  const toggleFilterTag = (tag: string) => {
    setFilterTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const toggleEditTag = (tag: string) => {
    setEditingTags(prev => {
      if (!prev) return [tag];
      if (prev.includes(tag)) return prev.filter(t => t !== tag);
      const without = (tag === 'Goal' || tag === 'Own Goal')
        ? prev.filter(t => t !== 'Goal' && t !== 'Own Goal')
        : prev;
      return [...without, tag];
    });
  };

  const handleSaveTags = async () => {
    if (!selectedMedia || editingTags === null) return;
    if (!canManageMedia) return;
    const collection = selectedMedia.id.startsWith('gallery_') ? 'gallery' : 'player_media';
    const docId = selectedMedia.id.startsWith('gallery_') ? selectedMedia.id.replace('gallery_', '') : selectedMedia.id;

    // Same guard as handleUpload: if edited credits exist and there
    // is no game linked, warn about the double-count risk. Only
    // triggers on transitions INTO the risky state (adding credits
    // without a game); un-tagging or removing credits doesn't nag.
    {
      const isOwnGoalEdit = editingTags.includes('Own Goal');
      const isGoalTagEdit = editingTags.includes('Goal') || isOwnGoalEdit;
      const editHasScorer = isGoalTagEdit && !isOwnGoalEdit && !!(editingGoalScorerId || selectedMedia.playerId);
      const editHasAssists = isGoalTagEdit && editingAssistByIds.length > 0;
      const editHasCredits = editHasScorer || editHasAssists;
      if (editHasCredits && !editingGameId && recentGames.length > 0) {
        const scorerName = editHasScorer
          ? (players.find(p => p.id === (editingGoalScorerId || selectedMedia.playerId))?.name || 'a player')
          : null;
        const msg = editHasScorer && editHasAssists
          ? `This clip credits ${scorerName} with a goal plus ${editingAssistByIds.length} assist${editingAssistByIds.length === 1 ? '' : 's'} but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the goal was already tapped in GameDay. Save anyway?`
          : editHasScorer
            ? `This clip credits ${scorerName} with a goal but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the goal was already tapped in GameDay. Save anyway?`
            : `This clip carries assist credits but isn't linked to a game.\n\nLink it to a game to avoid double-counting if the play was already tapped in GameDay. Save anyway?`;
        if (!window.confirm(msg)) return;
      }
    }

    try {
      // Derive taggedPlayerIds from player name tags
      const taggedPlayerIds = players
        .filter(p => editingTags.includes(p.name) && p.id !== selectedMedia.playerId)
        .map(p => p.id);

      // Stats credits: only meaningful when 'Goal' tag is on
      const m = selectedMedia as any;
      // countsForStats respects the upload-time toggle. Undefined = true
      // for backwards-compat with pre-toggle docs. When the coach uploaded
      // with the toggle OFF, we preserve attribution + never bump stats,
      // regardless of what the edit modal does to tags/scorer/assists.
      const mediaCountsForStats = m.countsForStats !== false;
      const wasGoalClip = !!m.statsCredited && !!m.goalScorerId;
      const wasCreditedAssistIds: string[] = m.statsCreditedAssistIds || (wasGoalClip ? (m.assistByIds || []) : []);
      const isOwnGoal = editingTags.includes('Own Goal');
      const isGoalClip = editingTags.includes('Goal') || isOwnGoal;
      const newScorerId = (isGoalClip && !isOwnGoal) ? (editingGoalScorerId || selectedMedia.playerId) : undefined;
      const newAssistIds = isGoalClip ? editingAssistByIds.filter(id => id !== newScorerId) : [];

      const oldGameId: string | undefined = m.gameId;
      const newGameId = editingGameId || undefined;

      // 1. If the clip was previously linked to a game, scrub our markers off
      //    that game's timeline. Returns which credits had been "added" so we
      //    can roll back season stats if the game was already final.
      let priorAddedScorer = false;
      let priorAddedAssistIds: string[] = [];
      if (oldGameId) {
        try {
          const { detachClipCreditsFromGame } = await import('../utils/clipGameLink');
          const det = await detachClipCreditsFromGame(oldGameId, docId);
          priorAddedScorer = det.removedScorer;
          priorAddedAssistIds = det.removedAssistIds;
        } catch (e) { console.warn('detachClipCreditsFromGame failed', e); }
      }

      // 2. Compute the "old" stats footprint we need to undo. With a gameId
      //    link the clip itself only owns the credits that were *added*
      //    (attached credits never bumped season stats); without a link the
      //    clip owns everything it credited.
      const undoCredits = oldGameId
        ? {
            goalScorerId: priorAddedScorer ? m.goalScorerId : undefined,
            assistByIds: priorAddedAssistIds,
          }
        : (wasGoalClip
            ? { goalScorerId: m.goalScorerId, assistByIds: wasCreditedAssistIds }
            : {});

      // 3. Apply credits forward. Skip the whole forward path when the doc
      // was uploaded with countsForStats=false — attribution rides on the
      // doc for display, but the coach opted out of stats/XP/badges at
      // upload time and a no-op resave must not silently credit them.
      let willBumpScorerId: string | undefined;
      let willBumpAssistIds: string[] = [];
      if (mediaCountsForStats && (newScorerId || newAssistIds.length > 0) && newGameId) {
        try {
          const { attachClipCreditsToGame } = await import('../utils/clipGameLink');
          const scorer = newScorerId ? players.find(p => p.id === newScorerId) : undefined;
          const assistsById: Record<string, { name?: string; jersey?: number }> = {};
          for (const aid of newAssistIds) {
            const ap = players.find(pp => pp.id === aid);
            if (ap) assistsById[aid] = { name: ap.name, jersey: ap.jerseyNumber };
          }
          const res = await attachClipCreditsToGame({
            gameId: newGameId,
            mediaId: docId,
            clipUrl: selectedMedia.url,
            scorerId: newScorerId,
            scorerName: scorer?.name,
            scorerJersey: scorer?.jerseyNumber,
            assistIds: newAssistIds,
            assistsById,
            recordedBy: userData?.uid,
            recordedByName: userData?.name,
          });
          if (res.status === 'final') {
            // Only bump when the game's countsToStats flag allows it.
            // Scrimmage/demo games opt out of rollup, so linking a clip
            // to one shouldn't backdoor stats into the player card.
            willBumpScorerId = (res.addedScorer && res.countsToStats) ? newScorerId : undefined;
            willBumpAssistIds = res.countsToStats ? res.addedAssistIds : [];
          } else if (res.status === 'no-doc') {
            // Game has no live doc — fall back to direct bump
            willBumpScorerId = newScorerId;
            willBumpAssistIds = newAssistIds;
          } else {
            // live/halftime/scheduled → finalize will count, no immediate bump
          }
        } catch (e) {
          console.warn('attachClipCreditsToGame failed; falling back to direct bump', e);
          willBumpScorerId = newScorerId;
          willBumpAssistIds = newAssistIds;
        }
      } else if (mediaCountsForStats && (newScorerId || newAssistIds.length > 0)) {
        willBumpScorerId = newScorerId;
        willBumpAssistIds = newAssistIds;
      }

      await applyStatsDiff(
        undoCredits,
        (willBumpScorerId || willBumpAssistIds.length > 0)
          ? { goalScorerId: willBumpScorerId, assistByIds: willBumpAssistIds }
          : {},
      );

      const update: any = {
        tags: editingTags,
        taggedPlayerIds: taggedPlayerIds.length > 0 ? taggedPlayerIds : [],
        goalScorerId: newScorerId || null,
        assistByIds: newAssistIds.length > 0 ? newAssistIds : [],
        statsCredited: !!(willBumpScorerId),
        statsCreditedAssistIds: willBumpAssistIds,
        gameId: newGameId || null,
        isOwnGoal: isOwnGoal ? true : null,
        // Preserve the upload-time toggle when it was explicitly set. An
        // explicit false stays false so the next edit-save round-trip
        // keeps skipping the stat bump; legacy undefined stays undefined
        // (reads as true, matches pre-toggle behavior).
        ...(m.countsForStats === false ? { countsForStats: false } : {}),
      };
      await updateDocument(collection, docId, update);

      // Email + push parents of NEWLY tagged players only
      try {
        const prevTaggedIds: string[] = (selectedMedia as any).taggedPlayerIds || [];
        const newlyTagged = taggedPlayerIds.filter(id => !prevTaggedIds.includes(id));
        if (newlyTagged.length > 0 && userData) {
          const { getParentEmailsForPlayer, tplClipUploaded, sendEmailBatch, sendPushToPlayerParents } = await import('../utils/notify');
          const isVideo = (selectedMedia as any).type === 'video';
          const messages: any[] = [];
          const sentTo = new Set<string>();
          for (const pid of newlyTagged) {
            const tp = players.find(pp => pp.id === pid);
            if (!tp) continue;
            const parents = await getParentEmailsForPlayer(pid, 'clip');
            const { subject, html } = tplClipUploaded({
              playerName: tp.name,
              uploaderName: userData.name,
              isVideo,
              caption: (selectedMedia as any).caption || undefined,
              signature: {
                name: userData.name,
                role: isUserCoach ? ((userData as any).coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Coach') : undefined,
                teamName: selectedTeam?.name,
                email: userData.email,
                avatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl,
              },
            });
            for (const p of parents) {
              if (sentTo.has(p.email)) continue;
              sentTo.add(p.email);
              messages.push({ to: p.email, subject, html });
            }
            sendPushToPlayerParents(pid, {
              title: `${tp.name} tagged in a ${isVideo ? 'clip' : 'photo'}`,
              body: (selectedMedia as any).caption || `Tagged by ${userData.name}`,
              path: `/player/${pid}`,
            }, 'clip');
          }
          if (messages.length > 0) sendEmailBatch(messages);
        }
      } catch (e) { console.warn('tag-add notify failed', e); }

      // Update local state
      const localPatch: any = { tags: editingTags, taggedPlayerIds, goalScorerId: newScorerId, assistByIds: newAssistIds, statsCredited: !!willBumpScorerId, statsCreditedAssistIds: willBumpAssistIds, gameId: newGameId, isOwnGoal };
      setMedia(prev => prev.map(m2 => m2.id === selectedMedia.id ? { ...m2, ...localPatch } as PlayerMediaType : m2));
      setSelectedMedia({ ...selectedMedia, ...localPatch } as PlayerMediaType);
      setEditingTags(null);
      setEditingGoalScorerId('');
      setEditingAssistByIds([]);
      setEditingGameId('');
    } catch (err) {
      console.error('Error saving tags:', err);
      alert('Failed to save tags.');
    }
  };

  // Get all unique tags across media for filter options
  const allMediaTags = Array.from(new Set(media.flatMap(m => m.tags || [])));

  // A clip "belongs to" a player if they are attributed on it in ANY of
  // the four attribution paths: primary subject, tagged-in ("Who's in
  // this clip?"), goal scorer, or assist. Prior versions only checked
  // playerId + taggedPlayerIds, which missed anyone who was ONLY the
  // scorer or assister — so a kid tagged as "Assisted by" on a
  // teammate's goal clip didn't show up in Browse by Player at all,
  // and multi-attribution players (scorer on one clip + assist on
  // another) undercounted.
  const mediaBelongsToPlayer = (m: PlayerMediaType, playerId: string): boolean => {
    if (m.playerId === playerId) return true;
    if ((m.taggedPlayerIds || []).includes(playerId)) return true;
    if ((m as any).goalScorerId === playerId) return true;
    if (Array.isArray((m as any).assistByIds) && (m as any).assistByIds.includes(playerId)) return true;
    return false;
  };

  // Filter by selected player (any attribution). 'all' shows everything.
  const playerFilteredMedia = (selectedPlayerId && selectedPlayerId !== 'all')
    ? media.filter(m => mediaBelongsToPlayer(m, selectedPlayerId))
    : media;
  // Split by media type (videos / photos / both) before tags + search.
  // 'highlight' is a filter across BOTH types — anything with a
  // coach-tagged momentType shows here, video or photo.
  const typeFilteredMedia = mediaTypeFilter === 'all'
    ? playerFilteredMedia
    : mediaTypeFilter === 'highlight'
      ? playerFilteredMedia.filter(m => !!m.momentType)
      : playerFilteredMedia.filter(m => (m.type || 'video') === mediaTypeFilter);
  // Filter media by selected tags
  const tagFilteredMedia = filterTags.length > 0
    ? typeFilteredMedia.filter(m => filterTags.some(t => m.tags?.includes(t)))
    : typeFilteredMedia;
  // Then filter by search query (caption, player name, tags, fileName)
  const allFilteredMedia = searchQuery.trim()
    ? tagFilteredMedia.filter(m => {
        const q = searchQuery.toLowerCase();
        return (
          (m.caption || '').toLowerCase().includes(q) ||
          (m.playerName || '').toLowerCase().includes(q) ||
          (m.fileName || '').toLowerCase().includes(q) ||
          (m.tags || []).some(t => t.toLowerCase().includes(q))
        );
      })
    : tagFilteredMedia;
  const filteredMedia = allFilteredMedia.slice(0, visibleCount);
  const hasMore = allFilteredMedia.length > visibleCount;

  // ── Stats / Featured sections (computed on full unfiltered media) ──
  const totalClips = media.filter(m => m.type === 'video').length;
  const seasonStart = new Date();
  seasonStart.setMonth(seasonStart.getMonth() - 6);
  const thisSeasonCount = media.filter(m => {
    const d: any = m.createdAt;
    const date = d?.toDate ? d.toDate() : new Date(d);
    return date >= seasonStart;
  }).length;
  const mostLikedItem = [...media].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))[0];
  // Recent highlights: latest videos first, then photos
  const recentHighlights = [...media]
    .sort((a, b) => {
      const da: any = a.createdAt; const db: any = b.createdAt;
      const ta = (da?.toDate ? da.toDate() : new Date(da)).getTime();
      const tb = (db?.toDate ? db.toDate() : new Date(db)).getTime();
      return tb - ta;
    })
    .slice(0, 3);
  // Top plays this season: most-liked from last 6 months, top 3
  const topPlaysThisSeason = media
    .filter(m => {
      const d: any = m.createdAt;
      const date = d?.toDate ? d.toDate() : new Date(d);
      return date >= seasonStart && (m.likeCount || 0) > 0;
    })
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, 3);
  // Players with clip counts (for browse-by-player row). Uses the same
  // 4-attribution predicate as playerFilteredMedia so counts match what
  // you see when you tap the chip.
  const playersWithCounts = players
    .map(p => ({
      player: p,
      count: media.filter(m => mediaBelongsToPlayer(m, p.id)).length,
    }))
    .filter(p => p.count > 0)
    .sort((a, b) => b.count - a.count);

  // Video size cap lives in src/utils/streamUpload.ts (checkVideoLimit).
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

  const compressImage = (file: File): Promise<File> => {
    return new Promise((resolve) => {
      if (file.size <= 1024 * 1024) { resolve(file); return; } // Skip if under 1MB
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const MAX_DIM = 1920;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob && blob.size < file.size) {
            resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          } else {
            resolve(file);
          }
        }, 'image/jpeg', 0.8);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // Filter valid types
    const valid = files.filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    if (valid.length !== files.length) {
      alert('Some files were skipped. Only images and videos are allowed.');
    }
    // Videos over the hard cap: block each with warm copy, drop from the
    // batch, and keep going so a bulk pick with multiple oversized clips
    // doesn't leave any staged. Images still get their local 10 MB cap.
    const tooBigVideos = new Set<File>();
    for (const v of valid.filter(f => f.type.startsWith('video/'))) {
      const decision = checkVideoLimit(v);
      if (!decision.ok) {
        alert(decision.message);
        tooBigVideos.add(v);
      }
    }
    let kept = valid.filter(f => !tooBigVideos.has(f));

    const oversizedImages = kept.filter(f =>
      f.type.startsWith('image/') && f.size > MAX_IMAGE_SIZE
    );
    if (oversizedImages.length > 0) {
      alert(`${oversizedImages.length} photo(s) are too large. Photos must be under 10 MB.`);
      kept = kept.filter(f => !oversizedImages.includes(f));
    }

    // Warm-warn zone (100-500 MB): confirm per video. Canceling drops just
    // that clip from the batch, not the entire pick — so a small photo
    // selected alongside a long video still stages when the coach bails.
    const skippedWarnVideos = new Set<File>();
    for (const v of kept.filter(f => f.type.startsWith('video/'))) {
      const decision = checkVideoLimit(v);
      if (decision.ok && decision.warn && decision.message) {
        if (!window.confirm(decision.message)) skippedWarnVideos.add(v);
      }
    }
    setUploadFiles(kept.filter(f => !skippedWarnVideos.has(f)));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Group media by player. Same 4-attribution predicate as counts +
  // filter so a kid who assisted on someone else's goal is still
  // listed under their own player group.
  const mediaByPlayer = players.map(player => ({
    player,
    items: filteredMedia.filter(m => mediaBelongsToPlayer(m, player.id)),
  })).filter(group => group.items.length > 0);

  if (loading) return <DataGate when="loading" />;

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Page title — Patrick's half-empty critique flagged the
            previous 'MEDIA / HIGHLIGHTS · MOMENTS · MEMORIES' hero
            as a 200px banner that earned nothing. Replaced with a
            single-row title; the tab bar below carries the rest of
            the navigation. */}
        <div className="mb-4 flex items-baseline gap-3">
          <h1 className="text-2xl sm:text-3xl font-black text-ink-primary">Media</h1>
          <span className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40">
            Highlights · Moments · Memories
          </span>
        </div>

        {/* ── TABS + SEARCH + UPLOAD ──────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-4 mb-6 border-b border-line-default/10 pb-2">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setActiveTab('highlights')}
              className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors relative ${
                activeTab === 'highlights' ? 'text-brand-primary-soft' : 'text-ink-primary/50 hover:text-ink-primary'
              }`}
            >
              Highlights
              {activeTab === 'highlights' && <span className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-brand-primary-soft rounded-full" />}
            </button>
            <button
              onClick={() => setActiveTab('fullgames')}
              className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors relative ${
                activeTab === 'fullgames' ? 'text-brand-primary-soft' : 'text-ink-primary/50 hover:text-ink-primary'
              }`}
            >
              Full Games
              {activeTab === 'fullgames' && <span className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-brand-primary-soft rounded-full" />}
            </button>
            <button
              onClick={() => setActiveTab('photos')}
              className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors relative ${
                activeTab === 'photos' ? 'text-brand-primary-soft' : 'text-ink-primary/50 hover:text-ink-primary'
              }`}
            >
              Photos
              {activeTab === 'photos' && <span className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-brand-primary-soft rounded-full" />}
            </button>
            {canManageMedia && (selectedTeam?.videoTier || 'free') === 'free' && (
              <button
                onClick={() => navigate('/upgrade/video')}
                className="ml-2 px-3 py-1.5 rounded-full text-[11px] font-extrabold uppercase tracking-widest bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/40 hover:bg-amber-500/25 transition-colors"
              >
                Upgrade
              </button>
            )}
          </div>
          {activeTab === 'highlights' && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search highlights..."
                  className="w-44 sm:w-64 pl-9 pr-3 py-2 bg-surface-input border border-line-default/10 rounded-lg text-sm text-ink-primary placeholder:text-ink-primary/45 focus:outline-none focus:ring-2 focus:ring-brand-primary/50 focus:border-brand-primary/50"
                />
                <svg className="absolute left-2.5 top-2.5 w-4 h-4 text-ink-primary/50" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
              </div>
              {canManageMedia && (
                <>
                  <button
                    onClick={() => setShowEmbedModal(true)}
                    className="bg-surface-elevated text-ink-primary ring-1 ring-line-default/15 hover:bg-line-default/[0.08] px-3 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-1.5"
                    title="Paste a YouTube or Trace link"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    <span className="hidden sm:inline">Link</span>
                  </button>
                  <button
                    onClick={() => {
                      if (trialGated) { setTrialGateOpen(true); return; }
                      resetUploadForm(); setShowUploadModal(true);
                    }}
                    className="bg-brand-primary hover:bg-brand-primary-soft text-ink-primary px-4 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    <span className="hidden sm:inline">Upload</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {activeTab === 'fullgames' ? (
          <div className="bg-surface-elevated rounded-2xl overflow-hidden">
            <FullGames />
          </div>
        ) : activeTab === 'photos' ? (
          <div className="-mx-4 sm:-mx-6 lg:-mx-8">
            <PhotosTab
              players={players}
              events={allTeamEvents}
            />
          </div>
        ) : (
          <>
            {/* ── RECENT HIGHLIGHTS ─────────────────────────────────── */}
            {selectedPlayerId === 'all' && recentHighlights.length > 0 && (
              <section className="mb-10">
                <SectionHeader title="Recent Highlights" />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recentHighlights.map(item => {
                    const player = players.find(p => p.id === item.playerId);
                    const dateObj: any = item.createdAt;
                    const date = dateObj?.toDate ? dateObj.toDate() : new Date(dateObj);
                    return (
                      <FeaturedCard
                        key={item.id}
                        item={item}
                        player={player}
                        timeAgo={timeAgo(date)}
                        onClick={() => setSelectedMedia(item)}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── BROWSE BY PLAYER ──────────────────────────────────── */}
            {playersWithCounts.length > 0 && (
              <section className="mb-10">
                <SectionHeader
                  title="Browse by Player"
                  action={selectedPlayerId !== 'all' ? { label: 'View all', onClick: () => setSelectedPlayerId('all') } : undefined}
                />
                {/* Horizontal-only scroll. The wrapper is the scroll
                    container (overflow-x-auto, overflow-y-hidden), and
                    the inner row uses pt-2 / pb-3 so the ring on selected
                    avatars isn't clipped at top or bottom. Fade gradients
                    on the right edge tell the user there's more. */}
                <div className="relative">
                  <div
                    className="flex gap-4 overflow-x-auto overflow-y-hidden -mx-2 px-2 py-2 scrollbar-thin"
                    style={{ scrollbarGutter: 'stable', WebkitOverflowScrolling: 'touch' }}
                  >
                    <button
                      onClick={() => setSelectedPlayerId('all')}
                      className={`flex flex-col items-center flex-shrink-0 transition-transform hover:scale-105 ${selectedPlayerId === 'all' ? 'scale-105' : ''}`}
                    >
                      <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint flex items-center justify-center text-white text-2xl font-black ring-2 ring-offset-2 ring-offset-surface-base ${selectedPlayerId === 'all' ? 'ring-brand-primary-soft' : 'ring-transparent'}`}>
                        ALL
                      </div>
                      <span className="text-xs text-ink-primary font-medium mt-2">All</span>
                      <span className="text-[10px] text-ink-primary/50">{media.length} clips</span>
                    </button>
                    {/* Parent's kid floats to the front for them. */}
                    {playersWithCounts
                      .slice()
                      .sort((a, b) => {
                        if (a.player.id === parentLinkedPlayerId) return -1;
                        if (b.player.id === parentLinkedPlayerId) return 1;
                        return 0;
                      })
                      .map(({ player, count }) => (
                      <button
                        key={player.id}
                        onClick={() => setSelectedPlayerId(player.id)}
                        className={`flex flex-col items-center flex-shrink-0 transition-transform hover:scale-105 ${selectedPlayerId === player.id ? 'scale-105' : ''}`}
                      >
                        <div className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-full overflow-hidden bg-gradient-to-br from-surface-raised to-surface-elevated ring-2 ring-offset-2 ring-offset-surface-base ${selectedPlayerId === player.id ? 'ring-brand-primary-soft' : 'ring-transparent'}`}>
                          {player.profilePhotoUrl ? (
                            <img src={player.profilePhotoUrl} alt={player.name} className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-white text-xl font-black">
                              {player.jerseyNumber || player.name.charAt(0)}
                            </div>
                          )}
                          {player.profilePhotoUrl && player.jerseyNumber != null && (
                            <span className="absolute -bottom-0.5 -right-0.5 bg-brand-primary text-ink-primary rounded-full min-w-[22px] h-[22px] px-1.5 flex items-center justify-center text-[11px] font-black shadow ring-2 ring-charcoal-950">
                              {player.jerseyNumber}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-ink-primary font-medium mt-2 max-w-[80px] truncate">{player.name.split(' ')[0]}</span>
                        <span className="text-[10px] text-ink-primary/50">{count} clip{count !== 1 ? 's' : ''}</span>
                      </button>
                    ))}
                  </div>
                  {/* Right-edge fade — discoverability cue that there's
                      more to scroll. Hidden on small screens via
                      pointer-events:none + gradient. */}
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-surface-base via-surface-base/70 to-transparent" />
                </div>
              </section>
            )}

            {/* ── TOP PLAYS THIS SEASON ─────────────────────────────── */}
            {selectedPlayerId === 'all' && topPlaysThisSeason.length > 0 && (
              <section className="mb-10">
                <SectionHeader title="Top Plays This Season" />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {topPlaysThisSeason.map((item, idx) => (
                    <RankedCard
                      key={item.id}
                      rank={idx + 1}
                      item={item}
                      onClick={() => setSelectedMedia(item)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* ── ALL CLIPS / FILTERED VIEW ─────────────────────────── */}
            <section ref={clipsSectionRef} className="mb-10 scroll-mt-24">
              {selectedPlayerId !== 'all' && (
                <button
                  onClick={() => setSelectedPlayerId('all')}
                  className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full bg-line-default/5 ring-1 ring-line-default/10 text-sm font-medium text-brand-primary-soft hover:bg-line-default/10 hover:text-ink-primary transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
                  Back to all clips
                </button>
              )}
              <SectionHeader
                title={selectedPlayerId === 'all' ? 'All Clips' : `${players.find(p => p.id === selectedPlayerId)?.name || 'Player'}'s Clips`}
                action={
                  allMediaTags.length > 0
                    ? { label: filterTags.length > 0 ? `Filters (${filterTags.length}) ✕` : 'Filter by tag', onClick: () => filterTags.length > 0 ? setFilterTags([]) : null }
                    : undefined
                }
              />

              {/* Media-type toggle + tag chips. Always visible above the
                  grid (not hidden in a sticky bar that pushed the avatar
                  rings off-screen). */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="inline-flex bg-line-default/5 ring-1 ring-line-default/10 rounded-full p-0.5 flex-shrink-0">
                  {[
                    { k: 'all' as const, label: 'All' },
                    { k: 'photo' as const, label: 'Photos' },
                    { k: 'video' as const, label: 'Videos' },
                    { k: 'highlight' as const, label: 'Moments' },
                  ].map((opt) => (
                    <button
                      key={opt.k}
                      onClick={() => setMediaTypeFilter(opt.k)}
                      className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                        mediaTypeFilter === opt.k ? 'bg-surface-elevated text-ink-primary shadow-sm' : 'text-ink-primary/60 hover:text-ink-primary'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {allMediaTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleFilterTag(tag)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      filterTags.includes(tag)
                        ? 'bg-brand-primary text-ink-primary'
                        : 'bg-line-default/5 text-ink-primary/35 hover:bg-line-default/10 border border-line-default/10'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>

              {selectedPlayerId === 'all' ? (
                mediaByPlayer.length > 0 ? (
                  <div className="space-y-8">
                    {mediaByPlayer.map(({ player, items }) => (
                      <div key={player.id}>
                        <div className="flex items-center space-x-3 mb-3">
                          {player.profilePhotoUrl ? (
                            <div className="relative w-9 h-9">
                              <img src={player.profilePhotoUrl} alt={player.name} className="w-9 h-9 rounded-full object-cover ring-2 ring-brand-primary/30" loading="lazy" />
                              {player.jerseyNumber != null && (
                                <span className="absolute -bottom-1 -right-1 bg-brand-primary text-ink-primary rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center text-[9px] font-black ring-1 ring-charcoal-950">
                                  {player.jerseyNumber}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="w-9 h-9 bg-gradient-to-br from-surface-raised to-surface-elevated rounded-full flex items-center justify-center text-white font-bold text-xs ring-2 ring-brand-primary/30">
                              {player.jerseyNumber || player.name.charAt(0)}
                            </div>
                          )}
                          <h3 className="text-base font-bold text-ink-primary">{player.name}</h3>
                          <span className="text-xs text-ink-primary/50">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                        </div>
                        <DarkMediaGrid items={items} onView={setSelectedMedia} onDelete={handleDelete} onLike={handleLike} onShare={handleShare} userData={userData} isUserCoach={isUserCoach} />
                      </div>
                    ))}
                    {hasMore && (
                      <div className="text-center pt-4">
                        <button
                          onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                          className="px-6 py-2.5 bg-line-default/5 border border-line-default/10 rounded-lg text-sm font-medium text-ink-primary hover:bg-line-default/10 transition-colors"
                        >
                          Load More ({allFilteredMedia.length - visibleCount} remaining)
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="relative overflow-hidden text-center py-12 sm:py-16 bg-surface-elevated rounded-2xl border border-line-default/10 shadow-sm">
                    {/* Soft brand-tinted glow so the empty state reads
                        as "intentional and awaiting content" rather
                        than "the page failed to load." */}
                    <div aria-hidden className="absolute -top-16 -right-16 w-48 h-48 bg-brand-primary/10 rounded-full blur-3xl pointer-events-none" />
                    <div className="relative">
                      <div className="mx-auto w-14 h-14 rounded-2xl bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft flex items-center justify-center mb-4">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                      </div>
                      <h3 className="text-lg font-black text-ink-primary">
                        {isUserCoach ? 'The team highlight reel starts here' : 'Photos and clips will land here'}
                      </h3>
                      <p className="text-sm text-ink-primary/60 mt-1.5 max-w-xs mx-auto leading-snug">
                        {isUserCoach
                          ? isAdultTeam
                            ? 'Drop in photos or short clips from training and games. Players get a notification the moment they show up in one.'
                            : 'Drop in photos or short clips from practice and games. Parents get a notification the moment their kid shows up in one.'
                          : isAdultTeam
                            ? 'Your coach will start sharing photos and clips from training and games. Every one that features you gets pushed to you.'
                            : 'Your coach will start sharing photos and clips from practices and games. Every one that features your kid gets pushed to you.'}
                      </p>
                      {isUserCoach && (
                        <button
                          type="button"
                          onClick={() => setShowUploadModal(true)}
                          className="mt-5 inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-primary-dim text-white font-bold text-sm shadow-sm transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
                          <span>Upload first media</span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <>
                  <DarkMediaGrid
                    items={filteredMedia}
                    onView={setSelectedMedia}
                    onDelete={handleDelete}
                    onLike={handleLike}
                    onShare={handleShare}
                    userData={userData}
                    isUserCoach={isUserCoach}
                    emptyLabel={mediaTypeFilter === 'highlight'
                      ? (isUserCoach
                          ? 'No moments tagged yet. Pick a moment (Goal, Assist, or Big play) next time you upload a clip.'
                          : 'No moments tagged yet. Coaches can tag goals, assists, and big plays. They will show up here.')
                      : undefined}
                  />
                  {hasMore && (
                    <div className="text-center pt-4">
                      <button
                        onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                        className="px-6 py-2.5 bg-line-default/5 border border-line-default/10 rounded-lg text-sm font-medium text-ink-primary hover:bg-line-default/10 transition-colors"
                      >
                        Load More ({allFilteredMedia.length - visibleCount} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}

        <EmbedMediaModal
          isOpen={showEmbedModal}
          onClose={() => setShowEmbedModal(false)}
          players={players.map(p => ({ id: p.id, name: p.name }))}
          onSubmit={async (payload) => {
            if (!userData || !selectedTeamId) throw new Error('Missing context');
            // YouTube has predictable thumbnail URLs — pull them from
            // img.youtube.com so the gallery card has something to show
            // instead of a black square. Trace doesn't expose a public
            // thumbnail URL pattern, so its thumbnails stay placeholder.
            let thumbnailUrl: string | undefined;
            if (payload.source === 'youtube') {
              const m = payload.embedUrl.match(/youtube\.com\/embed\/([\w-]{11})/);
              if (m) thumbnailUrl = `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
            }
            const mediaDoc: any = {
              playerId: payload.playerId,
              playerName: payload.playerName,
              teamId: selectedTeamId,
              url: payload.url,
              embedUrl: payload.embedUrl,
              source: payload.source,
              thumbnailUrl,
              type: 'video',
              caption: payload.caption || undefined,
              uploadedBy: userData.uid,
              uploadedByName: userData.name || 'Coach',
              fileSize: 0,
              fileName: payload.source === 'youtube' ? 'YouTube link' : payload.source === 'trace' ? 'Trace highlight' : 'External video',
              contentType: 'video/embed',
              tags: ['Highlight'],
              taggedPlayerIds: [payload.playerId],
            };
            await addPlayerMedia(mediaDoc);
            // Push parents — same template as a real upload so the
            // notification carries the same weight.
            try {
              const { getParentEmailsForPlayer, tplClipUploaded, sendEmailBatch, sendPushToPlayerParents } = await import('../utils/notify');
              const parents = await getParentEmailsForPlayer(payload.playerId, 'clip');
              if (parents.length > 0) {
                const { subject, html } = tplClipUploaded({
                  playerName: payload.playerName,
                  uploaderName: userData.name || 'Coach',
                  isVideo: true,
                  caption: payload.caption,
                  signature: {
                    name: userData.name || 'Coach',
                    role: isUserCoach ? ((userData as any).coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Coach') : undefined,
                    teamName: selectedTeam?.name,
                    email: userData.email,
                    avatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl,
                  },
                });
                sendEmailBatch(parents.map(p => ({ to: p.email, subject, html })));
              }
              sendPushToPlayerParents(payload.playerId, {
                title: `${payload.playerName}: new clip`,
                body: payload.caption || `Shared by ${userData.name || 'Coach'}`,
                path: `/player/${payload.playerId}`,
              }, 'clip');
            } catch (e) { console.warn('embed notify failed', e); }
          }}
        />

        {/* Upload Modal */}
        {showUploadModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface-elevated rounded-xl shadow-xl max-w-lg w-full max-h-[calc(100vh-2rem)] overflow-y-auto overscroll-contain">
              <div className="p-6">
                <h2 className="text-xl font-bold text-ink-primary mb-4">Upload Player Media</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Player *</label>
                    <select
                      value={uploadPlayerId}
                      onChange={e => setUploadPlayerId(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary"
                    >
                      <option value="">Select player...</option>
                      {players.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Files (Photos & Videos)</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      onChange={handleFileSelect}
                      className="w-full text-sm text-ink-primary/65"
                    />
                    {uploadFiles.length > 0 && (
                      <p className="text-xs text-ink-primary/50 mt-1">
                        {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''} selected ({
                          formatFileSize(uploadFiles.reduce((s, f) => s + f.size, 0))
                        })
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Caption</label>
                    <input
                      type="text"
                      value={uploadCaption}
                      onChange={e => setUploadCaption(e.target.value)}
                      className="w-full px-3 py-2 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary"
                      placeholder="Optional caption..."
                    />
                  </div>
                  {/* Highlight picker — coach-only display tag.
                      Explicitly NOT a stat entry: no XP, no badges,
                      no live-game write. Copy calls this out so a
                      coach never confuses it with the Goal/Assist
                      tag row below (which DOES bump stats). */}
                  {isUserCoach && (
                    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-3 sm:p-4">
                      <div className="flex items-baseline justify-between mb-1">
                        <label className="text-sm font-bold text-ink-primary">Tag this moment</label>
                        <span className="text-[10px] font-black tracking-widest uppercase text-ink-primary/45">Display only</span>
                      </div>
                      <p className="text-xs text-ink-primary/60 mb-3 leading-snug">
                        Optional. This tags the clip so it surfaces under the Moments filter. It does not count as a stat or grant XP. Use the Goal or Assist tag below for stats.
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {([
                          { key: '' as const,        label: 'None',      hint: 'Just a clip' },
                          ...MOMENT_TYPES.map(m => ({ key: m.key, label: m.short, hint: m.hint })),
                        ]).map(opt => {
                          const on = uploadMomentType === (opt.key as MomentType | '');
                          return (
                            <button
                              key={opt.key || 'none'}
                              type="button"
                              onClick={() => setUploadMomentType(opt.key as MomentType | '')}
                              className={`flex flex-col items-center justify-center gap-1.5 rounded-xl p-3 text-center transition ring-1 ${
                                on
                                  ? 'bg-brand-primary/15 ring-brand-primary-soft/60 text-ink-primary'
                                  : 'bg-transparent ring-line-default/15 text-ink-primary/70 hover:bg-line-default/[0.05]'
                              }`}
                            >
                              <span className={on ? 'text-brand-primary-soft' : 'text-ink-primary/55'}>
                                {opt.key === '' ? (
                                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M4 4l16 16" />
                                    <circle cx="12" cy="12" r="9" />
                                  </svg>
                                ) : (
                                  <MomentIcon kind={opt.key as 'goal' | 'assist' | 'big_play'} />
                                )}
                              </span>
                              <span className="text-xs font-bold leading-none">{opt.label}</span>
                              <span className="text-[10px] text-ink-primary/45 leading-tight">{opt.hint}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Tags</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ACTIVITY_TAGS.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleUploadTag(tag)}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                            uploadTags.includes(tag)
                              ? 'bg-brand-primary text-white'
                              : 'bg-line-default/[0.08] text-ink-primary/65 hover:bg-line-default/[0.1]'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(uploadTags.includes('Goal') || uploadTags.includes('Own Goal')) && players.length > 0 && (
                    <div className="rounded-lg border border-brand-primary-soft/30 bg-brand-primary/15/60 p-3 space-y-3">
                      {uploadTags.includes('Own Goal') && (
                        <div className="text-xs text-rose-300 bg-rose-500/15 border border-rose-400/30 rounded px-2 py-1.5">
                          🥅 <strong>Own goal:</strong> team gets +1, no scorer credit. Award the assist below if applicable.
                        </div>
                      )}
                      {!uploadTags.includes('Own Goal') && (
                        <div>
                          <label className="block text-sm font-medium text-ink-primary/85 mb-1">⚽ Goal scorer</label>
                          <div className="flex flex-wrap gap-1.5">
                            {players.map(p => {
                              const isSel = (uploadGoalScorerId || uploadPlayerId) === p.id;
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => setUploadGoalScorerId(p.id)}
                                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                    isSel ? 'bg-brand-primary text-white' : 'bg-surface-elevated text-ink-primary/65 border border-line-default/10 hover:bg-line-default/[0.05]'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-xs text-ink-primary/50 mt-1">Defaults to the player this clip is for. +1 to their goals.</p>
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-ink-primary/85 mb-1">🅰️ Assisted by <span className="text-ink-primary/40 font-normal">(optional)</span></label>
                        <div className="flex flex-wrap gap-1.5">
                          {players
                            .filter(p => uploadTags.includes('Own Goal') || p.id !== (uploadGoalScorerId || uploadPlayerId))
                            .map(p => {
                              const isSel = uploadAssistByIds.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => setUploadAssistByIds(prev => isSel ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                    isSel ? 'bg-violet-600 text-white' : 'bg-surface-elevated text-ink-primary/65 border border-line-default/10 hover:bg-line-default/[0.05]'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                        </div>
                        <p className="text-xs text-ink-primary/50 mt-1">Each pick gets +1 to their assists.</p>
                      </div>
                      {isUserCoach && (
                        <div className="flex items-start gap-3 pt-3 border-t border-line-default/15">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={uploadCountsForStats}
                            aria-label="Count toward stats"
                            onClick={() => setUploadCountsForStats(v => !v)}
                            className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition ${
                              uploadCountsForStats ? 'bg-brand-primary' : 'bg-line-default/25'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition ${
                                uploadCountsForStats ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-ink-primary leading-tight">Count toward stats</div>
                            <p className="text-xs text-ink-primary/60 mt-0.5 leading-snug">
                              {uploadCountsForStats
                                ? 'Adds to their season stats. Earns XP, may unlock a badge.'
                                : 'Just a highlight. No stats change, and the scorer chip still shows on the clip.'}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {recentGames.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                        Link to game <span className="text-ink-primary/40 font-normal">(optional, prevents double-counting)</span>
                      </label>
                      <select
                        value={uploadGameId}
                        onChange={e => setUploadGameId(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-line-default/15 focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/20 text-sm"
                      >
                        <option value="">— Not linked —</option>
                        {recentGames.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                      </select>
                      <p className="text-xs text-ink-primary/50 mt-1">If the coach already tapped this goal on Game Day, linking attaches your clip without doubling stats.</p>
                    </div>
                  )}
                  {players.length > 1 && (
                    <div className="rounded-xl bg-brand-primary/[0.05] ring-1 ring-brand-primary-soft/20 p-3">
                      <div className="flex items-baseline justify-between mb-2">
                        <label className="text-sm font-bold text-ink-primary/85">
                          Who's in this clip?
                          {uploadTaggedPlayers.length > 0 && (
                            <span className="ml-2 text-[10px] font-black text-brand-primary-soft tabular-nums">{uploadTaggedPlayers.length}</span>
                          )}
                        </label>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setUploadTaggedPlayers(players.filter(p => p.id !== uploadPlayerId).map(p => p.id))}
                            className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft hover:text-brand-primary px-2 py-1"
                          >
                            Tag all
                          </button>
                          <span className="text-ink-primary/25">·</span>
                          <button
                            type="button"
                            onClick={() => setUploadTaggedPlayers([])}
                            className="text-[10px] font-black tracking-widest uppercase text-ink-primary/50 hover:text-ink-primary px-2 py-1"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                        {players
                          .filter(p => p.id !== uploadPlayerId)
                          .map(p => {
                            const on = uploadTaggedPlayers.includes(p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => toggleTaggedPlayer(p.id)}
                                className={`flex flex-col items-center gap-1 p-1.5 rounded-lg transition ring-1 ${
                                  on
                                    ? 'bg-brand-primary/20 ring-brand-primary-soft/60'
                                    : 'bg-transparent ring-line-default/10 hover:bg-line-default/[0.05]'
                                }`}
                              >
                                <div className={`relative w-11 h-11 rounded-full overflow-hidden flex-shrink-0 ${on ? 'ring-2 ring-brand-primary-soft' : 'ring-1 ring-line-default/15'}`}>
                                  {(p as any).profilePhotoUrl ? (
                                    <img src={(p as any).profilePhotoUrl} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full bg-line-default/10 flex items-center justify-center">
                                      <span className="text-[13px] font-black text-ink-primary/70">
                                        {(p.jerseyNumber != null) ? `#${p.jerseyNumber}` : (p.name || '?').charAt(0).toUpperCase()}
                                      </span>
                                    </div>
                                  )}
                                  {on && (
                                    <div className="absolute inset-0 bg-brand-primary/30 flex items-center justify-center">
                                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                                        <polyline points="20 6 9 17 4 12" />
                                      </svg>
                                    </div>
                                  )}
                                </div>
                                <span className={`text-[10px] font-bold leading-tight truncate w-full text-center ${on ? 'text-ink-primary' : 'text-ink-primary/60'}`}>
                                  {(p.name || '').split(' ')[0]}
                                </span>
                              </button>
                            );
                          })}
                      </div>
                      <p className="text-[10px] text-ink-primary/40 mt-2">Tap a face to tag them in this clip. Each tagged player's family gets a push.</p>
                    </div>
                  )}
                  {uploading && (
                    <div>
                      {compressionStatus && (
                        <div className="mb-2 flex items-center space-x-2">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-charcoal-600"></div>
                          <p className="text-sm text-ink-primary/85 font-medium">{compressionStatus}</p>
                        </div>
                      )}
                      <div className="w-full bg-line-default/15 rounded-full h-2">
                        <div className="h-2 rounded-full bg-brand-primary transition-all" style={{ width: `${uploadProgress}%` }} />
                      </div>
                      <p className="text-xs text-ink-primary/50 mt-1">
                        {compressionStatus ? 'Optimizing for mobile playback...' : `Uploading... ${uploadProgress}%`}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { resetUploadForm(); setShowUploadModal(false); }}
                    disabled={uploading}
                    className="px-4 py-2 border border-line-default/15 rounded-lg text-ink-primary/85 hover:bg-line-default/[0.05] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpload}
                    disabled={uploading || !uploadPlayerId || uploadFiles.length === 0}
                    className="px-4 py-2 bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dim disabled:opacity-50"
                  >
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Lightbox */}
        {selectedMedia && (
          <div
            className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center z-50 p-2 sm:p-4"
            onClick={() => { setSelectedMedia(null); setEditingTags(null); }}
          >
            {/* Close button. w-14 h-14 (56px) exceeds Apple HIG 44pt
                minimum comfortably. Safe-area-inset-top keeps it clear
                of the iOS notch on Capacitor shells. bg-black/70 + ring
                gives real contrast against the dim-video background so
                the target is visible even mid-playback. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSelectedMedia(null); setEditingTags(null); }}
              aria-label="Close"
              className="absolute right-3 z-[60] w-14 h-14 flex items-center justify-center rounded-full bg-black/70 hover:bg-black/85 active:bg-black text-white ring-1 ring-white/25 shadow-lg transition"
              style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="max-w-4xl w-full flex flex-col items-center" onClick={e => e.stopPropagation()}>
              {selectedMedia.type === 'video' ? (
                ((selectedMedia as any).source === 'youtube' || (selectedMedia as any).source === 'trace') ? (
                  // External embed (YouTube / Trace) — drop their iframe
                  // straight into the lightbox. Both services handle their
                  // own player chrome + autoplay quirks.
                  <div className="w-full max-w-[min(100%,calc((60vh)*16/9))] sm:max-w-[min(100%,calc((70vh)*16/9))] aspect-video rounded-lg overflow-hidden bg-black">
                    <iframe
                      key={selectedMedia.id}
                      src={(selectedMedia as any).embedUrl || selectedMedia.url}
                      title={selectedMedia.caption || selectedMedia.playerName}
                      loading="lazy"
                      allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
                      allowFullScreen
                      className="w-full h-full block border-0"
                    />
                  </div>
                ) : selectedMedia.streamUid ? (
                  <div className="w-full max-w-[min(100%,calc((60vh)*16/9))] sm:max-w-[min(100%,calc((70vh)*16/9))] aspect-video rounded-lg overflow-hidden bg-black">
                    <CloudflareStreamIframe
                      ref={lightboxIframeRef}
                      key={selectedMedia.streamUid}
                      uid={selectedMedia.streamUid}
                      streamReady={selectedMedia.streamReady === true}
                      autoplay
                      title={selectedMedia.caption || selectedMedia.playerName}
                      onReady={async () => {
                        // First viewer to see transcode-complete: stamp
                        // streamReady:true on the doc so every future
                        // viewer skips the readiness poll entirely.
                        if (selectedMedia.streamReady === true) return;
                        try {
                          await updateDocument('player_media', selectedMedia.id, {
                            streamReady: true,
                            streamReadyAt: new Date(),
                          });
                        } catch (err) {
                          console.warn('stamp streamReady failed', err);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <video
                    src={selectedMedia.url}
                    controls
                    autoPlay
                    playsInline
                    preload="metadata"
                    className="max-w-full max-h-[60vh] sm:max-h-[70vh] rounded-lg"
                  />
                )
              ) : (
                <img
                  src={selectedMedia.url}
                  alt={selectedMedia.caption || selectedMedia.playerName}
                  className="max-w-full max-h-[60vh] sm:max-h-[70vh] rounded-lg object-contain"
                />
              )}
              {/* Action bar */}
              <div className="w-full flex items-center justify-between mt-3 px-1">
                <div className="flex items-center space-x-4">
                  <button
                    onClick={() => handleLike(selectedMedia)}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                  >
                    {selectedMedia.likes?.includes(userData?.uid || '') ? (
                      <svg className="w-6 h-6 text-rose-300" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                    ) : (
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
                    )}
                  </button>
                  {(selectedMedia.likeCount || 0) > 0 ? (
                    <button
                      onClick={() => setShowLikersFor(selectedMedia)}
                      className="-ml-3 text-white text-sm font-medium hover:underline"
                      title="See who liked"
                    >
                      {selectedMedia.likeCount}
                    </button>
                  ) : (
                    <span className="-ml-3 text-white/70 text-sm font-medium">0</span>
                  )}
                  <button
                    onClick={() => setShowViewersFor(selectedMedia)}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                    title="See who viewed"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span className="text-sm font-medium">{selectedMedia.viewCount || 0}</span>
                  </button>
                  <button
                    onClick={() => handleShare(selectedMedia)}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                    <span className="text-sm font-medium">Share</span>
                  </button>
                  {(selectedMedia.shareCount || 0) > 0 && (
                    <button
                      onClick={() => setShowSharersFor(selectedMedia)}
                      className="-ml-3 text-white text-sm font-medium hover:underline"
                      title="See who shared"
                    >
                      {selectedMedia.shareCount}
                    </button>
                  )}
                  <button
                    onClick={() => handleDownload(selectedMedia)}
                    disabled={downloadingId === selectedMedia.id}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform disabled:opacity-70 disabled:cursor-wait"
                    title="Save to your device"
                  >
                    {downloadingId === selectedMedia.id ? (
                      <>
                        <div className="w-5 h-5 rounded-full border-2 border-line-default/30 border-t-white animate-spin" />
                        <span className="text-sm font-medium tabular-nums">
                          {downloadPercent > 0 ? `${downloadPercent}%` : 'Saving…'}
                        </span>
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                        <span className="text-sm font-medium">Download</span>
                      </>
                    )}
                  </button>
                  {(selectedMedia.downloadCount || 0) > 0 && (
                    <button
                      onClick={() => setShowDownloadersFor(selectedMedia)}
                      className="-ml-3 text-white text-sm font-medium hover:underline"
                      title="See who downloaded"
                    >
                      {selectedMedia.downloadCount}
                    </button>
                  )}
                </div>
                {(canManageMedia || userData?.uid === selectedMedia.uploadedBy) && (
                  <div className="flex items-center gap-3">
                    {selectedMedia.type === 'video' && canManageMedia && (
                      <>
                        <input
                          ref={replaceFileInputRef}
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={handleReplaceVideo}
                        />
                        {selectedMedia.streamUid && (
                          <button
                            onClick={handleSetThumbnailFromCurrentFrame}
                            disabled={savingThumbnail}
                            title="Pause the video at the frame you want, then tap this to use it as the thumbnail"
                            className="flex items-center space-x-1.5 text-ink-primary/35 hover:text-brand-primary-soft disabled:opacity-50 transition-colors"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                            <span className="text-sm font-medium hidden sm:inline">
                              {savingThumbnail ? 'Saving…' : 'Set thumbnail'}
                            </span>
                          </button>
                        )}
                        <button
                          onClick={() => replaceFileInputRef.current?.click()}
                          disabled={replacing}
                          title="Replace video (preserves likes, tags, caption)"
                          className="flex items-center space-x-1.5 text-ink-primary/35 hover:text-brand-primary-soft disabled:opacity-50 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          <span className="text-sm font-medium hidden sm:inline">{replacing ? `${replaceProgress}%` : 'Replace'}</span>
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => { handleDelete(selectedMedia); setSelectedMedia(null); }}
                      disabled={replacing}
                      className="flex items-center space-x-1.5 text-ink-primary/40 hover:text-red-400 disabled:opacity-50 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                  </div>
                )}
              </div>
              {selectedMedia.caption && (
                <p className="text-white text-center mt-2 text-sm">{selectedMedia.caption}</p>
              )}
              {replacing && (
                <div className="w-full mt-2 px-1">
                  <div className="text-brand-primary-soft text-xs font-medium mb-1">Replacing video... {replaceProgress}%</div>
                  <div className="w-full bg-line-default/10 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full bg-brand-primary-soft transition-all" style={{ width: `${replaceProgress}%` }} />
                  </div>
                </div>
              )}
              {/* Tag display / editor */}
              {editingTags !== null ? (
                <div className="mt-3 bg-line-default/10 rounded-lg p-3 backdrop-blur-sm">
                  <div className="flex flex-wrap justify-center gap-1.5 mb-2">
                    {ACTIVITY_TAGS.map(tag => (
                      <button
                        key={tag}
                        onClick={() => toggleEditTag(tag)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          editingTags.includes(tag)
                            ? 'bg-brand-primary text-white'
                            : 'bg-line-default/20 text-white/70 hover:bg-line-default/30'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  {/* Player name tags */}
                  <div className="flex flex-wrap justify-center gap-1.5 mb-2">
                    {players.map(p => (
                      <button
                        key={p.id}
                        onClick={() => toggleEditTag(p.name)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          editingTags.includes(p.name)
                            ? 'bg-green-500 text-white'
                            : 'bg-line-default/20 text-white/70 hover:bg-line-default/30'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  {(editingTags.includes('Goal') || editingTags.includes('Own Goal')) && players.length > 0 && (
                    <div className="mt-2 mb-2 rounded-lg bg-black/30 border border-line-default/10 p-2.5 space-y-2">
                      {editingTags.includes('Own Goal') && (
                        <div className="text-[11px] text-rose-200 bg-rose-500/15 border border-rose-400/30 rounded px-2 py-1.5">
                          🥅 <strong>Own goal:</strong> no scorer credit. Assists still allowed.
                        </div>
                      )}
                      {!editingTags.includes('Own Goal') && (
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-white/50 mb-1.5">⚽ Goal scorer</p>
                          <div className="flex flex-wrap justify-center gap-1.5">
                            {players.map(p => {
                              const isSel = (editingGoalScorerId || selectedMedia.playerId) === p.id;
                              return (
                                <button
                                  key={p.id}
                                  onClick={() => setEditingGoalScorerId(p.id)}
                                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                    isSel ? 'bg-brand-primary text-white' : 'bg-line-default/15 text-white/70 hover:bg-line-default/25'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-white/50 mb-1.5">🅰️ Assisted by</p>
                        <div className="flex flex-wrap justify-center gap-1.5">
                          {players
                            .filter(p => editingTags.includes('Own Goal') || p.id !== (editingGoalScorerId || selectedMedia.playerId))
                            .map(p => {
                              const isSel = editingAssistByIds.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  onClick={() => setEditingAssistByIds(prev => isSel ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                    isSel ? 'bg-violet-500 text-white' : 'bg-line-default/15 text-white/70 hover:bg-line-default/25'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  )}
                  {recentGames.length > 0 && (
                    <div className="px-2">
                      <p className="text-[11px] uppercase tracking-wide text-white/50 mb-1.5">🔗 Link to game</p>
                      <select
                        value={editingGameId}
                        onChange={e => setEditingGameId(e.target.value)}
                        className="w-full bg-line-default/10 ring-1 ring-line-default/20 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        <option value="" className="text-ink-primary">— Not linked —</option>
                        {recentGames.map(g => <option key={g.id} value={g.id} className="text-ink-primary">{g.label}</option>)}
                      </select>
                      <p className="text-[10px] text-white/40 mt-1">Linking dedupes against the coach’s live taps so stats aren’t doubled.</p>
                    </div>
                  )}
                  <div className="flex justify-center gap-2">
                    <button onClick={() => { setEditingTags(null); setEditingGoalScorerId(''); setEditingAssistByIds([]); setEditingGameId(''); }} className="px-3 py-1 text-xs text-white/60 hover:text-white">Cancel</button>
                    <button onClick={handleSaveTags} className="px-3 py-1 bg-brand-primary text-white text-xs rounded-full hover:bg-brand-primary-dim">Save Tags</button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap justify-center items-center gap-1.5 mt-2">
                  {selectedMedia.tags && selectedMedia.tags.length > 0 && selectedMedia.tags.map(tag => (
                    <span key={tag} className="px-2 py-0.5 bg-line-default/15 text-white/80 rounded-full text-xs">{tag}</span>
                  ))}
                  {canManageMedia && (
                    <button
                      onClick={() => {
                        setEditingTags(selectedMedia.tags || []);
                        const m = selectedMedia as any;
                        setEditingGoalScorerId(m.goalScorerId || selectedMedia.playerId || '');
                        setEditingAssistByIds(m.assistByIds || []);
                        setEditingGameId(m.gameId || '');
                      }}
                      className="px-2 py-0.5 border border-line-default/20 text-white/50 rounded-full text-xs hover:text-white/80 hover:border-line-default/40 transition-colors"
                    >
                      {selectedMedia.tags && selectedMedia.tags.length > 0 ? 'Edit tags' : '+ Tags'}
                    </button>
                  )}
                </div>
              )}
              <p className="text-ink-primary/40 text-center mt-1 text-xs">
                {selectedMedia.playerName} • Uploaded by {selectedMedia.uploadedByName}
              </p>
            </div>
          </div>
        )}

        {/* Likers / Viewers / Downloaders / Sharers panel */}
        {(showLikersFor || showViewersFor || showDownloadersFor || showSharersFor) && (() => {
          const item = (showLikersFor || showViewersFor || showDownloadersFor || showSharersFor) as PlayerMediaType;
          let uids: string[] = [];
          let title = '';
          let empty = '';
          if (showLikersFor) { uids = item.likes || []; title = `❤️ Liked by ${uids.length}`; empty = 'No likes yet.'; }
          else if (showViewersFor) { uids = item.views || []; title = `👁 Viewed by ${uids.length}`; empty = 'No views yet.'; }
          else if (showDownloadersFor) { uids = item.downloads || []; title = `⬇️ Downloaded by ${uids.length} (${item.downloadCount || 0} total)`; empty = 'No downloads yet.'; }
          else if (showSharersFor) { uids = item.shares || []; title = `🔗 Shared by ${uids.length} (${item.shareCount || 0} total)`; empty = 'No shares yet.'; }
          const close = () => { setShowLikersFor(null); setShowViewersFor(null); setShowDownloadersFor(null); setShowSharersFor(null); };
          return (
            <div
              className="fixed inset-0 bg-black/80 flex items-center justify-center z-[70] p-4"
              onClick={close}
            >
              <div
                className="bg-surface-elevated rounded-2xl shadow-2xl max-w-sm w-full max-h-[70vh] overflow-hidden flex flex-col"
                onClick={e => e.stopPropagation()}
              >
                <div className="px-4 py-3 border-b border-line-default/5 flex items-center justify-between">
                  <h3 className="font-semibold text-ink-primary/90">{title}</h3>
                  <button onClick={close} className="text-ink-primary/40 hover:text-ink-primary/65 text-xl leading-none">✕</button>
                </div>
                <div className="overflow-y-auto flex-1">
                  {uids.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-ink-primary/50">{empty}</p>
                  ) : (
                    <ul className="divide-y divide-line-default/5">
                      {uids.map(uid => (
                        <li key={uid} className="px-4 py-2.5 flex items-center space-x-3">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-primary-soft to-brand-primary flex items-center justify-center text-white text-xs font-bold">
                            {(usersMap[uid] || '?').charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm text-ink-primary/90">
                            {usersMap[uid] || 'Unknown user'}
                            {uid === userData?.uid && <span className="text-ink-primary/40 ml-1">(you)</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
      <TrialGateModal
        open={trialGateOpen}
        onClose={() => setTrialGateOpen(false)}
        action="upload media"
        reason={trialReason}
      />
      <VideoQuotaModal
        open={!!quotaBlocked}
        quota={quotaBlocked}
        onClose={() => setQuotaBlocked(null)}
        teamId={selectedTeamId || undefined}
      />
    </div>
  );
};

// ─── Media Grid ──────────────────────────────────────────────────────────────
interface MediaGridProps {
  items: PlayerMediaType[];
  onView: (item: PlayerMediaType) => void;
  onDelete: (item: PlayerMediaType) => void;
  onLike: (item: PlayerMediaType) => void;
  onShare: (item: PlayerMediaType) => void;
  userData: any;
  viewMode: 'grid' | 'list';
  isUserCoach: boolean;
}

const MediaGrid: React.FC<MediaGridProps> = ({ items, onView, onDelete, onLike, onShare, userData, viewMode, isUserCoach }) => {
  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-ink-primary/50">
        No media uploaded yet.
      </div>
    );
  }

  const isLiked = (item: PlayerMediaType) => item.likes?.includes(userData?.uid || '') || false;
  const canDelete = (item: PlayerMediaType) => userData?.uid === item.uploadedBy || isUserCoach;

  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-center space-x-4 bg-surface-elevated rounded-lg border border-line-default/10 p-3 hover:bg-line-default/[0.05]">
            <div
              className="w-16 h-16 rounded-lg overflow-hidden bg-line-default/[0.08] flex-shrink-0 cursor-pointer"
              onClick={() => onView(item)}
            >
              {item.type === 'video' ? (
                <div className="w-full h-full flex items-center justify-center bg-surface-input text-ink-primary text-2xl">▶</div>
              ) : (
                <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover" loading="lazy" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-primary truncate">{item.caption || item.fileName}</p>
              <p className="text-xs text-ink-primary/50">{item.playerName} • {item.type} • {item.uploadedByName}</p>
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.tags.map(tag => (
                    <span key={tag} className="px-1.5 py-0.5 bg-brand-primary/15 text-ink-primary/65 rounded text-[10px] font-medium">{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center space-x-3 flex-shrink-0">
              <button onClick={(e) => { e.stopPropagation(); onLike(item); }} className="flex items-center space-x-1 text-ink-primary/50 hover:text-rose-300 transition-colors">
                {isLiked(item) ? (
                  <svg className="w-4 h-4 text-rose-300" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
                )}
                <span className="text-xs">{item.likeCount || 0}</span>
              </button>
              <button onClick={(e) => { e.stopPropagation(); onShare(item); }} className="text-ink-primary/40 hover:text-brand-primary transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
              </button>
              {canDelete(item) && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(item); }} className="text-ink-primary/40 hover:text-rose-300 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map(item => (
        <div key={item.id} className="group relative aspect-square bg-line-default/[0.08] rounded-lg overflow-hidden">
          <div className="cursor-pointer w-full h-full" onClick={() => onView(item)}>
            {item.type === 'video' ? (
              <>
                <div className="w-full h-full bg-surface-input flex items-center justify-center">
                  <div className="w-10 h-10 bg-black bg-opacity-50 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  </div>
                </div>
                <span className="absolute top-2 left-2 text-xs bg-black bg-opacity-60 text-white px-1.5 py-0.5 rounded">
                  Video
                </span>
              </>
            ) : (
              <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover" loading="lazy" />
            )}
          </div>

          {/* Bottom action bar */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 via-black/40 to-transparent pt-6 pb-2 px-2.5">
            {item.caption && (
              <p className="text-white text-xs truncate mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity">{item.caption}</p>
            )}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-0.5 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {item.tags.slice(0, 3).map(tag => (
                  <span key={tag} className="px-1.5 py-0.5 bg-line-default/20 text-white rounded text-[9px] font-medium backdrop-blur-sm">{tag}</span>
                ))}
                {item.tags.length > 3 && <span className="text-white/60 text-[9px]">+{item.tags.length - 3}</span>}
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <button
                  onClick={(e) => { e.stopPropagation(); onLike(item); }}
                  className="flex items-center space-x-1 transition-transform hover:scale-110"
                >
                  {isLiked(item) ? (
                    <svg className="w-4 h-4 text-rose-300 drop-shadow" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  ) : (
                    <svg className="w-4 h-4 text-white/90 drop-shadow" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
                  )}
                  {(item.likeCount || 0) > 0 && (
                    <span className="text-white text-xs font-medium drop-shadow">{item.likeCount}</span>
                  )}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onShare(item); }}
                  className="transition-transform hover:scale-110"
                >
                  <svg className="w-4 h-4 text-white/90 drop-shadow" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                </button>
              </div>
              {canDelete(item) && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(item); }}
                  className="opacity-0 group-hover:opacity-100 transition-all hover:scale-110"
                >
                  <svg className="w-4 h-4 text-white/70 hover:text-red-400 drop-shadow transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default PlayerMediaPage;

// ─── Small helpers ───────────────────────────────────────────────────────────
function timeAgo(date: Date): string {
  const now = Date.now();
  const diff = Math.floor((now - date.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

const ACCENT_BG: Record<string, string> = {
  cyan: 'from-brand-primary/20 to-brand-primary/5 border-brand-primary/30',
  blue: 'from-brand-primary/20 to-brand-primary/5 border-brand-primary/30',
  purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
  orange: 'from-orange-500/20 to-orange-500/5 border-orange-500/30',
};

const StatCard: React.FC<{ icon: string; label: string; value: string; accent: string }> = ({ icon, label, value, accent }) => (
  <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${ACCENT_BG[accent] || ACCENT_BG.cyan} border p-3 sm:p-4`}>
    <div className="flex items-center gap-3">
      <div className="text-2xl sm:text-3xl">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-ink-primary/40">{label}</div>
        <div className="text-base sm:text-xl font-black text-ink-primary truncate">{value}</div>
      </div>
    </div>
  </div>
);

const SectionHeader: React.FC<{ title: string; action?: { label: string; onClick: any } }> = ({ title, action }) => (
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-sm sm:text-base font-bold uppercase tracking-[0.15em] text-ink-primary">{title}</h2>
    {action && (
      <button onClick={action.onClick} className="text-xs sm:text-sm text-brand-primary-soft hover:text-brand-primary-soft font-medium">
        {action.label} →
      </button>
    )}
  </div>
);

interface FeaturedCardProps {
  item: PlayerMediaType;
  player?: Player;
  timeAgo: string;
  onClick: () => void;
}
const FeaturedCard: React.FC<FeaturedCardProps> = ({ item, player, timeAgo, onClick }) => {
  const primaryTag = (item.tags || []).find(t => ['Goal', 'Assist', 'Save', 'Skill', 'Highlight'].includes(t));
  const tagColor: Record<string, string> = {
    Goal: 'bg-yellow-400 text-yellow-950',
    Assist: 'bg-green-400 text-green-950',
    Save: 'bg-brand-primary-soft text-ink-primary',
    Skill: 'bg-purple-400 text-purple-950',
    Highlight: 'bg-pink-400 text-pink-950',
  };
  return (
    <button
      onClick={onClick}
      className="group relative aspect-video w-full bg-surface-elevated rounded-xl overflow-hidden border border-line-default/5 hover:border-brand-primary/50 transition-all hover:shadow-2xl hover:shadow-brand-primary/10 text-left"
    >
      {item.type === 'video' ? (
        ((item as any).source === 'youtube' || (item as any).source === 'trace') ? (
          item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt={item.caption || ''} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-brand-primary to-brand-primary-dim text-white text-[11px] font-extrabold uppercase tracking-widest">
              {(item as any).source}
            </div>
          )
        ) : item.streamUid ? (
          <img
            src={streamThumbnailUrl(item.streamUid, { height: 360, time: item.posterTimeSeconds != null ? `${item.posterTimeSeconds}s` : undefined })}
            alt={item.caption || ''}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <video
            src={`${item.url}#t=0.5`}
            preload="metadata"
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
        )
      ) : (
        <img src={item.url} alt={item.caption || ''} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      )}
      {/* Play icon overlay for videos */}
      {item.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-14 h-14 bg-black/50 backdrop-blur-sm rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
            <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}
      {/* Highlight overlay — coach-tagged moment. Display only. */}
      {item.momentType && (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-brand-primary text-white pl-2 pr-2.5 py-1 shadow ring-1 ring-black/10">
          <MomentIcon kind={item.momentType} className="w-4 h-4" />
          <span className="text-[10px] font-black uppercase tracking-widest">
            {momentLabel(item.momentType)}
          </span>
        </div>
      )}
      {/* Bottom info gradient */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-3 pt-10">
        <div className="flex items-center gap-2">
          {player?.profilePhotoUrl ? (
            <img src={player.profilePhotoUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-brand-primary/40" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-surface-raised to-surface-elevated flex items-center justify-center text-white text-xs font-bold ring-2 ring-brand-primary/40">
              {player?.jerseyNumber || item.playerName?.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-white text-sm font-bold truncate uppercase tracking-wide">{item.playerName}</div>
            <div className="text-ink-primary/35 text-xs truncate">{timeAgo}{item.caption ? ` · ${item.caption}` : ''}</div>
          </div>
          {primaryTag && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider flex-shrink-0 ${tagColor[primaryTag]}`}>
              {primaryTag}
            </span>
          )}
        </div>
      </div>
    </button>
  );
};

interface RankedCardProps {
  rank: number;
  item: PlayerMediaType;
  onClick: () => void;
}
const RankedCard: React.FC<RankedCardProps> = ({ rank, item, onClick }) => {
  const rankColor = rank === 1 ? 'from-yellow-400 to-orange-500' : rank === 2 ? 'from-gray-300 to-gray-500' : 'from-orange-400 to-orange-700';
  return (
    <button
      onClick={onClick}
      className="group relative aspect-video w-full bg-surface-elevated rounded-xl overflow-hidden border border-line-default/5 hover:border-brand-primary/50 transition-all text-left"
    >
      {item.type === 'video' ? (
        ((item as any).source === 'youtube' || (item as any).source === 'trace') ? (
          item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt={item.caption || ''} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-brand-primary to-brand-primary-dim text-white text-[11px] font-extrabold uppercase tracking-widest">
              {(item as any).source}
            </div>
          )
        ) : item.streamUid ? (
          <img
            src={streamThumbnailUrl(item.streamUid, { height: 360, time: item.posterTimeSeconds != null ? `${item.posterTimeSeconds}s` : undefined })}
            alt={item.caption || ''}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <video
            src={`${item.url}#t=0.5`}
            preload="metadata"
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
        )
      ) : (
        <img src={item.url} alt={item.caption || ''} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      )}
      <div className={`absolute top-2 left-2 w-9 h-9 rounded-lg bg-gradient-to-br ${rankColor} flex items-center justify-center text-white font-black text-lg shadow-lg`}>
        {rank}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-3 pt-10">
        <div className="text-white text-sm font-bold truncate uppercase">{item.playerName}</div>
        <div className="flex items-center justify-between text-xs text-ink-primary/35 mt-0.5">
          <span className="truncate">{item.caption || (item.tags && item.tags[0]) || 'Highlight'}</span>
          <span className="flex items-center gap-1 flex-shrink-0 ml-2">
            <svg className="w-3 h-3 text-red-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
            {item.likeCount || 0}
          </span>
        </div>
      </div>
    </button>
  );
};

// Dark-themed thumbnail grid for the new layout
interface DarkMediaGridProps {
  items: PlayerMediaType[];
  onView: (item: PlayerMediaType) => void;
  onDelete: (item: PlayerMediaType) => void;
  onLike: (item: PlayerMediaType) => void;
  onShare: (item: PlayerMediaType) => void;
  userData: any;
  isUserCoach: boolean;
  emptyLabel?: string;
}
const DarkMediaGrid: React.FC<DarkMediaGridProps> = ({ items, onView, onDelete, onLike, onShare, userData, isUserCoach, emptyLabel }) => {
  if (items.length === 0) {
    return <div className="text-center py-8 text-ink-primary/50 text-sm">{emptyLabel || 'No clips here.'}</div>;
  }
  const isLiked = (item: PlayerMediaType) => item.likes?.includes(userData?.uid || '') || false;
  const canDelete = (item: PlayerMediaType) => userData?.uid === item.uploadedBy || isUserCoach;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map(item => (
        <div key={item.id} className="group relative aspect-square bg-surface-elevated rounded-xl overflow-hidden border border-line-default/5 hover:border-brand-primary/40 transition-colors">
          <button onClick={() => onView(item)} className="w-full h-full block">
            {item.type === 'video' ? (
              ((item as any).source === 'youtube' || (item as any).source === 'trace') ? (
                item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt={item.caption || ''} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-brand-primary to-brand-primary-dim text-white text-[11px] font-extrabold uppercase tracking-widest">
                    {(item as any).source}
                  </div>
                )
              ) : item.streamUid ? (
                <img
                  src={streamThumbnailUrl(item.streamUid, { height: 360, time: item.posterTimeSeconds != null ? `${item.posterTimeSeconds}s` : undefined })}
                  alt={item.caption || ''}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              ) : (
                <video
                  src={`${item.url}#t=0.5`}
                  preload="metadata"
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                />
              )
            ) : (
              <img src={item.url} alt={item.caption || ''} loading="lazy" className="w-full h-full object-cover" />
            )}
          </button>
          {item.type === 'video' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-10 h-10 bg-black/50 rounded-full flex items-center justify-center">
                <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
          )}
          {item.momentType && (
            <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-full bg-brand-primary text-white pl-1.5 pr-2 py-1 shadow-sm ring-1 ring-black/10">
              <MomentIcon kind={item.momentType} className="w-3.5 h-3.5" />
              <span className="text-[9px] font-black uppercase tracking-widest">Highlight</span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2">
            <div className="flex items-center justify-between">
              <button onClick={(e) => { e.stopPropagation(); onLike(item); }} className="flex items-center gap-1 hover:scale-110 transition-transform">
                {isLiked(item) ? (
                  <svg className="w-4 h-4 text-rose-300" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
                ) : (
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>
                )}
                {(item.likeCount || 0) > 0 && <span className="text-white text-xs font-medium">{item.likeCount}</span>}
              </button>
              <div className="flex items-center gap-2">
                <button onClick={(e) => { e.stopPropagation(); onShare(item); }} className="hover:scale-110 transition-transform">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                </button>
                {canDelete(item) && (
                  <button onClick={(e) => { e.stopPropagation(); onDelete(item); }} className="opacity-0 group-hover:opacity-100 hover:scale-110 transition-all">
                    <svg className="w-4 h-4 text-white/80 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

