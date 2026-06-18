import React, { useEffect, useState } from 'react';
import { ChatMessage } from '../../types';

interface Props {
  message: ChatMessage;
  currentUserId: string;
  ownTheme: boolean;
  onVote: (messageId: string, optionId: string) => void;
  /** Coach / admin gate. When true, a "Voters" button shows under the
   *  poll that opens a per-option list of who voted. Hidden otherwise. */
  canSeeVoters?: boolean;
  /** Resolve a uid → display name. Same lookup used by the Seen-by
   *  sheet — checks active-team roster then the cross-team cache. */
  getUserName?: (uid: string) => string | undefined;
  /** Trigger an async fetch for uids the active-team roster can't
   *  resolve. Lets the voter list pull names for ex-teammates etc. */
  resolveUnknownUids?: (uids: string[]) => void;
}

/**
 * Renders a poll attached to a chat message. Tap an option to cast a
 * vote (or remove your existing vote on that option). For single-choice
 * polls, voting on a different option moves your vote.
 */
const PollCard: React.FC<Props> = ({ message, currentUserId, ownTheme, onVote, canSeeVoters, getUserName, resolveUnknownUids }) => {
  const poll = message.poll;
  const [votersOpen, setVotersOpen] = useState(false);

  // When the coach opens the voter sheet, ask the parent to resolve
  // any uids we can't name locally — same pattern as the Seen-by sheet.
  useEffect(() => {
    if (!votersOpen || !resolveUnknownUids || !getUserName || !poll) return;
    const all = new Set<string>();
    poll.options.forEach(o => o.voters.forEach(u => all.add(u)));
    const unknown = Array.from(all).filter(uid => !getUserName(uid));
    if (unknown.length > 0) resolveUnknownUids(unknown);
  }, [votersOpen, resolveUnknownUids, getUserName, poll]);

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
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`text-[11px] ${labelColor}`}>
          {totalVoters.size} {totalVoters.size === 1 ? 'vote' : 'votes'}
          {poll.multi ? ' · pick multiple' : ' · single choice'}
        </p>
        {canSeeVoters && totalVoters.size > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setVotersOpen(true); }}
            className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded-md transition ${
              ownTheme
                ? 'bg-white/15 text-white hover:bg-white/25'
                : 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 hover:bg-cyan-100'
            }`}
          >
            Voters
          </button>
        )}
      </div>

      {votersOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
          onClick={() => setVotersOpen(false)}
        >
          <div
            className="bg-white text-slate-900 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600">Voters</div>
              <button
                onClick={() => setVotersOpen(false)}
                className="text-[10px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-slate-700"
              >
                Done
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {poll.options.map(opt => (
                <div key={opt.id} className="border-b border-slate-100 last:border-b-0">
                  <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-900 truncate">{opt.text}</span>
                    <span className="text-[11px] font-bold tabular-nums text-slate-500 flex-shrink-0 ml-2">
                      {opt.voters.length}
                    </span>
                  </div>
                  {opt.voters.length === 0 ? (
                    <div className="px-4 py-2 text-[12px] text-slate-400 italic">No votes yet.</div>
                  ) : (
                    <ul className="pb-2">
                      {opt.voters.map(uid => (
                        <li key={uid} className="px-4 py-1 text-sm text-slate-700">
                          {(getUserName ? getUserName(uid) : null) || 'Member'}
                          {uid === currentUserId && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-widest text-cyan-600">You</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PollCard;
