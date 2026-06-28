import React from 'react';

interface Reader {
  uid: string;
  name: string;
  photoURL?: string;
  readAt: number; // epoch ms
}

interface Props {
  readers: Reader[];
  threadParticipantCount?: number;
  onClose: () => void;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const ReadBySheet: React.FC<Props> = ({ readers, threadParticipantCount, onClose }) => {
  const sorted = [...readers].sort((a, b) => a.readAt - b.readAt);

  return (
    <div className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
      <div className="px-4 py-3 border-b border-line-default/5">
        <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/65">
          Seen by
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-ink-primary/40">No one's seen this yet.</div>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {sorted.map(r => (
            <li key={r.uid} className="px-4 py-2 flex items-center gap-2.5">
              {r.photoURL ? (
                <img src={r.photoURL} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {(r.name || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink-primary truncate">{r.name}</div>
                <div className="text-[11px] text-ink-primary/50">{formatRelative(r.readAt)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={onClose}
        className="w-full text-center py-3 text-sm font-bold text-ink-primary/50 hover:bg-line-default/[0.05] border-t border-line-default/5"
      >
        Done
      </button>
    </div>
  );
};

export default ReadBySheet;
