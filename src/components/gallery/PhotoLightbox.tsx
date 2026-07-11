import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GalleryPhoto, Player } from '../../types';

interface Props {
  photos: GalleryPhoto[];
  startIndex: number;
  players: Player[];
  currentUid?: string;
  canModerate: boolean;
  onClose: () => void;
  onReactionToggle: (photo: GalleryPhoto) => void;
  onTagsChange: (photo: GalleryPhoto, taggedPlayerIds: string[]) => void;
  onCaptionChange: (photo: GalleryPhoto, caption: string) => void;
  onDelete: (photo: GalleryPhoto) => void;
  onView: (photo: GalleryPhoto) => void;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Full-screen photo viewer. Keyboard nav (← → esc), tap zones on
// mobile, tagged-player chips at the bottom, edit affordances for
// caption + tags, reaction heart. Renders as a portal-shaped fixed
// modal. Dark scrim; the photo dominates the frame.
const PhotoLightbox: React.FC<Props> = ({
  photos, startIndex, players, currentUid, canModerate,
  onClose, onReactionToggle, onTagsChange, onCaptionChange, onDelete, onView,
}) => {
  const [idx, setIdx] = useState(clamp(startIndex, 0, photos.length - 1));
  const [tagOpen, setTagOpen] = useState(false);
  const [captionEditing, setCaptionEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState('');
  const [tagSearch, setTagSearch] = useState('');
  const viewedRef = useRef<Set<string>>(new Set());
  const photo = photos[idx];

  // Fire onView once per photo the user actually lingers on.
  useEffect(() => {
    if (!photo) return;
    if (viewedRef.current.has(photo.id)) return;
    viewedRef.current.add(photo.id);
    onView(photo);
  }, [photo, onView]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(photos.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [photos.length, onClose]);

  const playerMap = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

  const taggedIds = photo?.taggedPlayerIds || [];
  const untagged = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    const filtered = players.filter((p) => {
      if (taggedIds.includes(p.id)) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q);
    });
    return filtered.slice(0, 40);
  }, [players, taggedIds, tagSearch]);

  const iReacted = !!(photo?.reactions && currentUid && photo.reactions.includes(currentUid));
  const reactionCount = photo?.reactionCount ?? (photo?.reactions?.length || 0);

  if (!photo) return null;

  const isMyPhoto = currentUid && photo.uploadedBy === currentUid;
  const canEdit = canModerate || isMyPhoto;

  const openCaptionEdit = () => {
    setCaptionDraft(photo.caption || '');
    setCaptionEditing(true);
  };
  const saveCaption = () => {
    onCaptionChange(photo, captionDraft.trim());
    setCaptionEditing(false);
  };

  const goPrev = () => setIdx((i) => Math.max(0, i - 1));
  const goNext = () => setIdx((i) => Math.min(photos.length - 1, i + 1));

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm animate-fade-in"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Top bar */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3 text-white bg-gradient-to-b from-black/70 to-transparent"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button
          onClick={onClose}
          className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">
          {idx + 1} / {photos.length}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={photo.url}
            download={photo.fileName || 'photo.jpg'}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md"
            aria-label="Download"
            title="Download"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
          </a>
          {canEdit && (
            <button
              onClick={() => onDelete(photo)}
              className="p-2 rounded-full bg-rose-500/20 hover:bg-rose-500/30 text-rose-100"
              aria-label="Delete"
              title="Delete"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a2 2 0 012-2h2a2 2 0 012 2v3" /></svg>
            </button>
          )}
        </div>
      </div>

      {/* Photo canvas */}
      <div className="absolute inset-0 flex items-center justify-center">
        <img
          key={photo.id}
          src={photo.url}
          alt={photo.caption || ''}
          className="max-h-full max-w-full object-contain select-none animate-fade-in"
          draggable={false}
          style={{ touchAction: 'manipulation' }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {/* Left tap zone */}
        {idx > 0 && (
          <button
            onClick={goPrev}
            className="hidden sm:flex absolute left-0 top-0 h-full w-1/3 items-center justify-start pl-6"
            aria-label="Previous"
          >
            <span className="p-3 rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </span>
          </button>
        )}
        {idx < photos.length - 1 && (
          <button
            onClick={goNext}
            className="hidden sm:flex absolute right-0 top-0 h-full w-1/3 items-center justify-end pr-6"
            aria-label="Next"
          >
            <span className="p-3 rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </span>
          </button>
        )}
        {/* Mobile: full-height invisible tap zones so swipe-feeling works */}
        <button onClick={goPrev} className="sm:hidden absolute left-0 top-0 h-full w-1/3" aria-label="Previous" />
        <button onClick={goNext} className="sm:hidden absolute right-0 top-0 h-full w-1/3" aria-label="Next" />
      </div>

      {/* Bottom info + actions */}
      <div className="absolute bottom-0 inset-x-0 z-10 text-white bg-gradient-to-t from-black/80 via-black/60 to-transparent px-4 pt-8"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        {/* Meta line */}
        <div className="flex items-center justify-between mb-2 text-[11px] opacity-80">
          <div className="truncate">
            <span className="font-semibold">{photo.uploadedByName || 'Unknown'}</span>
            <span className="mx-1.5">·</span>
            <span>{formatRelativeDate(photo.createdAt as any)}</span>
          </div>
          <div className="flex items-center gap-3">
            {typeof photo.viewCount === 'number' && photo.viewCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                {photo.viewCount}
              </span>
            )}
            <button
              onClick={() => onReactionToggle(photo)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full transition ${iReacted ? 'bg-rose-500 text-white' : 'bg-white/10 hover:bg-white/20'}`}
              aria-label={iReacted ? 'Remove reaction' : 'React'}
            >
              <svg className="w-4 h-4" fill={iReacted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" /></svg>
              <span className="text-[11px] font-bold tabular-nums">{reactionCount || 0}</span>
            </button>
          </div>
        </div>

        {/* Caption */}
        {captionEditing ? (
          <div className="flex items-center gap-2 mb-2">
            <input
              autoFocus
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveCaption(); if (e.key === 'Escape') setCaptionEditing(false); }}
              placeholder="Add a caption..."
              className="flex-1 bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white placeholder:text-white/40 text-sm focus:outline-none focus:border-white/40"
              maxLength={280}
            />
            <button onClick={saveCaption} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold">Save</button>
            <button onClick={() => setCaptionEditing(false)} className="px-2 py-2 rounded-lg bg-white/10 text-xs font-bold">Cancel</button>
          </div>
        ) : (
          <div className="mb-2">
            {photo.caption ? (
              <p className="text-sm leading-snug">
                {photo.caption}
                {canEdit && (
                  <button onClick={openCaptionEdit} className="ml-2 text-[10px] font-bold uppercase tracking-widest opacity-60 hover:opacity-100">Edit</button>
                )}
              </p>
            ) : canEdit ? (
              <button onClick={openCaptionEdit} className="text-xs opacity-60 hover:opacity-100 italic">+ Add a caption</button>
            ) : null}
          </div>
        )}

        {/* Tagged player chips */}
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          {taggedIds.length === 0 && !tagOpen && (
            <button
              onClick={() => setTagOpen(true)}
              className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-white/60 hover:text-white"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              Tag a player
            </button>
          )}
          {taggedIds.map((pid) => {
            const p = playerMap.get(pid);
            return (
              <span key={pid} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-cyan-500/25 border border-cyan-400/40 text-cyan-50 text-[11px] font-bold">
                {p?.name || 'Player'}
                <button
                  onClick={() => onTagsChange(photo, taggedIds.filter((id) => id !== pid))}
                  className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-cyan-900/40 hover:bg-cyan-900/80"
                  aria-label={`Remove ${p?.name || 'player'}`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.6} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            );
          })}
          {taggedIds.length > 0 && !tagOpen && (
            <button
              onClick={() => setTagOpen(true)}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white/70"
              aria-label="Tag another player"
              title="Tag another player"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          )}
        </div>

        {/* Tag picker */}
        {tagOpen && (
          <div className="mt-2 rounded-lg bg-white/10 backdrop-blur-md p-2 border border-white/20">
            <div className="flex items-center gap-2 mb-2">
              <input
                autoFocus
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Search players..."
                className="flex-1 bg-white/10 border border-white/20 rounded-lg px-3 py-1.5 text-white placeholder:text-white/40 text-sm focus:outline-none focus:border-white/40"
              />
              <button onClick={() => { setTagOpen(false); setTagSearch(''); }} className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded bg-white/10 text-white/70 hover:text-white">
                Done
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
              {untagged.length === 0 ? (
                <p className="text-[11px] text-white/50 italic px-1 py-1">No matches.</p>
              ) : untagged.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onTagsChange(photo, [...taggedIds, p.id])}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/10 hover:bg-cyan-500/30 border border-white/20 hover:border-cyan-400/50 text-white text-[11px] font-semibold transition"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function formatRelativeDate(d: any): string {
  if (!d) return '';
  const dt = d?.toDate ? d.toDate() : (d instanceof Date ? d : new Date(d));
  if (isNaN(dt.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - dt.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: dt.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export default PhotoLightbox;
