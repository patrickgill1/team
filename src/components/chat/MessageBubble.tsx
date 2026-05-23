import React, { useRef, useState } from 'react';
import { ChatMessage } from '../../types';
import PollCard from './PollCard';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '⚽', '🏆', '😂', '🙌', '👏'];

interface MessageBubbleProps {
  message: ChatMessage;
  currentUserId: string;
  currentUserName: string;
  replyTarget?: ChatMessage | null;
  onReply: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  /** Delete handler — only shown for the user's own messages. */
  onDelete?: (m: ChatMessage) => void;
  /** Toggle pin on this message (coaches / admins only). */
  onTogglePin?: (m: ChatMessage) => void;
  /** Whether this message is currently pinned in its thread. */
  isPinned?: boolean;
  /** Whether the current user is allowed to pin/unpin in this thread. */
  canPin?: boolean;
  /** Called when the user taps an image attachment — opens the lightbox. */
  onImageClick?: (url: string) => void;
  /** Called when the user votes on a poll option in this message. */
  onPollVote?: (messageId: string, optionId: string) => void;
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
  // @team is a special everyone-ping mention; render it noticeably
  // differently so it's clear at a glance that the whole team got
  // pinged, not just one parent.
  const teamMentionColor = ownTheme
    ? 'bg-amber-300 text-amber-900'
    : 'bg-amber-100 text-amber-900 ring-1 ring-amber-200';
  const withTeam = linked.replace(
    /@(team|everyone)\b/gi,
    `<span class="${teamMentionColor} font-bold px-1.5 rounded">@team</span>`
  );
  const mentioned = withTeam.replace(
    /@([A-Za-z][A-Za-z0-9 _'-]{0,28}[A-Za-z0-9])/g,
    `<span class="${mentionColor} font-semibold px-1 rounded">@$1</span>`
  );
  return mentioned;
}

const senderColor = (name: string): string => {
  // Stable, distinct avatar tint per sender — name hash → gradient.
  // Subtle diagonal gradient feels more polished than flat fills while
  // staying readable on small avatars.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = [
    'bg-gradient-to-br from-rose-400 to-rose-600',
    'bg-gradient-to-br from-amber-400 to-orange-600',
    'bg-gradient-to-br from-emerald-400 to-emerald-600',
    'bg-gradient-to-br from-cyan-400 to-cyan-600',
    'bg-gradient-to-br from-violet-400 to-violet-600',
    'bg-gradient-to-br from-fuchsia-400 to-pink-600',
    'bg-gradient-to-br from-blue-400 to-blue-600',
    'bg-gradient-to-br from-teal-400 to-teal-600',
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
  onDelete,
  onTogglePin,
  isPinned = false,
  canPin = false,
  onImageClick,
  onPollVote,
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

  // Be defensive: skip attachments missing a URL — historic messages
  // can have malformed data, and rendering <img src={undefined}> in a
  // long thread is a known way to OOM the iOS WKWebView (which is what
  // caused the force-close on threads with photos after the 1.0 release).
  const images = (message.attachments || []).filter(
    (a) => a && a.type === 'image' && typeof a.url === 'string' && a.url.length > 0
  );
  const isMentioned =
    !!currentUserName &&
    new RegExp(`@${currentUserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
      message.content || ''
    );

  // Continuous-bubble corners: middle of a run flattens the appropriate edge
  // so consecutive bubbles read as one column of speech.
  const cornerClasses = isOwn
    ? `rounded-[20px] ${isFirstInGroup ? '' : 'rounded-tr-md'} ${isLastInGroup ? '' : 'rounded-br-md'}`
    : `rounded-[20px] ${isFirstInGroup ? '' : 'rounded-tl-md'} ${isLastInGroup ? '' : 'rounded-bl-md'}`;

  // Sleeker bubble fills: subtle gradient on outgoing, soft fill (no
  // ring) on incoming — closer to iMessage / modern messaging apps.
  const bubbleBg = isOwn
    ? 'bg-gradient-to-br from-cyan-500 to-cyan-600 text-white'
    : 'bg-gray-100 text-gray-900';

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

        {/* Inline poll card — replaces the standard text bubble when
            a poll is attached. Renders before image attachments so the
            poll is the visual centerpiece of the message. */}
        {message.poll && (
          <PollCard
            message={message}
            currentUserId={currentUserId}
            ownTheme={isOwn}
            onVote={(mid, oid) => onPollVote?.(mid, oid)}
          />
        )}

        {/* Image attachments */}
        {images.length > 0 && (
          <div
            className={`mt-1 grid gap-1 ${images.length === 1 ? '' : 'grid-cols-2'} max-w-full`}
          >
            {images.map((img, i) => (
              // Render the <img> directly (no <a> wrapper) so iOS's native
              // long-press menu (Save Image / Copy / Share) still works.
              // Tap is handled by onClick → lightbox; long-press falls
              // through to the WebView's default behavior.
              <img
                key={i}
                src={img.url}
                alt={img.name || 'attachment'}
                loading="lazy"
                decoding="async"
                onClick={() => onImageClick?.(img.url)}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
                className={`rounded-2xl object-cover cursor-pointer ${
                  images.length === 1 ? 'max-h-72 w-auto' : 'h-32 w-full'
                }`}
              />
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
            {canPin && onTogglePin && (
              <button
                onClick={() => {
                  onTogglePin(message);
                  setActionsOpen(false);
                }}
                className="w-full text-left px-4 py-3 text-sm font-medium text-gray-900 hover:bg-gray-50 transition flex items-center gap-3 border-t border-gray-100"
              >
                <span>📌</span> {isPinned ? 'Unpin from thread' : 'Pin to thread'}
              </button>
            )}
            {isOwn && onDelete && (
              <button
                onClick={() => {
                  onDelete(message);
                  setActionsOpen(false);
                }}
                className="w-full text-left px-4 py-3 text-sm font-medium text-red-600 hover:bg-red-50 transition flex items-center gap-3 border-t border-gray-100"
              >
                <span>🗑️</span> Delete
              </button>
            )}
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
