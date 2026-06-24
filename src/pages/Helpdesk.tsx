// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addDoc, collection, getDocs, onSnapshot, orderBy, query, serverTimestamp, where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import Header from '../components/common/Header';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';
import { sendPushToUsers } from '../utils/notify';
import type { HelpdeskTicket, TicketStatus, TicketPriority, TicketCategory, Team } from '../types';

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  team_logistics: 'Team logistics (tryouts, games, schedule)',
  team_issue: 'Team issue',
  general_question: 'General question',
  app_bug: 'App bug',
  feature_request: 'Feature request',
  billing: 'Billing',
  other: 'Other',
};
const STATUS_CHIP: Record<TicketStatus, string> = {
  open: 'bg-crimson-500/15 text-crimson-300 border-crimson-400/30',
  assigned: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  in_progress: 'bg-crimson-500/15 text-bone/85 border-crimson-400/30',
  resolved: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  closed: 'bg-charcoal-950 text-bone/50 border-white/10',
};
const PRIORITY_CHIP: Record<TicketPriority, string> = {
  low: 'bg-charcoal-950 text-bone/65 border-white/10',
  normal: 'bg-crimson-500/15 text-crimson-300 border-crimson-400/30',
  high: 'bg-rose-500/15 text-rose-300 border-rose-400/30',
};

async function notifyAdminsOfNewTicket(
  ticketId: string,
  subject: string,
  authorUid: string,
  authorName: string,
  category: TicketCategory,
  priority: TicketPriority,
) {
  try {
    const adminSnap = await getDocs(
      query(collection(db, 'users'), where('isClubAdmin', '==', true)),
    );
    const ids: string[] = [];
    adminSnap.forEach(d => { if (d.id !== authorUid) ids.push(d.id); });
    if (ids.length === 0) return;
    const tag = priority === 'high' ? '[HIGH] ' : '';
    await sendPushToUsers(ids, {
      title: `${tag}New support ticket`,
      body: `${authorName} · ${CATEGORY_LABEL[category]}: ${subject}`,
      url: `/helpdesk/${ticketId}`,
    }, { pushPrefKey: 'helpdesk' });
  } catch (err) {
    console.warn('helpdesk create push failed', err);
  }
}

function formatRel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const Helpdesk: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const [tickets, setTickets] = useState<HelpdeskTicket[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'mine'>('open');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [newOpen, setNewOpen] = useState(false);

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const isAdmin = !!(userData as any)?.isClubAdmin;

  // Admins get a team filter — pull this admin's CLUB's teams so
  // the chip list shows names. Non-admins don't need this query.
  // 2026-06-23 multi-tenant fix: was pulling EVERY team in the DB
  // across all clubs; now scoped to the admin's clubIds.
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const clubIds: string[] = Array.isArray((userData as any)?.clubIds)
          ? (userData as any).clubIds
          : (userData as any)?.clubId ? [(userData as any).clubId] : [];
        if (clubIds.length === 0) { setTeams([]); return; }
        const snap = await getDocs(query(
          collection(db, 'teams'),
          where('clubId', 'in', clubIds.slice(0, 30)),
        ));
        setTeams(snap.docs
          .map(d => ({ id: d.id, name: ((d.data() as any).name as string) || 'Team' }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) {
        console.warn('teams fetch failed', err);
      }
    })();
  }, [isAdmin, (userData as any)?.clubIds, (userData as any)?.clubId]);

  useEffect(() => {
    if (!userData?.uid) return;
    setLoading(true);
    // Admins see every ticket; everyone else sees their own.
    const q = isAdmin
      ? query(collection(db, 'helpdeskTickets'), orderBy('createdAt', 'desc'))
      : query(collection(db, 'helpdeskTickets'),
          where('createdBy', '==', userData.uid),
          orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, snap => {
      setTickets(snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as any),
        createdAt: (d.data() as any).createdAt?.toDate?.() || new Date(),
        updatedAt: (d.data() as any).updatedAt?.toDate?.(),
        resolvedAt: (d.data() as any).resolvedAt?.toDate?.(),
      })) as HelpdeskTicket[]);
      setLoading(false);
    }, () => { setLoading(false); });
    return () => unsub();
  }, [userData?.uid, isAdmin]);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      // Status pill
      if (statusFilter === 'mine' && t.createdBy !== userData?.uid) return false;
      if (statusFilter === 'open' && (t.status === 'resolved' || t.status === 'closed')) return false;
      // Team filter — 'unassigned' means the ticket has no teamId (general).
      if (teamFilter !== 'all') {
        if (teamFilter === 'unassigned') { if (t.teamId) return false; }
        else if (t.teamId !== teamFilter) return false;
      }
      return true;
    });
  }, [tickets, statusFilter, teamFilter, userData?.uid]);

  const counts = useMemo(() => ({
    all: tickets.length,
    open: tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed').length,
    mine: tickets.filter(t => t.createdBy === userData?.uid).length,
  }), [tickets, userData?.uid]);

  return (
    <div className="min-h-screen bg-charcoal-950">
      <Header
        title="Club Support"
        subtitle={isAdmin ? `${counts.open} open · ${counts.all} total` : 'Ask the club anything — logistics, issues, ideas'}
        action={
          <button
            onClick={() => setNewOpen(true)}
            aria-label="New ticket"
            className="w-9 h-9 rounded-full bg-gradient-to-br from-crimson-500 to-charcoal-600 text-white flex items-center justify-center shadow-lg shadow-crimson-500/30 hover:from-crimson-400 hover:to-crimson-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        }
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Filter pills (admin only) */}
        {isAdmin && (
          <div className="space-y-1.5">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {([
                { k: 'open' as const, label: `Open ${counts.open}` },
                { k: 'all' as const, label: `All ${counts.all}` },
                { k: 'mine' as const, label: `Mine ${counts.mine}` },
              ]).map(({ k, label }) => (
                <button
                  key={k}
                  onClick={() => setStatusFilter(k)}
                  className={`px-3 py-1 rounded-md text-[11px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                    statusFilter === k
                      ? 'bg-crimson-500/15 text-crimson-300 border-crimson-400/30'
                      : 'bg-charcoal-900 text-bone/50 border-white/10 hover:text-bone/90'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {teams.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                <button
                  onClick={() => setTeamFilter('all')}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                    teamFilter === 'all'
                      ? 'bg-charcoal-900 text-white border-slate-900'
                      : 'bg-charcoal-900 text-bone/50 border-white/10 hover:text-bone/90'
                  }`}
                >
                  All teams
                </button>
                <button
                  onClick={() => setTeamFilter('unassigned')}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                    teamFilter === 'unassigned'
                      ? 'bg-charcoal-900 text-white border-slate-900'
                      : 'bg-charcoal-900 text-bone/50 border-white/10 hover:text-bone/90'
                  }`}
                >
                  General
                </button>
                {teams.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTeamFilter(t.id)}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                      teamFilter === t.id
                        ? 'bg-charcoal-900 text-white border-slate-900'
                        : 'bg-charcoal-900 text-bone/50 border-white/10 hover:text-bone/90'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-crimson-400/30 border-t-cyan-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-charcoal-900 rounded-xl border border-white/10 p-8 text-center">
            <p className="text-bone/50 text-sm mb-1">No tickets {statusFilter === 'open' ? 'open' : 'yet'}.</p>
            <p className="text-[11px] text-bone/40">Tap + to ask a question or submit an issue.</p>
          </div>
        ) : (
          <ul className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm divide-y divide-white/5 overflow-hidden">
            {filtered.map(t => (
              <li key={t.id}>
                <Link to={`/helpdesk/${t.id}`} className="block px-3 py-3 hover:bg-white/[0.05] transition-colors">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-bone text-sm truncate">{t.subject}</div>
                      <div className="text-[11px] text-bone/50 mt-0.5">
                        {t.createdByName}{t.assignedToName ? ` · → ${t.assignedToName}` : ''} · {formatRel(new Date(t.createdAt))}
                      </div>
                    </div>
                    <span className={`text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border ${STATUS_CHIP[t.status]} flex-shrink-0`}>
                      {t.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-white/[0.04] text-bone/65 border-white/10">
                      {CATEGORY_LABEL[t.category]}
                    </span>
                    {isAdmin && (
                      <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-charcoal-900 text-bone/50 border-white/10">
                        {t.teamId ? (teams.find(x => x.id === t.teamId)?.name || 'Team') : 'General'}
                      </span>
                    )}
                    {t.priority === 'high' && (
                      <span className={`text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border ${PRIORITY_CHIP.high}`}>
                        High priority
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {newOpen && (
        <NewTicketModal
          clubId={(userData as any)?.clubId || 'club_unknown'}
          teamId={selectedTeamId || undefined}
          userUid={userData?.uid || ''}
          userName={userData?.name || 'Member'}
          userRole={isAdmin ? 'admin' : (userData?.role as any)}
          onClose={() => setNewOpen(false)}
          onCreated={() => setNewOpen(false)}
        />
      )}
    </div>
  );
};

// ---------- New ticket modal ----------
const NewTicketModal: React.FC<{
  clubId: string;
  teamId?: string;
  userUid: string;
  userName: string;
  userRole: any;
  onClose: () => void;
  onCreated: () => void;
}> = ({ clubId, teamId, userUid, userName, userRole, onClose, onCreated }) => {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TicketCategory>('team_logistics');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!subject.trim() || !description.trim()) { alert('Subject and description are required.'); return; }
    setBusy(true);
    try {
      const ref = await addDoc(collection(db, 'helpdeskTickets'), {
        clubId,
        teamId: teamId || null,
        createdBy: userUid,
        createdByName: userName,
        createdByRole: userRole,
        subject: subject.trim(),
        description: description.trim(),
        category,
        priority,
        status: 'open',
        createdAt: serverTimestamp(),
      });
      // Fan out a push to every club admin (minus the author) so a new
      // ticket doesn't sit unread until someone happens to open the app.
      void notifyAdminsOfNewTicket(ref.id, subject.trim(), userUid, userName, category, priority);
      onCreated();
    } catch (err) {
      console.error('ticket create failed', err);
      alert('Failed to submit — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-charcoal-900 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[92vh] sm:max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
          <div className="text-xs font-extrabold tracking-widest uppercase text-bone/65">New ticket</div>
          <button onClick={onClose} aria-label="Close" className="text-bone/40 hover:text-bone/85">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">Subject</label>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Short summary"
              className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">What's going on?</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Steps to reproduce, what you expected, etc."
              rows={4}
              className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value as any)}
                className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg bg-charcoal-900"
              >
                {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map(k => (
                  <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">Priority</label>
              <select
                value={priority}
                onChange={e => setPriority(e.target.value as any)}
                className="w-full px-3 py-2 text-sm border border-white/10 rounded-lg bg-charcoal-900"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <button
            onClick={submit}
            disabled={busy || !subject.trim() || !description.trim()}
            className="w-full text-xs font-extrabold tracking-widest uppercase px-3 py-2.5 rounded-lg bg-gradient-to-br from-crimson-500 to-charcoal-600 text-white shadow-md shadow-crimson-500/30 disabled:opacity-40"
          >
            {busy ? 'Submitting…' : 'Submit ticket'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Helpdesk;
