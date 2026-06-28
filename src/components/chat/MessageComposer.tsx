import React, { useEffect, useRef, useState } from 'react';
import { useStorage } from '../../hooks/useStorage';
import GifPicker from './GifPicker';
import CreatePollModal from './CreatePollModal';
import { tenorEnabled, TenorGif } from '../../utils/tenor';

export interface ComposerAttachment {
  type: 'image';
  /** Full-resolution image URL — what the lightbox shows. */
  url: string;
  /** Optional thumbnail URL (~800px longer-edge JPEG). When present,
   *  this is what renders in the chat list — keeps scroll fast even
   *  when a thread has dozens of full-resolution photos. Older
   *  messages predate this field and fall back to `url`. */
  thumbUrl?: string;
  /** Intrinsic width/height of the THUMBNAIL — used to reserve
   *  layout so images don't shift as they decode. */
  thumbWidth?: number;
  thumbHeight?: number;
  name: string;
  size: number;
}

interface Member {
  uid: string;
  name: string;
  role?: string;
}

interface MessageComposerProps {
  threadId: string;
  teamId: string;
  members: Member[];
  replyingTo?: { senderName: string } | null;
  onCancelReply: () => void;
  onSend: (content: string, attachments: ComposerAttachment[], opts?: { requireAck?: boolean; pinOnSend?: boolean }) => Promise<void> | void;
  /** Optional poll send handler. When set, the composer shows a poll
   *  button that opens the create-poll modal. The handler is expected
   *  to add a chat_messages doc with the poll field populated. */
  onSendPoll?: (poll: { question: string; options: string[]; multi: boolean }) => Promise<void> | void;
  /** When true, the composer shows a "📢 Important" toggle that marks
   *  the outgoing message as requiring acknowledgment. Pass `true` for
   *  coaches/admins; parents shouldn't be marking messages important. */
  canMarkImportant?: boolean;
  rows?: number;
  /** When true, pad the bottom with env(safe-area-inset-bottom) so the input
   *  clears the iPhone home indicator. Pass false when the keyboard is open
   *  (the keyboard already sits above the home indicator). */
  safeAreaInsetBottom?: boolean;
  /** Fired on every keystroke with non-empty text. Parent throttles the
   *  Firestore presence write — typing indicators are real-time but
   *  hammering writes on every key would burn quota. */
  onTyping?: () => void;
}

const MessageComposer: React.FC<MessageComposerProps> = ({
  threadId,
  teamId,
  members,
  replyingTo,
  onCancelReply,
  onSend,
  onSendPoll,
  canMarkImportant = false,
  rows = 2,
  safeAreaInsetBottom = false,
  onTyping,
}) => {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false);
  const [isPollOpen, setIsPollOpen] = useState(false);
  const [markImportant, setMarkImportant] = useState(false);
  // "Post to wall" — when on, the message gets auto-pinned after send,
  // which surfaces it both in the chat's pinned bar and (separately) on
  // the team dashboard's announcements widget. Coach-only, same gate
  // as Mark-important since the audience is identical.
  const [postToWall, setPostToWall] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploadFile } = useStorage();

  // Reset on thread change
  useEffect(() => {
    setText('');
    setPending([]);
    setMentionQuery(null);
  }, [threadId]);

  const updateMentionState = (val: string, caret: number) => {
    // find @ before caret with no whitespace between
    const before = val.slice(0, caret);
    const match = before.match(/(^|\s)@([A-Za-z][A-Za-z0-9 _'-]{0,28})$/);
    if (match) {
      const start = caret - match[2].length - 1; // include @
      setMentionQuery(match[2].toLowerCase());
      setMentionRange({ start, end: caret });
      setHighlight(0);
    } else {
      setMentionQuery(null);
      setMentionRange(null);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    updateMentionState(v, e.target.selectionStart || v.length);
    if (v.trim().length > 0 && onTyping) onTyping();
  };

  // The mention picker always includes a synthetic "team" entry at the
  // top — selecting it inserts `@team` which is recognized server-side
  // (and in onSend below) as a ping-everyone trigger. Filtered by the
  // typed query so "te…" still surfaces it.
  const filteredMembers: Member[] = mentionQuery !== null
    ? (() => {
        const teamEntry: Member = { uid: '__team__', name: 'team', role: 'Everyone on this team' };
        const teamMatches = !mentionQuery || 'team'.startsWith(mentionQuery) || 'everyone'.startsWith(mentionQuery);
        const peopleMatches = members
          .filter((m) => m.name && m.name.toLowerCase().includes(mentionQuery))
          .slice(0, 6);
        return teamMatches ? [teamEntry, ...peopleMatches].slice(0, 6) : peopleMatches;
      })()
    : [];

  const insertMention = (m: Member) => {
    if (!mentionRange) return;
    const before = text.slice(0, mentionRange.start);
    const after = text.slice(mentionRange.end);
    const insert = `@${m.name} `;
    const next = before + insert + after;
    setText(next);
    setMentionQuery(null);
    setMentionRange(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) {
        const caret = before.length + insert.length;
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && filteredMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, filteredMembers.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredMembers[highlight]);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    // Enter always inserts a newline so people can break their
    // messages into paragraphs without it accidentally sending. Power
    // users on a hardware keyboard can still Cmd/Ctrl+Enter to send.
    // The send button is the only "one tap = send" affordance on
    // touch.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSend();
    }
  };

  // Common upload path used by file-picker AND paste (iOS GIF keyboard).
  // For each picked image, we upload TWO assets: the original (lightbox
  // opens this) and a ~800px JPEG thumbnail (chat list renders this).
  // GIFs skip the thumbnail step — animation would be lost in a JPEG.
  const uploadImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const { resizeImage } = await import('../../utils/imageResize');
      const uploaded: ComposerAttachment[] = [];
      let i = 0;
      for (const f of files) {
        // Full-resolution upload (lightbox quality).
        const url = await uploadFile(f, `chat/${teamId}/${threadId}`, (p) => {
          // Reserve ~70% of the progress bar for the full upload,
          // the remaining 30% for the thumbnail. Reflects rough
          // byte-count ratio (thumb is ~5% the size but the resize
          // itself takes a moment on big iPhone photos).
          setUploadPct(Math.round(((i + (p.progress / 100) * 0.7) / files.length) * 100));
        });

        // Thumbnail upload — skipped for GIFs (would lose animation)
        // and for files that already came in tiny.
        let thumbUrl: string | undefined;
        let thumbWidth: number | undefined;
        let thumbHeight: number | undefined;
        if (!f.type.includes('gif')) {
          try {
            const thumb = await resizeImage(f, 800, 0.82);
            const thumbFile = new File([thumb.blob], `thumb-${f.name.replace(/\.[a-z0-9]+$/i, '')}.jpg`, { type: 'image/jpeg' });
            thumbUrl = await uploadFile(thumbFile, `chat/${teamId}/${threadId}/thumbs`, (p) => {
              setUploadPct(Math.round(((i + 0.7 + (p.progress / 100) * 0.3) / files.length) * 100));
            });
            thumbWidth = thumb.width;
            thumbHeight = thumb.height;
          } catch (err) {
            // Resize / thumb upload failures shouldn't block the message.
            // We just fall back to using the full URL in the list.
            console.warn('[chat] thumbnail generation skipped', err);
          }
        }

        uploaded.push({ type: 'image', url, thumbUrl, thumbWidth, thumbHeight, name: f.name, size: f.size });
        i += 1;
      }
      setPending((prev) => [...prev, ...uploaded]);
    } catch (err) {
      console.error('[chat] image upload failed', err);
      alert('Image upload failed.');
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    await uploadImageFiles(files);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Paste from clipboard — this is how the iOS GIF keyboard delivers a GIF
  // into the input. Also handles screenshot paste from the OS clipboard.
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return; // fall through to default text paste
    e.preventDefault(); // suppress the URL-like blob that some keyboards also paste
    await uploadImageFiles(imageFiles);
  };

  const removePending = (idx: number) => {
    setPending((prev) => prev.filter((_, i) => i !== idx));
  };

  // GIF picker → send the GIF straight as a chat attachment (no upload —
  // we reuse Tenor's CDN URL, which is built for this).
  const pickGif = async (gif: TenorGif) => {
    const attachment: ComposerAttachment = {
      type: 'image',
      url: gif.url,
      name: gif.description ? `${gif.description}.gif` : 'tenor.gif',
      size: 0,
    };
    try {
      await onSend('', [attachment]);
    } catch (err) {
      console.error('[chat] gif send failed', err);
      alert('Could not send GIF.');
    }
  };

  const doSend = async () => {
    if (uploading) return;
    const content = text.trim();
    if (!content && pending.length === 0) return;
    // Fire haptic the instant the user taps Send — before any awaits
    // so it lands during the press, not after the network round-trip.
    void import('../../utils/nativeShell').then(m => m.tapHaptic('medium'));

    // Snapshot what we're sending, then clear the composer IMMEDIATELY
    // — same frame as the tap. Two bugs were caused by clearing AFTER
    // awaiting onSend:
    //   1) The typed text lingered in the textarea for the duration
    //      of the Firestore write (visible as "the words stay in the
    //      box for a brief second").
    //   2) The textarea-height reset happened AFTER the optimistic
    //      message landed in the list, so the layout shift arrived
    //      late — the auto-scroll-to-bottom ran on the wrong
    //      scrollHeight and the thread settled mid-screen instead of
    //      pinned to the latest message.
    // Clearing first means the composer collapses first, THEN the
    // optimistic message lands on a stable layout, and the parent's
    // scrollIntoView lands cleanly at the bottom.
    const snapshotText = content;
    const snapshotPending = pending;
    const snapshotImportant = markImportant;
    const snapshotPostToWall = postToWall;
    setText('');
    setPending([]);
    setMentionQuery(null);
    setMarkImportant(false);
    setPostToWall(false);
    // Snap the textarea back to single-row height. Without this, the
    // inline style.height left over from auto-grow keeps the box tall
    // until the user re-types and onChange recalculates.
    if (taRef.current) taRef.current.style.height = '';
    taRef.current?.focus();

    // Fire-and-forget the actual send. The parent's optimistic-update
    // path (TeamChat's __pending flag on the message) gives the
    // sender immediate visual confirmation; a network failure flips
    // it to __failed, which renders an error chip. So we don't need
    // to await here.
    try {
      await onSend(snapshotText, snapshotPending, { requireAck: snapshotImportant, pinOnSend: snapshotPostToWall });
    } catch (err) {
      console.error('[chat] send failed', err);
    }
  };

  return (
    <div
      data-chat-composer
      className="bg-surface-elevated border-t border-line-default/10 px-3 pt-1.5 pb-1.5"
      style={
        safeAreaInsetBottom
          ? { paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }
          : undefined
      }
    >
      {replyingTo && (
        <div className="mb-2 px-3 py-1.5 bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 rounded-xl flex items-center justify-between">
          <span className="text-xs text-brand-primary-soft truncate">
            <span className="font-semibold">↪ Replying to {replyingTo.senderName}</span>
          </span>
          <button
            onClick={onCancelReply}
            className="text-brand-primary-soft hover:text-ink-primary ml-2 flex-shrink-0"
            aria-label="Cancel reply"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Important — when armed, show a small dismissable chip above
          the input so the coach can see the next message will go out
          as an announcement. Toggle lives inside the + menu now. */}
      {markImportant && (
        <div className="mb-1.5 inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-extrabold tracking-widest uppercase bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30">
          <span>Marked important</span>
          <button
            type="button"
            onClick={() => setMarkImportant(false)}
            aria-label="Clear important"
            className="text-amber-300 hover:text-ink-primary"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

      {postToWall && (
        <div className="mb-1.5 inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-extrabold tracking-widest uppercase bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30">
          <span>Posting to wall</span>
          <button
            type="button"
            onClick={() => setPostToWall(false)}
            aria-label="Clear wall post"
            className="text-brand-primary-soft hover:text-ink-primary"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((a, i) => (
            <div key={i} className="relative">
              <img
                src={a.url}
                alt={a.name}
                className="w-16 h-16 object-cover rounded-xl ring-1 ring-line-default/10"
              />
              <button
                onClick={() => removePending(i)}
                className="absolute -top-1.5 -right-1.5 bg-black hover:bg-surface-base text-white rounded-full w-5 h-5 flex items-center justify-center text-xs shadow ring-1 ring-line-default/20"
                aria-label="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="mb-1.5 text-[11px] text-ink-primary/55">Uploading {uploadPct}%…</div>
      )}

      {/* Single row, baseline-aligned. All controls share a 40px height
          + pill rounding so the composer reads as one continuous control
          strip. items-end keeps the buttons pinned to the bottom edge
          when the textarea auto-grows on multi-line messages. */}
      <div className="relative flex gap-1.5 items-end">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPickFiles}
          className="hidden"
        />
        {/* Consolidated "+" button — iMessage-style. Photo, GIF, poll,
            and Mark-important all live in a small sheet so the bar
            gives the textarea its full horizontal width. */}
        <button
          type="button"
          onClick={() => setPlusOpen(true)}
          className="flex-shrink-0 w-10 h-10 rounded-full bg-line-default/5 hover:bg-line-default/10 active:scale-95 text-ink-primary/80 flex items-center justify-center transition"
          title="More"
          aria-label="More"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>

        <div className="flex-1 relative">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              onChange(e);
              // Auto-grow the textarea to fit the typed content so the user
              // can always see what they're writing. Capped at maxHeight so a
              // long message scrolls inside the box instead of pushing
              // everything up.
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 140) + 'px';
            }}
            onKeyDown={handleKey}
            onPaste={onPaste}
            placeholder="Message"
            rows={1}
            className="block w-full resize-none bg-surface-base rounded-[20px] px-4 py-2 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/50 text-[15px] text-ink-primary placeholder-bone/40 leading-tight transition-colors ring-1 ring-line-default/10"
            style={{ fontSize: '16px', maxHeight: '140px', minHeight: '40px', lineHeight: '24px' }}
          />
          {mentionQuery !== null && filteredMembers.length > 0 && (
            <div className="absolute z-30 bottom-full mb-1 left-0 right-0 max-h-48 overflow-y-auto bg-surface-elevated ring-1 ring-line-default/10 rounded-lg shadow-2xl">
              {filteredMembers.map((m, i) => {
                const isTeam = m.uid === '__team__';
                return (
                  <button
                    key={m.uid}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(m);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-line-default/5 flex items-center gap-2 ${
                      i === highlight ? 'bg-line-default/5' : ''
                    }`}
                  >
                    {isTeam && (
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint text-white text-[10px] font-bold flex-shrink-0">
                        @
                      </span>
                    )}
                    <span className={`font-medium ${isTeam ? 'text-brand-primary-soft' : 'text-ink-primary'}`}>
                      @{m.name}
                    </span>
                    {m.role && (
                      <span className="ml-auto text-xs text-ink-primary/50">{m.role}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={doSend}
          disabled={uploading || (!text.trim() && pending.length === 0)}
          className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary hover:from-brand-primary hover:to-brand-primary active:scale-95 disabled:from-white/10 disabled:to-white/10 disabled:text-ink-primary/30 text-white flex items-center justify-center shadow-sm disabled:shadow-none disabled:cursor-not-allowed transition"
          aria-label="Send"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>

      {/* + menu sheet — bottom-sheet with the four attachment actions.
          Each row tap closes the sheet and triggers its handler. */}
      {plusOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
          onClick={() => setPlusOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface-elevated ring-1 ring-line-default/10 w-full sm:max-w-xs rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between border-b border-line-default/5">
              <button
                onClick={() => setPlusOpen(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/50 hover:text-ink-primary px-1"
              >
                Cancel
              </button>
              <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Add</div>
              <span className="w-12" aria-hidden />
            </div>
            <div className="divide-y divide-line-default/5">
              <button
                type="button"
                onClick={() => { setPlusOpen(false); fileRef.current?.click(); }}
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-line-default/[0.04]"
              >
                <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-rose-600 text-white flex items-center justify-center">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="9" cy="9" r="2"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-ink-primary">Photo</span>
                  <span className="block text-[11px] text-ink-primary/55">Send images from your library.</span>
                </span>
              </button>
              {tenorEnabled() && (
                <button
                  type="button"
                  onClick={() => { setPlusOpen(false); setIsGifPickerOpen(true); }}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-line-default/[0.04]"
                >
                  <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-violet-600 text-white flex items-center justify-center text-[10px] font-extrabold tracking-wider">
                    GIF
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink-primary">GIF</span>
                    <span className="block text-[11px] text-ink-primary/55">Search Tenor and send.</span>
                  </span>
                </button>
              )}
              {onSendPoll && (
                <button
                  type="button"
                  onClick={() => { setPlusOpen(false); setIsPollOpen(true); }}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-line-default/[0.04]"
                >
                  <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-emerald-600 text-white flex items-center justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <rect x="3" y="12" width="4" height="9" rx="1"/>
                      <rect x="10" y="7" width="4" height="14" rx="1"/>
                      <rect x="17" y="3" width="4" height="18" rx="1"/>
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink-primary">Poll</span>
                    <span className="block text-[11px] text-ink-primary/55">Quick yes/no or pick-an-option.</span>
                  </span>
                </button>
              )}
              {canMarkImportant && (
                <button
                  type="button"
                  onClick={() => { setMarkImportant(v => !v); setPlusOpen(false); }}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-line-default/[0.04]"
                >
                  <span className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                    markImportant ? 'bg-amber-400 text-charcoal-950 ring-2 ring-amber-300' : 'bg-amber-500 text-charcoal-950'
                  }`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink-primary">
                      {markImportant ? 'Important (on)' : 'Mark as important'}
                    </span>
                    <span className="block text-[11px] text-ink-primary/55">
                      Requires every recipient to tap "I see this."
                    </span>
                  </span>
                </button>
              )}
              {canMarkImportant && (
                <button
                  type="button"
                  onClick={() => { setPostToWall(v => !v); setPlusOpen(false); }}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-line-default/[0.04]"
                >
                  <span className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                    postToWall ? 'bg-brand-primary text-white ring-2 ring-brand-primary-soft' : 'bg-brand-primary text-white'
                  }`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <path d="M12 2v6"/>
                      <path d="M12 8l-3 3h6z"/>
                      <rect x="3" y="11" width="18" height="11" rx="2"/>
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink-primary">
                      {postToWall ? 'Posting to wall (on)' : 'Post to wall'}
                    </span>
                    <span className="block text-[11px] text-ink-primary/55">
                      Pins in chat + shows on the team dashboard.
                    </span>
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <GifPicker
        isOpen={isGifPickerOpen}
        onClose={() => setIsGifPickerOpen(false)}
        onPick={pickGif}
      />
      {onSendPoll && (
        <CreatePollModal
          isOpen={isPollOpen}
          onClose={() => setIsPollOpen(false)}
          onSubmit={(p) => { onSendPoll(p); }}
        />
      )}
    </div>
  );
};

export default MessageComposer;
