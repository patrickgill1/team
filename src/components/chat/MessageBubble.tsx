import React, { useState } from 'react';
import { ChatMessage } from '../../types';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '⚽', '🏆', '😂', '🙌', '👏'];

interface MessageBubbleProps {
  message: ChatMessage;
  currentUserId: string;
  currentUserName: string;
  replyTarget?: ChatMessage | null; // resolved message that this one replies to
  onReply: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  formatTime: (d: any) => string;
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

function renderRichContent(text: string): string {
  const safe = escapeHtml(text);
  // URLs
  const linked = safe.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-cyan-300 underline break-all">$1</a>'
  );
  // @mentions of any name (letters/numbers/spaces up to 30 chars terminated by punctuation/end)
  const mentioned = linked.replace(
    /@([A-Za-z][A-Za-z0-9 _'-]{0,28}[A-Za-z0-9])/g,
    '<span class="bg-cyan-500/20 text-cyan-200 font-medium px-1 rounded">@$1</span>'
  );
  return mentioned;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  currentUserId,
  currentUserName,
  replyTarget,
  onReply,
  onToggleReaction,
  formatTime,
  compact = false,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);

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

  return (
    <div
      className={`flex space-x-3 group ${
        isMentioned ? '-mx-2 px-2 py-1 rounded-md bg-amber-500/10' : ''
      }`}
    >
      <div className="flex-shrink-0">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ${
            message.senderRole === 'coach' ? 'bg-blue-600' : 'bg-green-600'
          }`}
        >
          {message.senderName.charAt(0).toUpperCase()}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center space-x-2 mb-1 flex-wrap">
          <span
            className={`font-medium text-white ${compact ? 'text-sm truncate' : ''}`}
          >
            {message.senderName}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
              message.senderRole === 'coach'
                ? 'bg-cyan-500/20 text-cyan-200'
                : 'bg-emerald-500/20 text-emerald-200'
            }`}
          >
            {message.senderRole}
          </span>
          <span className="text-xs text-gray-400 flex-shrink-0">{formatTime(message.timestamp)}</span>
        </div>

        {message.replyTo && (
          <div className="mb-2 p-2 bg-gray-100 rounded border-l-2 border-blue-400 text-sm text-gray-200">
            {replyTarget ? (
              <>
                <div className="text-xs font-semibold text-cyan-200">
                  ↪ {replyTarget.senderName}
                </div>
                <div className="truncate">{(replyTarget.content || '').slice(0, 140)}</div>
              </>
            ) : (
              <span className="italic text-gray-400">Replying to a message</span>
            )}
          </div>
        )}

        {message.content && (
          <div
            className={`text-white whitespace-pre-wrap break-words ${
              compact ? 'text-sm leading-relaxed' : ''
            }`}
            dangerouslySetInnerHTML={{ __html: renderRichContent(message.content) }}
          />
        )}

        {images.length > 0 && (
          <div
            className={`mt-2 grid gap-2 ${
              images.length === 1 ? 'grid-cols-1 max-w-xs' : 'grid-cols-2 max-w-md'
            }`}
          >
            {images.map((img, i) => (
              <a key={i} href={img.url} target="_blank" rel="noopener noreferrer">
                <img
                  src={img.url}
                  alt={img.name || 'attachment'}
                  className="rounded-lg border border-white/10 max-h-64 object-cover w-full"
                />
              </a>
            ))}
          </div>
        )}

        {Object.keys(grouped).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(grouped).map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => onToggleReaction(message, emoji)}
                title={info.names.join(', ')}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  info.mine
                    ? 'bg-cyan-500/10 border-cyan-500/30 text-blue-800'
                    : 'bg-white/5 border-white/15 text-gray-200 hover:bg-white/5'
                }`}
              >
                <span className="mr-1">{emoji}</span>
                <span className="font-medium">{info.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-1 flex items-center space-x-3 text-xs text-gray-400">
          <button
            onClick={() => onReply(message)}
            className="hover:text-gray-200 font-medium"
          >
            Reply
          </button>

          <div className="relative">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="hover:text-gray-200 font-medium"
              aria-label="Add reaction"
            >
              😊 React
            </button>
            {pickerOpen && (
              <div className="absolute z-20 mt-1 left-0 bg-white/5 border border-white/10 rounded-lg shadow-lg p-2 flex space-x-1">
                {QUICK_REACTIONS.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      onToggleReaction(message, e);
                      setPickerOpen(false);
                    }}
                    className="text-lg hover:bg-white/10 rounded p-1"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;
