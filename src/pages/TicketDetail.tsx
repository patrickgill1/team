// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getTicket, replyToTicket, setTicketStatus } from '../utils/tickets';
import { Button } from '../components/ui';
import type { SupportTicket as Ticket, SupportTicketMessage as TicketMessage, SupportTicketStatus as TicketStatus } from '../types';

/** Single-ticket view. Shows messages newest-at-bottom; author and
 *  responders can post replies; club admin/coach can change status. */
const TicketDetail: React.FC = () => {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const { userData, currentUser } = useAuth();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleReply = async () => {
    if (!ticket || !reply.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await replyToTicket({
        ticketId: ticket.id,
        authorUid: uid,
        authorName: userData?.name || 'Member',
        authorEmail: userData?.email || currentUser?.email || '',
        body: reply,
        setStatus: ticket.status === 'closed' ? 'open' : undefined,
      });
      const t = await getTicket(ticket.id);
      setTicket(t);
      setReply('');
    } catch (e: any) {
      setError(e?.message || 'Could not send reply.');
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

  if (loading) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex items-center justify-center">
        <p className="text-bone/45">Loading...</p>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="min-h-screen bg-charcoal-950 px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
        <Link to="/tickets" className="text-bone/55 text-xs">← Back to tickets</Link>
        <p className="mt-6 text-bone/65 text-sm">This ticket no longer exists or you don't have access to it.</p>
      </div>
    );
  }

  const messages: TicketMessage[] = Array.isArray((ticket as any).recentMessages) ? (ticket as any).recentMessages : [];

  return (
    <div className="min-h-screen bg-charcoal-950 pb-32">
      <div className="max-w-3xl mx-auto px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
        <Link to="/tickets" className="text-bone/55 hover:text-bone text-xs mb-3 inline-block">← Back to tickets</Link>
        <header className="mb-5">
          <div className="flex items-baseline gap-2 mb-1">
            <StatusBadge status={ticket.status} />
            {ticket.scope === 'platform' && (
              <span className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">GoalKickr</span>
            )}
          </div>
          <h1 className="text-xl font-black text-bone leading-tight">{ticket.subject}</h1>
          <p className="text-bone/45 text-xs mt-1">
            Opened by {ticket.authorName || ticket.authorEmail}
          </p>
        </header>

        <ul className="space-y-3 mb-5">
          {messages.map((m, i) => (
            <li key={m.id || i} className="bg-charcoal-900 border border-white/5 rounded-2xl p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <p className="text-bone text-xs font-bold">
                  {m.authorName || m.authorEmail || 'Unknown'}
                  {m.source === 'admin' && (
                    <span className="ml-2 text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">GoalKickr</span>
                  )}
                </p>
                <p className="text-bone/35 text-[10px]">{fmtTime((m as any).sentAt)}</p>
              </div>
              <p className="text-bone/85 text-sm whitespace-pre-wrap break-words">{m.body}</p>
            </li>
          ))}
        </ul>

        {error && (
          <p className="mb-3 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{error}</p>
        )}

        {canRespond ? (
          <>
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={4}
              placeholder="Type a reply..."
              className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30 focus:outline-none focus:border-brand-primary resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <Button variant="primary" onClick={handleReply} disabled={busy || !reply.trim()}>
                {busy ? 'Sending...' : 'Send reply'}
              </Button>
              {ticket.status !== 'resolved' && (
                <button
                  type="button"
                  onClick={() => handleStatus('resolved')}
                  disabled={busy}
                  className="text-xs text-bone/55 hover:text-bone font-bold px-2 py-1 rounded"
                >
                  Mark resolved
                </button>
              )}
              {ticket.status === 'resolved' && (
                <button
                  type="button"
                  onClick={() => handleStatus('open')}
                  disabled={busy}
                  className="text-xs text-bone/55 hover:text-bone font-bold px-2 py-1 rounded"
                >
                  Reopen
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="text-bone/45 text-xs italic">You can't reply to this ticket.</p>
        )}
      </div>
    </div>
  );
};

const StatusBadge: React.FC<{ status: TicketStatus }> = ({ status }) => {
  const styles: Record<TicketStatus, string> = {
    open:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    pending:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
    resolved:  'bg-sky-500/15 text-sky-300 border-sky-500/30',
    closed:    'bg-charcoal-700 text-bone/55 border-white/10',
  };
  return (
    <span className={`text-[10px] font-black tracking-widest uppercase px-1.5 py-0.5 rounded border ${styles[status]}`}>
      {status}
    </span>
  );
};

function fmtTime(t: any): string {
  const ms = t?.toDate?.()?.getTime?.() ?? (t instanceof Date ? t.getTime() : (typeof t === 'string' ? Date.parse(t) : null));
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default TicketDetail;
