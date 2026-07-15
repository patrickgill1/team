import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin, isCoach } from '../utils/helpers';
import { useClubId } from '../hooks/useClubId';
import { logActivity } from '../utils/activityLog';
import CreateTaskModal from '../components/club/CreateTaskModal';
import type { Task } from '../types';

// Club-wide task list. Two scopes: mine (assigned to me, default) and
// all. Filter by status (open / in_progress / done). Sort overdue
// first within open tasks so important things float up.

type StatusFilter = 'open' | 'in_progress' | 'done' | 'all';

const Tasks: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData) || (userData?.role ? isCoach(userData.role) : false);
  const { clubId } = useClubId();
  const myUid = userData?.uid || '';

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const reload = async () => {
    if (!clubId) return;
    try {
      setLoading(true);
      const snap = await getDocs(query(collection(db, 'tasks'), where('clubId', '==', clubId), orderBy('createdAt', 'desc')));
      setTasks(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Task));
    } catch (err) {
      // Index missing — fall back to unordered.
      try {
        const snap = await getDocs(query(collection(db, 'tasks'), where('clubId', '==', clubId)));
        setTasks(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Task));
      } catch {/* ignore */}
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (allowed) void reload(); }, [allowed, clubId]);

  const visible = useMemo(() => {
    const list = tasks.filter(t => {
      if (scope === 'mine' && t.assigneeUid !== myUid) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      return true;
    });
    // Overdue + high-priority float up within open status.
    list.sort((a, b) => {
      if (a.status === 'done' && b.status !== 'done') return 1;
      if (b.status === 'done' && a.status !== 'done') return -1;
      const ap = priorityRank(a.priority);
      const bp = priorityRank(b.priority);
      if (ap !== bp) return ap - bp;
      const aDue = a.dueDate ? toDate(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? toDate(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });
    return list;
  }, [tasks, scope, statusFilter, myUid]);

  const updateStatus = async (task: Task, status: Task['status']) => {
    if (task.status === status) return;
    setUpdating(task.id);
    try {
      const patch: any = { status, updatedAt: serverTimestamp() };
      if (status === 'done') {
        patch.completedAt = serverTimestamp();
        patch.completedBy = myUid;
      } else if (task.status === 'done') {
        patch.completedAt = null;
        patch.completedBy = null;
      }
      await updateDoc(doc(db, 'tasks', task.id), patch);
      await logActivity({
        clubId: task.clubId,
        kind: status === 'done' ? 'task_completed' : task.status === 'done' ? 'task_reopened' : 'task_assigned',
        playerId: task.relatedPlayerId,
        teamId: task.relatedTeamId,
        actorUid: myUid,
        actorName: userData?.name,
        payload: { taskId: task.id, title: task.title, status },
      });
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status } : t));
    } finally {
      setUpdating(null);
    }
  };

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-ink-primary/65 text-sm">Coaches + club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-surface-base px-4 py-6 sm:py-10">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary/85">← Club</Link>
            <h1 className="text-2xl font-black text-ink-primary mt-1">Tasks</h1>
            <p className="text-sm text-ink-primary/65">Admin todos. Overdue + high priority float to the top.</p>
          </div>
          <button type="button" onClick={() => setCreating(true)} className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/150 text-white text-sm font-bold">
            + New task
          </button>
        </div>

        <div className="bg-surface-elevated rounded-xl ring-1 ring-line-default/10 p-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg ring-1 ring-line-default/10 overflow-hidden">
            {(['mine', 'all'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest ${scope === s ? 'bg-brand-primary text-white' : 'bg-surface-elevated text-ink-primary/65 hover:bg-line-default/[0.05]'}`}
              >
                {s === 'mine' ? 'Mine' : 'All club'}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg ring-1 ring-line-default/10 overflow-hidden">
            {(['open', 'in_progress', 'done', 'all'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest ${statusFilter === s ? 'bg-surface-elevated text-ink-primary' : 'bg-surface-elevated text-ink-primary/65 hover:bg-line-default/[0.05]'}`}
              >
                {s === 'in_progress' ? 'In progress' : s}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-ink-primary/50">{visible.length} of {tasks.length}</span>
        </div>

        {loading ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-6 text-sm text-ink-primary/50">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-10 text-center text-sm text-ink-primary/50">No tasks here. Hit + New task to add one.</div>
        ) : (
          <ul className="space-y-2">
            {visible.map(t => <Row key={t.id} task={t} myUid={myUid} updating={updating === t.id} onUpdate={(s) => updateStatus(t, s)} />)}
          </ul>
        )}
      </div>

      {creating && clubId && (
        <CreateTaskModal
          clubId={clubId}
          actorUid={myUid}
          actorName={userData?.name || 'Admin'}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); void reload(); }}
        />
      )}
    </div>
  );
};

const Row: React.FC<{ task: Task; myUid: string; updating: boolean; onUpdate: (s: Task['status']) => void }> = ({ task, updating, onUpdate }) => {
  const overdue = task.status !== 'done' && task.dueDate && toDate(task.dueDate).getTime() < Date.now();
  return (
    <li className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-3 flex items-start gap-3">
      <button
        type="button"
        disabled={updating}
        onClick={() => onUpdate(task.status === 'done' ? 'open' : 'done')}
        className={`mt-0.5 w-5 h-5 rounded-full ring-1 flex items-center justify-center transition shrink-0 ${
          task.status === 'done'
            ? 'bg-emerald-500/150 ring-emerald-500 text-white'
            : 'bg-surface-elevated ring-line-default/15 hover:ring-emerald-400'
        }`}
        title={task.status === 'done' ? 'Mark not done' : 'Mark done'}
      >
        {task.status === 'done' && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-bold ${task.status === 'done' ? 'text-ink-primary/40 line-through' : 'text-ink-primary'}`}>{task.title}</span>
          {task.priority === 'high' && <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 ring-1 ring-rose-200">High</span>}
          {task.priority === 'low' && <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-surface-base text-ink-primary/50 ring-1 ring-line-default/10">Low</span>}
          {overdue && <span className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/30">Overdue</span>}
        </div>
        {task.description && <p className="text-[11px] text-ink-primary/65 mt-0.5">{task.description}</p>}
        <div className="text-[11px] text-ink-primary/50 mt-1 flex items-center gap-2 flex-wrap">
          {task.relatedPlayerName && (
            <Link to={`/club/person/${task.relatedPlayerId}`} className="font-bold text-brand-primary-soft hover:text-brand-primary-soft">
              {task.relatedPlayerName}
            </Link>
          )}
          {task.assigneeName && <span>· {task.assigneeName}</span>}
          {task.dueDate && <span>· due {toDate(task.dueDate).toLocaleDateString()}</span>}
        </div>
      </div>
      {task.status !== 'done' && (
        <select
          value={task.status}
          onChange={(e) => onUpdate(e.target.value as Task['status'])}
          disabled={updating}
          className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded ring-1 ring-line-default/10 bg-surface-elevated shrink-0"
        >
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select>
      )}
    </li>
  );
};

function priorityRank(p: Task['priority']): number {
  if (p === 'high') return 0;
  if (p === 'normal') return 1;
  return 2;
}

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

export default Tasks;
