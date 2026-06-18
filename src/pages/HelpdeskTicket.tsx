// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  addDoc, collection, doc, getDocs, onSnapshot, query, serverTimestamp, updateDoc, where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { sendPushToUsers } from '../utils/notify';
import type { HelpdeskTicket, HelpdeskComment, TicketStatus } from '../types';

const STATUS_OPTIONS: TicketStatus[] = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];
const STATUS_CHIP: Record<TicketStatus, string> = {
  open: 'bg-crimson-50 text-crimson-700 border-crimson-200',
  assigned: 'bg-amber-50 text-amber-700 border-amber-200',
  in_progress: 'bg-crimson-50 text-charcoal-700 border-crimson-200',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
};

function formatRel(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function notifyReply(
  ticket: HelpdeskTicket,
  ticketId: string,
  authorUid: string,
  authorName: string,
  content: string,
) {
  try {
    const recipients = new Set<string>();
    if (ticket.createdBy) recipients.add(ticket.createdBy);
    if (ticket.assignedTo) recipients.add(ticket.assignedTo);
    // Loop in every club admin so triage isn't bottlenecked on one person.
    try {
      const adminSnap = await getDocs(
        query(collection(db, 'users'), where('isClubAdmin', '==', true)),
      );
      adminSnap.forEach(d => recipients.add(d.id));
    } catch { /* ignore */ }
    recipients.delete(authorUid);
    const ids = Array.from(recipients);
    if (ids.length === 0) return;
    const preview = content.length > 120 ? `${content.slice(0, 117)}…` : content;
    await sendPushToUsers(ids, {
      title: `Support: ${ticket.subject}`,
      body: `${authorName}: ${preview}`,
      url: `/helpdesk/${ticketId}`,
    }, { pushPrefKey: 'helpdesk' });
  } catch (err) {
    console.warn('helpdesk push failed', err);
  }
}

const HelpdeskTicketPage: React.FC = () => {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const { userData } = useAuth();

  const [ticket, setTicket] = useState<HelpdeskTicket | null>(null);
  const [comments, setComments] = useState<HelpdeskComment[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);
  const [admins, setAdmins] = useState<Array<{ id: string; name: string }>>([]);
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const isAdmin = !!(userData as any)?.isClubAdmin;

  // Pull the small list of club admins so an assignee picker can show
  // names instead of UIDs. Only needed for admins; parents don't see it.
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'users'), where('isClubAdmin', '==', true)),
        );
        setAdmins(snap.docs.map(d => ({
          id: d.id,
          name: ((d.data() as any).name as string) || 'Admin',
        })).sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) {
        console.warn('admin fetch failed', err);
      }
    })();
  }, [isAdmin]);

  useEffect(() => {
    if (!ticketId) return;
    const unsubT = onSnapshot(doc(db, 'helpdeskTickets', ticketId), snap => {
      if (!snap.exists()) { setTicket(null); return; }
      const data = snap.data() as any;
      setTicket({
        id: snap.id,
        ...data,
        createdAt: data.createdAt?.toDate?.() || new Date(),
        updatedAt: data.updatedAt?.toDate?.(),
        resolvedAt: data.resolvedAt?.toDate?.(),
      } as HelpdeskTicket);
    });
    // Sort client-side so we don't need a composite (ticketId + createdAt)
    // Firestore index — the orderBy on a filtered field requires one
    // and was silently failing the subscription.
    const unsubC = onSnapshot(
      query(collection(db, 'helpdeskComments'), where('ticketId', '==', ticketId)),
      snap => {
        const list = snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as any),
          createdAt: (d.data() as any).createdAt?.toDate?.() || new Date(),
        })) as HelpdeskComment[];
        list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        setComments(list);
      },
      (err) => { console.warn('comments subscribe failed', err); }
    );
    return () => { unsubT(); unsubC(); };
  }, [ticketId]);

  const post = async () => {
    const content = draft.trim();
    if (!content || !ticketId || !userData?.uid || !ticket) return;
    setBusy(true);
    try {
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: userData.uid,
        authorName: userData.name || 'Member',
        authorRole: isAdmin ? 'admin' : userData.role,
        content,
        createdAt: serverTimestamp(),
      });
      setDraft('');
      // Fan out a push to everyone tracking this ticket: creator,
      // assignee, and every club admin — minus whoever just typed.
      void notifyReply(ticket, ticketId, userData.uid, userData.name || 'Member', content);
    } catch (err) {
      console.error('comment post failed', err);
    } finally {
      setBusy(false);
    }
  };

  const assignTo = async (admin: { id: string; name: string } | null) => {
    if (!ticket || !ticketId || !userData?.uid) return;
    setAssigning(true);
    try {
      await updateDoc(doc(db, 'helpdeskTickets', ticketId), {
        assignedTo: admin?.id || null,
        assignedToName: admin?.name || null,
        updatedAt: serverTimestamp(),
        // Bump status to 'assigned' when assigning if it was still 'open'.
        ...(admin && ticket.status === 'open' ? { status: 'assigned' } : {}),
      });
      // Audit-log the reassignment as a system comment.
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: userData.uid,
        authorName: userData.name || 'Admin',
        authorRole: 'admin',
        content: admin
          ? `Assigned to ${admin.name}`
          : 'Unassigned',
        createdAt: serverTimestamp(),
      });
      // Notify the new assignee (skip if they're assigning to themselves).
      if (admin && admin.id !== userData.uid) {
        void sendPushToUsers([admin.id], {
          title: `Assigned to you: ${ticket.subject}`,
          body: `${userData.name || 'Admin'} assigned this ticket to you.`,
          url: `/helpdesk/${ticketId}`,
        }, { pushPrefKey: 'helpdesk' });
      }
      setShowAssignPicker(false);
    } catch (err) {
      console.error('assign failed', err);
      alert("Couldn't reassign — try again.");
    } finally {
      setAssigning(false);
    }
  };

  const changeStatus = async (next: TicketStatus) => {
    if (!ticket || !ticketId || !userData?.uid) return;
    if (next === ticket.status) return;
    setStatusChanging(true);
    try {
      await updateDoc(doc(db, 'helpdeskTickets', ticketId), {
        status: next,
        updatedAt: serverTimestamp(),
        ...(next === 'resolved' || next === 'closed' ? { resolvedAt: serverTimestamp() } : {}),
        ...(next === 'assigned' && !ticket.assignedTo ? {
          assignedTo: userData.uid,
          assignedToName: userData.name,
        } : {}),
      });
      // Drop a system comment so the thread shows the status change.
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: userData.uid,
        authorName: userData.name || 'Admin',
        authorRole: 'admin',
        content: `Status changed: ${ticket.status} → ${next}`,
        statusChange: { from: ticket.status, to: next },
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error('status change failed', err);
      alert("Couldn't update status. Are you a club admin?");
    } finally {
      setStatusChanging(false);
    }
  };

  if (!ticket) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-8">
        <Link to="/helpdesk" className="text-crimson-600 font-semibold text-sm">← Back to tickets</Link>
      </div>
    );
  }

  const canChangeStatus = isAdmin || ticket.createdBy === userData?.uid;

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Custom navy header so we can fit the back button + status pill */}
      <header className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 border-b border-crimson-500/10 px-4 sm:px-6 pt-4 pb-5">
        <div className="max-w-3xl mx-auto">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 text-slate-300 hover:text-white text-xs font-extrabold tracking-widest uppercase mb-3"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back
          </button>
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-2xl font-black text-white leading-tight">{ticket.subject}</h1>
            <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border ${STATUS_CHIP[ticket.status]} flex-shrink-0`}>
              {ticket.status.replace('_', ' ')}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {ticket.createdByName} · {formatRel(new Date(ticket.createdAt))}
            {ticket.assignedToName ? ` · assigned to ${ticket.assignedToName}` : ''}
          </p>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Description */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 mb-2">Description</div>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{ticket.description}</p>
        </div>

        {/* Assignee (admin only) */}
        {isAdmin && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500">Assigned to</div>
              <button
                onClick={() => setShowAssignPicker(s => !s)}
                disabled={assigning}
                className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-700 hover:text-crimson-900 disabled:opacity-50"
              >
                {showAssignPicker ? 'Cancel' : (ticket.assignedTo ? 'Change' : 'Assign')}
              </button>
            </div>
            <div className="text-sm text-slate-800">
              {ticket.assignedToName || <span className="italic text-slate-400">Unassigned</span>}
            </div>
            {showAssignPicker && (
              <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
                {admins.map(a => (
                  <button
                    key={a.id}
                    onClick={() => assignTo(a)}
                    disabled={assigning || a.id === ticket.assignedTo}
                    className={`w-full text-left text-sm px-2 py-1.5 rounded-md ${
                      a.id === ticket.assignedTo
                        ? 'bg-slate-100 text-slate-400 cursor-default'
                        : 'hover:bg-crimson-50 text-slate-800'
                    } disabled:opacity-60`}
                  >
                    {a.name}{a.id === userData?.uid ? ' (me)' : ''}
                  </button>
                ))}
                {ticket.assignedTo && (
                  <button
                    onClick={() => assignTo(null)}
                    disabled={assigning}
                    className="w-full text-left text-sm px-2 py-1.5 rounded-md hover:bg-rose-50 text-rose-700 disabled:opacity-60"
                  >
                    Unassign
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Status changer (admin or creator) */}
        {canChangeStatus && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
            <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-2">Change status</div>
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map(s => (
                <button
                  key={s}
                  disabled={statusChanging || s === ticket.status}
                  onClick={() => changeStatus(s)}
                  className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded-md border ${
                    s === ticket.status
                      ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-default'
                      : `${STATUS_CHIP[s]} hover:opacity-80`
                  } disabled:opacity-50`}
                >
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 mb-2">
            Replies <span className="text-slate-400 font-bold">{comments.length}</span>
          </div>
          {comments.length === 0 ? (
            <p className="text-sm text-slate-500 mb-3">No replies yet.</p>
          ) : (
            <ul className="space-y-2 mb-3">
              {comments.map(c => (
                <li key={c.id} className={`rounded-lg p-2.5 ${c.statusChange ? 'bg-slate-50 border border-slate-200' : 'bg-white border border-slate-100'}`}>
                  <div className="text-[11px] text-slate-500 mb-1">
                    <span className="font-semibold text-slate-700">{c.authorName}</span>
                    {c.authorRole === 'admin' && (
                      <span className="ml-1.5 text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">Admin</span>
                    )}
                    <span className="ml-1.5">{formatRel(c.createdAt)}</span>
                  </div>
                  <div className="text-sm text-slate-800 whitespace-pre-wrap">{c.content}</div>
                </li>
              ))}
            </ul>
          )}

          {userData?.uid ? (
            <div className="flex gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
                }}
                rows={2}
                placeholder="Add a reply…"
                className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg resize-none"
              />
              <button
                onClick={post}
                disabled={!draft.trim() || busy}
                className="px-3 rounded-lg bg-crimson-600 text-white text-sm font-bold disabled:opacity-50"
              >Send</button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Sign in to reply.</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default HelpdeskTicketPage;
