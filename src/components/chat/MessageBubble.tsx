import React, { useRef, useState } from 'react';
import { ChatMessage } from '../../types';
import PollCard from './PollCard';
import EmojiPicker from './EmojiPicker';
import ReadBySheet from './ReadBySheet';
import ReactionDetailsSheet from './ReactionDetailsSheet';
import UserProfileModal from '../common/UserProfileModal';

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
  /** Called every time an image attachment finishes loading. Parent
   *  uses this to pin the scroll container to bottom — without it,
   *  WebKit's scroll anchoring can land the user on the image. */
  onImageLoaded?: () => void;
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
  /** Trigger an async fetch for uids the active-team roster can't
   *  resolve. Lets the Seen-by sheet pull names for people on OTHER
   *  teams who saw the message back when the viewer was on their team. */
  resolveUnknownUids?: (uids: string[]) => void;
  /** Coach / admin gate for the poll's "Voters" affordance. When true,
   *  PollCard surfaces a button that opens a per-option voter list. */
  canSeeVoters?: boolean;
  /** Called once on first render of a message NOT sent by the current
   *  user and NOT already in readBy[currentUserId]. Wires up the
   *  read-receipt write back to Firestore from the parent. */
  onMarkRead?: (m: ChatMessage) => void;
  /** Open a DM with another user. Wired through to the action sheet's
   *  "Message" button so users can DM directly from a profile. */
  onStartDm?: (uid: string, name: string) => void;
  /** Mute / unmute another user in this user's preferences. */
  onToggleMute?: (uid: string, name: string) => void;
  /** Is the target sender currently muted in this user's prefs? */
  isMuted?: boolean;
  /** Save an edit to this message (own messages only). */
  onEdit?: (m: ChatMessage, newContent: string) => Promise<void> | void;
  /** True when this bubble lives in a 1:1 DM thread. In group chats
   *  we deliberately suppress the double-check "seen by N" badge —
   *  with many participants it's noise, not signal. DMs keep both
   *  states (sent → single check, seen → double check). */
  threadIsDm?: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Chat-attachment image with a soft slate placeholder and an opacity
// fade once the bytes decode. This replaces the bare <img>, which on
// iOS WKWebView shows a brief BLACK flash between request and decode —
// the source of the "photos flash to black" feedback. The wrapping div
// holds the layout dimensions so there is also no layout shift as the
// image arrives.
const ChatAttachmentImage: React.FC<{
  src: string;
  alt: string;
  solo: boolean;
  onLoad?: () => void;
  onClick?: () => void;
  /** When true, the image is rendered INSIDE a parent bubble — drop
   *  the rounded corners and the placeholder background so it tucks
   *  cleanly into the bubble's fill (iMessage pattern). */
  insideBubble?: boolean;
}> = ({ src, alt, solo, onLoad, onClick, insideBubble }) => {
  const skinClasses = insideBubble
    ? 'bg-black/10'
    : 'rounded-2xl bg-slate-100';

  // Solo: let the image drive its own size (intrinsic, capped at
  // max-h-72). This is what the pre-ChatAttachmentImage code did
  // and it Just Worked. The previous version forced `w-full
  // aspect-[4/3]` inside a grid with no explicit columns — WebKit
  // resolves that circular sizing to 0×0 and the bubble looks
  // empty. Symptom: photo-only and GIF-only messages render as
  // invisible bubbles on iOS. Photos with text were unaffected
  // because that path nests inside an already-sized text bubble.
  //
  // Multi-image (grid): absolute-fill the cell — grid-cols-2 gives
  // the parent explicit tracks, so w-full + aspect-square has
  // something concrete to anchor to.
  if (solo) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => onLoad?.()}
        onError={() => console.warn('[chat] attachment image failed to load', src)}
        onClick={onClick}
        className={`block max-h-72 w-auto max-w-full cursor-pointer ${skinClasses}`}
        style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      />
    );
  }

  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden cursor-pointer w-full aspect-square ${skinClasses}`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => onLoad?.()}
        onError={() => console.warn('[chat] attachment image failed to load', src)}
        className="absolute inset-0 w-full h-full object-cover"
        style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      />
    </div>
  );
};

function renderRichContent(text: string, ownTheme: boolean): string {
  const safe = escapeHtml(text);
  const linkColor = ownTheme ? 'text-white underline underline-offset-2' : 'text-crimson-700 underline underline-offset-2';
  const linked = safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    `<a href="$1" target="_blank" rel="noopener noreferrer" class="${linkColor} break-all">$1</a>`
  );
  const mentionColor = ownTheme ? 'bg-white/25 text-white' : 'bg-crimson-100 text-crimson-900';
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

/** Standard rich-row used inside the action sheet. Icon chip in a
 *  tone color, bold label, single-line description. ~64px tall so it
 *  hits the "easy to tap on mobile" bar comfortably. */
const ActionRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  description: string;
  tone?: 'cyan' | 'amber' | 'rose' | 'slate';
  onClick: () => void;
}> = ({ icon, label, description, tone = 'slate', onClick }) => {
  const chipClass = {
    cyan: 'bg-crimson-50 text-crimson-700 ring-1 ring-crimson-200',
    amber: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    rose: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
    slate: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
  }[tone];
  const labelColor = tone === 'rose' ? 'text-rose-700' : 'text-slate-900';
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-start gap-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors"
    >
      <span className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${chipClass}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 pt-0.5">
        <span className={`block text-[15px] font-bold ${labelColor}`}>{label}</span>
        <span className="block text-[12px] text-slate-500 leading-snug mt-0.5">{description}</span>
      </span>
    </button>
  );
};

// "2m ago" / "1h ago" / "3d ago" — short relative time used on the
// edited-receipt under each bubble. Falls back to absolute for >7d.
const relativeShort = (d: any): string => {
  const date = d instanceof Date ? d : (d?.toDate?.() || new Date(d));
  const ms = Date.now() - date.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  if (ms < 7 * 86400_000) return `${Math.floor(ms / 86400_000)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

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
    'bg-gradient-to-br from-crimson-400 to-crimson-600',
    'bg-gradient-to-br from-violet-400 to-violet-600',
    'bg-gradient-to-br from-fuchsia-400 to-pink-600',
    'bg-gradient-to-br from-crimson-400 to-charcoal-600',
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
  onImageLoaded,
  onPollVote,
  onAcknowledge,
  threadParticipantCount,
  formatTime,
  isFirstInGroup = true,
  isLastInGroup = true,
  getSenderPhotoUrl,
  getUserName,
  resolveUnknownUids,
  canSeeVoters = false,
  onMarkRead,
  onStartDm,
  onToggleMute,
  isMuted = false,
  onEdit,
  threadIsDm,
}) => {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [readByOpen, setReadByOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  // Long-press on the bubble opens this lightweight react-only sheet
  // (iMessage / WhatsApp pattern). The full action menu lives on the ⋯
  // button — one gesture per surface so they don't fight each other.
  // (quickReactOpen removed — long-press now opens the full EmojiPicker)
  // Track whether long-press fired, so the touch-end click doesn't
  // also open the full menu or swallow the gesture.
  const longPressFiredRef = useRef<boolean>(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const reactionPressTimer = useRef<number | null>(null);
  const reactionPressFiredRef = useRef<boolean>(false);

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

  // When the Seen-by sheet opens, ask the parent to look up any UIDs
  // we don't already have a name for. The parent caches them, so the
  // next render of this sheet (or any other) sees the resolved names.
  React.useEffect(() => {
    if (!readByOpen || !resolveUnknownUids || !getUserName) return;
    const unknown = Object.keys(readBy).filter(uid => !getUserName(uid));
    if (unknown.length > 0) resolveUnknownUids(unknown);
  }, [readByOpen, resolveUnknownUids, getUserName, readBy]);

  const isOwn = message.senderId === currentUserId;
  // Prefer the photoURL frozen onto the message at send time, but fall
  // back to a live lookup so older messages still get a real avatar.
  const resolvedPhotoUrl =
    (message as any).senderPhotoUrl ||
    (getSenderPhotoUrl ? getSenderPhotoUrl(message.senderId) : undefined);

  // Group reactions by emoji. We track `mineFirstName` so "You" shows
  // first in the chip's name list (matches iMessage / Slack convention).
  const grouped: Record<string, { count: number; mine: boolean; names: string[] }> = {};
  for (const r of message.reactions || []) {
    if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false, names: [] };
    grouped[r.emoji].count += 1;
    if (r.userId === currentUserId) {
      grouped[r.emoji].mine = true;
      grouped[r.emoji].names.unshift('You');
    } else {
      grouped[r.emoji].names.push(r.userName || 'Member');
    }
  }

  // Build the display label for a reaction chip: names inline when the
  // list is short (1–3), name + "+N" when it's longer. Replaces the
  // bare count — which left people guessing "who reacted?" on mobile
  // where the title tooltip doesn't show.
  const reactionLabel = (info: { count: number; names: string[] }): string => {
    const names = info.names.filter(Boolean);
    if (names.length === 0) return String(info.count);
    if (names.length <= 2) return names.join(', ');
    return `${names[0]}, ${names[1]} +${names.length - 2}`;
  };

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

  // iMessage-style fills: clean gradient on outgoing, soft white-ish
  // gray on incoming. No shadow ring — looks dated. The colors are
  // calibrated to look like Apple's Messages app on iOS 17+.
  const bubbleBg = isOwn
    ? 'bg-gradient-to-b from-crimson-500 to-crimson-600 text-white'
    : 'bg-[#E9E9EB] text-[#0B0B0F]';

  // Swipe-gesture state. We resolve each touch into ONE of three modes:
  //   null        — undetermined (the first few px of any drag)
  //   'horizontal'— committed to a swipe (move bubble, cancel long-press)
  //   'vertical'  — committed to a scroll (don't translate, don't fire)
  // Once committed we don't switch, so the bubble doesn't twitch sideways
  // when the user is mid-scroll.
  const swipeStateRef = React.useRef<{ startX: number; startY: number; mode: null | 'horizontal' | 'vertical' }>({ startX: 0, startY: 0, mode: null });
  const [swipeDx, setSwipeDx] = React.useState(0);
  const SWIPE_THRESHOLD = 60;
  const SWIPE_MAX = 100;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressFiredRef.current = false;
    swipeStateRef.current = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      mode: null,
    };
    // 1000ms keeps the long-press from firing on accidental brushes
    // (Patrick's feedback was that 600ms was too sensitive). Long-press
    // opens the quick-react sheet only — the full action menu is the
    // ⋯ button's job, so the two gestures don't overlap.
    longPressTimer.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      // Long-press opens the full reaction picker (same big sheet
      // as the ⋯ "More emoji" button). Previously this opened a
      // small quick-react row; Patrick wanted one consistent
      // surface for "add a reaction" — easier to reach with a
      // thumb, no two-step "tap + for more".
      setEmojiOpen(true);
    }, 1000);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const dx = t.clientX - swipeStateRef.current.startX;
    const dy = t.clientY - swipeStateRef.current.startY;
    if (swipeStateRef.current.mode === null) {
      // Still figuring out which gesture this is. Need 8px of motion
      // before we commit either way.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        swipeStateRef.current.mode = 'horizontal';
        // Movement = not a long-press. Cancel the timer before it fires.
        if (longPressTimer.current) {
          window.clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      } else {
        swipeStateRef.current.mode = 'vertical';
      }
    }
    if (swipeStateRef.current.mode !== 'horizontal') return;
    // Allow right (reply) for anyone; left (delete) only if this is
    // the user's own message and onDelete is wired.
    const allowLeft = isOwn && !!onDelete;
    let constrained = dx;
    if (constrained < 0 && !allowLeft) constrained = 0;
    // Resistance past SWIPE_MAX so the bubble doesn't fly off-screen
    // if the user keeps dragging. Matches iOS rubber-banding.
    if (Math.abs(constrained) > SWIPE_MAX) {
      const sign = constrained > 0 ? 1 : -1;
      constrained = sign * (SWIPE_MAX + (Math.abs(constrained) - SWIPE_MAX) * 0.3);
    }
    setSwipeDx(constrained);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    const mode = swipeStateRef.current.mode;
    const dx = swipeDx;
    // Spring back to neutral regardless of outcome.
    setSwipeDx(0);
    if (mode !== 'horizontal') return;
    if (dx > SWIPE_THRESHOLD) {
      onReply(message);
    } else if (dx < -SWIPE_THRESHOLD && isOwn && onDelete) {
      if (window.confirm('Delete this message?')) onDelete(message);
    }
  };

  // Visual feedback for the swipe: icons revealed as the bubble drags.
  // Reply icon appears on the swipe-source side (i.e. left margin when
  // dragging right). Trash appears on the right margin when dragging
  // left. Opacity scales linearly to threshold.
  const swipeProgress = Math.min(1, Math.abs(swipeDx) / SWIPE_THRESHOLD);
  const showReplyIcon = swipeDx > 8;
  const showDeleteIcon = swipeDx < -8 && isOwn && !!onDelete;

  return (
    <div
      className={`group relative flex ${isOwn ? 'justify-end' : 'justify-start'} ${
        isFirstInGroup ? 'mt-3' : 'mt-0.5'
      } px-1`}
    >
      {/* Swipe-reveal icons — sit behind the bubble at fixed positions.
          As the bubble translates, these become visible. */}
      {showReplyIcon && (
        <span
          aria-hidden
          className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-crimson-500 text-white flex items-center justify-center pointer-events-none"
          style={{ opacity: swipeProgress }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        </span>
      )}
      {showDeleteIcon && (
        <span
          aria-hidden
          className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-rose-500 text-white flex items-center justify-center pointer-events-none"
          style={{ opacity: swipeProgress }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
        </span>
      )}
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

      <div
        className={`flex flex-col max-w-[78%] ${isOwn ? 'items-end' : 'items-start'}`}
        style={{
          transform: `translateX(${swipeDx}px)`,
          // No transition while the finger is on the screen; spring
          // back smoothly when released. swipeDx === 0 means released
          // OR not yet touched, so the transition is safe either way.
          transition: swipeDx === 0 ? 'transform 0.18s ease-out' : 'none',
        }}
      >
        {/* Sender name + coach pill — only on first message in a run, for incoming */}
        {!isOwn && isFirstInGroup && (
          <div className="ml-1 mb-0.5 flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-700">{message.senderName}</span>
            {message.senderRole === 'coach' && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-crimson-700 bg-crimson-50 ring-1 ring-crimson-200 px-1.5 py-0.5 rounded">
                Coach
              </span>
            )}
          </div>
        )}

        {/* Reply quote — tappable. Scrolls to the original message and
            flashes a ring so the eye finds it. Falls back to a static
            "unavailable" chip when the original is gone (deleted). */}
        {message.replyTo && (
          <button
            type="button"
            onClick={() => {
              if (!replyTarget) return;
              const el = document.getElementById(`msg-${replyTarget.id}`);
              if (!el) return;
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Flash highlight via a temporary ring; clean up after
              // the animation so subsequent renders aren't sticky.
              el.classList.add('ring-2', 'ring-crimson-400', 'rounded-2xl');
              setTimeout(() => el.classList.remove('ring-2', 'ring-crimson-400', 'rounded-2xl'), 1400);
            }}
            disabled={!replyTarget}
            className={`text-xs mb-1 px-3 py-1.5 rounded-xl max-w-full text-left transition-opacity ${
              isOwn ? 'bg-crimson-100 text-crimson-900' : 'bg-gray-100 text-gray-700'
            } ${replyTarget ? 'hover:opacity-80 cursor-pointer' : 'cursor-default opacity-60'}`}
          >
            <div className="text-[10px] font-bold opacity-70">
              ↪ {replyTarget?.senderName || 'message'}
            </div>
            {replyTarget ? (
              <div className="truncate max-w-[260px]">
                {(replyTarget.content || '').slice(0, 140) || (replyTarget.attachments?.length ? 'Photo' : '')}
              </div>
            ) : (
              <span className="italic">unavailable</span>
            )}
          </button>
        )}

        {/* Inline edit mode — replaces the bubble with a textarea. Save
            writes the new content + sets `edited: true`. Cancel discards. */}
        {editing && message.content ? (
          <div
            className={`px-3.5 py-2 rounded-[20px] shadow-sm ${
              isOwn ? 'bg-crimson-50 ring-1 ring-crimson-300' : 'bg-slate-50 ring-1 ring-slate-300'
            }`}
          >
            <textarea
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              rows={Math.min(6, Math.max(2, editDraft.split('\n').length))}
              autoFocus
              className="w-full bg-transparent border-0 focus:outline-none text-[15px] text-slate-900 resize-none"
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { setEditing(false); setEditDraft(''); }}
                disabled={savingEdit}
                className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded text-slate-500 hover:text-slate-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const next = editDraft.trim();
                  if (!next || next === (message.content || '').trim()) { setEditing(false); return; }
                  if (!onEdit) { setEditing(false); return; }
                  setSavingEdit(true);
                  try {
                    await onEdit(message, next);
                    setEditing(false);
                  } catch (err) {
                    console.error('edit save failed', err);
                    alert('Failed to save edit.');
                  } finally {
                    setSavingEdit(false);
                  }
                }}
                disabled={savingEdit || !editDraft.trim()}
                className="text-[10px] font-extrabold tracking-widest uppercase px-3 py-1 rounded bg-crimson-600 text-white hover:bg-crimson-500 disabled:opacity-50"
              >
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (<>

        {/* The bubble itself. When the message ALSO has image
            attachments, we render the bubble as a wrapping shell with
            the text at top and image(s) at bottom — all inside one
            shared cyan/gray fill (iMessage pattern). When it's text
            only, just the text block. The image-only case is handled
            separately below and stays standalone (no bubble shell). */}
        {message.content && !isImportant && (
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setEmojiOpen(true); }}
            className={`overflow-hidden break-words select-none ${cornerClasses} ${bubbleBg} ${
              isMentioned && !isOwn ? 'ring-2 ring-amber-300' : ''
            }`}
            // -webkit-touch-callout: none kills iOS's "Copy / Look Up /
            // Share" callout that was racing our long-press timer.
            style={{ wordBreak: 'break-word', WebkitTouchCallout: 'none', WebkitUserSelect: 'none' } as React.CSSProperties}
          >
            <div
              className="px-3.5 py-[7px] leading-[1.35] text-[15.5px]"
              dangerouslySetInnerHTML={{ __html: renderRichContent(message.content, isOwn) }}
            />
            {/* Image attachments tucked at the BOTTOM of the same
                bubble (Patrick's request — iMessage pattern). Edge-
                to-edge inside the bubble shell, separated from the
                text by a thin same-color band. */}
            {images.length > 0 && (
              <div className={`mt-1 grid gap-0.5 ${images.length === 1 ? '' : 'grid-cols-2'}`}>
                {images.map((img, i) => (
                  <ChatAttachmentImage
                    key={i}
                    src={(img as any).thumbUrl || img.url}
                    alt={img.name || 'attachment'}
                    onLoad={() => onImageLoaded?.()}
                    onClick={() => {
                      if (longPressFiredRef.current) {
                        longPressFiredRef.current = false;
                        return;
                      }
                      // Lightbox opens the FULL-resolution url so
                      // tapping a thumbnail still shows the original.
                      onImageClick?.(img.url);
                    }}
                    solo={images.length === 1}
                    insideBubble
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </>)}

        {/* Important / acknowledgment-required message — rendered as a
            full-width announcement card (overrides the regular bubble).
            Visually distinct so it doesn't get lost in the thread. */}
        {message.content && isImportant && (
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setEmojiOpen(true); }}
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
            canSeeVoters={canSeeVoters}
            getUserName={getUserName}
            resolveUnknownUids={resolveUnknownUids}
          />
        )}

        {/* Image-only message — render the image standalone (no
            wrapping bubble shell). When the message ALSO has text,
            the images already render inside the text bubble above
            and we skip this block. */}
        {images.length > 0 && !message.content && (
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setEmojiOpen(true); }}
            className={`grid gap-1 ${images.length === 1 ? '' : 'grid-cols-2'} max-w-full`}
          >
            {images.map((img, i) => (
              <ChatAttachmentImage
                key={i}
                src={img.url}
                alt={img.name || 'attachment'}
                onLoad={() => onImageLoaded?.()}
                onClick={() => {
                  if (longPressFiredRef.current) {
                    longPressFiredRef.current = false;
                    return;
                  }
                  onImageClick?.(img.url);
                }}
                solo={images.length === 1}
              />
            ))}
          </div>
        )}

        {/* Reactions + actions row, UNDER the bubble (Ollie pattern).
            - For own messages, layout is reversed so the ⋯ kebab sits
              CLOSEST to the bubble (rightmost in reading order).
            - For incoming, ⋯ sits closest to the bubble on the left.
            We render this row whenever the bubble itself rendered —
            i.e. there's real content or images — so a deleted /
            ghost message that has neither doesn't produce a stray
            kebab + reaction chip floating in the thread. */}
        {(message.content || images.length > 0) && (
          <div className={`mt-1.5 flex items-center gap-1.5 flex-wrap ${isOwn ? 'flex-row-reverse justify-start' : 'justify-start'}`}>
            <button
              onClick={() => {
                void import('../../utils/nativeShell').then(m => m.tapHaptic('medium'));
                setActionsOpen(true);
              }}
              aria-label="Message actions"
              className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-crimson-700 active:scale-95 transition"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="1.9"/>
                <circle cx="12" cy="12" r="1.9"/>
                <circle cx="19" cy="12" r="1.9"/>
              </svg>
            </button>
            {Object.keys(grouped).length > 0 && (
              <div className={`flex flex-wrap gap-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
            {Object.entries(grouped).map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => {
                  // Suppress the toggle if a long-press just fired.
                  if (reactionPressFiredRef.current) {
                    reactionPressFiredRef.current = false;
                    return;
                  }
                  void import('../../utils/nativeShell').then(m => m.tapHaptic('light'));
                  onToggleReaction(message, emoji);
                }}
                onTouchStart={() => {
                  reactionPressFiredRef.current = false;
                  if (reactionPressTimer.current) window.clearTimeout(reactionPressTimer.current);
                  reactionPressTimer.current = window.setTimeout(() => {
                    reactionPressFiredRef.current = true;
                    setReactionsOpen(true);
                  }, 500);
                }}
                onTouchEnd={() => {
                  if (reactionPressTimer.current) {
                    window.clearTimeout(reactionPressTimer.current);
                    reactionPressTimer.current = null;
                  }
                }}
                onTouchCancel={() => {
                  if (reactionPressTimer.current) {
                    window.clearTimeout(reactionPressTimer.current);
                    reactionPressTimer.current = null;
                  }
                }}
                onContextMenu={(e) => { e.preventDefault(); setReactionsOpen(true); }}
                title={info.names.join(', ')}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors flex items-center gap-1 ${
                  info.mine
                    ? 'bg-crimson-100 ring-1 ring-crimson-300 text-crimson-900'
                    : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="text-sm leading-none">{emoji}</span>
                <span className="font-semibold tabular-nums">{info.count}</span>
              </button>
            ))}
              </div>
            )}
          </div>
        )}

        {/* Timestamp under the last message in a run. Adds "edited Xm
            ago" so receivers see when the content changed; surfaces
            the editedAt time the editMessage handler writes. */}
        {isLastInGroup && (
          <div className={`mt-0.5 text-[10px] text-gray-400 ${isOwn ? 'mr-1' : 'ml-1'}`}>
            {formatTime(message.timestamp)}
            {message.edited && (
              <span className="ml-1 italic" title={(message as any).editedAt instanceof Date ? (message as any).editedAt.toLocaleString() : ''}>
                · edited{(message as any).editedAt ? ` ${relativeShort((message as any).editedAt)}` : ''}
              </span>
            )}
            {/* Delivery state on the user's own sent bubbles. Single
                checkmark when the message is in Firestore but nobody
                else has opened it yet; double when anyone has. */}
            {isOwn && !(message as any).__pending && !(message as any).__failed && (() => {
              const seen = ((message as any).readBy && typeof (message as any).readBy === 'object')
                ? Object.keys((message as any).readBy).filter(uid => uid !== currentUserId).length
                : 0;
              // In group/team chats we suppress the double-check (seen)
              // state — with 10+ participants the "1 of 14 has seen"
              // signal becomes noise. DMs keep both states.
              const showSeen = !!threadIsDm && seen > 0;
              return (
                <span className={`ml-1.5 inline-flex items-center gap-0.5 ${showSeen ? 'text-crimson-500' : 'text-gray-400'}`} title={showSeen ? 'Seen' : 'Sent'}>
                  {showSeen ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="2 12 7 17 13 9" />
                      <polyline points="10 12 15 17 22 7" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="4 12 9 17 20 6" />
                    </svg>
                  )}
                </span>
              );
            })()}
            {(message as any).__pending && !(message as any).__failed && (
              <span className="ml-1.5 inline-flex items-center" title="Sending…">
                <svg className="w-3 h-3 text-gray-400 animate-spin" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              </span>
            )}
            {(message as any).__failed && (
              <span className="ml-1.5 inline-flex items-center text-rose-500" title="Failed to send">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </span>
            )}
          </div>
        )}
      </div>

      {/* (⋯ button moved inside the inner column, alongside reactions
          — see the row above. This used to live here outside the
          column, vertically centered next to the bubble, but Patrick
          wanted Ollie's pattern: kebab BELOW the bubble, on the same
          row as reactions. Cleaner and fewer competing focal points.) */}

      {/* Long-press / right-click quick-react sheet. Just the emoji row,
          no menu — that's what the ⋯ button is for. Tap an emoji to
          react and dismiss; tap + to open the full picker. */}
      {/* (Old quick-react row removed — long-press now opens the
          full EmojiPicker so there's a single consistent "add a
          reaction" surface. See setEmojiOpen call above.) */}

      {actionsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setActionsOpen(false)}
        >
          <div
            className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[84vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Branded header — same chrome as UserProfileModal so the
                two surfaces feel like one design system. */}
            <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 py-3 flex items-center justify-between flex-shrink-0">
              <button
                onClick={() => setActionsOpen(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white px-1"
              >
                Cancel
              </button>
              <div className="text-xs font-extrabold tracking-widest uppercase text-crimson-300">Actions</div>
              <span className="w-12" aria-hidden />
            </div>

            <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {/* Quick-reaction row — kept at the top because reactions are
                  the most-used action by far. Tap "+" for the full picker. */}
              <div className="px-3 py-3 border-b border-slate-100 grid grid-cols-9 gap-0.5">
                {['👍','❤️','🔥','⚽','🏆','😂','🙌','👏'].map((e) => (
                  <button
                    key={e}
                    onClick={() => { onToggleReaction(message, e); setActionsOpen(false); }}
                    className="text-2xl py-1.5 rounded-lg hover:bg-slate-100 active:scale-95"
                  >{e}</button>
                ))}
                <button
                  onClick={() => { setActionsOpen(false); setEmojiOpen(true); }}
                  className="text-lg py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold"
                  aria-label="More emoji"
                >+</button>
              </div>

              {/* Rich rows — icon (in a colored chip), bold label, helpful
                  one-line description. Tap-target is the full row height
                  (≥56px). Same pattern across every action. */}
              <ActionRow
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>}
                tone="cyan"
                label="Reply"
                description={`Quote ${isOwn ? 'this message' : message.senderName} in your next message.`}
                onClick={() => { onReply(message); setActionsOpen(false); }}
              />

              {message.content && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                  tone="slate"
                  label="Copy"
                  description="Copy the message text to your clipboard."
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(message.content || ''); } catch { /* ignore */ }
                    setActionsOpen(false);
                  }}
                />
              )}

              <ActionRow
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                tone="slate"
                label="Seen by"
                description="See who's already seen this message."
                onClick={() => { setActionsOpen(false); setReadByOpen(true); }}
              />

              {canPin && onTogglePin && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5L17 5H7l-.5 8.5L5 17z"/></svg>}
                  tone="amber"
                  label={isPinned ? 'Unpin from thread' : 'Pin to thread'}
                  description={isPinned ? 'Remove from the pinned messages bar.' : 'Show at the top of this thread for everyone.'}
                  onClick={() => { onTogglePin(message); setActionsOpen(false); }}
                />
              )}

              {!isOwn && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                  tone="cyan"
                  label="View profile"
                  description={`See ${message.senderName}'s teams, players, and contact info.`}
                  onClick={() => { setActionsOpen(false); setProfileOpen(true); }}
                />
              )}

              {!isOwn && onStartDm && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>}
                  tone="cyan"
                  label={`Message ${message.senderName.split(' ')[0]}`}
                  description="Open a direct conversation with this person."
                  onClick={() => { onStartDm(message.senderId, message.senderName); setActionsOpen(false); }}
                />
              )}

              {!isOwn && onToggleMute && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><line x1="2" y1="2" x2="22" y2="22"/></svg>}
                  tone="slate"
                  label={isMuted ? `Unmute ${message.senderName.split(' ')[0]}` : `Mute ${message.senderName.split(' ')[0]}`}
                  description={isMuted ? 'Get notifications from this person again.' : "Don't get pushed when this person posts in any thread."}
                  onClick={() => { onToggleMute(message.senderId, message.senderName); setActionsOpen(false); }}
                />
              )}

              {isOwn && onEdit && message.content && !message.poll && (
                <ActionRow
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
                  tone="cyan"
                  label="Edit message"
                  description="Fix a typo or change wording. Shows as (edited)."
                  onClick={() => {
                    setEditDraft(message.content || '');
                    setEditing(true);
                    setActionsOpen(false);
                  }}
                />
              )}

              {isOwn && onDelete && (() => {
                // Recall window — within 60s of sending, show "Unsend"
                // (no warning, no confirm, treat as a fat-finger fix).
                // After that, fall back to "Delete" with the existing
                // confirm dialog the parent handler enforces.
                const ageMs = Date.now() - new Date(message.timestamp).getTime();
                const isRecall = ageMs < 60_000;
                return (
                  <ActionRow
                    icon={isRecall
                      ? <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                      : <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>}
                    tone="rose"
                    label={isRecall ? 'Unsend message' : 'Delete message'}
                    description={isRecall
                      ? 'Just sent it? Pull it back before anyone notices.'
                      : 'Removes this message for everyone in the thread.'}
                    onClick={() => { onDelete(message); setActionsOpen(false); }}
                  />
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Full emoji picker — opened from the affordance chip OR
          from the "+" button in the action sheet. */}
      {emojiOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setEmojiOpen(false)}
        >
          {/* Edge-to-edge on mobile (Patrick: "can emoji picker come
              up edge to edge?"). Bounded on tablet+ so it doesn't
              stretch into a 1200px-wide grid. */}
          <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md animate-sheet-up sm:animate-pop-in">
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
          className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center p-4 animate-fade-in"
          onClick={() => setReadByOpen(false)}
        >
          <div className="animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <ReadBySheet
              readers={Object.entries(((message as any).readBy || {}) as Record<string, number>)
                .map(([uid, readAt]) => ({
                  uid,
                  readAt,
                  // Always show every reader, even if we can't resolve
                  // the name from the active team roster — Patrick: "if
                  // you have access to that chat, it should always show
                  // who read it." Unknown UIDs trigger a cross-team
                  // lookup via the useEffect above; once it resolves,
                  // this re-renders with the real name in place of the
                  // placeholder.
                  name: getUserName ? (getUserName(uid) || 'Member') : 'Member',
                  photoURL: getSenderPhotoUrl ? getSenderPhotoUrl(uid) : undefined,
                }))}
              threadParticipantCount={threadParticipantCount}
              onClose={() => setReadByOpen(false)}
            />
          </div>
        </div>
      )}

      {profileOpen && message.senderId && (
        <UserProfileModal
          uid={message.senderId}
          onClose={() => setProfileOpen(false)}
          onStartDm={onStartDm ? (uid, name) => { setProfileOpen(false); onStartDm(uid, name); } : undefined}
        />
      )}

      {reactionsOpen && (
        <ReactionDetailsSheet
          message={message}
          currentUserId={currentUserId}
          onToggleReaction={(m, e) => {
            onToggleReaction(m, e);
            // Close if that was the user's last reaction across all
            // emojis (otherwise they expect the sheet to stay open so
            // they can keep adjusting).
            const remaining = (m.reactions || []).filter(r => !(r.userId === currentUserId && r.emoji === e));
            if (!remaining.some(r => r.userId === currentUserId)) setReactionsOpen(false);
          }}
          onClose={() => setReactionsOpen(false)}
          getUserPhotoUrl={getSenderPhotoUrl}
        />
      )}
    </div>
  );
};

export default MessageBubble;
