// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getTicket, replyToTicket, setTicketStatus } from '../utils/tickets';
import type { SupportTicket as Ticket, SupportTicketMessage as TicketMessage, SupportTicketStatus as TicketStatus } from '../types';

/**
 * Single-ticket view as a CHAT THREAD.
 *
 * Redesign 2026-07-08 per Patrick: "make it look more like a chat
 * style system." The prior implementation stacked every message as
 * a full-width bordered card, which read as a helpdesk form log —
 * fine for a legal audit, cold for a support conversation.
 *
 * Layout:
 *   - Sticky top header: back button, subject, status pill
 *   - Message list (chat-shape):
 *       own messages   → right-aligned, brand-primary bubble
 *       admin replies  → left-aligned, amber ring + "GoalKickr" badge
 *       others         → left-aligned, surface-elevated bubble
 *       author name shown above first bubble in each sender run
 *       timestamps shown as a centered pill between messages if
 *       there's a >30min gap
 *   - Sticky bottom composer: textarea + send button, safe-area
 *     padding-bottom for the home indicator + iOS keyboard.
 *   - Status flip (resolve / reopen) lives as a subtle text button
 *     in the composer area to keep the message stream uncluttered.
 *
 * Author + reply-permission logic and the underlying
 * SupportTicket.recentMessages array are unchanged. This is a UI
 * rewrite only — no schema, rules, or worker work.
 */

const TicketDetail: React.FC = () => {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const { userData, currentUser } = useAuth();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ticketId) return;
      const t = await getTicket(ticketId).catch(() => null);
      if (cancelled) return;
      setTicket(t);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ticketId]);

  const uid = userData?.uid || currentUser?.uid;

  const canRespond = ticket && uid && (
    ticket.authorUid === uid
    || (userData as any)?.isClubAdmin
    || (userData as any)?.role === 'coach'
    || (userData as any)?.role === 'team_manager'
  );

  // Scroll to newest message on mount and after every send. iMessage
  // pattern — the conversation should always be pinned at the bottom
  // like you're reading forward, not archaeology.
  const messages: TicketMessage[] = useMemo(
    () => (Array.isArray((ticket as any)?.recentMessages) ? (ticket as any).recentMessages : []),
    [ticket]
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // rAF because the DOM has to have painted the new bubbles first.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  const handleReply = async () => {
    if (!ticket || !reply.trim() || busy) return;
    const trimmed = reply.trim();
    setBusy(true); setError(null);
    // Optimistic clear so the composer feels snappy — the reload
    // below refreshes the ticket state which will surface the new
    // message from the source of truth.
    setReply('');
    try {
      await replyToTicket({
        ticketId: ticket.id,
        authorUid: uid,
        authorName: userData?.name || 'Member',
        authorEmail: userData?.email || currentUser?.email || '',
        body: trimmed,
        setStatus: ticket.status === 'closed' ? 'open' : undefined,
      });
      const t = await getTicket(ticket.id);
      setTicket(t);
    } catch (e: any) {
      setError(e?.message || 'Could not send reply.');
      // Restore text on failure so the user doesn't lose what they
      // wrote.
      setReply(trimmed);
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (s: TicketStatus) => {
    if (!ticket || !uid) return;
    setBusy(true); setError(null);
    try {
      await setTicketStatus(ticket.id, s, uid);
      const t = await getTicket(ticket.id);
      setTicket(t);
    } catch (e: any) {
      setError(e?.message || 'Could not change status.');
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Enter sends. Shift-Enter adds a line break. Same iMessage
    // convention. On mobile the composer is a soft-keyboard target
    // so this behavior is honored by the on-screen return key too.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleReply();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <p className="text-ink-primary/45">Loading...</p>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="min-h-screen bg-surface-base px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
        <Link to="/tickets" className="text-ink-primary/55 text-xs">Back to tickets</Link>
        <p className="mt-6 text-ink-primary/65 text-sm">This ticket no longer exists or you don't have access to it.</p>
      </div>
    );
  }

  const resolved = ticket.status === 'resolved' || ticket.status === 'closed';

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
                <StatusBadge status={ticket.status} />
                {ticket.scope === 'platform' && (
                  <span className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">GoalKickr</span>
                )}
              </div>
              <h1 className="text-base font-black text-ink-primary leading-tight truncate">{ticket.subject}</h1>
              <p className="text-ink-primary/45 text-[11px] mt-0.5 truncate">
                Opened by {ticket.authorName || ticket.authorEmail}
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* ── Messages ──────────────────────────────────────────── */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-3 py-4 space-y-1">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const isOwn = !!uid && m.authorUid === uid;
            const isAdmin = m.source === 'admin';
            // "Group" consecutive messages from the same sender —
            // hide the author label when the previous message was
            // from the same person, unless there's a big time gap.
            const sameSender = prev && prev.authorUid === m.authorUid;
            const timeGap = prev ? Math.abs(msOf(m) - msOf(prev)) : Infinity;
            const showTimeSep = timeGap > 30 * 60 * 1000; // 30 min
            const showAuthor = !sameSender || showTimeSep;
            return (
              <React.Fragment key={m.id || i}>
                {showTimeSep && (
                  <div className="flex justify-center py-3">
                    <span className="text-[10px] font-black tracking-widest uppercase text-ink-primary/35">
                      {fmtTimeSep(m)}
                    </span>
                  </div>
                )}
                <Bubble
                  message={m}
                  isOwn={isOwn}
                  isAdmin={isAdmin}
                  showAuthor={showAuthor}
                />
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
        <div className="max-w-3xl mx-auto px-3 pt-3">
          {error && (
            <p className="mb-2 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg px-2 py-1.5">{error}</p>
          )}
          {canRespond ? (
            <>
              <div className="flex items-end gap-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  placeholder={resolved ? 'Reopen with a reply…' : 'Message…'}
                  className="flex-1 min-w-0 max-h-32 bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl px-4 py-2.5 text-ink-primary placeholder:text-ink-primary/35 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 resize-none text-[15px]"
                />
                <button
                  type="button"
                  onClick={handleReply}
                  disabled={busy || !reply.trim()}
                  className="flex-shrink-0 h-10 w-10 rounded-full bg-brand-primary text-white flex items-center justify-center shadow-lg active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Send"
                >
                  <svg className="w-5 h-5 -translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3.4 20.4l17.45-8.4a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.15L4.5 11.5H12v1H4.5L2 19.25a1 1 0 001.4 1.15z" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center justify-end gap-3 mt-2 -mb-0.5">
                {ticket.status !== 'resolved' && ticket.status !== 'closed' && (
                  <button
                    type="button"
                    onClick={() => handleStatus('resolved')}
                    disabled={busy}
                    className="text-[11px] font-bold text-ink-primary/45 hover:text-ink-primary transition"
                  >
                    Mark resolved
                  </button>
                )}
                {(ticket.status === 'resolved' || ticket.status === 'closed') && (
                  <button
                    type="button"
                    onClick={() => handleStatus('open')}
                    disabled={busy}
                    className="text-[11px] font-bold text-ink-primary/45 hover:text-ink-primary transition"
                  >
                    Reopen
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="text-ink-primary/45 text-xs italic text-center py-3">You can't reply to this ticket.</p>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Bubble ─────────────────────────────────────────────────────
const Bubble: React.FC<{
  message: TicketMessage;
  isOwn: boolean;
  isAdmin: boolean;
  showAuthor: boolean;
}> = ({ message, isOwn, isAdmin, showAuthor }) => {
  const sideClasses = isOwn ? 'items-end' : 'items-start';
  const bubbleClasses = isOwn
    ? 'bg-brand-primary text-white rounded-2xl rounded-br-md'
    : isAdmin
      ? 'bg-amber-500/10 text-ink-primary ring-1 ring-amber-400/40 rounded-2xl rounded-bl-md'
      : 'bg-surface-elevated text-ink-primary ring-1 ring-line-default/10 rounded-2xl rounded-bl-md';
  return (
    <div className={`flex flex-col ${sideClasses}`}>
      {showAuthor && (
        <div className={`flex items-center gap-1.5 mb-1 px-1 ${isOwn ? 'flex-row-reverse' : ''}`}>
          <p className="text-[11px] font-bold text-ink-primary/70">
            {message.authorName || message.authorEmail || 'Unknown'}
          </p>
          {isAdmin && (
            <span className="text-[9px] font-black tracking-widest uppercase text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
              GoalKickr
            </span>
          )}
        </div>
      )}
      <div className={`max-w-[85%] sm:max-w-[75%] px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words ${bubbleClasses}`}>
        {message.body}
      </div>
      <p className={`text-[10px] text-ink-primary/35 mt-1 px-1 ${isOwn ? '' : ''}`}>
        {fmtTime(message.sentAt)}
      </p>
    </div>
  );
};

// ── Status pill ────────────────────────────────────────────────
const StatusBadge: React.FC<{ status: TicketStatus }> = ({ status }) => {
  const styles: Record<TicketStatus, string> = {
    open:      'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    pending:   'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
    resolved:  'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
    closed:    'bg-surface-raised text-ink-primary/55 ring-1 ring-line-default/10',
  };
  return (
    <span className={`text-[10px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded ${styles[status]}`}>
      {status}
    </span>
  );
};

// ── Formatters ─────────────────────────────────────────────────
function msOf(t: any): number {
  const ms = t?.sentAt?.toDate?.()?.getTime?.()
    ?? (t?.sentAt instanceof Date ? t.sentAt.getTime() : null)
    ?? (typeof t?.sentAt === 'string' ? Date.parse(t.sentAt) : null);
  return typeof ms === 'number' ? ms : 0;
}

function fmtTime(t: any): string {
  const ms = t?.toDate?.()?.getTime?.() ?? (t instanceof Date ? t.getTime() : (typeof t === 'string' ? Date.parse(t) : null));
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtTimeSep(m: any): string {
  const ms = msOf(m);
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (wasYesterday) return `Yesterday ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default TicketDetail;
