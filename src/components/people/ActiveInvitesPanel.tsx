// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query as fsQuery, orderBy } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { revokeInvite, inviteUrl } from '../../utils/invites';

interface Props {
  isAdmin: boolean;
  currentUid: string;
  myTeamIds: string[];
  teamNameById: Record<string, string>;
  playerNameById: Record<string, string>;
  onClose: () => void;
}

type Row = {
  id: string;
  type: 'player' | 'coach' | 'team_manager';
  teamId: string;
  playerId?: string;
  role?: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  maxUses: number | null;
  usedCount: number;
  revokedAt?: Date | null;
  note?: string;
};

function statusOf(row: Row): { label: string; tone: 'good' | 'mid' | 'bad' | 'gone' } {
  if (row.revokedAt) return { label: 'Revoked', tone: 'bad' };
  if (row.expiresAt.getTime() < Date.now()) return { label: 'Expired', tone: 'gone' };
  if (row.maxUses != null && row.usedCount >= row.maxUses) return { label: 'Used up', tone: 'gone' };
  if (row.maxUses != null) return { label: `${row.usedCount}/${row.maxUses} used`, tone: row.usedCount > 0 ? 'mid' : 'good' };
  return { label: `${row.usedCount} uses`, tone: 'good' };
}

const TONE_CLASS: Record<string, string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  mid: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-rose-50 text-rose-700 border-rose-200',
  gone: 'bg-slate-100 text-slate-500 border-slate-200',
};

const ActiveInvitesPanel: React.FC<Props> = ({ isAdmin, currentUid, myTeamIds, teamNameById, playerNameById, onClose }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(fsQuery(collection(db, 'invites'), orderBy('createdAt', 'desc')));
        if (cancelled) return;
        const list: Row[] = [];
        snap.forEach(d => {
          const v: any = d.data();
          list.push({
            id: d.id,
            type: v.type,
            teamId: v.teamId,
            playerId: v.playerId,
            role: v.role,
            createdBy: v.createdBy,
            createdAt: v.createdAt?.toDate ? v.createdAt.toDate() : new Date(v.createdAt || Date.now()),
            expiresAt: v.expiresAt?.toDate ? v.expiresAt.toDate() : new Date(v.expiresAt),
            maxUses: v.maxUses ?? null,
            usedCount: v.usedCount || 0,
            revokedAt: v.revokedAt?.toDate ? v.revokedAt.toDate() : null,
            note: v.note,
          });
        });
        // Non-admins only see invites they created or for teams they're on.
        const scoped = isAdmin
          ? list
          : list.filter(r => r.createdBy === currentUid || myTeamIds.includes(r.teamId));
        setRows(scoped);
      } catch (err) {
        console.warn('invite list failed', err);
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, currentUid, myTeamIds.join(',')]);

  const visible = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter(r => {
      const s = statusOf(r);
      return s.tone !== 'bad' && s.tone !== 'gone';
    });
  }, [rows, filter]);

  const counts = useMemo(() => ({
    active: rows.filter(r => { const s = statusOf(r); return s.tone !== 'bad' && s.tone !== 'gone'; }).length,
    all: rows.length,
  }), [rows]);

  const handleRevoke = async (id: string) => {
    if (!window.confirm('Revoke this invite? Anyone holding the link will no longer be able to use it.')) return;
    setBusyId(id);
    try {
      await revokeInvite(id);
      setRows(prev => prev.map(r => r.id === id ? { ...r, revokedAt: new Date() } : r));
    } catch (err) {
      console.error('revoke failed', err);
      alert('Failed to revoke.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(id));
      // Cheap toast.
      alert('Invite link copied.');
    } catch {
      window.prompt('Copy this invite link:', inviteUrl(id));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600">Active invites</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{counts.active} active · {counts.all} total</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="px-4 pt-3 flex gap-1.5">
          {(['active', 'all'] as const).map(k => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                filter === k
                  ? 'bg-brand-primary-soft text-brand-primary border-brand-primary-soft'
                  : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
              }`}
            >
              {k === 'active' ? `Active ${counts.active}` : `All ${counts.all}`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-primary-soft border-t-cyan-500" />
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">
              {filter === 'active' ? 'No active invites.' : 'No invites yet.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map(r => {
                const s = statusOf(r);
                const subject =
                  r.type === 'player'
                    ? (r.playerId ? playerNameById[r.playerId] || 'Player' : 'Player')
                    : (r.role === 'head_coach' ? 'Head coach' : r.role === 'team_manager' ? 'Team manager' : 'Assistant coach');
                const teamName = teamNameById[r.teamId] || 'Team';
                const daysLeft = Math.ceil((r.expiresAt.getTime() - Date.now()) / (24 * 3600 * 1000));
                const isRevocable = s.tone === 'good' || s.tone === 'mid';
                return (
                  <li key={r.id} className="border border-slate-200 rounded-lg p-2.5">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-900 text-sm">{subject}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {teamName} · {r.type === 'player' ? 'Parent invite' : 'Staff invite'}
                        </div>
                      </div>
                      <span className={`text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border ${TONE_CLASS[s.tone]} flex-shrink-0`}>
                        {s.label}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 mb-2">
                      {s.tone === 'good' || s.tone === 'mid'
                        ? (daysLeft > 0 ? `Expires in ${daysLeft}d` : 'Expires today')
                        : `Expired ${r.expiresAt.toLocaleDateString()}`}
                      {r.note && <> · {r.note}</>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isRevocable && (
                        <>
                          <button
                            onClick={() => handleCopy(r.id)}
                            disabled={busyId === r.id}
                            className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Copy link
                          </button>
                          <button
                            onClick={() => handleRevoke(r.id)}
                            disabled={busyId === r.id}
                            className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border bg-white text-rose-700 border-rose-200 hover:bg-rose-50 disabled:opacity-50"
                          >
                            {busyId === r.id ? '…' : 'Revoke'}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ActiveInvitesPanel;
