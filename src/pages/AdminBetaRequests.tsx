// AdminBetaRequests — platform-admin-only queue of Android beta
// tester requests.
//
// Purpose: coaches submit parent emails for the Play Store closed-
// testing allowlist (via the "Fast-track this parent" affordance
// on InviteShareModal). This page shows every pending request in
// one place with a "Copy all pending emails" button, so the admin
// batch-pastes into Play Console once a day or so instead of
// getting dripped individual texts.
//
// Vestigial once the Play listing exits closed testing and
// PLAY_STORE_LIVE flips true — the submit affordance auto-hides
// on the same flag, so no new requests come in and the queue
// drains. Leaving the page around costs nothing.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { debugWarn } from '../utils/debug';
import { toMillis, relativeTime } from '../utils/timestamps';
import type { BetaRequest } from '../types';

const AdminBetaRequests: React.FC = () => {
  const { userData } = useAuth();
  const isAdmin = !!userData && (userData as any).isClubAdmin === true;
  const [requests, setRequests] = useState<BetaRequest[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'added' | 'declined' | 'all'>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  useEffect(() => {
    if (!isAdmin) { setRequests([]); return; }
    const q = statusFilter === 'all'
      ? query(collection(db, 'beta_requests'), orderBy('requestedAt', 'desc'))
      : query(
        collection(db, 'beta_requests'),
        where('status', '==', statusFilter),
        orderBy('requestedAt', 'desc'),
      );
    const unsub = onSnapshot(q, (snap) => {
      const rows: BetaRequest[] = snap.docs.map(d => {
        const data: any = d.data();
        return {
          id: d.id,
          email: data.email || '',
          playerId: data.playerId || undefined,
          playerName: data.playerName || undefined,
          teamId: data.teamId || undefined,
          teamName: data.teamName || undefined,
          requestedByUid: data.requestedByUid || '',
          requestedByName: data.requestedByName || 'Coach',
          requestedAt: data.requestedAt?.toDate?.() || new Date(data.requestedAt || Date.now()),
          status: data.status || 'pending',
          addedAt: data.addedAt?.toDate?.() || undefined,
          addedByUid: data.addedByUid || undefined,
          note: data.note || undefined,
        };
      });
      setRequests(rows);
    }, (err) => {
      debugWarn('[beta-requests] subscribe failed', err);
      setRequests([]);
    });
    return () => unsub();
  }, [isAdmin, statusFilter]);

  const pendingEmails = useMemo(() => {
    if (!requests) return '';
    return requests
      .filter(r => r.status === 'pending')
      .map(r => r.email.trim().toLowerCase())
      .filter((e, i, arr) => e && arr.indexOf(e) === i)
      .join('\n');
  }, [requests]);

  const copyAllEmails = async () => {
    if (!pendingEmails) return;
    try {
      await navigator.clipboard.writeText(pendingEmails);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      window.prompt('Copy these emails:', pendingEmails);
    }
  };

  const markAdded = async (r: BetaRequest) => {
    if (busyId) return;
    setBusyId(r.id);
    try {
      await updateDoc(doc(db, 'beta_requests', r.id), {
        status: 'added',
        addedAt: serverTimestamp(),
        addedByUid: (userData as any)?.uid,
      });
    } catch (err) {
      debugWarn('[beta-requests] mark added failed', err);
      alert('Could not mark added. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const markDeclined = async (r: BetaRequest) => {
    if (busyId) return;
    if (!window.confirm(`Decline the request for ${r.email}? They will not be added to the tester list.`)) return;
    setBusyId(r.id);
    try {
      await updateDoc(doc(db, 'beta_requests', r.id), {
        status: 'declined',
        addedAt: serverTimestamp(),
        addedByUid: (userData as any)?.uid,
      });
    } catch (err) {
      debugWarn('[beta-requests] mark declined failed', err);
      alert('Could not mark declined. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const removeRow = async (r: BetaRequest) => {
    if (busyId) return;
    if (!window.confirm(`Delete this request row for ${r.email}? This does not remove them from Play Console.`)) return;
    setBusyId(r.id);
    try {
      await deleteDoc(doc(db, 'beta_requests', r.id));
    } catch (err) {
      debugWarn('[beta-requests] delete failed', err);
      alert('Could not delete. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-surface-base p-6 text-ink-primary">
        <p className="text-sm text-ink-primary/70">Platform admin only.</p>
        <Link to="/dashboard" className="mt-4 inline-block text-brand-primary-soft text-sm font-semibold">Back to Team HQ</Link>
      </div>
    );
  }

  const pendingCount = requests?.filter(r => r.status === 'pending').length || 0;

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      <header className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/15">
        <div className="max-w-4xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Team HQ
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Android beta requests</h1>
          <p className="text-sm text-ink-primary/60 mt-0.5">
            Emails coaches submitted for the Play Store closed-testing allowlist. Batch-paste into Play Console when convenient.
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {/* Bulk-copy panel — the whole point of this page. */}
        <section className="rounded-2xl bg-brand-primary/8 ring-1 ring-brand-primary/25 p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div>
              <p className="text-[10px] font-black tracking-[0.3em] uppercase text-brand-primary-soft">Pending</p>
              <p className="text-lg font-black">{pendingCount} {pendingCount === 1 ? 'email' : 'emails'} to add</p>
            </div>
            <button
              type="button"
              onClick={copyAllEmails}
              disabled={pendingCount === 0}
              className="px-4 py-2 rounded-full bg-brand-primary text-white font-black text-sm shadow hover:brightness-110 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {copiedAll ? 'Copied' : `Copy all ${pendingCount} emails`}
            </button>
          </div>
          {pendingEmails && (
            <div className="rounded-lg bg-surface-base/60 ring-1 ring-line-default/10 p-2 font-mono text-[12px] text-ink-primary/85 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
              {pendingEmails}
            </div>
          )}
          <p className="text-[11px] text-ink-primary/55 leading-snug">
            After pasting into Play Console (Testing then your track then Testers), tap Mark added on each row here so the queue clears.
          </p>
        </section>

        {/* Filter chips */}
        <div className="flex gap-2 flex-wrap">
          {(['pending', 'added', 'declined', 'all'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-black tracking-widest uppercase transition ${
                statusFilter === s
                  ? 'bg-brand-primary text-white shadow'
                  : 'bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 hover:text-ink-primary'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Rows */}
        {requests === null ? null : requests.length === 0 ? (
          <p className="text-sm text-ink-primary/50 py-8 text-center">
            {statusFilter === 'pending' ? 'No pending requests. Nothing to add.' : `No ${statusFilter === 'all' ? '' : statusFilter} requests.`}
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map(r => (
              <li key={r.id} className="rounded-xl bg-surface-elevated ring-1 ring-line-default/15 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-black font-mono text-ink-primary break-all">{r.email}</span>
                      {r.status !== 'pending' && (
                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${
                          r.status === 'added' ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30'
                        }`}>{r.status}</span>
                      )}
                    </div>
                    <p className="text-[12px] text-ink-primary/60 mt-1 leading-snug">
                      {r.playerName ? `For ${r.playerName}` : 'No player specified'}
                      {r.teamName ? ` on ${r.teamName}` : ''}
                      {' · '}
                      {r.requestedByName}
                      {' · '}
                      {relativeTime(toMillis(r.requestedAt))}
                    </p>
                    {r.note && (
                      <p className="text-[12px] text-ink-primary/75 mt-1 italic">{r.note}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {r.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          onClick={() => markAdded(r)}
                          disabled={busyId === r.id}
                          className="px-3 py-1.5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-200 text-[11px] font-black hover:bg-emerald-500/25 transition disabled:opacity-50"
                        >
                          Mark added
                        </button>
                        <button
                          type="button"
                          onClick={() => markDeclined(r)}
                          disabled={busyId === r.id}
                          className="px-3 py-1.5 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 text-[11px] font-black hover:bg-line-default/15 transition disabled:opacity-50"
                        >
                          Decline
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => removeRow(r)}
                      disabled={busyId === r.id}
                      aria-label="Delete row"
                      className="px-2 py-1.5 rounded-full text-ink-primary/40 hover:text-rose-300 hover:bg-rose-500/10 transition disabled:opacity-50"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
};

export default AdminBetaRequests;
