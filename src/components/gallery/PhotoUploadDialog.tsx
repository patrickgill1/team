import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent, Player } from '../../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onUpload: (files: File[], meta: {
    caption: string;
    tags: string[];
    taggedPlayerIds: string[];
    eventId: string | null;
  }) => Promise<void>;
  players: Player[];
  events: CalendarEvent[];
  uploading: boolean;
  progressPct: number;
  suggestedEventId?: string | null;
}

const TAG_OPTIONS = ['game', 'practice', 'team', 'celebration', 'tournament', 'training', 'awards'];
const MAX_FILES = 15;

// Modern R2-backed upload dialog. Multi-file drag/drop, per-photo
// preview grid, one shared caption + tags for the batch (parents
// don't need per-photo captions — that's editable later in the
// lightbox anyway), player face-tagging via chip picker with search,
// optional event link (defaults to the closest event in time).
const PhotoUploadDialog: React.FC<Props> = ({
  isOpen, onClose, onUpload, players, events, uploading, progressPct, suggestedEventId,
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [taggedPlayerIds, setTaggedPlayerIds] = useState<string[]>([]);
  const [eventId, setEventId] = useState<string | null>(null);
  const [playerSearch, setPlayerSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFiles([]);
      setPreviews([]);
      setCaption('');
      setTags([]);
      setTaggedPlayerIds([]);
      setEventId(suggestedEventId || null);
      setPlayerSearch('');
      setError(null);
    }
  }, [isOpen, suggestedEventId]);

  const acceptFiles = (list: FileList | File[]) => {
    const arr = Array.from(list).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|gif|webp|avif)$/i.test(f.name));
    if (arr.length === 0) {
      setError('Please pick images only.');
      return;
    }
    const combined = [...files, ...arr].slice(0, MAX_FILES);
    if (combined.length > MAX_FILES) {
      setError(`Up to ${MAX_FILES} photos at a time.`);
    } else {
      setError(null);
    }
    setFiles(combined);
    // Regenerate previews for the whole list (simpler than incrementally
    // pushing). URL.createObjectURL is instant.
    const urls = combined.map((f) => {
      try { return URL.createObjectURL(f); } catch { return ''; }
    });
    setPreviews((prev) => {
      // Revoke old ones we're replacing
      for (const u of prev) { try { URL.revokeObjectURL(u); } catch {} }
      return urls;
    });
  };

  const removeAt = (i: number) => {
    setFiles((prev) => prev.filter((_, ii) => ii !== i));
    setPreviews((prev) => {
      const gone = prev[i];
      if (gone) { try { URL.revokeObjectURL(gone); } catch {} }
      return prev.filter((_, ii) => ii !== i);
    });
  };

  const filteredPlayers = useMemo(() => {
    const q = playerSearch.trim().toLowerCase();
    return players.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [players, playerSearch]);

  const submit = async () => {
    if (!files.length) return;
    setError(null);
    try {
      await onUpload(files, { caption: caption.trim(), tags, taggedPlayerIds, eventId });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Upload failed. Try again.');
    }
  };

  useEffect(() => {
    return () => {
      for (const u of previews) { try { URL.revokeObjectURL(u); } catch {} }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="bg-surface-elevated w-full sm:max-w-2xl max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-line-default/10 bg-surface-elevated">
          <h2 className="text-base font-black text-ink-primary tracking-tight">Upload photos</h2>
          <button
            onClick={onClose}
            disabled={uploading}
            className="p-1.5 rounded-full hover:bg-line-default/[0.08] text-ink-primary/60 disabled:opacity-40"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Drop / pick zone */}
          {files.length === 0 && (
            <label
              htmlFor="photo-drop-input"
              onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer?.files?.length) acceptFiles(e.dataTransfer.files);
              }}
              className={`block rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
                dragging ? 'border-cyan-500 bg-cyan-500/10' : 'border-line-default/25 hover:border-cyan-500/50 hover:bg-cyan-500/[0.04]'
              }`}
            >
              <input
                id="photo-drop-input"
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                onChange={(e) => e.target.files && acceptFiles(e.target.files)}
                className="hidden"
              />
              <svg className="w-12 h-12 mx-auto mb-3 text-cyan-500/70" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m8-8H4M6 20h12" /></svg>
              <p className="text-sm font-bold text-ink-primary mb-1">Drop photos here or tap to pick</p>
              <p className="text-[11px] text-ink-primary/60">Up to {MAX_FILES} at a time · JPG · PNG · HEIC</p>
            </label>
          )}

          {/* Selected previews */}
          {files.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {previews.map((src, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-surface-base ring-1 ring-line-default/10 group">
                    <img src={src} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => removeAt(i)}
                      disabled={uploading}
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                      aria-label="Remove"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
                {files.length < MAX_FILES && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-lg border-2 border-dashed border-line-default/20 flex items-center justify-center text-ink-primary/50 hover:border-cyan-500/50 hover:text-cyan-500 transition"
                  >
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={(e) => e.target.files && acceptFiles(e.target.files)}
                  className="hidden"
                />
              </div>

              {/* Caption */}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-1">Caption (all photos)</label>
                <input
                  type="text"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Optional — e.g. Saturday's win vs Riverside"
                  className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-cyan-500/50"
                  maxLength={280}
                />
              </div>

              {/* Topic tags */}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-1">Tags</label>
                <div className="flex flex-wrap gap-1.5">
                  {TAG_OPTIONS.map((t) => {
                    const sel = tags.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                          sel
                            ? 'bg-cyan-600 text-white border-cyan-600'
                            : 'bg-surface-base text-ink-primary/80 border-line-default/15 hover:border-cyan-500/40'
                        }`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Player tagging */}
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-1">Who's in these photos?</label>
                <input
                  type="text"
                  value={playerSearch}
                  onChange={(e) => setPlayerSearch(e.target.value)}
                  placeholder="Search players to tag..."
                  className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 focus:outline-none focus:border-cyan-500/50 mb-2"
                />
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                  {filteredPlayers.slice(0, 60).map((p) => {
                    const sel = taggedPlayerIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setTaggedPlayerIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                          sel
                            ? 'bg-cyan-600 text-white border-cyan-600'
                            : 'bg-surface-base text-ink-primary/80 border-line-default/15 hover:border-cyan-500/40'
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                  {filteredPlayers.length === 0 && (
                    <p className="text-xs text-ink-primary/50 italic py-1">No matches.</p>
                  )}
                </div>
              </div>

              {/* Event link */}
              {events.length > 0 && (
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/50 mb-1">Link to an event (optional)</label>
                  <select
                    value={eventId || ''}
                    onChange={(e) => setEventId(e.target.value || null)}
                    className="w-full bg-surface-base border border-line-default/10 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-cyan-500/50"
                  >
                    <option value="">No event</option>
                    {events.slice(0, 100).map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.title} · {new Date(ev.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-300">{error}</div>
          )}
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 border-t border-line-default/10 bg-surface-elevated p-3">
          {uploading && (
            <div className="mb-2">
              <div className="h-1.5 w-full bg-line-default/[0.15] rounded-full overflow-hidden">
                <div className="h-full bg-cyan-500 transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-ink-primary/50 mt-1">
                Uploading… {Math.round(progressPct)}%
              </p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={uploading}
              className="flex-1 py-2.5 rounded-lg bg-surface-base text-ink-primary/80 text-sm font-bold disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={uploading || files.length === 0}
              className="flex-1 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-black disabled:opacity-40 transition"
            >
              {uploading ? 'Uploading…' : `Upload ${files.length || ''} photo${files.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PhotoUploadDialog;
