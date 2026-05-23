import React from 'react';
import { ChatMessage } from '../../types';

interface Props {
  message: ChatMessage;
  currentUserId: string;
  ownTheme: boolean;
  onVote: (messageId: string, optionId: string) => void;
}

/**
 * Renders a poll attached to a chat message. Tap an option to cast a
 * vote (or remove your existing vote on that option). For single-choice
 * polls, voting on a different option moves your vote.
 */
const PollCard: React.FC<Props> = ({ message, currentUserId, ownTheme, onVote }) => {
  const poll = message.poll;
  if (!poll) return null;

  const totalVoters = new Set<string>();
  for (const o of poll.options) for (const u of o.voters) totalVoters.add(u);
  const totalVotes = poll.multi
    ? poll.options.reduce((s, o) => s + o.voters.length, 0)
    : totalVoters.size;

  const labelColor = ownTheme ? 'text-white/85' : 'text-gray-500';
  const bgInactive = ownTheme ? 'bg-white/10 ring-white/20' : 'bg-gray-50 ring-gray-200';
  const bgActive = ownTheme ? 'bg-white text-cyan-900 ring-white' : 'bg-cyan-50 ring-cyan-300 text-cyan-900';
  const fillInactive = ownTheme ? 'bg-white/15' : 'bg-cyan-100/60';
  const fillActive = ownTheme ? 'bg-white/35' : 'bg-cyan-200/80';

  return (
    <div className={`mt-1 w-full max-w-[340px] rounded-2xl px-3 py-2.5 ${ownTheme ? 'bg-gradient-to-br from-cyan-500 to-cyan-600 text-white' : 'bg-gray-100 text-gray-900'}`}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-base">📊</span>
        <span className={`text-[10px] font-bold uppercase tracking-wider ${labelColor}`}>Poll</span>
      </div>
      <p className="font-bold text-[15px] leading-snug mb-2.5">{poll.question}</p>
      <div className="space-y-1.5">
        {poll.options.map((opt) => {
          const mine = opt.voters.includes(currentUserId);
          const pct = totalVotes > 0 ? Math.round((opt.voters.length / totalVotes) * 100) : 0;
          return (
            <button
              key={opt.id}
              onClick={(e) => { e.stopPropagation(); onVote(message.id, opt.id); }}
              className={`relative w-full text-left rounded-xl ring-1 transition active:scale-[0.99] ${
                mine ? bgActive : bgInactive
              }`}
            >
              {/* Vote-share fill behind the label */}
              <div
                className={`absolute inset-y-0 left-0 rounded-xl transition-all ${mine ? fillActive : fillInactive}`}
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-semibold truncate">{opt.text}</span>
                <span className={`flex-shrink-0 text-xs font-bold tabular-nums ${mine ? '' : labelColor}`}>
                  {opt.voters.length} · {pct}%
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <p className={`mt-2 text-[11px] ${labelColor}`}>
        {totalVoters.size} {totalVoters.size === 1 ? 'vote' : 'votes'}
        {poll.multi ? ' · pick multiple' : ' · single choice'}
      </p>
    </div>
  );
};

export default PollCard;
