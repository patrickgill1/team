import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { workerOrigin } from '../utils/workerFetch';
import type { PaymentRequest } from '../types';

/**
 * /pay/{requestId} — anonymous "guest pay" surface (Ship 1 decision #3).
 *
 * Coach shares this URL from CoachPaymentDetail. The guest (grandma,
 * a booster, a family friend without an account) sees the club's
 * team name, the request title, the amount, and a lightweight
 * email+name form. Submitting POSTs to /payments/checkout-anon and
 * redirects to Stripe.
 *
 * Firestore rules allow anon single-doc reads on active,
 * still-billable payment_requests, so this page never asks the
 * guest to sign in. Only one_off requests are supported in v1 —
 * recurring + catalog require accounts.
 *
 * Copy voice: warm, soccer-native, never "invoice / billing".
 */

interface AnonPr {
  id: string;
  title: string;
  description?: string;
  kind: string;
  status: string;
  feeCents?: number;
  clubName?: string;
  clubId: string;
  createdByName?: string;
}

const PayLink: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const paid = params.get('paid') === '1';

  const [pr, setPr] = useState<AnonPr | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not-found' | 'not-shareable'>('loading');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'payment_requests', id));
        if (cancelled) return;
        if (!snap.exists()) {
          setLoadState('not-found');
          return;
        }
        const data: any = snap.data();
        if (data.status !== 'active' || data.isActive === false || data.kind !== 'one_off') {
          setLoadState('not-shareable');
          return;
        }
        // Best-effort club-name fetch for the header. Not fatal if
        // it fails — the anon page still works with just the title.
        let clubName: string | undefined;
        try {
          const clubSnap = await getDoc(doc(db, 'clubs', String(data.clubId || '')));
          if (clubSnap.exists()) clubName = String((clubSnap.data() as any).name || '') || undefined;
        } catch { /* ignore */ }
        setPr({
          id: snap.id,
          title: String(data.title || 'Team payment'),
          description: data.description ? String(data.description) : undefined,
          kind: String(data.kind),
          status: String(data.status),
          feeCents: Number(data.feeCents || 0) || undefined,
          clubName,
          clubId: String(data.clubId || ''),
          createdByName: data.createdByName ? String(data.createdByName) : undefined,
        });
        setLoadState('ready');
      } catch (e) {
        console.warn('[pay-link] load failed', e);
        setLoadState('not-found');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const canSubmit = useMemo(() => {
    return /^\S+@\S+\.\S+$/.test(email.trim()) && !busy;
  }, [email, busy]);

  const submit = async () => {
    if (!pr) return;
    setBusy(true);
    setErr(null);
    try {
      const origin = workerOrigin();
      if (!origin) {
        setErr('This link is not fully configured yet. Please text the coach.');
        setBusy(false);
        return;
      }
      const res = await fetch(`${origin}/payments/checkout-anon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentRequestId: pr.id,
          email: email.trim(),
          name: name.trim() || undefined,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !data?.url) {
        setErr(data?.hint || data?.error || 'Could not open checkout. Try again in a minute.');
        setBusy(false);
        return;
      }
      window.location.assign(String(data.url));
    } catch (e: any) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  };

  if (paid) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 sm:p-7 text-center">
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">Payment received</p>
          <h1 className="text-xl font-black text-ink-primary mt-1">Thanks for supporting the team.</h1>
          <p className="text-sm text-ink-primary/70 mt-3 leading-relaxed">
            Your receipt is on the way from Stripe. The coach was notified too.
          </p>
        </div>
      </div>
    );
  }

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
        <div className="h-0.5 w-40 bg-brand-primary/15 overflow-hidden rounded-full">
          <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
        </div>
      </div>
    );
  }

  if (loadState === 'not-found' || loadState === 'not-shareable' || !pr) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 sm:p-7 text-center">
          <h1 className="text-lg font-black text-ink-primary">This link is not active.</h1>
          <p className="text-sm text-ink-primary/70 mt-2 leading-relaxed">
            {loadState === 'not-shareable'
              ? 'Your coach may have closed this collection or it may need a full account to pay. Text them for the next step.'
              : 'Double-check the link or reach out to your coach.'}
          </p>
          <Link to="/auth" className="inline-block mt-5 text-xs font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary">
            Have an account? Sign in
          </Link>
        </div>
      </div>
    );
  }

  const amount = pr.feeCents ? `$${(pr.feeCents / 100).toFixed(2)}` : '';

  return (
    <div className="min-h-screen bg-surface-base flex items-start sm:items-center justify-center px-4 py-8">
      <div className="max-w-md w-full rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 sm:p-7 space-y-5">
        <div>
          {pr.clubName && (
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">
              {pr.clubName}
            </p>
          )}
          <h1 className="text-xl font-black text-ink-primary leading-tight mt-1">{pr.title}</h1>
          {pr.description && (
            <p className="text-[13px] text-ink-primary/70 leading-relaxed mt-2">{pr.description}</p>
          )}
          {pr.createdByName && (
            <p className="text-[11px] text-ink-primary/55 mt-2">from Coach {pr.createdByName}</p>
          )}
        </div>

        <div className="flex items-center justify-between rounded-xl bg-surface-base ring-1 ring-line-default/15 px-4 py-3">
          <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Amount</span>
          <span className="text-lg font-black text-ink-primary tabular-nums">{amount}</span>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Your email</span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
            />
            <span className="text-[11px] text-ink-primary/50 mt-1 block">We use this only for your receipt.</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Your name (optional)</span>
            <input
              type="text"
              autoComplete="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="So Coach knows who paid"
              className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
            />
          </label>
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="w-full py-3 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest hover:bg-brand-primary/90 transition disabled:opacity-50"
        >
          {busy ? 'Opening checkout...' : `Pay ${amount || 'now'}`}
        </button>

        <p className="text-[11px] text-ink-primary/50 text-center leading-relaxed">
          Secure checkout by Stripe.{' '}
          <Link to="/auth" className="text-brand-primary-soft hover:text-brand-primary">Sign in</Link>{' '}
          if you already have an account with this team.
        </p>
      </div>
    </div>
  );
};

export default PayLink;
