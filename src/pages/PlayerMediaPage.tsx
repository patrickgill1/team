import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { useStorage } from '../hooks/useStorage';
import { Player, PlayerMedia as PlayerMediaType } from '../types';
import { isCoach, formatDate } from '../utils/helpers';
import { compressVideo, canCompressVideo, CompressionProgress } from '../utils/videoCompression';
import { uploadToR2 } from '../utils/r2Upload';
import FullGames from './FullGames';

const ACTIVITY_TAGS = ['Goal', 'Own Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];
const ITEMS_PER_PAGE = 20;

const PlayerMediaPage: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addPlayerMedia, getPlayerMediaByPlayer, getPlayerMediaByTeam, getPhotosByTeam, deleteDocument, updateDocument, updatePlayerStats } = useFirestore();
  const { uploadFile } = useStorage();

  const [players, setPlayers] = useState<Player[]>([]);
  const [media, setMedia] = useState<PlayerMediaType[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('all');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [compressionStatus, setCompressionStatus] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedMedia, setSelectedMedia] = useState<PlayerMediaType | null>(null);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [editingTags, setEditingTags] = useState<string[] | null>(null); // null = not editing
  const [editingGoalScorerId, setEditingGoalScorerId] = useState<string>('');
  const [editingAssistByIds, setEditingAssistByIds] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
  const [activeTab, setActiveTab] = useState<'highlights' | 'fullgames'>('highlights');
  const [searchQuery, setSearchQuery] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [replaceProgress, setReplaceProgress] = useState(0);
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({}); // uid -> display name
  const [showLikersFor, setShowLikersFor] = useState<PlayerMediaType | null>(null);
  const [showViewersFor, setShowViewersFor] = useState<PlayerMediaType | null>(null);
  const [showDownloadersFor, setShowDownloadersFor] = useState<PlayerMediaType | null>(null);
  const [showSharersFor, setShowSharersFor] = useState<PlayerMediaType | null>(null);

  // Upload form
  const [uploadPlayerId, setUploadPlayerId] = useState('');
  const [uploadCaption, setUploadCaption] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadTags, setUploadTags] = useState<string[]>([]);
  const [uploadTaggedPlayers, setUploadTaggedPlayers] = useState<string[]>([]);
  const [uploadGoalScorerId, setUploadGoalScorerId] = useState<string>('');
  const [uploadAssistByIds, setUploadAssistByIds] = useState<string[]>([]);
  const [uploadGameId, setUploadGameId] = useState<string>('');
  const [editingGameId, setEditingGameId] = useState<string>('');
  const [recentGames, setRecentGames] = useState<{ id: string; label: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    setVisibleCount(ITEMS_PER_PAGE);
    loadData();
  }, [selectedTeamId, selectedPlayerId]);

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      setLoading(true);

      // Load players and media in parallel
      const mediaPromise = (selectedPlayerId && selectedPlayerId !== 'all')
        ? getPlayerMediaByPlayer(selectedPlayerId)
        : getPlayerMediaByTeam(selectedTeamId);

      const galleryPromise = (!selectedPlayerId || selectedPlayerId === 'all')
        ? getPhotosByTeam(selectedTeamId).catch(err => { console.error('Error loading gallery photos:', err); return []; })
        : Promise.resolve([]);

      const [playersData, mediaData, galleryPhotos, usersData] = await Promise.all([
        getDocuments('players', []),
        mediaPromise,
        galleryPromise,
        getDocuments('users', []).catch(() => [])
      ]);

      // Build uid -> name lookup for likes/views display
      const uMap: Record<string, string> = {};
      (usersData as any[]).forEach((u: any) => {
        const uid = u.uid || u.id;
        if (uid) uMap[uid] = u.name || u.email || 'Unknown';
      });
      setUsersMap(uMap);

      const teamPlayers = playersData
        .filter((p: any) => (p.teamId === selectedTeamId || p.teamIds?.includes(selectedTeamId)) && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        })) as Player[];
      setPlayers(teamPlayers);

      // Recent games for the optional "Link to game" dropdown (used to dedup
      // stat credits between coach live-tap and parent clip uploads).
      try {
        const allEvents = await getDocuments('events', []);
        const cutoffPast = Date.now() - 60 * 24 * 3600 * 1000;
        const cutoffFuture = Date.now() + 7 * 24 * 3600 * 1000;
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
        await updatePlayerStats(pid, next as any);
      } catch (err) {
        console.error('Failed to update stats for player', pid, err);
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

    const player = players.find(p => p.id === uploadPlayerId);
    if (!player) return;

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

        // Videos go to Cloudflare R2 (cheaper egress, better streaming).
        // Photos stay on Firebase Storage.
        let url: string;
        if (isVideo) {
          const folder = `player_media/${selectedTeamId}/${uploadPlayerId}`;
          const result = await uploadToR2(file, folder, (pct) => {
            // Map per-file progress into overall progress
            const overall = ((i + pct / 100) / totalFiles) * 100;
            setUploadProgress(Math.round(overall));
          });
          url = result.url;
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
          updatedAt: new Date(),
        };

        const newMediaId = await addPlayerMedia(mediaPayload);

        // We only credit the FIRST file of a multi-file upload to avoid double-
        // counting when a coach drops in 5 angles of the same goal.
        // Trigger when there's a scorer OR (own-goal case) when assists exist.
        if (i === 0 && (scorerId || assistIds.length > 0)) {
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
                needsBumpScorer = res.addedScorer;
                needsBumpAssistIds = res.addedAssistIds;
              } else if (res.status !== 'no-doc') {
                // Game is live/halftime/scheduled — finalize will pick everything
                // up. Skip the immediate bump.
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

          // Persist the credit fields on the media doc. statsCredited reflects
          // what *this clip* directly bumped (used to roll back on delete/edit).
          try {
            await updateDocument('player_media', newMediaId, {
              goalScorerId: scorerId,
              assistByIds: assistIds.length > 0 ? assistIds : [],
              statsCredited: !!(willBumpScorer && scorerId),
              statsCreditedAssistIds: willBumpAssistIds,
            } as any);
          } catch (e) { console.warn('failed to persist credit fields', e); }
        }
      }

      setUploadProgress(100);

      // Email parents of subject player + any tagged players (one batch per upload session)
      try {
        const { getParentEmailsForPlayer, tplClipUploaded, sendEmailBatch } = await import('../utils/notify');
        const subjectPlayer = players.find(p => p.id === uploadPlayerId);
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
          });
          for (const p of parents) {
            if (sentTo.has(p.email)) continue;
            sentTo.add(p.email);
            messages.push({ to: p.email, subject, html });
          }
        }
        if (messages.length > 0) sendEmailBatch(messages);
      } catch (e) { console.warn('clip email failed', e); }

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
      if (mediaItem.id.startsWith('gallery_')) {
        await deleteDocument('gallery', mediaItem.id.replace('gallery_', ''));
      } else {
        await deleteDocument('player_media', mediaItem.id);
      }
      loadData();
    } catch (error) {
      console.error('Error deleting media:', error);
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
    const shareUrl = `${window.location.origin}/media/${encodeURIComponent(docId)}`;
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
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Replace a video in-place: keeps Firestore doc ID, likes, tags, caption — only swaps the URL.
  // Works for migrating old Firebase videos to R2 AND for swapping in a re-edited cut later.
  const handleReplaceVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedMedia) return;
    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file.');
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      alert(`File too large. Max ${MAX_VIDEO_SIZE / 1024 / 1024}MB.`);
      return;
    }

    const ok = window.confirm(
      `Replace this video with "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)}MB)?\n\nLikes, tags, and caption will be preserved.`
    );
    if (!ok) {
      if (replaceFileInputRef.current) replaceFileInputRef.current.value = '';
      return;
    }

    try {
      setReplacing(true);
      setReplaceProgress(0);
      const folder = `player_media/${selectedMedia.teamId}/${selectedMedia.playerId}`;
      const result = await uploadToR2(file, folder, (pct) => setReplaceProgress(pct));

      const collection = selectedMedia.id.startsWith('gallery_') ? 'gallery' : 'player_media';
      const docId = selectedMedia.id.startsWith('gallery_') ? selectedMedia.id.replace('gallery_', '') : selectedMedia.id;
      await updateDocument(collection, docId, {
        url: result.url,
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
        storageProvider: 'r2',
        previousUrl: selectedMedia.url,
        replacedAt: new Date(),
      });

      // Update local state so lightbox + grid reflect new URL immediately
      const updated = { ...selectedMedia, url: result.url, fileName: file.name, fileSize: file.size, contentType: file.type } as PlayerMediaType;
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
    const collection = selectedMedia.id.startsWith('gallery_') ? 'gallery' : 'player_media';
    const docId = selectedMedia.id.startsWith('gallery_') ? selectedMedia.id.replace('gallery_', '') : selectedMedia.id;
    try {
      // Derive taggedPlayerIds from player name tags
      const taggedPlayerIds = players
        .filter(p => editingTags.includes(p.name) && p.id !== selectedMedia.playerId)
        .map(p => p.id);

      // Stats credits: only meaningful when 'Goal' tag is on
      const m = selectedMedia as any;
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

      // 3. Apply credits forward.
      let willBumpScorerId: string | undefined;
      let willBumpAssistIds: string[] = [];
      if ((newScorerId || newAssistIds.length > 0) && newGameId) {
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
            willBumpScorerId = res.addedScorer ? newScorerId : undefined;
            willBumpAssistIds = res.addedAssistIds;
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
      } else if (newScorerId || newAssistIds.length > 0) {
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
      };
      await updateDocument(collection, docId, update);

      // Email parents of NEWLY tagged players only (skip already-tagged + subject player)
      try {
        const prevTaggedIds: string[] = (selectedMedia as any).taggedPlayerIds || [];
        const newlyTagged = taggedPlayerIds.filter(id => !prevTaggedIds.includes(id));
        if (newlyTagged.length > 0 && userData) {
          const { getParentEmailsForPlayer, tplClipUploaded, sendEmailBatch } = await import('../utils/notify');
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
            });
            for (const p of parents) {
              if (sentTo.has(p.email)) continue;
              sentTo.add(p.email);
              messages.push({ to: p.email, subject, html });
            }
          }
          if (messages.length > 0) sendEmailBatch(messages);
        }
      } catch (e) { console.warn('tag-add email failed', e); }

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

  // Filter media by selected tags
  const tagFilteredMedia = filterTags.length > 0
    ? media.filter(m => filterTags.some(t => m.tags?.includes(t)))
    : media;
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
  // Players with clip counts (for browse-by-player row)
  const playersWithCounts = players
    .map(p => ({
      player: p,
      count: media.filter(m => m.playerId === p.id || (m.taggedPlayerIds || []).includes(p.id)).length,
    }))
    .filter(p => p.count > 0)
    .sort((a, b) => b.count - a.count);

  const MAX_VIDEO_SIZE = 350 * 1024 * 1024; // 350MB (will be compressed before upload)
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
    // Check file sizes
    const oversized = valid.filter(f => 
      (f.type.startsWith('video/') && f.size > MAX_VIDEO_SIZE) ||
      (f.type.startsWith('image/') && f.size > MAX_IMAGE_SIZE)
    );
    if (oversized.length > 0) {
      alert(`${oversized.length} file(s) are too large. Videos must be under 350MB, images under 10MB.`);
      setUploadFiles(valid.filter(f => !oversized.includes(f)));
      return;
    }
    setUploadFiles(valid);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Group media by player
  const mediaByPlayer = players.map(player => ({
    player,
    items: filteredMedia.filter(m => m.playerId === player.id),
  })).filter(group => group.items.length > 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-fire-950 via-gray-950 to-gray-950">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* ── HERO ─────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-2xl mb-6 bg-gradient-to-br from-fire-900 via-fire-950 to-black border border-cyan-500/10">
          <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_30%_20%,rgba(34,211,238,0.25),transparent_50%),radial-gradient(circle_at_80%_80%,rgba(239,68,68,0.2),transparent_50%)]" />
          <div className="relative px-6 py-10 sm:py-14 sm:px-10">
            <h1 className="text-5xl sm:text-7xl font-black tracking-[0.15em] uppercase bg-gradient-to-r from-cyan-200 via-white to-cyan-200 bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(34,211,238,0.3)]">
              Media
            </h1>
            <p className="mt-3 text-cyan-200/80 text-xs sm:text-sm font-bold tracking-[0.3em] uppercase">
              Highlights · Moments · Memories
            </p>
          </div>
        </div>

        {/* ── TABS + SEARCH + UPLOAD ──────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-4 mb-6 border-b border-white/10 pb-2">
          <div className="flex space-x-1">
            <button
              onClick={() => setActiveTab('highlights')}
              className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors relative ${
                activeTab === 'highlights' ? 'text-cyan-300' : 'text-gray-400 hover:text-white'
              }`}
            >
              Highlights
              {activeTab === 'highlights' && <span className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-cyan-400 rounded-full" />}
            </button>
            <button
              onClick={() => setActiveTab('fullgames')}
              className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors relative ${
                activeTab === 'fullgames' ? 'text-cyan-300' : 'text-gray-400 hover:text-white'
              }`}
            >
              Full Games
              {activeTab === 'fullgames' && <span className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-cyan-400 rounded-full" />}
            </button>
          </div>
          {activeTab === 'highlights' && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search highlights..."
                  className="w-44 sm:w-64 pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50"
                />
                <svg className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
              </div>
              <button
                onClick={() => { resetUploadForm(); setShowUploadModal(true); }}
                className="bg-cyan-500 hover:bg-cyan-400 text-fire-950 px-4 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="hidden sm:inline">Upload</span>
              </button>
            </div>
          )}
        </div>

        {activeTab === 'fullgames' ? (
          <div className="bg-white rounded-2xl overflow-hidden">
            <FullGames />
          </div>
        ) : (
          <>
            {/* ── STATS ROW ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              <StatCard icon="🎬" label="Total Clips" value={String(totalClips)} accent="cyan" />
              <StatCard icon="📅" label="This Season" value={String(thisSeasonCount)} accent="blue" />
              <StatCard icon="👥" label="Players" value={String(players.length)} accent="purple" />
              <StatCard icon="🔥" label="Most Liked" value={mostLikedItem ? (mostLikedItem.caption || mostLikedItem.playerName || 'Top Clip').slice(0, 18) : '—'} accent="orange" />
            </div>

            {/* ── RECENT HIGHLIGHTS ─────────────────────────────────── */}
            {recentHighlights.length > 0 && (
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
                <div className="flex gap-4 overflow-x-auto pb-3 -mx-2 px-2 scrollbar-thin">
                  <button
                    onClick={() => setSelectedPlayerId('all')}
                    className={`flex flex-col items-center flex-shrink-0 transition-transform hover:scale-105 ${selectedPlayerId === 'all' ? 'scale-105' : ''}`}
                  >
                    <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-2xl font-black ring-2 ring-offset-2 ring-offset-gray-950 ${selectedPlayerId === 'all' ? 'ring-cyan-400' : 'ring-transparent'}`}>
                      ALL
                    </div>
                    <span className="text-xs text-white font-medium mt-2">All</span>
                    <span className="text-[10px] text-gray-500">{media.length} clips</span>
                  </button>
                  {playersWithCounts.map(({ player, count }) => (
                    <button
                      key={player.id}
                      onClick={() => setSelectedPlayerId(player.id)}
                      className={`flex flex-col items-center flex-shrink-0 transition-transform hover:scale-105 ${selectedPlayerId === player.id ? 'scale-105' : ''}`}
                    >
                      <div className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-full overflow-hidden bg-gradient-to-br from-fire-700 to-fire-900 ring-2 ring-offset-2 ring-offset-gray-950 ${selectedPlayerId === player.id ? 'ring-cyan-400' : 'ring-transparent'}`}>
                        {player.profilePhotoUrl ? (
                          <img src={player.profilePhotoUrl} alt={player.name} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-white text-xl font-black">
                            {player.jerseyNumber || player.name.charAt(0)}
                          </div>
                        )}
                        {player.profilePhotoUrl && player.jerseyNumber != null && (
                          <span className="absolute -bottom-0.5 -right-0.5 bg-cyan-500 text-gray-950 rounded-full min-w-[22px] h-[22px] px-1.5 flex items-center justify-center text-[11px] font-black shadow ring-2 ring-gray-950">
                            {player.jerseyNumber}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-white font-medium mt-2 max-w-[80px] truncate">{player.name.split(' ')[0]}</span>
                      <span className="text-[10px] text-gray-500">{count} clip{count !== 1 ? 's' : ''}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* ── TOP PLAYS THIS SEASON ─────────────────────────────── */}
            {topPlaysThisSeason.length > 0 && (
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
            <section className="mb-10">
              {selectedPlayerId !== 'all' && (
                <button
                  onClick={() => setSelectedPlayerId('all')}
                  className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full bg-white/5 ring-1 ring-white/10 text-sm font-medium text-cyan-300 hover:bg-white/10 hover:text-cyan-200 transition-colors"
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

              {/* Tag chips */}
              {allMediaTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {allMediaTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => toggleFilterTag(tag)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                        filterTags.includes(tag)
                          ? 'bg-cyan-500 text-fire-950'
                          : 'bg-white/5 text-gray-300 hover:bg-white/10 border border-white/10'
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}

              {selectedPlayerId === 'all' ? (
                mediaByPlayer.length > 0 ? (
                  <div className="space-y-8">
                    {mediaByPlayer.map(({ player, items }) => (
                      <div key={player.id}>
                        <div className="flex items-center space-x-3 mb-3">
                          {player.profilePhotoUrl ? (
                            <div className="relative w-9 h-9">
                              <img src={player.profilePhotoUrl} alt={player.name} className="w-9 h-9 rounded-full object-cover ring-2 ring-cyan-500/30" loading="lazy" />
                              {player.jerseyNumber != null && (
                                <span className="absolute -bottom-1 -right-1 bg-cyan-500 text-gray-950 rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center text-[9px] font-black ring-1 ring-gray-950">
                                  {player.jerseyNumber}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="w-9 h-9 bg-gradient-to-br from-fire-700 to-fire-900 rounded-full flex items-center justify-center text-white font-bold text-xs ring-2 ring-cyan-500/30">
                              {player.jerseyNumber || player.name.charAt(0)}
                            </div>
                          )}
                          <h3 className="text-base font-bold text-white">{player.name}</h3>
                          <span className="text-xs text-gray-500">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                        </div>
                        <DarkMediaGrid items={items} onView={setSelectedMedia} onDelete={handleDelete} onLike={handleLike} onShare={handleShare} userData={userData} />
                      </div>
                    ))}
                    {hasMore && (
                      <div className="text-center pt-4">
                        <button
                          onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                          className="px-6 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm font-medium text-white hover:bg-white/10 transition-colors"
                        >
                          Load More ({allFilteredMedia.length - visibleCount} remaining)
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-12 bg-white/5 rounded-xl border border-white/10">
                    <div className="text-5xl mb-4">📸</div>
                    <h3 className="text-lg font-medium text-white">No Media Yet</h3>
                    <p className="text-gray-400 mt-2">Upload photos and videos for your players.</p>
                  </div>
                )
              ) : (
                <>
                  <DarkMediaGrid items={filteredMedia} onView={setSelectedMedia} onDelete={handleDelete} onLike={handleLike} onShare={handleShare} userData={userData} />
                  {hasMore && (
                    <div className="text-center pt-4">
                      <button
                        onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                        className="px-6 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm font-medium text-white hover:bg-white/10 transition-colors"
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

        {/* Upload Modal */}
        {showUploadModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full">
              <div className="p-6">
                <h2 className="text-xl font-bold text-gray-900 mb-4">Upload Player Media</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Player *</label>
                    <select
                      value={uploadPlayerId}
                      onChange={e => setUploadPlayerId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select player...</option>
                      {players.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Files (Photos & Videos)</label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      onChange={handleFileSelect}
                      className="w-full text-sm text-gray-600"
                    />
                    {uploadFiles.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        {uploadFiles.length} file{uploadFiles.length !== 1 ? 's' : ''} selected ({
                          formatFileSize(uploadFiles.reduce((s, f) => s + f.size, 0))
                        })
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Caption</label>
                    <input
                      type="text"
                      value={uploadCaption}
                      onChange={e => setUploadCaption(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      placeholder="Optional caption..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
                    <div className="flex flex-wrap gap-1.5">
                      {ACTIVITY_TAGS.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleUploadTag(tag)}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                            uploadTags.includes(tag)
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(uploadTags.includes('Goal') || uploadTags.includes('Own Goal')) && players.length > 0 && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 space-y-3">
                      {uploadTags.includes('Own Goal') && (
                        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
                          🥅 <strong>Own goal:</strong> team gets +1, no scorer credit. Award the assist below if applicable.
                        </div>
                      )}
                      {!uploadTags.includes('Own Goal') && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">⚽ Goal scorer</label>
                          <div className="flex flex-wrap gap-1.5">
                            {players.map(p => {
                              const isSel = (uploadGoalScorerId || uploadPlayerId) === p.id;
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => setUploadGoalScorerId(p.id)}
                                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                    isSel ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                          </div>
                          <p className="text-xs text-gray-500 mt-1">Defaults to the player this clip is for. +1 to their goals.</p>
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">🅰️ Assisted by <span className="text-gray-400 font-normal">(optional)</span></label>
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
                                    isSel ? 'bg-violet-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                                  }`}
                                >
                                  {p.name}
                                </button>
                              );
                            })}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">Each pick gets +1 to their assists.</p>
                      </div>
                    </div>
                  )}
                  {recentGames.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Link to game <span className="text-gray-400 font-normal">(optional, prevents double-counting)</span>
                      </label>
                      <select
                        value={uploadGameId}
                        onChange={e => setUploadGameId(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-gray-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-sm"
                      >
                        <option value="">— Not linked —</option>
                        {recentGames.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">If the coach already tapped this goal on Game Day, linking attaches your clip without doubling stats.</p>
                    </div>
                  )}
                  {players.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tag Other Players</label>
                      <div className="flex flex-wrap gap-1.5">
                        {players
                          .filter(p => p.id !== uploadPlayerId)
                          .map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => toggleTaggedPlayer(p.id)}
                              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                uploadTaggedPlayers.includes(p.id)
                                  ? 'bg-green-600 text-white'
                                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                              }`}
                            >
                              {p.name}
                            </button>
                          ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-1">Tag players involved in this clip</p>
                    </div>
                  )}
                  {uploading && (
                    <div>
                      {compressionStatus && (
                        <div className="mb-2 flex items-center space-x-2">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                          <p className="text-sm text-blue-700 font-medium">{compressionStatus}</p>
                        </div>
                      )}
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${uploadProgress}%` }} />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {compressionStatus ? 'Optimizing for mobile playback...' : `Uploading... ${uploadProgress}%`}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    onClick={() => { resetUploadForm(); setShowUploadModal(false); }}
                    disabled={uploading}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpload}
                    disabled={uploading || !uploadPlayerId || uploadFiles.length === 0}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
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
            {/* Close button — large, always visible */}
            <button
              onClick={() => { setSelectedMedia(null); setEditingTags(null); }}
              className="absolute top-3 right-3 z-[60] bg-black/60 hover:bg-black/80 text-white rounded-full w-10 h-10 flex items-center justify-center text-lg"
            >
              ✕
            </button>
            <div className="max-w-4xl w-full flex flex-col items-center" onClick={e => e.stopPropagation()}>
              {selectedMedia.type === 'video' ? (
                <video
                  src={selectedMedia.url}
                  controls
                  autoPlay
                  playsInline
                  preload="metadata"
                  className="max-w-full max-h-[60vh] sm:max-h-[70vh] rounded-lg"
                />
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
                      <svg className="w-6 h-6 text-red-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
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
                  <a
                    href={selectedMedia.url}
                    download={selectedMedia.fileName || `${selectedMedia.playerName}-${selectedMedia.type}.${selectedMedia.type === 'video' ? 'mp4' : 'jpg'}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => bumpEngagement(selectedMedia, 'downloads')}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    <span className="text-sm font-medium">Download</span>
                  </a>
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
                {(userData?.uid === selectedMedia.uploadedBy || userData?.role === 'coach') && (
                  <div className="flex items-center gap-3">
                    {selectedMedia.type === 'video' && (
                      <>
                        <input
                          ref={replaceFileInputRef}
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={handleReplaceVideo}
                        />
                        <button
                          onClick={() => replaceFileInputRef.current?.click()}
                          disabled={replacing}
                          title="Replace video (preserves likes, tags, caption)"
                          className="flex items-center space-x-1.5 text-gray-300 hover:text-cyan-400 disabled:opacity-50 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          <span className="text-sm font-medium hidden sm:inline">{replacing ? `${replaceProgress}%` : 'Replace'}</span>
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => { handleDelete(selectedMedia); setSelectedMedia(null); }}
                      disabled={replacing}
                      className="flex items-center space-x-1.5 text-gray-400 hover:text-red-400 disabled:opacity-50 transition-colors"
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
                  <div className="text-cyan-300 text-xs font-medium mb-1">Replacing video... {replaceProgress}%</div>
                  <div className="w-full bg-white/10 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full bg-cyan-400 transition-all" style={{ width: `${replaceProgress}%` }} />
                  </div>
                </div>
              )}
              {/* Tag display / editor */}
              {editingTags !== null ? (
                <div className="mt-3 bg-white/10 rounded-lg p-3 backdrop-blur-sm">
                  <div className="flex flex-wrap justify-center gap-1.5 mb-2">
                    {ACTIVITY_TAGS.map(tag => (
                      <button
                        key={tag}
                        onClick={() => toggleEditTag(tag)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          editingTags.includes(tag)
                            ? 'bg-blue-500 text-white'
                            : 'bg-white/20 text-white/70 hover:bg-white/30'
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
                            : 'bg-white/20 text-white/70 hover:bg-white/30'
                        }`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  {(editingTags.includes('Goal') || editingTags.includes('Own Goal')) && players.length > 0 && (
                    <div className="mt-2 mb-2 rounded-lg bg-black/30 border border-white/10 p-2.5 space-y-2">
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
                                    isSel ? 'bg-blue-500 text-white' : 'bg-white/15 text-white/70 hover:bg-white/25'
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
                                    isSel ? 'bg-violet-500 text-white' : 'bg-white/15 text-white/70 hover:bg-white/25'
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
                        className="w-full bg-white/10 ring-1 ring-white/20 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        <option value="" className="text-gray-900">— Not linked —</option>
                        {recentGames.map(g => <option key={g.id} value={g.id} className="text-gray-900">{g.label}</option>)}
                      </select>
                      <p className="text-[10px] text-white/40 mt-1">Linking dedupes against the coach’s live taps so stats aren’t doubled.</p>
                    </div>
                  )}
                  <div className="flex justify-center gap-2">
                    <button onClick={() => { setEditingTags(null); setEditingGoalScorerId(''); setEditingAssistByIds([]); setEditingGameId(''); }} className="px-3 py-1 text-xs text-white/60 hover:text-white">Cancel</button>
                    <button onClick={handleSaveTags} className="px-3 py-1 bg-blue-500 text-white text-xs rounded-full hover:bg-blue-600">Save Tags</button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap justify-center items-center gap-1.5 mt-2">
                  {selectedMedia.tags && selectedMedia.tags.length > 0 && selectedMedia.tags.map(tag => (
                    <span key={tag} className="px-2 py-0.5 bg-white/15 text-white/80 rounded-full text-xs">{tag}</span>
                  ))}
                  <button
                    onClick={() => {
                      setEditingTags(selectedMedia.tags || []);
                      const m = selectedMedia as any;
                      setEditingGoalScorerId(m.goalScorerId || selectedMedia.playerId || '');
                      setEditingAssistByIds(m.assistByIds || []);
                      setEditingGameId(m.gameId || '');
                    }}
                    className="px-2 py-0.5 border border-white/20 text-white/50 rounded-full text-xs hover:text-white/80 hover:border-white/40 transition-colors"
                  >
                    {selectedMedia.tags && selectedMedia.tags.length > 0 ? '✏️ Edit' : '+ Tags'}
                  </button>
                </div>
              )}
              <p className="text-gray-400 text-center mt-1 text-xs">
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
                className="bg-white rounded-2xl shadow-2xl max-w-sm w-full max-h-[70vh] overflow-hidden flex flex-col"
                onClick={e => e.stopPropagation()}
              >
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-800">{title}</h3>
                  <button onClick={close} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
                </div>
                <div className="overflow-y-auto flex-1">
                  {uids.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-gray-500">{empty}</p>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {uids.map(uid => (
                        <li key={uid} className="px-4 py-2.5 flex items-center space-x-3">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                            {(usersMap[uid] || '?').charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm text-gray-800">
                            {usersMap[uid] || 'Unknown user'}
                            {uid === userData?.uid && <span className="text-gray-400 ml-1">(you)</span>}
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
}

const MediaGrid: React.FC<MediaGridProps> = ({ items, onView, onDelete, onLike, onShare, userData, viewMode }) => {
  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No media uploaded yet.
      </div>
    );
  }

  const isLiked = (item: PlayerMediaType) => item.likes?.includes(userData?.uid || '') || false;
  const canDelete = (item: PlayerMediaType) => userData?.uid === item.uploadedBy || userData?.role === 'coach';

  if (viewMode === 'list') {
    return (
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-center space-x-4 bg-white rounded-lg border border-gray-200 p-3 hover:bg-gray-50">
            <div
              className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 cursor-pointer"
              onClick={() => onView(item)}
            >
              {item.type === 'video' ? (
                <div className="w-full h-full flex items-center justify-center bg-gray-800 text-white text-2xl">▶</div>
              ) : (
                <img src={item.url} alt={item.caption || ''} className="w-full h-full object-cover" loading="lazy" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{item.caption || item.fileName}</p>
              <p className="text-xs text-gray-500">{item.playerName} • {item.type} • {item.uploadedByName}</p>
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {item.tags.map(tag => (
                    <span key={tag} className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-[10px] font-medium">{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center space-x-3 flex-shrink-0">
              <button onClick={(e) => { e.stopPropagation(); onLike(item); }} className="flex items-center space-x-1 text-gray-500 hover:text-red-500 transition-colors">
                {isLiked(item) ? (
                  <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>
                )}
                <span className="text-xs">{item.likeCount || 0}</span>
              </button>
              <button onClick={(e) => { e.stopPropagation(); onShare(item); }} className="text-gray-400 hover:text-blue-500 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
              </button>
              {canDelete(item) && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(item); }} className="text-gray-400 hover:text-red-500 transition-colors">
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
        <div key={item.id} className="group relative aspect-square bg-gray-100 rounded-lg overflow-hidden">
          <div className="cursor-pointer w-full h-full" onClick={() => onView(item)}>
            {item.type === 'video' ? (
              <>
                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
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
                  <span key={tag} className="px-1.5 py-0.5 bg-white/20 text-white rounded text-[9px] font-medium backdrop-blur-sm">{tag}</span>
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
                    <svg className="w-4 h-4 text-red-500 drop-shadow" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
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
  cyan: 'from-cyan-500/20 to-cyan-500/5 border-cyan-500/30',
  blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/30',
  purple: 'from-purple-500/20 to-purple-500/5 border-purple-500/30',
  orange: 'from-orange-500/20 to-orange-500/5 border-orange-500/30',
};

const StatCard: React.FC<{ icon: string; label: string; value: string; accent: string }> = ({ icon, label, value, accent }) => (
  <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${ACCENT_BG[accent] || ACCENT_BG.cyan} border p-3 sm:p-4`}>
    <div className="flex items-center gap-3">
      <div className="text-2xl sm:text-3xl">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-gray-400">{label}</div>
        <div className="text-base sm:text-xl font-black text-white truncate">{value}</div>
      </div>
    </div>
  </div>
);

const SectionHeader: React.FC<{ title: string; action?: { label: string; onClick: any } }> = ({ title, action }) => (
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-sm sm:text-base font-bold uppercase tracking-[0.15em] text-white">{title}</h2>
    {action && (
      <button onClick={action.onClick} className="text-xs sm:text-sm text-cyan-400 hover:text-cyan-300 font-medium">
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
    Save: 'bg-blue-400 text-blue-950',
    Skill: 'bg-purple-400 text-purple-950',
    Highlight: 'bg-pink-400 text-pink-950',
  };
  return (
    <button
      onClick={onClick}
      className="group relative aspect-video w-full bg-gray-900 rounded-xl overflow-hidden border border-white/5 hover:border-cyan-500/50 transition-all hover:shadow-2xl hover:shadow-cyan-500/10 text-left"
    >
      {item.type === 'video' ? (
        <video
          src={`${item.url}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
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
      {/* Bottom info gradient */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-3 pt-10">
        <div className="flex items-center gap-2">
          {player?.profilePhotoUrl ? (
            <img src={player.profilePhotoUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-cyan-500/40" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-fire-700 to-fire-900 flex items-center justify-center text-white text-xs font-bold ring-2 ring-cyan-500/40">
              {player?.jerseyNumber || item.playerName?.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-white text-sm font-bold truncate uppercase tracking-wide">{item.playerName}</div>
            <div className="text-gray-300 text-xs truncate">{timeAgo}{item.caption ? ` · ${item.caption}` : ''}</div>
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
      className="group relative aspect-video w-full bg-gray-900 rounded-xl overflow-hidden border border-white/5 hover:border-cyan-500/50 transition-all text-left"
    >
      {item.type === 'video' ? (
        <video
          src={`${item.url}#t=0.5`}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <img src={item.url} alt={item.caption || ''} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      )}
      <div className={`absolute top-2 left-2 w-9 h-9 rounded-lg bg-gradient-to-br ${rankColor} flex items-center justify-center text-white font-black text-lg shadow-lg`}>
        {rank}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-3 pt-10">
        <div className="text-white text-sm font-bold truncate uppercase">{item.playerName}</div>
        <div className="flex items-center justify-between text-xs text-gray-300 mt-0.5">
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
}
const DarkMediaGrid: React.FC<DarkMediaGridProps> = ({ items, onView, onDelete, onLike, onShare, userData }) => {
  if (items.length === 0) {
    return <div className="text-center py-8 text-gray-500 text-sm">No clips here.</div>;
  }
  const isLiked = (item: PlayerMediaType) => item.likes?.includes(userData?.uid || '') || false;
  const canDelete = (item: PlayerMediaType) => userData?.uid === item.uploadedBy || userData?.role === 'coach';
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map(item => (
        <div key={item.id} className="group relative aspect-square bg-gray-900 rounded-xl overflow-hidden border border-white/5 hover:border-cyan-500/40 transition-colors">
          <button onClick={() => onView(item)} className="w-full h-full block">
            {item.type === 'video' ? (
              <video
                src={`${item.url}#t=0.5`}
                preload="metadata"
                muted
                playsInline
                className="w-full h-full object-cover"
              />
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
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2">
            <div className="flex items-center justify-between">
              <button onClick={(e) => { e.stopPropagation(); onLike(item); }} className="flex items-center gap-1 hover:scale-110 transition-transform">
                {isLiked(item) ? (
                  <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
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

