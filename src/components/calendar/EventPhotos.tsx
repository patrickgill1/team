// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { useStorage } from '../../hooks/useStorage';
import { useTeam } from '../../contexts/TeamContext';
import { canManageTeamMedia } from '../../utils/helpers';

interface Props {
  eventId: string;
  teamId: string;
  /** Coach editing the event can also delete photos. Parents can only
   *  delete their own uploads. */
  canModerate?: boolean;
}

/**
 * Event-scoped photo gallery. Sits inside an event card on the
 * calendar. Uploading is staff-only by default (see team.mediaUploaders
 * for the per-team parent allowlist) — coaches didn't want surprise
 * uploads they then have to moderate. Each photo carries the eventId,
 * so the gallery is automatically grouped per game / practice /
 * tournament.
 */
const EventPhotos: React.FC<Props> = ({ eventId, teamId, canModerate = false }) => {
  const { userData } = useAuth();
  const { selectedTeam } = useTeam();
  const { addPhoto, subscribeToEventPhotos, deleteDocument } = useFirestore();
  const { uploadFile } = useStorage();
  const canUpload = canManageTeamMedia(userData, selectedTeam);
  const fileRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!eventId) return;
    const unsub = subscribeToEventPhotos(eventId, setPhotos);
    return () => { unsub && unsub(); };
  }, [eventId, subscribeToEventPhotos]);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    if (!canUpload) return;
    setUploading(true);
    setUploadPct(0);
    try {
      let i = 0;
      for (const f of files) {
        const url = await uploadFile(f, `events/${teamId}/${eventId}`, (p) => {
          setUploadPct(Math.round(((i + p.progress / 100) / files.length) * 100));
        });
        await addPhoto({
          url,
          uploadedBy: userData?.uid || '',
          uploadedByName: userData?.name || 'Anon',
          teamId,
          eventId,
          fileSize: f.size,
          fileName: f.name,
          contentType: f.type,
        } as any);
        i += 1;
      }
    } catch (err) {
      console.error('Event photo upload failed:', err);
      alert('Could not upload some photos. Please try again.');
    } finally {
      setUploading(false);
      setUploadPct(0);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDelete = async (photo: any) => {
    if (!userData) return;
    const canDelete = canModerate || photo.uploadedBy === userData.uid;
    if (!canDelete) return;
    if (!window.confirm('Remove this photo?')) return;
    try {
      await deleteDocument('gallery', photo.id);
    } catch (err) {
      console.error('Delete photo failed:', err);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          📸 Event photos {photos.length > 0 && <span className="text-gray-700">· {photos.length}</span>}
        </span>
        {canUpload && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handlePick}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="text-xs font-bold text-crimson-700 hover:text-crimson-900 disabled:opacity-50"
            >
              {uploading ? `Uploading ${uploadPct}%…` : '+ Add photos'}
            </button>
          </>
        )}
      </div>

      {photos.length === 0 ? (
        <p className="text-xs text-gray-400">
          {canUpload ? 'No photos yet — be the first to add some.' : 'No photos yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {photos.slice(0, 8).map((p, idx) => (
            <button
              key={p.id}
              onClick={() => setLightboxIdx(idx)}
              className="relative aspect-square rounded-lg overflow-hidden bg-gray-100 ring-1 ring-gray-200 hover:opacity-90 active:scale-95 transition"
            >
              <img
                src={p.url}
                alt={p.fileName || 'photo'}
                loading="lazy"
                decoding="async"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                className="absolute inset-0 w-full h-full object-cover"
              />
            </button>
          ))}
          {photos.length > 8 && (
            <button
              onClick={() => setLightboxIdx(8)}
              className="relative aspect-square rounded-lg overflow-hidden bg-gray-900/80 text-white flex items-center justify-center text-sm font-bold"
            >
              +{photos.length - 8}
            </button>
          )}
        </div>
      )}

      {/* Full-screen lightbox — portaled so it escapes the event card's
          stacking context. */}
      {lightboxIdx != null && photos[lightboxIdx] && createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          style={{ zIndex: 200 }}
          onClick={() => setLightboxIdx(null)}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(null); }}
            className="absolute right-4 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
            style={{ top: 'calc(1rem + env(safe-area-inset-top))' }}
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {lightboxIdx > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx((lightboxIdx ?? 0) - 1); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {lightboxIdx < photos.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx((lightboxIdx ?? 0) + 1); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <img
            src={photos[lightboxIdx].url}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-w-[95vw] max-h-[85vh] object-contain rounded-lg select-none"
          />
          <div
            className="absolute left-0 right-0 bottom-0 px-6 py-3 text-center text-xs text-white/80 bg-gradient-to-t from-black/70 to-transparent"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p>Posted by {photos[lightboxIdx].uploadedByName || 'someone'} · {photos[lightboxIdx].createdAt?.toLocaleDateString?.() || ''}</p>
            {(canModerate || photos[lightboxIdx].uploadedBy === userData?.uid) && (
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(photos[lightboxIdx]); setLightboxIdx(null); }}
                className="mt-1 text-xs font-bold text-rose-300 hover:text-rose-200"
              >
                Delete photo
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default EventPhotos;
