import React from 'react';
import type { GalleryPhoto, Player } from '../../types';

interface Props {
  photos: GalleryPhoto[];
  players: Player[];
  currentUid?: string;
  onOpen: (index: number) => void;
}

// CSS-column masonry. Each column stacks items vertically; browser
// balances them automatically. Fast, no library, works on every
// device. Trade-off: reading order is column-then-row instead of
// pure chronological — for a photo grid where recency matters at
// the top, this reads fine because column 1's first item is the
// newest.
const PhotoMasonry: React.FC<Props> = ({ photos, players, currentUid, onOpen }) => {
  const playerMap = React.useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

  if (photos.length === 0) return null;

  return (
    <div
      className="w-full"
      style={{
        // 2 cols on phones, 3 on tablets, 4 on wide screens. columnGap
        // reads as `gap` in most browsers today.
        columnGap: '10px',
        columnCount: 'var(--pm-cols)' as any,
      } as any}
    >
      <style>{`
        @media (min-width: 0px)   { .pm-container { column-count: 2; } }
        @media (min-width: 640px) { .pm-container { column-count: 3; } }
        @media (min-width: 1024px){ .pm-container { column-count: 4; } }
        @media (min-width: 1536px){ .pm-container { column-count: 5; } }
        .pm-tile { break-inside: avoid; margin-bottom: 10px; }
      `}</style>
      <div className="pm-container">
        {photos.map((photo, i) => {
          const tagged = photo.taggedPlayerIds || [];
          const firstTag = tagged[0] ? playerMap.get(tagged[0]) : null;
          const iReacted = !!(currentUid && photo.reactions?.includes(currentUid));
          const reactionCount = photo.reactionCount ?? (photo.reactions?.length || 0);
          return (
            <button
              key={photo.id}
              onClick={() => onOpen(i)}
              className="pm-tile relative w-full block rounded-xl overflow-hidden bg-surface-elevated ring-1 ring-line-default/10 group hover:ring-cyan-500/40 transition"
            >
              <img
                src={photo.thumbnailUrl || photo.url}
                alt={photo.caption || ''}
                loading="lazy"
                decoding="async"
                className="w-full h-auto object-cover block transition-transform duration-500 group-hover:scale-[1.02]"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0.4'; }}
              />
              {/* Bottom overlay: caption + tag pill + reaction */}
              <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent text-white opacity-0 group-hover:opacity-100 transition-opacity">
                {photo.caption && (
                  <p className="text-[11px] font-semibold line-clamp-2 leading-snug mb-1">{photo.caption}</p>
                )}
                <div className="flex items-center justify-between text-[10px] font-bold">
                  <div className="flex items-center gap-1 flex-wrap truncate">
                    {firstTag && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-cyan-500/70 text-white truncate max-w-[100px]">
                        {firstTag.name}
                      </span>
                    )}
                    {tagged.length > 1 && (
                      <span className="opacity-80">+{tagged.length - 1}</span>
                    )}
                  </div>
                  {reactionCount > 0 && (
                    <span className={`inline-flex items-center gap-0.5 ${iReacted ? 'text-rose-300' : 'text-white/80'}`}>
                      <svg className="w-3 h-3" fill={iReacted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" /></svg>
                      {reactionCount}
                    </span>
                  )}
                </div>
              </div>
              {/* Persistent bottom-right heart when the current user reacted */}
              {iReacted && (
                <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-rose-500/95 text-white flex items-center justify-center shadow">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" /></svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default PhotoMasonry;
