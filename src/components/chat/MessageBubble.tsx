import React, { useRef, useState } from 'react';
import { ChatMessage } from '../../types';
import PollCard from './PollCard';
import EmojiPicker from './EmojiPicker';
import ReadBySheet from './ReadBySheet';

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
  /** Called when the user taps "I see this" to acknowledge an important
   *  message. Adds their uid to the message's acknowledgedBy[]. */
  onAcknowledge?: (m: ChatMessage) => void;
  /** Total participants in the thread — used to render the "5/12
   *  acknowledged" count under important messages. */
  threadParticipantCount?: number;
  formatTime: (d: any) => string;
  /** First message from this sender in a run (show avatar + name) */
  isFirstInGroup?: boolean;
  /** Last message from this sender in a run (show timestamp underneath) */
  isLastInGroup?: boolean;
  compact?: boolean;
  /** Optional live photo lookup by senderId. Used as a fallback when
   *  the message itself doesn't carry senderPhotoUrl (older messages
   *  predate that field) so DMs / threads still show real avatars. */
  getSenderPhotoUrl?: (senderId: string) => string | undefined;
  /** Optional name lookup by uid — used to render the "Read by" list. */
  getUserName?: (uid: string) => string | undefined;
  /** Called once on first render of a message NOT sent by the current
   *  user and NOT already in readBy[currentUserId]. Wires up the
   *  read-receipt write back to Firestore from the parent. */
  onMarkRead?: (m: ChatMessage) => void;
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
  onAcknowledge,
  threadParticipantCount,
  formatTime,
  isFirstInGroup = true,
  isLastInGroup = true,
  getSenderPhotoUrl,
  getUserName,
  onMarkRead,
}) => {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [readByOpen, setReadByOpen] = useState(false);
  const longPressTimer = useRef<number | null>(null);

  // Mark this message as read once per render-cycle if (a) it's not
  // ours and (b) the current user isn't already in readBy. Fires
  // immediately — the conversation is open, the message is in the
  // DOM, the user has effectively seen it.
  const isOwnForRead = message.senderId === currentUserId;
  const readBy = ((message as any).readBy || {}) as Record<string, number>;
  const alreadyRead = currentUserId ? !!readBy[currentUserId] : true;
  React.useEffect(() => {
    if (!onMarkRead) return;
    if (isOwnForRead) return;
    if (alreadyRead) return;
    onMarkRead(message);
  }, [message.id, isOwnForRead, alreadyRead, onMarkRead]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOwn = message.senderId === currentUserId;
  // Prefer the photoURL frozen onto the message at send time, but fall
  // back to a live lookup so older messages still get a real avatar.
  const resolvedPhotoUrl =
    (message as any).senderPhotoUrl ||
    (getSenderPhotoUrl ? getSenderPhotoUrl(message.senderId) : undefined);

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

  // Important / acknowledgment-required state.
  const isImportant = (message as any).requireAck === true;
  const ackList: string[] = Array.isArray((message as any).acknowledgedBy) ? (message as any).acknowledgedBy : [];
  const iAcked = !!currentUserId && ackList.includes(currentUserId);

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
            resolvedPhotoUrl ? (
              <img
                src={resolvedPhotoUrl}
                alt={message.senderName}
                title={message.senderName}
                className="w-8 h-8 rounded-full object-cover shadow-sm ring-1 ring-black/5"
                onError={(e) => {
                  // If the photo URL 404s (deleted Storage object, etc.)
                  // hide the broken <img> so the colored-initial fallback
                  // doesn't get crowded out.
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div
                className={`w-8 h-8 rounded-full text-white text-sm font-bold flex items-center justify-center shadow-sm ${senderColor(
                  message.senderName
                )}`}
                title={message.senderName}
              >
                {message.senderName.charAt(0).toUpperCase()}
              </div>
            )
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
        {message.content && !isImportant && (
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

        {/* Important / acknowledgment-required message — rendered as a
            full-width announcement card (overrides the regular bubble).
            Visually distinct so it doesn't get lost in the thread. */}
        {message.content && isImportant && (
          <div
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setActionsOpen(true); }}
            className="w-full max-w-[340px] rounded-2xl bg-gradient-to-br from-amber-100 to-amber-200 ring-1 ring-amber-400/50 shadow-md p-3.5"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-base">📢</span>
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-900">Important</span>
              {!iAcked && currentUserId !== message.senderId && (
                <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-amber-900/70 animate-pulse">
                  Tap to acknowledge
                </span>
              )}
            </div>
            <div
              className="text-amber-950 text-[15px] leading-relaxed break-words"
              style={{ wordBreak: 'break-word' }}
              dangerouslySetInnerHTML={{ __html: renderRichContent(message.content, false) }}
            />
            {/* Recipient: button to acknowledge; or confirmation if done. */}
            {currentUserId !== message.senderId && (
              <div className="mt-3">
                {iAcked ? (
                  <p className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    You've seen this
                  </p>
                ) : (
                  <button
                    onClick={() => onAcknowledge?.(message)}
                    className="w-full bg-amber-700 hover:bg-amber-800 active:scale-95 text-white font-bold py-2 rounded-xl text-sm shadow-sm transition"
                  >
                    ✓ I see this
                  </button>
                )}
              </div>
            )}
            {/* Sender: roster of who has / hasn't acknowledged. */}
            {currentUserId === message.senderId && (
              <p className="mt-2 text-[11px] font-semibold text-amber-900/80">
                {ackList.length} {threadParticipantCount ? `of ${threadParticipantCount} ` : ''}acknowledged
              </p>
            )}
          </div>
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
      {/* Reaction affordance — small chip next to incoming bubbles that
          opens the picker without long-press. Visible always on mobile,
          hidden until hover on desktop. */}
      {!isOwn && message.content && (
        <button
          onClick={() => setEmojiOpen(true)}
          aria-label="React to message"
          className="ml-1 self-end mb-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-white border border-slate-200 text-slate-500 shadow-sm sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
            <line x1="19" y1="6" x2="19" y2="10"/>
            <line x1="17" y1="8" x2="21" y2="8"/>
          </svg>
        </button>
      )}

      {actionsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4"
          onClick={() => setActionsOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Inline 8-quick-emoji row — most common reactions, one tap
                away. Tap "More" to open the full picker. */}
            <div className="grid grid-cols-9 gap-0.5 p-2 border-b border-slate-100">
              {['👍','❤️','🔥','⚽','🏆','😂','🙌','👏'].map((e) => (
                <button
                  key={e}
                  onClick={() => { onToggleReaction(message, e); setActionsOpen(false); }}
                  className="text-xl py-1.5 rounded-lg hover:bg-slate-100 active:scale-95"
                >{e}</button>
              ))}
              <button
                onClick={() => { setActionsOpen(false); setEmojiOpen(true); }}
                className="text-base py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold"
                aria-label="More emoji"
              >+</button>
            </div>

            <button
              onClick={() => { onReply(message); setActionsOpen(false); }}
              className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50 transition flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
              Reply
            </button>

            <button
              onClick={() => { setActionsOpen(false); setReadByOpen(true); }}
              className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50 transition flex items-center gap-3 border-t border-slate-100"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Read by {(message as any).readBy ? Object.keys((message as any).readBy).length : 0}
            </button>

            {canPin && onTogglePin && (
              <button
                onClick={() => { onTogglePin(message); setActionsOpen(false); }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50 transition flex items-center gap-3 border-t border-slate-100"
              >
                <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z"/></svg>
                {isPinned ? 'Unpin from thread' : 'Pin to thread'}
              </button>
            )}

            {isOwn && onDelete && (
              <button
                onClick={() => { onDelete(message); setActionsOpen(false); }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50 transition flex items-center gap-3 border-t border-slate-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                Delete
              </button>
            )}

            <button
              onClick={() => setActionsOpen(false)}
              className="w-full text-center px-4 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-50 border-t border-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Full emoji picker — opened from the affordance chip OR
          from the "+" button in the action sheet. */}
      {emojiOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4"
          onClick={() => setEmojiOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm">
            <EmojiPicker
              onPick={(emoji) => { onToggleReaction(message, emoji); setEmojiOpen(false); }}
              onClose={() => setEmojiOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Read-by sheet — list of who's seen this message, with timestamps. */}
      {readByOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4"
          onClick={() => setReadByOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ReadBySheet
              readers={Object.entries(((message as any).readBy || {}) as Record<string, number>).map(([uid, readAt]) => ({
                uid,
                readAt,
                name: getUserName ? (getUserName(uid) || 'Member') : 'Member',
                photoURL: getSenderPhotoUrl ? getSenderPhotoUrl(uid) : undefined,
              }))}
              threadParticipantCount={threadParticipantCount}
              onClose={() => setReadByOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageBubble;
