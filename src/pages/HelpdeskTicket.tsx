// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  addDoc, collection, doc, getDocs, onSnapshot, query, serverTimestamp, updateDoc, where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { sendPushToUsers } from '../utils/notify';
import type { HelpdeskTicket, HelpdeskComment, TicketStatus } from '../types';

/**
 * Helpdesk ticket viewer as a CHAT THREAD.
 *
 * Redesign 2026-07-08 (same session as TicketDetail 3.9.118).
 * Preserves everything HelpdeskTicket does that SupportTicket
 * doesn't:
 *   - helpdeskComments subcollection (unbounded, live updates)
 *   - Status changes as SYSTEM comments (centered pill in stream)
 *   - Assignee picker (admin only)
 *   - 5-state status flow (open / assigned / in_progress /
 *     resolved / closed) via a discreet dropdown near the composer
 *
 * Visual pattern mirrors TicketDetail.tsx:
 *   - Sticky top header with back button, subject, status
 *   - Bubbles: own right, others left, admin ring
 *   - System comments (statusChange or "Assigned to X") render as
 *     centered pill "chip" rows, not bubbles.
 *   - Sticky bottom composer with pill textarea + circular send.
 *   - Assignee + status control chips tuck into a row above the
 *     composer so the stream stays clean.
 */

const STATUS_OPTIONS: TicketStatus[] = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];
const STATUS_CHIP: Record<TicketStatus, string> = {
  open: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  assigned: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  in_progress: 'bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30',
  resolved: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
  closed: 'bg-surface-raised text-ink-primary/55 ring-1 ring-line-default/10',
};

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
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const isAdmin = !!(userData as any)?.isClubAdmin;
  const uid = userData?.uid;
  const canChangeStatus = isAdmin || ticket?.createdBy === uid;

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

  // Auto-scroll to newest message on load + after every add.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [comments.length, ticket?.id]);

  // Compose an ordered "stream" — the ticket's own description
  // renders as the first bubble (from ticket.createdBy), then all
  // real user comments in chronological order. Status/assignment
  // system comments render as centered pills, not bubbles.
  const stream = useMemo(() => {
    if (!ticket) return [] as Array<any>;
    const out: Array<any> = [];
    if (ticket.description) {
      out.push({
        kind: 'bubble' as const,
        id: `ticket-body`,
        authorId: ticket.createdBy,
        authorName: ticket.createdByName || 'Reporter',
        authorRole: 'reporter',
        content: ticket.description,
        createdAt: ticket.createdAt,
      });
    }
    for (const c of comments) {
      if ((c as any).statusChange) {
        out.push({
          kind: 'system' as const,
          id: c.id,
          content: c.content,
          createdAt: c.createdAt,
        });
      } else if (
        typeof c.content === 'string'
        && (c.content.startsWith('Assigned to ') || c.content === 'Unassigned')
      ) {
        // Assignment audits — render as system pill too.
        out.push({
          kind: 'system' as const,
          id: c.id,
          content: c.content,
          createdAt: c.createdAt,
        });
      } else {
        out.push({
          kind: 'bubble' as const,
          id: c.id,
          authorId: (c as any).authorId,
          authorName: c.authorName,
          authorRole: (c as any).authorRole,
          content: c.content,
          createdAt: c.createdAt,
        });
      }
    }
    return out;
  }, [ticket, comments]);

  const post = async () => {
    const content = draft.trim();
    if (!content || !ticketId || !uid || !ticket) return;
    setBusy(true);
    setDraft('');
    try {
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: uid,
        authorName: userData?.name || 'Member',
        authorRole: isAdmin ? 'admin' : userData?.role,
        content,
        notify: true,
        createdAt: serverTimestamp(),
      });
      void notifyReply(ticket, ticketId, uid, userData?.name || 'Member', content);
    } catch (err) {
      console.error('comment post failed', err);
      setDraft(content);
    } finally {
      setBusy(false);
    }
  };

  const assignTo = async (admin: { id: string; name: string } | null) => {
    if (!ticket || !ticketId || !uid) return;
    setAssigning(true);
    try {
      await updateDoc(doc(db, 'helpdeskTickets', ticketId), {
        assignedTo: admin?.id || null,
        assignedToName: admin?.name || null,
        updatedAt: serverTimestamp(),
        ...(admin && ticket.status === 'open' ? { status: 'assigned' } : {}),
      });
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: uid,
        authorName: userData?.name || 'Admin',
        authorRole: 'admin',
        content: admin ? `Assigned to ${admin.name}` : 'Unassigned',
        createdAt: serverTimestamp(),
      });
      if (admin && admin.id !== uid) {
        void sendPushToUsers([admin.id], {
          title: `Assigned to you: ${ticket.subject}`,
          body: `${userData?.name || 'Admin'} assigned this ticket to you.`,
          url: `/helpdesk/${ticketId}`,
        }, { pushPrefKey: 'helpdesk' });
      }
      setAssignOpen(false);
    } catch (err) {
      console.error('assign failed', err);
    } finally {
      setAssigning(false);
    }
  };

  const changeStatus = async (next: TicketStatus) => {
    if (!ticket || !ticketId || !uid) return;
    if (next === ticket.status) return;
    setStatusChanging(true);
    try {
      await updateDoc(doc(db, 'helpdeskTickets', ticketId), {
        status: next,
        updatedAt: serverTimestamp(),
        ...(next === 'resolved' || next === 'closed' ? { resolvedAt: serverTimestamp() } : {}),
        ...(next === 'assigned' && !ticket.assignedTo ? {
          assignedTo: uid,
          assignedToName: userData?.name,
        } : {}),
      });
      await addDoc(collection(db, 'helpdeskComments'), {
        ticketId,
        authorId: uid,
        authorName: userData?.name || 'Admin',
        authorRole: 'admin',
        content: `Status changed: ${ticket.status} → ${next}`,
        statusChange: { from: ticket.status, to: next },
        createdAt: serverTimestamp(),
      });
      setStatusOpen(false);
    } catch (err) {
      console.error('status change failed', err);
    } finally {
      setStatusChanging(false);
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      post();
    }
  };

  if (!ticket) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center p-8">
        <Link to="/tickets" className="text-brand-primary font-semibold text-sm">Back to tickets</Link>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-surface-base">
      {/* ── Header ────────────────────────────────────────────── */}
      <header
        className="flex-shrink-0 border-b border-line-default/10 bg-surface-base/95 backdrop-blur-md"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <div className="max-w-3xl mx-auto px-3 pb-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/tickets')}
              className="flex-shrink-0 -ml-1 p-2 rounded-full text-ink-primary/70 hover:text-ink-primary hover:bg-surface-elevated transition"
              aria-label="Back"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-[10px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded ${STATUS_CHIP[ticket.status]}`}>
                  {ticket.status.replace('_', ' ')}
                </span>
                {ticket.assignedToName && (
                  <span className="text-[10px] font-black tracking-widest uppercase text-ink-primary/50 truncate">
                    · {ticket.assignedToName}
                  </span>
                )}
              </div>
              <h1 className="text-base font-black text-ink-primary leading-tight truncate">{ticket.subject}</h1>
              <p className="text-ink-primary/45 text-[11px] mt-0.5 truncate">
                Opened by {ticket.createdByName || 'Member'}
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* ── Stream ────────────────────────────────────────────── */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-3 py-4 space-y-1">
          {stream.map((row, i) => {
            const prev = stream[i - 1];
            if (row.kind === 'system') {
              return (
                <div key={row.id} className="flex justify-center py-2">
                  <span className="text-[10px] font-black tracking-widest uppercase text-ink-primary/45 bg-surface-elevated/60 ring-1 ring-line-default/10 px-2.5 py-1 rounded-full">
                    {row.content}
                  </span>
                </div>
              );
            }
            const isOwn = !!uid && row.authorId === uid;
            const isAdminRow = row.authorRole === 'admin';
            const sameSender = prev?.kind === 'bubble' && prev.authorId === row.authorId;
            const timeGap = prev ? Math.abs(msOf(row.createdAt) - msOf(prev.createdAt)) : Infinity;
            const showTimeSep = timeGap > 30 * 60 * 1000;
            const showAuthor = !sameSender || showTimeSep;
            return (
              <React.Fragment key={row.id}>
                {showTimeSep && (
                  <div className="flex justify-center py-3">
                    <span className="text-[10px] font-black tracking-widest uppercase text-ink-primary/35">
                      {fmtTimeSep(row.createdAt)}
                    </span>
                  </div>
                )}
                <Bubble row={row} isOwn={isOwn} isAdminRow={isAdminRow} showAuthor={showAuthor} />
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ── Composer ──────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 border-t border-line-default/10 bg-surface-base/95 backdrop-blur-md"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <div className="max-w-3xl mx-auto px-3 pt-2.5">
          {/* Admin control row — status + assign — sits above the
              composer so the stream stays clean. Hidden for anyone
              who can't change status. */}
          {canChangeStatus && (
            <div className="flex items-center gap-2 mb-2 relative">
              <button
                type="button"
                onClick={() => { setStatusOpen(o => !o); setAssignOpen(false); }}
                className="text-[10px] font-black tracking-widest uppercase px-2 py-1 rounded-full bg-surface-elevated ring-1 ring-line-default/10 text-ink-primary/75 hover:text-ink-primary transition"
              >
                Change status
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { setAssignOpen(o => !o); setStatusOpen(false); }}
                  className="text-[10px] font-black tracking-widest uppercase px-2 py-1 rounded-full bg-surface-elevated ring-1 ring-line-default/10 text-ink-primary/75 hover:text-ink-primary transition"
                >
                  {ticket.assignedToName ? 'Reassign' : 'Assign'}
                </button>
              )}
              {statusOpen && (
                <div className="absolute bottom-full mb-2 left-0 bg-surface-elevated ring-1 ring-line-default/10 rounded-xl shadow-2xl p-1 z-20 min-w-[160px]">
                  {STATUS_OPTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => changeStatus(s)}
                      disabled={statusChanging || s === ticket.status}
                      className={`w-full text-left text-[11px] font-bold tracking-wider uppercase px-2 py-1.5 rounded-lg ${
                        s === ticket.status
                          ? 'text-ink-primary/35'
                          : 'text-ink-primary/85 hover:bg-line-default/[0.06]'
                      } disabled:opacity-60`}
                    >
                      {s.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              )}
              {assignOpen && isAdmin && (
                <div className="absolute bottom-full mb-2 left-24 bg-surface-elevated ring-1 ring-line-default/10 rounded-xl shadow-2xl p-1 z-20 min-w-[180px] max-h-64 overflow-y-auto">
                  {admins.map(a => (
                    <button
                      key={a.id}
                      onClick={() => assignTo(a)}
                      disabled={assigning || a.id === ticket.assignedTo}
                      className={`w-full text-left text-[11px] font-bold px-2 py-1.5 rounded-lg ${
                        a.id === ticket.assignedTo
                          ? 'text-ink-primary/35'
                          : 'text-ink-primary/85 hover:bg-line-default/[0.06]'
                      } disabled:opacity-60`}
                    >
                      {a.name}{a.id === uid ? ' (me)' : ''}
                    </button>
                  ))}
                  {ticket.assignedTo && (
                    <button
                      onClick={() => assignTo(null)}
                      disabled={assigning}
                      className="w-full text-left text-[11px] font-bold px-2 py-1.5 rounded-lg text-rose-400 hover:bg-rose-500/10 disabled:opacity-60"
                    >
                      Unassign
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {uid ? (
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Message…"
                className="flex-1 min-w-0 max-h-32 bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl px-4 py-2.5 text-ink-primary placeholder:text-ink-primary/35 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 resize-none text-[15px]"
              />
              <button
                type="button"
                onClick={post}
                disabled={busy || !draft.trim()}
                className="flex-shrink-0 h-10 w-10 rounded-full bg-brand-primary text-white flex items-center justify-center shadow-lg active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <svg className="w-5 h-5 -translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3.4 20.4l17.45-8.4a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.15L4.5 11.5H12v1H4.5L2 19.25a1 1 0 001.4 1.15z" />
                </svg>
              </button>
            </div>
          ) : (
            <p className="text-ink-primary/45 text-xs italic text-center py-3">Sign in to reply.</p>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Bubble ─────────────────────────────────────────────────────
const Bubble: React.FC<{
  row: any;
  isOwn: boolean;
  isAdminRow: boolean;
  showAuthor: boolean;
}> = ({ row, isOwn, isAdminRow, showAuthor }) => {
  const sideClasses = isOwn ? 'items-end' : 'items-start';
  const bubbleClasses = isOwn
    ? 'bg-brand-primary text-white rounded-2xl rounded-br-md'
    : isAdminRow
      ? 'bg-amber-500/10 text-ink-primary ring-1 ring-amber-400/40 rounded-2xl rounded-bl-md'
      : 'bg-surface-elevated text-ink-primary ring-1 ring-line-default/10 rounded-2xl rounded-bl-md';
  return (
    <div className={`flex flex-col ${sideClasses}`}>
      {showAuthor && (
        <div className={`flex items-center gap-1.5 mb-1 px-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
          <p className="text-[11px] font-bold text-ink-primary/70">{row.authorName || 'Unknown'}</p>
          {isAdminRow && (
            <span className="text-[9px] font-black tracking-widest uppercase text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
              GoalKickr
            </span>
          )}
        </div>
      )}
      <div className={`max-w-[85%] sm:max-w-[75%] px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words ${bubbleClasses}`}>
        {row.content}
      </div>
      <p className="text-[10px] text-ink-primary/35 mt-1 px-1">{fmtTime(row.createdAt)}</p>
    </div>
  );
};

// ── Formatters ─────────────────────────────────────────────────
function msOf(d: any): number {
  if (!d) return 0;
  if (d instanceof Date) return d.getTime();
  if (typeof d?.toDate === 'function') return d.toDate().getTime();
  if (typeof d === 'string') return Date.parse(d) || 0;
  return 0;
}

function fmtTime(d: any): string {
  const ms = msOf(d);
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtTimeSep(d: any): string {
  const ms = msOf(d);
  if (!ms) return '';
  const dt = new Date(ms);
  const now = new Date();
  const sameDay = dt.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday = dt.toDateString() === yesterday.toDateString();
  if (sameDay) return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (wasYesterday) return `Yesterday ${dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default HelpdeskTicketPage;
