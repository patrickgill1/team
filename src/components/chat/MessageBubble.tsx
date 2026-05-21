import React, { useRef, useState } from 'react';
import { ChatMessage } from '../../types';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '⚽', '🏆', '😂', '🙌', '👏'];

interface MessageBubbleProps {
  message: ChatMessage;
  currentUserId: string;
  currentUserName: string;
  replyTarget?: ChatMessage | null;
  onReply: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  formatTime: (d: any) => string;
  /** First message from this sender in a run (show avatar + name) */
  isFirstInGroup?: boolean;
  /** Last message from this sender in a run (show timestamp underneath) */
  isLastInGroup?: boolean;
  compact?: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderRichContent(text: string, ownTheme: boolean): string {
  const safe = escapeHtml(text);
  const linkColor = ownTheme ? 'text-white underline underline-offset-2' : 'text-cyan-700 underline underline-offset-2';
  const linked = safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    `<a href="$1" target="_blank" rel="noopener noreferrer" class="${linkColor} break-all">$1</a>`
  );
  const mentionColor = ownTheme ? 'bg-white/25 text-white' : 'bg-cyan-100 text-cyan-900';
  const mentioned = linked.replace(
    /@([A-Za-z][A-Za-z0-9 _'-]{0,28}[A-Za-z0-9])/g,
    `<span class="${mentionColor} font-semibold px-1 rounded">@$1</span>`
  );
  return mentioned;
}

const senderColor = (name: string): string => {
  // Stable, distinct avatar tint per sender — name hash → hue.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = [
    'bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-cyan-500',
    'bg-violet-500', 'bg-fuchsia-500', 'bg-blue-500', 'bg-teal-500',
  ];
  return palette[h % palette.length];
};

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  currentUserId,
  currentUserName,
  replyTarget,
  onReply,
  onToggleReaction,
  formatTime,
  isFirstInGroup = true,
  isLastInGroup = true,
}) => {
  const [actionsOpen, setActionsOpen] = useState(false);
  const longPressTimer = useRef<number | null>(null);

  const isOwn = message.senderId === currentUserId;

  // Group reactions by emoji
  const grouped: Record<string, { count: number; mine: boolean; names: string[] }> = {};
  for (const r of message.reactions || []) {
    if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false, names: [] };
    grouped[r.emoji].count += 1;
    if (r.userId === currentUserId) grouped[r.emoji].mine = true;
    grouped[r.emoji].names.push(r.userName || '');
  }

  const images = (message.attachments || []).filter((a) => a.type === 'image');
  const isMentioned =
    !!currentUserName &&
    new RegExp(`@${currentUserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
      message.content || ''
    );

  // Continuous-bubble corners: middle of a run flattens the appropriate edge
  // so consecutive bubbles read as one column of speech.
  const cornerClasses = isOwn
    ? `rounded-2xl ${isFirstInGroup ? '' : 'rounded-tr-md'} ${isLastInGroup ? '' : 'rounded-br-md'}`
    : `rounded-2xl ${isFirstInGroup ? '' : 'rounded-tl-md'} ${isLastInGroup ? '' : 'rounded-bl-md'}`;

  const bubbleBg = isOwn
    ? 'bg-cyan-600 text-white'
    : 'bg-white text-gray-900 ring-1 ring-gray-200';

  const handleTouchStart = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => setActionsOpen(true), 350);
  };
  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <div
      className={`group flex ${isOwn ? 'justify-end' : 'justify-start'} ${
        isFirstInGroup ? 'mt-3' : 'mt-0.5'
      } px-1`}
    >
      {/* Avatar gutter for incoming messages — only renders on the first
          message of a run, but always reserves the space so subsequent
          messages line up with the first one's bubble edge. */}
      {!isOwn && (
        <div className="w-9 mr-2 flex-shrink-0 self-end">
          {isFirstInGroup && (
            <div
              className={`w-8 h-8 rounded-full text-white text-sm font-bold flex items-center justify-center shadow-sm ${senderColor(
                message.senderName
              )}`}
              title={message.senderName}
            >
              {message.senderName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      )}

      <div className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}>
        {/* Sender name + coach pill — only on first message in a run, for incoming */}
        {!isOwn && isFirstInGroup && (
          <div className="ml-1 mb-0.5 flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-700">{message.senderName}</span>
            {message.senderRole === 'coach' && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">
                Coach
              </span>
            )}
          </div>
        )}

        {/* Reply quote — sits above the bubble */}
        {message.replyTo && (
          <div
            className={`text-xs mb-1 px-3 py-1.5 rounded-xl max-w-full ${
              isOwn ? 'bg-cyan-100 text-cyan-900' : 'bg-gray-100 text-gray-700'
            }`}
          >
            <div className="text-[10px] font-bold opacity-70">
              ↪ {replyTarget?.senderName || 'message'}
            </div>
            {replyTarget ? (
              <div className="truncate max-w-[260px]">
                {(replyTarget.content || '').slice(0, 140) || (replyTarget.attachments?.length ? '📷 photo' : '')}
              </div>
            ) : (
              <span className="italic opacity-60">unavailable</span>
            )}
          </div>
        )}

        {/* The bubble itself */}
        {message.content && (
          <div
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setActionsOpen(true); }}
            className={`px-3.5 py-2 leading-relaxed break-words text-[15px] shadow-sm select-text ${cornerClasses} ${bubbleBg} ${
              isMentioned && !isOwn ? 'ring-2 ring-amber-300' : ''
            }`}
            style={{ wordBreak: 'break-word' }}
            dangerouslySetInnerHTML={{ __html: renderRichContent(message.content, isOwn) }}
          />
        )}

        {/* Image attachments */}
        {images.length > 0 && (
          <div
            className={`mt-1 grid gap-1 ${images.length === 1 ? '' : 'grid-cols-2'} max-w-full`}
          >
            {images.map((img, i) => (
              <a
                key={i}
                href={img.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={img.url}
                  alt={img.name || 'attachment'}
                  className={`rounded-2xl object-cover ${
                    images.length === 1 ? 'max-h-72 w-auto' : 'h-32 w-full'
                  }`}
                />
              </a>
            ))}
          </div>
        )}

        {/* Reaction chips beneath the bubble */}
        {Object.keys(grouped).length > 0 && (
          <div className={`mt-1 flex flex-wrap gap-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
            {Object.entries(grouped).map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => onToggleReaction(message, emoji)}
                title={info.names.join(', ')}
                className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                  info.mine
                    ? 'bg-cyan-100 ring-1 ring-cyan-300 text-cyan-900'
                    : 'bg-white ring-1 ring-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="mr-1">{emoji}</span>
                <span className="font-semibold tabular-nums">{info.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Timestamp under the last message in a run */}
        {isLastInGroup && (
          <div className={`mt-0.5 text-[10px] text-gray-400 ${isOwn ? 'mr-1' : 'ml-1'}`}>
            {formatTime(message.timestamp)}
          </div>
        )}
      </div>

      {/* Action sheet — opens on long-press or right-click. Tap outside to close. */}
      {actionsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4"
          onClick={() => setActionsOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-4 gap-1 p-3 border-b border-gray-100">
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onToggleReaction(message, e);
                    setActionsOpen(false);
                  }}
                  className="text-2xl py-2 rounded-xl hover:bg-gray-100 transition active:scale-95"
                >
                  {e}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                onReply(message);
                setActionsOpen(false);
              }}
              className="w-full text-left px-4 py-3 text-sm font-medium text-gray-900 hover:bg-gray-50 transition flex items-center gap-3"
            >
              <span>↪</span> Reply
            </button>
            <button
              onClick={() => setActionsOpen(false)}
              className="w-full text-center px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50 border-t border-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageBubble;
