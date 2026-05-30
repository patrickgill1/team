import React, { useMemo, useState } from 'react';

// Hand-curated emoji set — bigger than the old 8-option grid, but
// still finite (no fat unicode dependency). Grouped by tab so the
// most likely soccer-team reactions are one tap away.

const GROUPS: { id: string; label: string; emojis: string[] }[] = [
  {
    id: 'top',
    label: 'Top',
    emojis: [
      '👍','❤️','🔥','⚽','🏆','😂','🙌','👏',
      '💯','🎉','😍','💪','🤩','😅','🥳','😎',
    ],
  },
  {
    id: 'faces',
    label: 'Faces',
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
    label: 'Hands',
    emojis: [
      '👍','👎','👌','🤝','🙏','👋','✋','🤘',
      '👊','✊','🤛','🤜','✌️','🤞','🤟','🫶',
      '💪','🦾','👏','🙌','🫳','🫴','🤲','🖐️',
    ],
  },
  {
    id: 'hearts',
    label: 'Hearts',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍',
      '🤎','💖','💗','💓','💞','💕','💘','💝',
      '❣️','💟','♥️','💔',
    ],
  },
  {
    id: 'sports',
    label: 'Sports',
    emojis: [
      '⚽','🥅','🏆','🥇','🥈','🥉','🏅','🎖️',
      '⛳','🎯','🏃','🤸','🏋️','🚴','🏟️','🎽',
      '⛹️','🤾','🏊','🤺','🏉','🥎','🏐','🏀',
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
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
    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
      {/* Search */}
      <div className="px-3 pt-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          className="w-full px-3 py-2 text-sm bg-slate-100 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        />
      </div>

      {/* Tabs (only when not searching) */}
      {!filtered && (
        <div className="flex gap-1 px-3 pt-2 overflow-x-auto">
          {GROUPS.map(g => (
            <button
              key={g.id}
              onClick={() => setActiveTab(g.id)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase whitespace-nowrap ${
                activeTab === g.id ? 'bg-cyan-500/15 text-cyan-700' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
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

      <button
        onClick={onClose}
        className="w-full text-center py-3 text-sm font-bold text-slate-500 hover:bg-slate-50 border-t border-slate-100"
      >
        Close
      </button>
    </div>
  );
};

export default EmojiPicker;
