import React, { useEffect, useRef, useState } from 'react';
import { useStorage } from '../../hooks/useStorage';
import GifPicker from './GifPicker';
import { tenorEnabled, TenorGif } from '../../utils/tenor';

export interface ComposerAttachment {
  type: 'image';
  url: string;
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
  onSend: (content: string, attachments: ComposerAttachment[]) => Promise<void> | void;
  rows?: number;
  /** When true, pad the bottom with env(safe-area-inset-bottom) so the input
   *  clears the iPhone home indicator. Pass false when the keyboard is open
   *  (the keyboard already sits above the home indicator). */
  safeAreaInsetBottom?: boolean;
}

const MessageComposer: React.FC<MessageComposerProps> = ({
  threadId,
  teamId,
  members,
  replyingTo,
  onCancelReply,
  onSend,
  rows = 2,
  safeAreaInsetBottom = false,
}) => {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false);

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
  };

  const filteredMembers = mentionQuery !== null
    ? members
        .filter((m) => m.name && m.name.toLowerCase().includes(mentionQuery))
        .slice(0, 6)
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  // Common upload path used by file-picker AND paste (iOS GIF keyboard).
  const uploadImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const uploaded: ComposerAttachment[] = [];
      let i = 0;
      for (const f of files) {
        const url = await uploadFile(f, `chat/${teamId}/${threadId}`, (p) => {
          setUploadPct(Math.round(((i + p.progress / 100) / files.length) * 100));
        });
        uploaded.push({ type: 'image', url, name: f.name, size: f.size });
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
    await onSend(content, pending);
    setText('');
    setPending([]);
    setMentionQuery(null);
    taRef.current?.focus();
  };

  return (
    <div
      data-chat-composer
      className="bg-white border-t border-gray-200 px-3 pt-1.5 pb-1.5"
      style={
        safeAreaInsetBottom
          ? { paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }
          : undefined
      }
    >
      {replyingTo && (
        <div className="mb-2 px-3 py-1.5 bg-cyan-50 ring-1 ring-cyan-200 rounded-xl flex items-center justify-between">
          <span className="text-xs text-cyan-900 truncate">
            <span className="font-semibold">↪ Replying to {replyingTo.senderName}</span>
          </span>
          <button
            onClick={onCancelReply}
            className="text-cyan-600 hover:text-cyan-900 ml-2 flex-shrink-0"
            aria-label="Cancel reply"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
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
                className="w-16 h-16 object-cover rounded-xl ring-1 ring-gray-200"
              />
              <button
                onClick={() => removePending(i)}
                className="absolute -top-1.5 -right-1.5 bg-gray-900 hover:bg-black text-white rounded-full w-5 h-5 flex items-center justify-center text-xs shadow"
                aria-label="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="mb-1.5 text-[11px] text-gray-500">Uploading {uploadPct}%…</div>
      )}

      <div className="relative flex gap-2 items-end">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPickFiles}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 flex items-center justify-center transition-colors"
          title="Attach photo"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
        {tenorEnabled() && (
          <button
            type="button"
            onClick={() => setIsGifPickerOpen(true)}
            className="flex-shrink-0 h-10 px-3 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700 flex items-center justify-center font-bold text-xs transition-colors"
            title="Send a GIF"
          >
            GIF
          </button>
        )}

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
            className="w-full resize-none bg-gray-100 rounded-3xl px-4 py-2.5 focus:outline-none focus:bg-white focus:ring-2 focus:ring-cyan-300 text-[15px] text-gray-900 placeholder-gray-400 leading-snug transition-colors"
            style={{ fontSize: '16px', maxHeight: '140px' }}
          />
          {mentionQuery !== null && filteredMembers.length > 0 && (
            <div className="absolute z-30 bottom-full mb-1 left-0 right-0 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
              {filteredMembers.map((m, i) => (
                <button
                  key={m.uid}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(m);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${
                    i === highlight ? 'bg-gray-100' : ''
                  }`}
                >
                  <span className="font-medium text-gray-900">{m.name}</span>
                  {m.role && (
                    <span className="ml-2 text-xs text-gray-500">{m.role}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={doSend}
          disabled={uploading || (!text.trim() && pending.length === 0)}
          className="bg-cyan-600 hover:bg-cyan-700 active:bg-cyan-800 disabled:bg-gray-300 text-white w-10 h-10 rounded-full transition-all flex-shrink-0 flex items-center justify-center shadow disabled:shadow-none disabled:cursor-not-allowed"
          aria-label="Send"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>

      <GifPicker
        isOpen={isGifPickerOpen}
        onClose={() => setIsGifPickerOpen(false)}
        onPick={pickGif}
      />
    </div>
  );
};

export default MessageComposer;
