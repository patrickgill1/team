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
    <div className="bg-surface-elevated rounded-t-2xl sm:rounded-2xl shadow-2xl w-full overflow-hidden">
      {/* Dark navy header to match the rest of the app's branded
          chrome (TeamChat action sheet, Wall composer, etc.). Title
          on the left, search + close on the right. */}
      <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Add Reaction</div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSearchOpen(s => !s)}
            aria-label="Search emoji"
            className={`w-8 h-8 rounded-full flex items-center justify-center transition ${
              searchOpen ? 'bg-brand-primary/150/20 text-ink-primary' : 'text-ink-primary/40 hover:text-white hover:bg-line-default/10'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-ink-primary/40 hover:text-white hover:bg-line-default/10"
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
            className="w-full px-3 py-2 text-sm bg-surface-input border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
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
                activeTab === g.id ? 'bg-brand-primary/15 ring-1 ring-brand-primary-soft/30' : 'hover:bg-line-default/[0.05]'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid — 6 columns at large size (Ollie pattern). Big
          tap targets, easy to pick with a thumb. Taller scroll area
          so you don't have to flick through the whole catalog. */}
      <div className="grid grid-cols-6 gap-1.5 p-3 max-h-[60vh] overflow-y-auto" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {visible.length === 0 ? (
          <div className="col-span-6 text-center text-sm text-ink-primary/40 py-6">No matches.</div>
        ) : (
          visible.map((e, i) => (
            <button
              key={`${e}-${i}`}
              onClick={() => onPick(e)}
              className="text-3xl py-3 rounded-xl hover:bg-line-default/[0.08] active:scale-95 transition"
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
