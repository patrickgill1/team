// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { listClubInbox, listMyTickets } from '../utils/tickets';
import NewTicketSheet from '../components/support/NewTicketSheet';
import { Button } from '../components/ui';
import type { SupportTicket as Ticket, SupportTicketStatus as TicketStatus } from '../types';

/**
 * Two stacked sections:
 *   - 'My tickets' (always shown): tickets the current user opened
 *   - 'Club inbox' (only when user is a club admin or coach of the
 *     selected team's club): tickets filed to that club by members
 *
 * Patrick chose 'both' in the scoping question: club admins need
 * their own inbox; the GoalKickr admin portal sees everything.
 */

const Tickets: React.FC = () => {
  const { userData, currentUser } = useAuth();
  const { selectedTeam } = useTeam();
  const uid = userData?.uid || currentUser?.uid;
  const clubId = (selectedTeam as any)?.clubId || null;

  const isClubAdminOrCoach = useMemo(() => {
    if (!userData) return false;
    if ((userData as any).isClubAdmin) return true;
    if ((userData as any).role === 'coach' || (userData as any).role === 'team_manager') return true;
    return false;
  }, [userData]);

  const [mine, setMine] = useState<Ticket[]>([]);
  const [inbox, setInbox] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [openNew, setOpenNew] = useState(false);
  const [forceScope, setForceScope] = useState<'club' | 'platform' | undefined>(undefined);
  // Surface query errors instead of silently rendering "0 tickets"
  // when a missing Firestore index or rules failure hides real data.
  // Patrick caught the silent-swallow on 2026-06-26: ticket created
  // fine in DB, page still showed empty.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!uid) { setLoading(false); return; }
      setLoading(true);
      setLoadError(null);
      try {
        const m = await listMyTickets(uid);
        let i: Ticket[] = [];
        if (isClubAdminOrCoach && clubId) {
          try {
            i = await listClubInbox(clubId);
          } catch (clubErr: any) {
            console.warn('club inbox query failed', clubErr);
          }
        }
        if (cancelled) return;
        setMine(m);
        setInbox(i);
      } catch (err: any) {
        if (cancelled) return;
        console.error('tickets load failed', err);
        const msg = String(err?.message || err);
        const friendly = /requires an index/i.test(msg)
          ? "We're missing a Firestore index for tickets. Tap 'Email GoalKickr support' below and we'll fix it fast."
          : "Couldn't load your tickets. Pull to refresh in a moment.";
        setLoadError(friendly);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, clubId, isClubAdminOrCoach, reloadKey]);

  const startNew = (scope?: 'club' | 'platform') => {
    setForceScope(scope);
    setOpenNew(true);
  };

  return (
    <div className="min-h-screen bg-charcoal-950 pb-20">
      <div className="max-w-3xl mx-auto px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Support</p>
            <h1 className="text-2xl font-black text-bone">Tickets</h1>
          </div>
          <Button variant="primary" onClick={() => startNew()}>New ticket</Button>
        </header>

        {loadError && (
          <div className="mb-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-rose-200 text-sm">
            {loadError}
          </div>
        )}

        <Section title="My tickets" empty="You haven't opened any tickets yet.">
          {loading ? <Loading /> : mine.map((t) => <TicketRow key={t.id} t={t} />)}
        </Section>

        {isClubAdminOrCoach && clubId && (
          <Section
            title="Club inbox"
            hint={`Tickets parents and coaches filed to ${(selectedTeam as any)?.clubName || 'your club'}.`}
            empty="Your club inbox is empty."
          >
            {loading ? <Loading /> : inbox.map((t) => <TicketRow key={t.id} t={t} />)}
          </Section>
        )}

        <p className="text-bone/45 text-xs mt-8 text-center">
          Need help fast? <button onClick={() => startNew('platform')} className="text-brand-primary hover:underline">Email GoalKickr support</button>
        </p>
      </div>
      <NewTicketSheet
        open={openNew}
        onClose={() => setOpenNew(false)}
        forceScope={forceScope}
        onCreated={() => setReloadKey(k => k + 1)}
      />
    </div>
  );
};

const Section: React.FC<{ title: string; hint?: string; empty: string; children: React.ReactNode }> = ({ title, hint, empty, children }) => {
  const arr = React.Children.toArray(children);
  return (
    <section className="mb-6">
      <div className="mb-2">
        <h2 className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55">{title}</h2>
        {hint && <p className="text-bone/45 text-xs mt-0.5">{hint}</p>}
      </div>
      {arr.length === 0 ? (
        <p className="bg-charcoal-900 border border-white/5 rounded-2xl px-4 py-6 text-bone/45 text-sm text-center">{empty}</p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
};

const TicketRow: React.FC<{ t: Ticket }> = ({ t }) => {
  const updatedAt: any = (t as any).updatedAt;
  const ms = updatedAt?.toDate?.()?.getTime?.() ?? (updatedAt instanceof Date ? updatedAt.getTime() : null);
  const when = ms ? fmtRelative(ms) : '';
  return (
    <li>
      <Link
        to={`/tickets/${t.id}`}
        className="block bg-charcoal-900 border border-white/5 hover:border-white/15 rounded-2xl p-3 transition-colors"
      >
        <div className="flex items-baseline gap-2">
          <StatusBadge status={t.status} />
          {t.scope === 'platform' && (
            <span className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">GoalKickr</span>
          )}
          <span className="text-bone font-bold text-sm truncate flex-1">{t.subject || '(no subject)'}</span>
          <span className="text-bone/45 text-xs whitespace-nowrap">{when}</span>
        </div>
        <p className="text-bone/55 text-xs mt-1 line-clamp-1">{(t as any).bodyPreview || ''}</p>
      </Link>
    </li>
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

const Loading: React.FC = () => (
  <p className="bg-charcoal-900 border border-white/5 rounded-2xl px-4 py-6 text-bone/45 text-sm text-center">Loading...</p>
);

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default Tickets;
