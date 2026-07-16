// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where, documentId, onSnapshot } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { workerFetch } from '../utils/workerFetch';
import { createStaffInvite, inviteUrl } from '../utils/invites';
import {
  ALL_STAFF_PERMISSIONS,
  STAFF_PERMISSION_META,
  DEFAULT_PERMISSIONS_ASSISTANT,
  DEFAULT_PERMISSIONS_MANAGER,
  effectivePermissions,
  type StaffPermissionKey,
  type StaffPermissionMap,
} from '../utils/staffPermissions';
import type { Team } from '../types';

// Staff Management — head coach's control panel for a single team.
// Reads from the team doc in real-time so permission edits show up
// immediately after the head coach saves them.
//
// Non-head-coach visitors get an "only the head coach can manage
// staff" empty state. That's intentional — the whole point of the
// per-team permission model is that adjusting other people's
// capabilities is a head-coach responsibility.

interface UserLite {
  uid: string;
  name: string;
  email: string;
  photoURL?: string;
}

type StaffRole = 'head' | 'assistant' | 'manager';

const StaffManagement: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam: contextTeam } = useTeam();
  const [team, setTeam] = useState<Team | null>(contextTeam || null);
  const [users, setUsers] = useState<Record<string, UserLite>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingPermsFor, setEditingPermsFor] = useState<string | null>(null);
  const [pendingPerms, setPendingPerms] = useState<StaffPermissionMap>({});
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<'assistant_coach' | 'team_manager'>('assistant_coach');
  const [generatedInvite, setGeneratedInvite] = useState<{ url: string; role: string } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  // Subscribe to the team doc so permission changes reflect live.
  useEffect(() => {
    if (!selectedTeamId) return;
    const ref = doc(db, 'teams', selectedTeamId);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) setTeam({ id: snap.id, ...(snap.data() as any) } as Team);
    });
    return () => unsub();
  }, [selectedTeamId]);

  const isUserHeadCoach = !!(team?.headCoachId && userData?.uid && team.headCoachId === userData.uid);

  // Load user docs for everyone on the staff. Chunk by 30 (Firestore
  // `in` limit) so a wide staff list doesn't break the query.
  useEffect(() => {
    if (!team) return;
    const uids = new Set<string>();
    if (team.headCoachId) uids.add(team.headCoachId);
    (team.assistantCoachIds || []).forEach((u) => uids.add(u));
    (team.managerIds || []).forEach((u) => uids.add(u));
    // Defensive: pick up any legacy coachIds entries that never
    // mirrored to assistantCoachIds so the head coach can still see
    // and manage them from this page. See staffRows below for the
    // full rationale.
    ((team as any).coachIds || []).forEach((u: string) => uids.add(u));
    const missing = [...uids].filter((u) => !users[u]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, UserLite> = {};
      for (let i = 0; i < missing.length; i += 30) {
        const chunk = missing.slice(i, i + 30);
        const snap = await getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)));
        snap.docs.forEach((d) => {
          const data: any = d.data() || {};
          next[d.id] = {
            uid: d.id,
            name: data.name || data.displayName || '(unnamed)',
            email: data.email || '',
            photoURL: data.photoURL || data.profilePhotoUrl,
          };
        });
      }
      if (!cancelled) setUsers((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // Only trigger when the staff-uid set actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team?.headCoachId, (team?.assistantCoachIds || []).join(','), (team?.managerIds || []).join(','), ((team as any)?.coachIds || []).join(',')]);

  const staffRows: Array<{ uid: string; role: StaffRole; user: UserLite }> = useMemo(() => {
    if (!team) return [];
    const rows: Array<{ uid: string; role: StaffRole; user: UserLite }> = [];
    const fallback = (uid: string): UserLite => users[uid] || { uid, name: uid.slice(0, 8) + '…', email: '' };
    const accounted = new Set<string>();
    if (team.headCoachId) {
      rows.push({ uid: team.headCoachId, role: 'head', user: fallback(team.headCoachId) });
      accounted.add(team.headCoachId);
    }
    (team.assistantCoachIds || []).forEach((uid) => {
      if (accounted.has(uid)) return;
      rows.push({ uid, role: 'assistant', user: fallback(uid) });
      accounted.add(uid);
    });
    (team.managerIds || []).forEach((uid) => {
      if (accounted.has(uid)) return;
      rows.push({ uid, role: 'manager', user: fallback(uid) });
      accounted.add(uid);
    });
    // Belt-and-suspenders: any uid on team.coachIds that hasn't
    // already been placed by the buckets above is a "ghost coach"
    // — real for security rules (Firestore reads/writes gated on
    // coachIds check out) but never mirrored to the role-specific
    // arrays that this page reads. Render them as assistant so
    // the head coach can adjust or remove them via the normal UI.
    // Once applyMembership() writes both arrays and the backfill
    // migration runs, this path becomes a no-op; keeping it makes
    // future drift regressions self-heal instead of silently
    // hiding staff members.
    ((team as any).coachIds || []).forEach((uid: string) => {
      if (accounted.has(uid)) return;
      rows.push({ uid, role: 'assistant', user: fallback(uid) });
      accounted.add(uid);
    });
    return rows;
  }, [team, users]);

  const call = async (path: string, body: any, busyKey: string): Promise<boolean> => {
    setBusyRow(busyKey); setMessage(null); setError(null);
    try {
      const res = await workerFetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setError(j?.message || j?.error || `HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e: any) {
      setError(e?.message || 'Request failed');
      return false;
    } finally {
      setBusyRow(null);
    }
  };

  const handleRoleChange = async (staffUid: string, role: 'assistant' | 'manager' | 'remove') => {
    if (!selectedTeamId) return;
    const targetLabel = users[staffUid]?.name || staffUid.slice(0, 8) + '…';
    if (role === 'remove' && !window.confirm(`Remove ${targetLabel} from this team's staff? Their permissions will be cleared. They'll no longer see the team in their switcher unless they're also a parent here.`)) {
      return;
    }
    const ok = await call('/teams/set-staff-role', {
      teamId: selectedTeamId,
      staffUid,
      role,
    }, `role:${staffUid}`);
    if (ok) {
      setMessage(role === 'remove' ? `Removed ${targetLabel} from staff.` : `Moved ${targetLabel} to ${role}.`);
    }
  };

  const handleOpenPerms = (staffUid: string) => {
    const current = effectivePermissions({ uid: staffUid }, team as any);
    setEditingPermsFor(staffUid);
    setPendingPerms(current);
  };

  const handlePermToggle = (key: StaffPermissionKey) => {
    setPendingPerms((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleResetToRole = (staffUid: string) => {
    const isAssistant = (team?.assistantCoachIds || []).includes(staffUid);
    const isManager = (team?.managerIds || []).includes(staffUid);
    if (isAssistant) setPendingPerms({ ...DEFAULT_PERMISSIONS_ASSISTANT });
    else if (isManager) setPendingPerms({ ...DEFAULT_PERMISSIONS_MANAGER });
  };

  const handleSavePerms = async () => {
    if (!editingPermsFor || !selectedTeamId) return;
    const ok = await call('/teams/set-staff-permissions', {
      teamId: selectedTeamId,
      staffUid: editingPermsFor,
      permissions: pendingPerms,
    }, `perms:${editingPermsFor}`);
    if (ok) {
      setMessage(`Permissions updated for ${users[editingPermsFor]?.name || 'staff member'}.`);
      setEditingPermsFor(null);
    }
  };

  const handleGenerateInvite = async () => {
    if (!selectedTeamId || !userData?.uid) return;
    setInviteBusy(true); setError(null);
    try {
      const inv = await createStaffInvite({
        teamId: selectedTeamId,
        role: inviteRole,
        createdBy: userData.uid,
      });
      setGeneratedInvite({ url: inviteUrl(inv.id), role: inviteRole });
    } catch (e: any) {
      setError(e?.message || 'Failed to generate invite');
    } finally {
      setInviteBusy(false);
    }
  };

  if (!selectedTeamId) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-ink-primary/65">Pick a team from the switcher to manage its staff.</p>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-ink-primary/45 text-sm">Loading team…</p>
      </div>
    );
  }

  if (!isUserHeadCoach) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl p-6 text-center">
          <p className="text-ink-primary font-bold">Head coach only</p>
          <p className="text-ink-primary/55 text-sm mt-1">
            Only the head coach of <b>{team.name}</b> can manage this team's staff and permissions.
          </p>
          <Link to="/coach" className="mt-4 inline-block text-brand-primary-soft text-sm font-bold hover:underline">
            ← Back to Dugout
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto pb-24">
      <header className="mb-5">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-ink-primary/55 hover:text-ink-primary text-xs font-bold mb-2"
        >
          ← Back
        </button>
        <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/45">Team HQ</p>
        <h1 className="text-2xl font-black text-ink-primary">Staff</h1>
        <p className="text-ink-primary/55 text-sm mt-1">
          {team.name}. Set who does what on your team. Head coach permissions are always on; assistants and managers get sensible defaults you can tune per person.
        </p>
      </header>

      <button
        type="button"
        onClick={() => { setInviteOpen(true); setGeneratedInvite(null); }}
        className="mb-4 w-full text-left bg-brand-primary hover:bg-brand-primary-dim text-white rounded-xl px-4 py-3 font-bold text-sm shadow-sm transition-colors"
      >
        + Invite an assistant or team manager
      </button>

      <ul className="space-y-2">
        {staffRows.map(({ uid, role, user }) => {
          const isEditingThisRow = editingPermsFor === uid;
          const effective = effectivePermissions({ uid }, team as any);
          return (
            <li key={uid} className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-3 p-3">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-line-default/10 flex items-center justify-center text-sm font-bold text-ink-primary flex-shrink-0">
                    {(user.name || '?').charAt(0)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink-primary truncate">{user.name}</p>
                  <p className="text-[11px] text-ink-primary/55 truncate">
                    {user.email || uid.slice(0, 12) + '…'}
                  </p>
                </div>
                <RoleBadge role={role} />
              </div>
              {role !== 'head' && (
                <div className="border-t border-line-default/5 px-3 py-2 flex flex-wrap gap-2 items-center">
                  <button
                    type="button"
                    onClick={() => (isEditingThisRow ? setEditingPermsFor(null) : handleOpenPerms(uid))}
                    className="text-xs font-bold px-2.5 py-1.5 rounded-lg bg-line-default/[0.06] hover:bg-line-default/[0.1] text-ink-primary/85 transition-colors"
                  >
                    {isEditingThisRow ? 'Close permissions' : 'Permissions'}
                  </button>
                  {role === 'assistant' ? (
                    <button
                      type="button"
                      disabled={busyRow === `role:${uid}`}
                      onClick={() => handleRoleChange(uid, 'manager')}
                      className="text-xs font-bold px-2.5 py-1.5 rounded-lg bg-line-default/[0.06] hover:bg-line-default/[0.1] text-ink-primary/85 transition-colors disabled:opacity-50"
                    >
                      Switch to Team manager
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyRow === `role:${uid}`}
                      onClick={() => handleRoleChange(uid, 'assistant')}
                      className="text-xs font-bold px-2.5 py-1.5 rounded-lg bg-line-default/[0.06] hover:bg-line-default/[0.1] text-ink-primary/85 transition-colors disabled:opacity-50"
                    >
                      Switch to Assistant coach
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyRow === `role:${uid}`}
                    onClick={() => handleRoleChange(uid, 'remove')}
                    className="ml-auto text-xs font-bold px-2.5 py-1.5 rounded-lg text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                  >
                    Remove from staff
                  </button>
                </div>
              )}
              {isEditingThisRow && role !== 'head' && (
                <div className="border-t border-line-default/5 p-3 bg-surface-base/40">
                  <PermissionGroups
                    perms={pendingPerms}
                    onToggle={handlePermToggle}
                  />
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() => handleResetToRole(uid)}
                      className="text-[11px] font-bold text-ink-primary/55 hover:text-ink-primary px-2 py-1"
                    >
                      Reset to role defaults
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingPermsFor(null)}
                      className="ml-auto text-xs font-bold px-3 py-1.5 rounded-lg bg-line-default/[0.08] hover:bg-line-default/[0.12] text-ink-primary/85"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSavePerms}
                      disabled={busyRow === `perms:${uid}`}
                      className="text-xs font-bold px-3 py-1.5 rounded-lg bg-brand-primary hover:bg-brand-primary-dim text-white disabled:opacity-50"
                    >
                      {busyRow === `perms:${uid}` ? 'Saving…' : 'Save permissions'}
                    </button>
                  </div>
                </div>
              )}
              {role === 'head' && (
                <div className="border-t border-line-default/5 px-3 py-2">
                  <p className="text-[11px] text-ink-primary/55">Head coach — everything on.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {message && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2 rounded-lg text-xs font-bold bg-emerald-500/90 text-white shadow-2xl">
          {message}
        </div>
      )}
      {error && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2 rounded-lg text-xs font-bold bg-rose-500/90 text-white shadow-2xl">
          {error}
        </div>
      )}

      {inviteOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setInviteOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md bg-surface-elevated ring-1 ring-line-default/10 sm:rounded-2xl overflow-hidden">
            <header className="px-5 py-4 border-b border-line-default/5">
              <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55">Invite staff</p>
              <p className="text-sm font-bold text-ink-primary mt-0.5">{team.name}</p>
            </header>
            <div className="p-5 space-y-4">
              <label className="block">
                <span className="block text-[10px] font-black uppercase tracking-widest text-ink-primary/55 mb-2">Role</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setInviteRole('assistant_coach')}
                    className={`text-left px-3 py-2 rounded-lg text-xs font-bold border transition-colors ${
                      inviteRole === 'assistant_coach'
                        ? 'bg-brand-primary/15 border-brand-primary text-ink-primary'
                        : 'bg-surface-base border-line-default/10 text-ink-primary/75 hover:border-line-default/25'
                    }`}
                  >
                    Assistant coach
                  </button>
                  <button
                    type="button"
                    onClick={() => setInviteRole('team_manager')}
                    className={`text-left px-3 py-2 rounded-lg text-xs font-bold border transition-colors ${
                      inviteRole === 'team_manager'
                        ? 'bg-brand-primary/15 border-brand-primary text-ink-primary'
                        : 'bg-surface-base border-line-default/10 text-ink-primary/75 hover:border-line-default/25'
                    }`}
                  >
                    Team manager
                  </button>
                </div>
                <p className="text-[11px] text-ink-primary/45 mt-2 leading-snug">
                  {inviteRole === 'assistant_coach'
                    ? 'Coaching staff. Defaults to running GameDay, planning practice, and posting content.'
                    : 'Logistics staff. Defaults to schedule, chat, dues, and roster admin. No practice-planning by default.'}
                </p>
              </label>
              {generatedInvite ? (
                <div className="rounded-xl bg-surface-base ring-1 ring-line-default/10 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55 mb-1">Share this link</p>
                  <p className="text-xs font-mono text-brand-primary-soft break-all">{generatedInvite.url}</p>
                  <p className="text-[11px] text-ink-primary/55 mt-2 leading-snug">
                    Whoever opens it and signs in becomes a {generatedInvite.role.replace('_', ' ')} on {team.name} with the role's default permissions. You can fine-tune from this page after they land.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(generatedInvite.url).then(() => setMessage('Invite link copied.'))}
                    className="mt-2 w-full bg-brand-primary hover:bg-brand-primary-dim text-white rounded-lg py-2 text-xs font-bold"
                  >
                    Copy link
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleGenerateInvite}
                  disabled={inviteBusy}
                  className="w-full bg-brand-primary hover:bg-brand-primary-dim text-white rounded-lg py-2.5 text-sm font-bold disabled:opacity-50"
                >
                  {inviteBusy ? 'Generating…' : 'Generate invite link'}
                </button>
              )}
            </div>
            <footer className="px-5 py-3 border-t border-line-default/5 flex justify-end">
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                className="text-xs font-bold px-4 py-2 rounded-lg bg-line-default/[0.08] hover:bg-line-default/[0.12] text-ink-primary/85"
              >
                Close
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};

function RoleBadge({ role }: { role: StaffRole }) {
  const styles: Record<StaffRole, { label: string; cls: string }> = {
    head:      { label: 'Head coach',   cls: 'bg-brand-primary/15 text-brand-primary-soft ring-brand-primary/30' },
    assistant: { label: 'Assistant',    cls: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' },
    manager:   { label: 'Manager',      cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  };
  const s = styles[role];
  return (
    <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ring-1 ${s.cls} flex-shrink-0`}>
      {s.label}
    </span>
  );
}

function PermissionGroups({
  perms,
  onToggle,
}: {
  perms: StaffPermissionMap;
  onToggle: (k: StaffPermissionKey) => void;
}) {
  const groups: Array<{ id: 'coaching' | 'content' | 'logistics' | 'danger'; label: string; keys: StaffPermissionKey[] }> = useMemo(() => {
    const byGroup: Record<string, StaffPermissionKey[]> = {};
    ALL_STAFF_PERMISSIONS.forEach((k) => {
      const g = STAFF_PERMISSION_META[k].group;
      byGroup[g] = byGroup[g] || [];
      byGroup[g].push(k);
    });
    return [
      { id: 'coaching', label: 'Coaching', keys: byGroup.coaching || [] },
      { id: 'content', label: 'Content', keys: byGroup.content || [] },
      { id: 'logistics', label: 'Logistics', keys: byGroup.logistics || [] },
      { id: 'danger', label: 'Danger', keys: byGroup.danger || [] },
    ];
  }, []);
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.id}>
          <p className={`text-[10px] font-black uppercase tracking-widest mb-1.5 ${
            g.id === 'danger' ? 'text-rose-300' : 'text-ink-primary/55'
          }`}>{g.label}</p>
          <ul className="space-y-1">
            {g.keys.map((k) => (
              <li key={k}>
                <label className="flex items-start gap-3 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-line-default/[0.04]">
                  <input
                    type="checkbox"
                    checked={!!perms[k]}
                    onChange={() => onToggle(k)}
                    className={`mt-0.5 h-4 w-4 flex-shrink-0 ${g.id === 'danger' ? 'accent-rose-400' : 'accent-brand-primary'}`}
                  />
                  <span className="flex-1">
                    <span className="block text-xs font-bold text-ink-primary">{STAFF_PERMISSION_META[k].label}</span>
                    <span className="block text-[11px] text-ink-primary/55 leading-snug">{STAFF_PERMISSION_META[k].hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default StaffManagement;
