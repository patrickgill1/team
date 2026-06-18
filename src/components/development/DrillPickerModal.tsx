import React, { useEffect, useMemo, useState } from 'react';
import { Drill } from '../../types';
import { useFirestore } from '../../hooks/useFirestore';

const TOPIC_LABELS: Record<Drill['topic'], string> = {
  dribbling: 'Dribbling',
  passing: 'Passing',
  shooting: 'Shooting',
  'first-touch': 'First touch',
  defending: 'Defending',
  goalkeeping: 'Goalkeeping',
  fitness: 'Fitness',
  agility: 'Agility',
  tactical: 'Tactical',
  other: 'Other',
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
  /** Coach taps Add. The picker hands back the selected drills; the
   *  caller decides how to map them onto plan goals + bump
   *  assignmentCount on save. */
  onPick: (drills: Drill[]) => void;
}

const DrillPickerModal: React.FC<Props> = ({ isOpen, onClose, teamId, onPick }) => {
  const { getDocuments } = useFirestore();
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterTopic, setFilterTopic] = useState<Drill['topic'] | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen || !teamId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const all = await getDocuments('drills', []);
        const visible = (all as any[])
          .filter(d => d.isActive !== false)
          .filter(d => d.teamId === teamId)
          .map(d => ({
            ...d,
            createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : new Date(d.createdAt || Date.now()),
          })) as Drill[];
        if (!cancelled) setDrills(visible);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, teamId, getDocuments]);

  useEffect(() => {
    if (!isOpen) setSelected(new Set());
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drills.filter(d => {
      if (filterTopic !== 'all' && d.topic !== filterTopic) return false;
      if (q && !d.title.toLowerCase().includes(q) && !(d.focus || '').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => (b.assignmentCount || 0) - (a.assignmentCount || 0));
  }, [drills, search, filterTopic]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = () => {
    const picked = drills.filter(d => selected.has(d.id));
    onPick(picked);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Pick from drill library</h3>
            <p className="text-xs text-slate-500 mt-0.5">Selected drills become goals on the plan.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title or focus…"
            className="flex-1 min-w-[180px] px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-500/40"
          />
          <select
            value={filterTopic}
            onChange={(e) => setFilterTopic(e.target.value as any)}
            className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="all">All topics</option>
            {Object.entries(TOPIC_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="text-center py-10 text-sm text-slate-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-sm font-semibold text-slate-700">
                {drills.length === 0 ? 'Library is empty.' : 'No drills match.'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {drills.length === 0 ? 'Build the library first at /drills.' : 'Try a different search or topic.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map(d => {
                const isSel = selected.has(d.id);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => toggle(d.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors ${
                        isSel ? 'bg-crimson-50 border-crimson-300 ring-1 ring-crimson-300' : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`flex-shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-white text-xs font-bold ${
                          isSel ? 'bg-crimson-600' : 'bg-slate-200'
                        }`}>
                          {isSel && (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                          )}
                        </span>
                        <span className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-700 bg-crimson-50 ring-1 ring-crimson-200 px-1.5 py-0.5 rounded">
                          {TOPIC_LABELS[d.topic]}
                        </span>
                        {d.source === 'ai' && (
                          <span className="text-[10px] font-extrabold tracking-widest uppercase text-violet-700 bg-violet-50 ring-1 ring-violet-200 px-1.5 py-0.5 rounded">AI</span>
                        )}
                        {d.ageBand && d.ageBand !== 'all' && (
                          <span className="text-[10px] font-bold text-slate-500 ml-auto">{d.ageBand}</span>
                        )}
                      </div>
                      <div className="text-sm font-bold text-slate-900">{d.title}</div>
                      {d.focus && <div className="text-xs text-slate-600 line-clamp-1 mt-0.5">{d.focus}</div>}
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                        {d.durationMinutes != null && <span>{d.durationMinutes} min</span>}
                        {d.videoLinks && d.videoLinks.length > 0 && <span>· {d.videoLinks.length} video{d.videoLinks.length === 1 ? '' : 's'}</span>}
                        {d.assignmentCount != null && d.assignmentCount > 0 && <span>· assigned {d.assignmentCount}×</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={selected.size === 0}
            className="px-4 py-2 text-sm font-bold text-white bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 rounded-lg"
          >
            Add {selected.size} drill{selected.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DrillPickerModal;
