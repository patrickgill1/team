import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarEvent, GalleryPhoto, Player } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { canManageTeamMedia } from '../../utils/helpers';
import { uploadToR2, deleteR2Object } from '../../utils/r2Upload';
import { doc, updateDoc, arrayUnion, arrayRemove, increment, serverTimestamp } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import PhotoMasonry from './PhotoMasonry';
import PhotoLightbox from './PhotoLightbox';
import PhotoFilterBar, { DEFAULT_FILTERS, PhotoFilters } from './PhotoFilterBar';
import PhotoUploadDialog from './PhotoUploadDialog';

interface Props {
  players: Player[];
  events: CalendarEvent[];
}

// Photos tab — the third top-level tab inside PlayerMediaPage. Owns
// its own gallery-doc state independent of the Highlights feed. Any
// signed-in team member can upload (no canCoachWrite gate on this
// surface; rules loosened in the same ship). Filters, sort, masonry,
// lightbox, and player-tagging all live here.
const PhotosTab: React.FC<Props> = ({ players, events }) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getPhotosByTeam, addPhoto } = useFirestore();
  const canModerate = canManageTeamMedia(userData, selectedTeam);

  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [filters, setFilters] = useState<PhotoFilters>(DEFAULT_FILTERS);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressPct, setProgressPct] = useState(0);

  const loadPhotos = useCallback(async () => {
    if (!selectedTeamId) { setLoaded(true); return; }
    try {
      const raw = await getPhotosByTeam(selectedTeamId);
      const norm = (raw as any[]).map((p) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt || 0)),
      })) as GalleryPhoto[];
      setPhotos(norm);
    } finally {
      setLoaded(true);
    }
  }, [selectedTeamId, getPhotosByTeam]);

  useEffect(() => {
    setPhotos([]);
    setLoaded(false);
    setShowProgress(false);
    setFilters(DEFAULT_FILTERS);
    loadPhotos();
  }, [selectedTeamId, loadPhotos]);

  // Atomic-render pattern (memory): show nothing for 400ms, then a
  // subtle progress hint, then the grid fades in when data lands.
  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Suggested event: whichever is closest to right now (matches how
  // parents actually reach for the upload button — during / just
  // after an event). Undefined when the team has no events.
  const suggestedEventId = useMemo(() => {
    if (events.length === 0) return null;
    const now = Date.now();
    let best: string | null = null;
    let bestDelta = Infinity;
    for (const e of events) {
      const t = new Date(e.date).getTime();
      const delta = Math.abs(t - now);
      if (delta < bestDelta) { bestDelta = delta; best = e.id; }
    }
    return best;
  }, [events]);

  // Filter + sort. Search matches caption + tagged player names +
  // uploader name so a coach can find "photos of Boone from Riverside"
  // without a compound filter.
  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const now = Date.now();
    const windowMs = filters.datePreset === '7d'
      ? 7 * 24 * 3600 * 1000
      : filters.datePreset === '30d'
      ? 30 * 24 * 3600 * 1000
      : filters.datePreset === 'season'
      ? 200 * 24 * 3600 * 1000
      : null;

    return photos.filter((p) => {
      if (p.isActive === false) return false;
      if (filters.eventId && p.eventId !== filters.eventId) return false;
      if (filters.playerIds.length > 0) {
        const tagged = p.taggedPlayerIds || [];
        if (!filters.playerIds.some((id) => tagged.includes(id))) return false;
      }
      if (filters.untaggedOnly) {
        if ((p.taggedPlayerIds || []).length > 0) return false;
      }
      if (windowMs !== null) {
        const t = p.createdAt instanceof Date ? p.createdAt.getTime() : new Date(p.createdAt as any).getTime();
        if (Number.isNaN(t) || now - t > windowMs) return false;
      }
      if (q) {
        const captionHit = (p.caption || '').toLowerCase().includes(q);
        const uploaderHit = (p.uploadedByName || '').toLowerCase().includes(q);
        const tagHit = (p.tags || []).some((t) => t.toLowerCase().includes(q));
        const playerHit = (p.taggedPlayerIds || []).some((pid) => {
          const pl = players.find((pp) => pp.id === pid);
          return pl && pl.name.toLowerCase().includes(q);
        });
        if (!captionHit && !uploaderHit && !tagHit && !playerHit) return false;
      }
      return true;
    }).sort((a, b) => {
      if (filters.sort === 'popular') {
        return (b.reactionCount ?? (b.reactions?.length || 0)) - (a.reactionCount ?? (a.reactions?.length || 0));
      }
      const aT = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
      const bT = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
      return filters.sort === 'oldest' ? aT - bT : bT - aT;
    });
  }, [photos, filters, players]);

  const handleUpload = async (
    files: File[],
    meta: { caption: string; tags: string[]; taggedPlayerIds: string[]; eventId: string | null }
  ) => {
    if (!userData || !selectedTeamId) return;
    setUploading(true);
    setProgressPct(0);
    try {
      const newDocs: GalleryPhoto[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const perFileStart = (i / files.length) * 100;
        const perFileSpan = 100 / files.length;
        const r = await uploadToR2(file, 'photos', (pct) => {
          setProgressPct(perFileStart + (pct / 100) * perFileSpan);
        });
        const payload: any = {
          url: r.url,
          uploadedBy: userData.uid,
          uploadedByName: userData.name || 'Team member',
          teamId: selectedTeamId,
          fileSize: file.size,
          fileName: file.name,
          contentType: file.type || 'image/jpeg',
          createdAt: new Date(),
          updatedAt: new Date(),
          isActive: true,
        };
        if (meta.caption) payload.caption = meta.caption;
        if (meta.tags.length > 0) payload.tags = meta.tags;
        if (meta.taggedPlayerIds.length > 0) payload.taggedPlayerIds = meta.taggedPlayerIds;
        if (meta.eventId) payload.eventId = meta.eventId;
        const id = await addPhoto(payload);
        newDocs.push({ id, ...payload });
      }
      setPhotos((prev) => [...newDocs, ...prev]);
    } catch (err) {
      console.error('[photos-tab] upload failed', err);
      throw err;
    } finally {
      setUploading(false);
      setProgressPct(0);
    }
  };

  const handleReactionToggle = async (photo: GalleryPhoto) => {
    if (!userData) return;
    const uid = userData.uid;
    const wasReacted = (photo.reactions || []).includes(uid);
    // Optimistic update
    setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : {
      ...p,
      reactions: wasReacted
        ? (p.reactions || []).filter((u) => u !== uid)
        : [...(p.reactions || []), uid],
      reactionCount: Math.max(0, (p.reactionCount ?? (p.reactions?.length || 0)) + (wasReacted ? -1 : 1)),
    }));
    try {
      await updateDoc(doc(db, 'gallery', photo.id), {
        reactions: wasReacted ? arrayRemove(uid) : arrayUnion(uid),
        reactionCount: increment(wasReacted ? -1 : 1),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[photos-tab] reaction toggle failed', err);
      // Rollback
      setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : photo));
    }
  };

  const handleTagsChange = async (photo: GalleryPhoto, taggedPlayerIds: string[]) => {
    setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : { ...p, taggedPlayerIds }));
    try {
      await updateDoc(doc(db, 'gallery', photo.id), {
        taggedPlayerIds,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[photos-tab] tag update failed', err);
      setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : photo));
    }
  };

  const handleCaptionChange = async (photo: GalleryPhoto, caption: string) => {
    setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : { ...p, caption }));
    try {
      await updateDoc(doc(db, 'gallery', photo.id), {
        caption,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[photos-tab] caption update failed', err);
    }
  };

  const handleView = useCallback(async (photo: GalleryPhoto) => {
    if (!userData) return;
    const uid = userData.uid;
    if ((photo.viewedBy || []).includes(uid)) return;
    if (photo.uploadedBy === uid) return;  // don't count self
    try {
      await updateDoc(doc(db, 'gallery', photo.id), {
        viewedBy: arrayUnion(uid),
        viewCount: increment(1),
      });
      setPhotos((prev) => prev.map((p) => p.id !== photo.id ? p : {
        ...p,
        viewedBy: [...(p.viewedBy || []), uid],
        viewCount: (p.viewCount || 0) + 1,
      }));
    } catch (err) {
      console.warn('[photos-tab] view stamp failed', err);
    }
  }, [userData]);

  const handleDelete = async (photo: GalleryPhoto) => {
    if (!window.confirm('Remove this photo?')) return;
    // Close the lightbox first so the removal reads clean.
    setLightboxIndex(null);
    // Soft-delete + R2 cleanup mirroring Gallery.tsx / PlayerMediaPage.tsx.
    try {
      await updateDoc(doc(db, 'gallery', photo.id), {
        isActive: false,
        deletedAt: new Date(),
        deletedBy: userData?.uid || null,
      });
      if (photo.url) {
        void deleteR2Object(photo.url).then((r) => {
          if (!r.ok) console.warn('[photos-tab] R2 delete failed', photo.url, r.error);
        });
      }
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    } catch (err) {
      console.error('[photos-tab] delete failed', err);
      alert("Couldn't remove that photo. Try again.");
    }
  };

  // Empty states — atomic-render: silence, then hint, then content.
  if (!loaded && !showProgress) {
    return <div className="min-h-[40vh]" />;
  }
  if (!loaded && showProgress) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-cyan-500/40 border-t-cyan-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PhotoFilterBar
        filters={filters}
        onChange={setFilters}
        players={players}
        events={events}
        totalCount={photos.length}
        visibleCount={filtered.length}
      />

      <div className="p-3">
        {filtered.length === 0 ? (
          <div className="min-h-[40vh] flex flex-col items-center justify-center text-center px-8">
            <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-cyan-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
            </div>
            <p className="text-base font-black text-ink-primary mb-1">
              {photos.length === 0 ? 'Team photos live here.' : 'No photos match your filters.'}
            </p>
            <p className="text-xs text-ink-primary/60 mb-4 max-w-sm">
              {photos.length === 0
                ? 'Coaches, parents, whoever — tap the button to upload from the last game, practice, or a random great moment.'
                : 'Clear the filters to see everything, or upload something new.'}
            </p>
            <button
              onClick={() => setUploadOpen(true)}
              className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-black uppercase tracking-widest px-4 py-2.5 rounded-full transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              Upload photos
            </button>
          </div>
        ) : (
          <PhotoMasonry
            photos={filtered}
            players={players}
            currentUid={userData?.uid}
            onOpen={(i) => setLightboxIndex(i)}
          />
        )}
      </div>

      {/* Floating upload button (visible whenever there are photos) */}
      {filtered.length > 0 && (
        <button
          onClick={() => setUploadOpen(true)}
          className="fixed z-30 bottom-24 right-4 w-14 h-14 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white shadow-2xl flex items-center justify-center transition active:scale-95"
          aria-label="Upload photos"
          title="Upload photos"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
        </button>
      )}

      <PhotoUploadDialog
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUpload={handleUpload}
        players={players}
        events={events}
        uploading={uploading}
        progressPct={progressPct}
        suggestedEventId={suggestedEventId}
      />

      {lightboxIndex !== null && filtered[lightboxIndex] && (
        <PhotoLightbox
          photos={filtered}
          startIndex={lightboxIndex}
          players={players}
          currentUid={userData?.uid}
          canModerate={canModerate}
          onClose={() => setLightboxIndex(null)}
          onReactionToggle={handleReactionToggle}
          onTagsChange={handleTagsChange}
          onCaptionChange={handleCaptionChange}
          onDelete={handleDelete}
          onView={handleView}
        />
      )}
    </div>
  );
};

export default PhotosTab;
