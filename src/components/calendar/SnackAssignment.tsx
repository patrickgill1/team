// @ts-nocheck
import React, { useMemo, useState } from 'react';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../../utils/firebase';

interface RosterPlayer { id: string; name: string }

interface Props {
  eventId: string;
  teamId: string;
  isCoach: boolean;
  assignment?: {
    playerId: string;
    playerName: string;
    notes?: string;
  } | null;
  roster: RosterPlayer[];
  onChange: (
    assignment: { playerId: string; playerName: string; notes?: string } | null
  ) => Promise<void>;
}

const SnackAssignment: React.FC<Props> = ({ eventId, teamId, isCoach, assignment, roster, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [pickerId, setPickerId] = useState<string>(assignment?.playerId || '');
  const [notes, setNotes] = useState<string>(assignment?.notes || '');
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const selectedName = useMemo(
    () => roster.find(r => r.id === pickerId)?.name || '',
    [roster, pickerId],
  );

  // "Suggest" — fetch the team's last ~30 events and pick a roster
  // player who hasn't been assigned recently (or ever). Falls back to
  // a random pick if everyone's been assigned. Cheap one-shot read.
  const suggestNextUp = async () => {
    if (suggesting || roster.length === 0) return;
    setSuggesting(true);
    try {
      const snap = await getDocs(query(
        collection(db, 'events'),
        where('teamId', '==', teamId),
        orderBy('date', 'desc'),
        limit(30),
      ));
      const recentAssignees: string[] = [];
      snap.forEach(d => {
        const a = (d.data() as any)?.snackAssignment;
        if (a?.playerId && d.id !== eventId) recentAssignees.push(a.playerId);
      });
      const neverAssigned = roster.filter(r => !recentAssignees.includes(r.id));
      const pool = neverAssigned.length > 0 ? neverAssigned : roster;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      setPickerId(pick.id);
    } catch (err) {
      console.warn('snack suggest failed', err);
    } finally {
      setSuggesting(false);
    }
  };

  const save = async () => {
    if (!pickerId) return;
    const p = roster.find(r => r.id === pickerId);
    if (!p) return;
    setSaving(true);
    try {
      await onChange({ playerId: p.id, playerName: p.name, notes: notes.trim() || undefined });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('Remove snack assignment?')) return;
    setSaving(true);
    try {
      await onChange(null);
      setPickerId('');
      setNotes('');
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600">
          Snacks
        </div>
        {isCoach && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-700 hover:text-crimson-900"
          >
            {assignment ? 'Change' : 'Assign'}
          </button>
        )}
      </div>

      {!editing ? (
        assignment ? (
          <div>
            <div className="text-sm text-slate-900 font-semibold">{assignment.playerName}</div>
            {assignment.notes && (
              <div className="mt-0.5 text-xs text-slate-500 whitespace-pre-wrap">{assignment.notes}</div>
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-400 italic">No one assigned yet.</div>
        )
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              value={pickerId}
              onChange={e => setPickerId(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value="">Pick a player…</option>
              {roster.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <button
              onClick={suggestNextUp}
              disabled={suggesting}
              title="Suggest a player who hasn't been assigned recently"
              className="px-3 text-[10px] font-extrabold tracking-widest uppercase rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {suggesting ? '…' : 'Suggest'}
            </button>
          </div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes (e.g. fruit + water, nut-free)"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || !pickerId}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-crimson-600 text-white hover:bg-crimson-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : `Assign${selectedName ? ` to ${selectedName.split(' ')[0]}` : ''}`}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] font-bold uppercase tracking-wider px-2 py-1.5 text-slate-500 hover:text-slate-800"
            >
              Cancel
            </button>
            {assignment && (
              <button
                onClick={clear}
                disabled={saving}
                className="ml-auto text-[11px] font-bold uppercase tracking-wider px-2 py-1.5 text-rose-600 hover:text-rose-800"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SnackAssignment;
