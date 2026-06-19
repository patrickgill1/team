import React, { useEffect, useRef, useState } from 'react';
import { searchTenor, tenorEnabled, TenorGif } from '../../utils/tenor';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onPick: (gif: TenorGif) => void;
}

/**
 * Tenor-backed GIF picker. Opens as a sheet from the chat composer.
 * Family-friendly by default (Tenor `contentfilter=high`).
 */
const GifPicker: React.FC<Props> = ({ isOpen, onClose, onPick }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TenorGif[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);

  // Load featured/trending when the picker first opens, then re-query
  // (debounced) whenever the user types.
  useEffect(() => {
    if (!isOpen) return;
    if (!tenorEnabled()) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      const r = await searchTenor(query);
      setResults(r);
      setLoading(false);
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 110,
        paddingTop: 'calc(1rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
      }}
      onClick={onClose}
    >
      <div
        className="bg-charcoal-900 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col"
        style={{ maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
          <span className="font-bold text-bone">GIFs</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-bone/40">
            Powered by {process.env.REACT_APP_TENOR_API_KEY ? 'Tenor' : 'GIPHY'}
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-lg hover:bg-white/[0.08] text-bone/50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!tenorEnabled() ? (
          <div className="p-6 text-center text-sm text-bone/50">
            GIF search is offline. (Add <code className="bg-charcoal-800 px-1 rounded text-xs">REACT_APP_TENOR_API_KEY</code> or <code className="bg-charcoal-800 px-1 rounded text-xs">REACT_APP_GIPHY_API_KEY</code> to enable.)
          </div>
        ) : (
          <>
            <div className="p-3 border-b border-white/5">
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search GIFs (e.g. goal, high five, celebrate)"
                className="w-full bg-charcoal-800 rounded-full px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-crimson-300 text-[15px]"
                style={{ fontSize: '16px' }}
              />
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {loading && results.length === 0 ? (
                <div className="p-6 text-center text-sm text-bone/40">Loading…</div>
              ) : results.length === 0 ? (
                <div className="p-6 text-center text-sm text-bone/40">No GIFs found.</div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {results.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => { onPick(g); onClose(); }}
                      className="relative overflow-hidden rounded-lg bg-charcoal-800 hover:opacity-80 transition-opacity active:scale-95"
                      style={{ aspectRatio: `${g.width} / ${g.height}` }}
                      title={g.description}
                    >
                      <img
                        src={g.previewUrl}
                        alt={g.description}
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default GifPicker;
