import React, { useMemo, useState } from 'react';

interface PlayerOpt {
  id: string;
  name: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  players: PlayerOpt[];
  /** Caller decides what to do with the parsed embed — write the
   *  PlayerMedia doc, fire push notifications, etc. */
  onSubmit: (payload: {
    playerId: string;
    playerName: string;
    url: string;
    embedUrl: string;
    source: 'youtube' | 'trace' | 'other';
    caption: string;
  }) => Promise<void>;
}

/** Returns the canonical embed URL + source, or null if not recognized. */
function parseUrl(raw: string): { embedUrl: string; source: 'youtube' | 'trace' | 'other' } | null {
  const url = raw.trim();
  if (!url) return null;

  // YouTube — youtu.be/<id>, youtube.com/watch?v=<id>, youtube.com/shorts/<id>
  const yt =
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/youtube\.com\/watch\?.*?v=([\w-]{11})/) ||
    url.match(/youtube\.com\/shorts\/([\w-]{11})/) ||
    url.match(/youtube\.com\/embed\/([\w-]{11})/);
  if (yt) return { embedUrl: `https://www.youtube.com/embed/${yt[1]}`, source: 'youtube' };

  // Trace — accept share/highlight/video URLs. The public-share form
  // is iframe-embeddable as-is; we keep the original URL since Trace
  // hosts its own player when you embed any of these.
  if (/traceup\.com/.test(url) || /share\.traceup\.com/.test(url)) {
    return { embedUrl: url, source: 'trace' };
  }

  // Fallback — any URL ending in .mp4 / .mov can be played in a <video>;
  // otherwise treat as a generic link that we'll just hyperlink (no embed).
  if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) {
    return { embedUrl: url, source: 'other' };
  }
  return null;
}

const EmbedMediaModal: React.FC<Props> = ({ isOpen, onClose, players, onSubmit }) => {
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsed = useMemo(() => parseUrl(url), [url]);
  const valid = !!parsed && !!playerId;

  const handleSubmit = async () => {
    if (!parsed || !playerId) return;
    const player = players.find(p => p.id === playerId);
    if (!player) return;
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit({
        playerId,
        playerName: player.name,
        url,
        embedUrl: parsed.embedUrl,
        source: parsed.source,
        caption: caption.trim(),
      });
      // Reset on success
      setUrl('');
      setCaption('');
      setPlayerId('');
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save link.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Add a video link</h3>
            <p className="text-xs text-slate-500 mt-0.5">YouTube or Trace highlight — pasted, not uploaded.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-600 mb-1">Player</label>
            <select
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            >
              <option value="">— Pick a player —</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-600 mb-1">Video URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=… or https://traceup.com/…"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
            {url && !parsed && (
              <p className="text-xs text-rose-600 mt-1">Not a recognized YouTube or Trace URL.</p>
            )}
            {parsed && (
              <p className="text-xs text-emerald-700 mt-1 font-semibold">Detected: {parsed.source}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-600 mb-1">Caption (optional)</label>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Goal vs. Real Salt Lake — 64th min"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </div>

          {err && <p className="text-xs text-rose-600 font-semibold">{err}</p>}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!valid || submitting}
            className="px-4 py-2 text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg"
          >
            {submitting ? 'Saving…' : 'Add to media'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EmbedMediaModal;
