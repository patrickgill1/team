import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { useStorage } from '../hooks/useStorage';
import { Player, PlayerMedia as PlayerMediaType } from '../types';
import { isCoach, formatDate } from '../utils/helpers';
import { compressVideo, canCompressVideo, CompressionProgress } from '../utils/videoCompression';
import { uploadToR2 } from '../utils/r2Upload';

const ACTIVITY_TAGS = ['Goal', 'Assist', 'Save', 'Skill', 'Practice', 'Highlight', 'Celebration', 'Tournament', 'Training'];
const ITEMS_PER_PAGE = 20;

const PlayerMediaPage: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments, addPlayerMedia, getPlayerMediaByPlayer, getPlayerMediaByTeam, getPhotosByTeam, deleteDocument, updateDocument } = useFirestore();
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
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);

  // Upload form
  const [uploadPlayerId, setUploadPlayerId] = useState('');
  const [uploadCaption, setUploadCaption] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadTags, setUploadTags] = useState<string[]>([]);
  const [uploadTaggedPlayers, setUploadTaggedPlayers] = useState<string[]>([]);
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

      const [playersData, mediaData, galleryPhotos] = await Promise.all([
        getDocuments('players', []),
        mediaPromise,
        galleryPromise
      ]);

      const teamPlayers = playersData
        .filter((p: any) => (p.teamId === selectedTeamId || p.teamIds?.includes(selectedTeamId)) && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        })) as Player[];
      setPlayers(teamPlayers);

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

        await addPlayerMedia({
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
          updatedAt: new Date(),
        });
      }

      setUploadProgress(100);
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
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(shareUrl);
        alert('Link copied to clipboard!');
      }
    } catch (error) {
      // User cancelled share or error
      if ((error as any)?.name !== 'AbortError') {
        try {
          await navigator.clipboard.writeText(shareUrl);
          alert('Link copied to clipboard!');
        } catch {
          console.error('Error sharing:', error);
        }
      }
    }
  };

  const resetUploadForm = () => {
    setUploadPlayerId('');
    setUploadCaption('');
    setUploadFiles([]);
    setUploadTags([]);
    setUploadTaggedPlayers([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const toggleUploadTag = (tag: string) => {
    setUploadTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const toggleTaggedPlayer = (playerId: string) => {
    setUploadTaggedPlayers(prev => prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]);
  };

  const toggleFilterTag = (tag: string) => {
    setFilterTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const toggleEditTag = (tag: string) => {
    setEditingTags(prev => prev ? (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]) : [tag]);
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
      await updateDocument(collection, docId, { tags: editingTags, taggedPlayerIds: taggedPlayerIds.length > 0 ? taggedPlayerIds : [] });
      // Update local state
      setMedia(prev => prev.map(m => m.id === selectedMedia.id ? { ...m, tags: editingTags, taggedPlayerIds } : m));
      setSelectedMedia({ ...selectedMedia, tags: editingTags, taggedPlayerIds });
      setEditingTags(null);
    } catch (err) {
      console.error('Error saving tags:', err);
      alert('Failed to save tags.');
    }
  };

  // Get all unique tags across media for filter options
  const allMediaTags = Array.from(new Set(media.flatMap(m => m.tags || [])));

  // Filter media by selected tags
  const allFilteredMedia = filterTags.length > 0
    ? media.filter(m => filterTags.some(t => m.tags?.includes(t)))
    : media;
  const filteredMedia = allFilteredMedia.slice(0, visibleCount);
  const hasMore = allFilteredMedia.length > visibleCount;

  const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB (will be compressed before upload)
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
      alert(`${oversized.length} file(s) are too large. Videos must be under 200MB, images under 10MB.`);
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
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Gallery</h1>
              <p className="text-gray-600 mt-1">Team photos and player media</p>
            </div>
            <div className="flex items-center space-x-3">
              <select
                value={selectedPlayerId}
                onChange={e => setSelectedPlayerId(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Players</option>
                {players.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <div className="flex bg-gray-100 rounded-lg p-0.5">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'grid' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
                  }`}
                >
                  Grid
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    viewMode === 'list' ? 'bg-white shadow text-gray-900' : 'text-gray-600'
                  }`}
                >
                  List
                </button>
              </div>
              <button
                onClick={() => { resetUploadForm(); setShowUploadModal(true); }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Upload</span>
              </button>
            </div>
          </div>
        </div>

        {/* Tag filter bar */}
        {allMediaTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-500 mr-1">Filter:</span>
            {allMediaTags.map(tag => (
              <button
                key={tag}
                onClick={() => toggleFilterTag(tag)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  filterTags.includes(tag)
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {tag}
              </button>
            ))}
            {filterTags.length > 0 && (
              <button
                onClick={() => setFilterTags([])}
                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Media by Player - grouped view */}
        {selectedPlayerId === 'all' ? (
          mediaByPlayer.length > 0 ? (
            <div className="space-y-8">
              {mediaByPlayer.map(({ player, items }) => (
                <div key={player.id}>
                  <div className="flex items-center space-x-3 mb-4">
                    {player.profilePhotoUrl ? (
                      <img src={player.profilePhotoUrl} alt={player.name} className="w-8 h-8 rounded-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-xs">
                        {player.jerseyNumber || player.name.charAt(0)}
                      </div>
                    )}
                    <h2 className="text-lg font-bold text-gray-900">{player.name}</h2>
                    <span className="text-sm text-gray-500">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                  </div>
                  <MediaGrid items={items} onView={setSelectedMedia} onDelete={handleDelete} onLike={handleLike} onShare={handleShare} userData={userData} viewMode={viewMode} />
                </div>
              ))}
              {hasMore && (
                <div className="text-center py-6">
                  <button
                    onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                    className="px-6 py-2.5 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Load More ({allFilteredMedia.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
              <div className="text-5xl mb-4">📸</div>
              <h3 className="text-lg font-medium text-gray-900">No Media Yet</h3>
              <p className="text-gray-600 mt-2">Upload photos and videos for your players.</p>
            </div>
          )
        ) : (
          <>
            <MediaGrid items={filteredMedia} onView={setSelectedMedia} onDelete={handleDelete} onLike={handleLike} onShare={handleShare} userData={userData} viewMode={viewMode} />
            {hasMore && (
              <div className="text-center py-6">
                <button
                  onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                  className="px-6 py-2.5 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Load More ({allFilteredMedia.length - visibleCount} remaining)
                </button>
              </div>
            )}
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
                    <span className="text-sm font-medium">{selectedMedia.likeCount || 0}</span>
                  </button>
                  <button
                    onClick={() => handleShare(selectedMedia)}
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                    <span className="text-sm font-medium">Share</span>
                  </button>
                  <a
                    href={selectedMedia.url}
                    download={selectedMedia.fileName || `${selectedMedia.playerName}-${selectedMedia.type}.${selectedMedia.type === 'video' ? 'mp4' : 'jpg'}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center space-x-1.5 text-white hover:scale-110 transition-transform"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    <span className="text-sm font-medium">Download</span>
                  </a>
                </div>
                {(userData?.uid === selectedMedia.uploadedBy || userData?.role === 'coach') && (
                  <button
                    onClick={() => { handleDelete(selectedMedia); setSelectedMedia(null); }}
                    className="flex items-center space-x-1.5 text-gray-400 hover:text-red-400 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  </button>
                )}
              </div>
              {selectedMedia.caption && (
                <p className="text-white text-center mt-2 text-sm">{selectedMedia.caption}</p>
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
                  <div className="flex justify-center gap-2">
                    <button onClick={() => setEditingTags(null)} className="px-3 py-1 text-xs text-white/60 hover:text-white">Cancel</button>
                    <button onClick={handleSaveTags} className="px-3 py-1 bg-blue-500 text-white text-xs rounded-full hover:bg-blue-600">Save Tags</button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap justify-center items-center gap-1.5 mt-2">
                  {selectedMedia.tags && selectedMedia.tags.length > 0 && selectedMedia.tags.map(tag => (
                    <span key={tag} className="px-2 py-0.5 bg-white/15 text-white/80 rounded-full text-xs">{tag}</span>
                  ))}
                  <button
                    onClick={() => setEditingTags(selectedMedia.tags || [])}
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
