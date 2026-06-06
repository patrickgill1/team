import React, { useMemo, useState } from 'react';

// Hand-curated emoji set — bigger than the old 8-option grid, but
// still finite (no fat unicode dependency). Grouped by tab so the
// most likely soccer-team reactions are one tap away.

// Tab labels are emoji icons rather than words. Wordy tabs (TOP / FACES /
// HANDS / HEARTS / SPORTS / OBJECTS) horizontally overflowed on small
// phones and cut off the last category. Single-glyph tabs always fit,
// and the picker stops feeling like a kitchen-sink dialog.
const GROUPS: { id: string; label: string; emojis: string[] }[] = [
  {
    id: 'top',
    label: '★',
    emojis: [
      '👍','❤️','🔥','⚽','🏆','😂','🙌','👏',
      '💯','🎉','😍','💪','🤩','😅','🥳','😎',
    ],
  },
  {
    id: 'faces',
    label: '😀',
    emojis: [
      '😀','😃','😄','😆','😊','🙂','😉','😌',
      '😘','🥰','😍','🤩','😋','😛','😜','🤪',
      '🤗','🤔','😐','😶','🙄','😏','😬','🤐',
      '😪','😴','🤤','😔','😢','😭','😤','😡',
      '🤬','🤯','😱','😨','😰','😥','🤢','🤮',
    ],
  },
  {
    id: 'hands',
    label: '👋',
    emojis: [
      '👍','👎','👌','🤝','🙏','👋','✋','🤘',
      '👊','✊','🤛','🤜','✌️','🤞','🤟','🫶',
      '💪','🦾','👏','🙌','🫳','🫴','🤲','🖐️',
    ],
  },
  {
    id: 'hearts',
    label: '❤️',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍',
      '🤎','💖','💗','💓','💞','💕','💘','💝',
      '❣️','💟','♥️','💔',
    ],
  },
  {
    id: 'sports',
    label: '⚽',
    emojis: [
      '⚽','🥅','🏆','🥇','🥈','🥉','🏅','🎖️',
      '⛳','🎯','🏃','🤸','🏋️','🚴','🏟️','🎽',
      '⛹️','🤾','🏊','🤺','🏉','🥎','🏐','🏀',
    ],
  },
  {
    id: 'objects',
    label: '🎉',
    emojis: [
      '🎉','🎊','🎈','🎁','🎂','🍕','🌭','🥤',
      '☕','🍺','🥃','🍿','💯','💥','⭐','🌟',
      '☀️','🌧️','⛈️','🌈','❄️','🌍','🚗','✈️',
    ],
  },
];

// Flatten for searches. Search matches against a tiny per-emoji
// keyword list (the most common soccer-team reactions).
const KEYWORDS: Record<string, string[]> = {
  '👍': ['like','yes','ok','thumbs','up','good'],
  '👎': ['no','down','dislike','thumbs'],
  '❤️': ['heart','love','red'],
  '🔥': ['fire','hot','lit'],
  '⚽': ['soccer','ball','football'],
  '🏆': ['trophy','win','champion'],
  '🥇': ['gold','first','medal','win'],
  '😂': ['lol','laugh','tears','joy','funny'],
  '🙌': ['praise','celebrate','hands'],
  '👏': ['clap','applause','well','done','nice'],
  '💪': ['strong','muscle','flex'],
  '🤩': ['star','eyes','wow'],
  '😍': ['love','eyes','heart'],
  '🥳': ['party','celebrate','birthday'],
  '🎉': ['party','celebrate','tada'],
  '💯': ['hundred','perfect','full','marks'],
  '🙏': ['please','thanks','pray'],
  '😎': ['cool','sunglasses'],
  '🌧️': ['rain','weather'],
  '☀️': ['sun','sunny','hot'],
};

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

const EmojiPicker: React.FC<Props> = ({ onPick, onClose }) => {
  const [activeTab, setActiveTab] = useState<string>('top');
  const [query, setQuery] = useState('');
  // Search input is hidden by default — opening the picker should not
  // pop the keyboard. User taps the magnifier to reveal it on demand.
  const [searchOpen, setSearchOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const matches: string[] = [];
    const seen = new Set<string>();
    for (const g of GROUPS) {
      for (const e of g.emojis) {
        if (seen.has(e)) continue;
        const kws = KEYWORDS[e] || [];
        if (kws.some(k => k.includes(q))) {
          matches.push(e);
          seen.add(e);
        }
      }
    }
    return matches;
  }, [query]);

  const visible = filtered ?? (GROUPS.find(g => g.id === activeTab)?.emojis || []);

  return (
    <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
      {/* Lightweight header — the heavy navy strip was overpowering for
          a small picker. Drag-handle hint up top, search + close on a
          single row below it. The picker's purpose is obvious from
          context; no need for a "REACT" label. */}
      <div className="pt-1.5 pb-1 border-b border-slate-100">
        <div className="w-9 h-1 rounded-full bg-slate-200 mx-auto mb-1" aria-hidden />
        <div className="px-3 flex items-center justify-end gap-1">
          <button
            onClick={() => setSearchOpen(s => !s)}
            aria-label="Search emoji"
            className={`w-7 h-7 rounded-md flex items-center justify-center transition ${
              searchOpen ? 'bg-cyan-50 text-cyan-700' : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      {/* Search input — only renders when toggled. Autofocus is OK
          HERE because the user explicitly asked for it by tapping the
          magnifier. */}
      {searchOpen && (
        <div className="px-3 pt-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full px-3 py-2 text-sm bg-slate-100 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
      )}

      {/* Category tabs — single-glyph icons fit on one row without
          overflow (the old word labels cut off the last tab on small
          phones). Active tab gets a soft cyan pill. */}
      {!filtered && (
        <div className="flex justify-between px-3 pt-2">
          {GROUPS.map(g => (
            <button
              key={g.id}
              onClick={() => setActiveTab(g.id)}
              aria-label={g.id}
              className={`flex-1 mx-0.5 h-8 rounded-lg text-base flex items-center justify-center transition ${
                activeTab === g.id ? 'bg-cyan-50 ring-1 ring-cyan-200' : 'hover:bg-slate-50'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-1 p-3 max-h-64 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="col-span-8 text-center text-sm text-slate-400 py-6">No matches.</div>
        ) : (
          visible.map((e, i) => (
            <button
              key={`${e}-${i}`}
              onClick={() => onPick(e)}
              className="text-xl py-1.5 rounded-lg hover:bg-slate-100 active:scale-95 transition"
            >
              {e}
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default EmojiPicker;
