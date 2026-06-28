// @ts-nocheck
import React from 'react';
import { ChatMessage } from '../../types';

interface Props {
  message: ChatMessage;
  currentUserId: string;
  /** Tap your own reaction in the sheet to remove it. */
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onClose: () => void;
  /** Looks up sender photo for avatar tiles. Optional — falls back to
   *  the first-letter colored circle when missing. */
  getUserPhotoUrl?: (uid: string) => string | undefined;
}

/**
 * Bottom-sheet (mobile) / centered modal (desktop) listing each emoji
 * with its reactors. Tap your own reaction to remove it. Tap anywhere
 * outside to close.
 */
const ReactionDetailsSheet: React.FC<Props> = ({ message, currentUserId, onToggleReaction, onClose, getUserPhotoUrl }) => {
  const grouped: Record<string, Array<{ uid: string; name: string }>> = {};
  for (const r of message.reactions || []) {
    if (!grouped[r.emoji]) grouped[r.emoji] = [];
    grouped[r.emoji].push({ uid: r.userId, name: r.userName || 'Member' });
  }
  const emojis = Object.keys(grouped);
  const totalReactors = (message.reactions || []).length;

  // Stable color from name hash — same palette as MessageBubble.
  const senderColor = (name: string): string => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const palette = [
      'from-rose-400 to-rose-600',
      'from-amber-400 to-orange-600',
      'from-emerald-400 to-emerald-600',
      'from-brand-primary-soft to-brand-primary',
      'from-violet-400 to-violet-600',
      'from-fuchsia-400 to-pink-600',
      'from-brand-primary-soft to-surface-tint',
      'from-teal-400 to-teal-600',
    ];
    return palette[h % palette.length];
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-elevated w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden"
      >
        <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
          <button
            onClick={onClose}
            className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-white px-1"
          >
            Close
          </button>
          <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">
            Reactions <span className="text-ink-primary/50">{totalReactors}</span>
          </div>
          <span className="w-12" aria-hidden />
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {emojis.map((emoji) => (
            <div key={emoji} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{emoji}</span>
                <span className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/50">
                  {grouped[emoji].length}
                </span>
              </div>
              <ul className="space-y-1.5">
                {grouped[emoji].map(({ uid, name }) => {
                  const isMe = uid === currentUserId;
                  const photo = getUserPhotoUrl ? getUserPhotoUrl(uid) : undefined;
                  const initial = (name || '?').charAt(0).toUpperCase();
                  return (
                    <li
                      key={uid}
                      className={`flex items-center justify-between gap-2 py-1 ${isMe ? '' : ''}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {photo ? (
                          <img src={photo} alt="" className="w-7 h-7 rounded-full object-cover" />
                        ) : (
                          <span className={`w-7 h-7 rounded-full bg-gradient-to-br ${senderColor(name)} text-white text-xs font-bold flex items-center justify-center`}>
                            {initial}
                          </span>
                        )}
                        <span className={`text-sm truncate ${isMe ? 'font-bold text-brand-primary' : 'text-ink-primary'}`}>
                          {isMe ? 'You' : name}
                        </span>
                      </span>
                      {isMe && (
                        <button
                          onClick={() => onToggleReaction(message, emoji)}
                          className="text-[10px] font-extrabold tracking-widest uppercase text-rose-600 hover:text-rose-800 px-2 py-1"
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ReactionDetailsSheet;
