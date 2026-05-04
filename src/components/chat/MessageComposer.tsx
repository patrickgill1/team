import React, { useEffect, useRef, useState } from 'react';
import { useStorage } from '../../hooks/useStorage';

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
}

const MessageComposer: React.FC<MessageComposerProps> = ({
  threadId,
  teamId,
  members,
  replyingTo,
  onCancelReply,
  onSend,
  rows = 2,
}) => {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [highlight, setHighlight] = useState(0);

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

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
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
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePending = (idx: number) => {
    setPending((prev) => prev.filter((_, i) => i !== idx));
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
    <div className="bg-gray-900/60 backdrop-blur border-t border-white/10 p-4">
      {replyingTo && (
        <div className="mb-3 p-2 bg-gray-100 rounded flex items-center justify-between">
          <span className="text-sm text-gray-300 truncate">
            Replying to {replyingTo.senderName}
          </span>
          <button
            onClick={onCancelReply}
            className="text-gray-400 hover:text-gray-300 ml-2 flex-shrink-0"
            aria-label="Cancel reply"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {pending.map((a, i) => (
            <div key={i} className="relative">
              <img
                src={a.url}
                alt={a.name}
                className="w-16 h-16 object-cover rounded-lg border border-white/15"
              />
              <button
                onClick={() => removePending(i)}
                className="absolute -top-2 -right-2 bg-gray-700 hover:bg-gray-900 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs"
                aria-label="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="mb-2 text-xs text-gray-400">Uploading {uploadPct}%…</div>
      )}

      <div className="relative flex space-x-2 items-end">
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
          className="flex-shrink-0 w-10 h-10 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5 flex items-center justify-center"
          title="Attach image"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z" />
          </svg>
        </button>

        <div className="flex-1 relative">
          <textarea
            ref={taRef}
            value={text}
            onChange={onChange}
            onKeyDown={handleKey}
            placeholder="Type a message… use @ to mention"
            rows={rows}
            className="w-full resize-none border border-white/15 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
            style={{ fontSize: '16px' }}
          />
          {mentionQuery !== null && filteredMembers.length > 0 && (
            <div className="absolute z-30 bottom-full mb-1 left-0 right-0 max-h-48 overflow-y-auto bg-white/5 border border-white/10 rounded-lg shadow-lg">
              {filteredMembers.map((m, i) => (
                <button
                  key={m.uid}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(m);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-white/10 ${
                    i === highlight ? 'bg-gray-100' : ''
                  }`}
                >
                  <span className="font-medium text-white">{m.name}</span>
                  {m.role && (
                    <span className="ml-2 text-xs text-gray-400">{m.role}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={doSend}
          disabled={uploading || (!text.trim() && pending.length === 0)}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-4 py-2 rounded-lg transition-colors flex-shrink-0 flex items-center justify-center"
          aria-label="Send"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default MessageComposer;
