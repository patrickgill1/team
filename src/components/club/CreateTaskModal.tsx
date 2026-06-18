import React, { useEffect, useState } from 'react';
import { collection, doc, getDocs, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { logActivity } from '../../utils/activityLog';
import type { Task } from '../../types';

// Modal to create a new club task. Pre-fills relatedPlayerId when
// opened from PersonAdmin. Assignee picker loads club admins +
// coaches so the dropdown is short and meaningful.

interface Props {
  clubId: string;
  actorUid: string;
  actorName: string;
  relatedPlayer?: { id: string; name: string };
  relatedTeamId?: string;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}

const CreateTaskModal: React.FC<Props> = ({ clubId, actorUid, actorName, relatedPlayer, relatedTeamId, onClose, onCreated }) => {
  const [title, setTitle] = useState(relatedPlayer ? `Follow up on ${relatedPlayer.name}` : '');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('normal');
  const [dueDate, setDueDate] = useState('');
  const [assignees, setAssignees] = useState<Array<{ uid: string; name: string }>>([]);
  const [assigneeUid, setAssigneeUid] = useState<string>(actorUid);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load potential assignees — club admins + coaches in this club.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'users'), where('clubId', '==', clubId)));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ uid: d.id, ...(d.data() as any) }))
          .filter((u: any) => u.isClubAdmin || u.role === 'coach' || u.role === 'team_manager')
          .map((u: any) => ({ uid: u.uid, name: u.name || u.email || u.uid }));
        // Always include the actor so they can self-assign even if the
        // user index is slow.
        if (!list.find(l => l.uid === actorUid)) list.unshift({ uid: actorUid, name: actorName });
        setAssignees(list);
      } catch (err) {
        // Fall back to actor-only assignment.
        setAssignees([{ uid: actorUid, name: actorName }]);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId, actorUid, actorName]);

  const canSave = !!(title.trim() && !saving);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const assignee = assignees.find(a => a.uid === assigneeUid);
      const payload: any = {
        clubId,
        title: title.trim(),
        description: description.trim() || undefined,
        status: 'open',
        priority,
        relatedPlayerId: relatedPlayer?.id,
        relatedPlayerName: relatedPlayer?.name,
        relatedTeamId,
        assigneeUid: assignee?.uid || null,
        assigneeName: assignee?.name,
        dueDate: dueDate ? new Date(dueDate) : null,
        createdBy: actorUid,
        createdByName: actorName,
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'tasks', id), payload);
      await logActivity({
        clubId,
        kind: 'task_created',
        playerId: relatedPlayer?.id,
        teamId: relatedTeamId,
        actorUid,
        actorName,
        payload: {
          taskId: id,
          title: title.trim(),
          assigneeName: assignee?.name,
          priority,
        },
      });
      onCreated(id);
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Create task</h2>
            {relatedPlayer && <p className="text-[11px] text-slate-500">About {relatedPlayer.name}</p>}
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call back about uniform sizing"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
            />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Assign to</span>
              <select value={assigneeUid} onChange={(e) => setAssigneeUid(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm">
                <option value="">Unassigned</option>
                {assignees.map(a => <option key={a.uid} value={a.uid}>{a.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Task['priority'])} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Due date (optional)</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm" />
          </label>

          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateTaskModal;
