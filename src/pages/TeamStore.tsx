// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useTeam } from '../contexts/TeamContext';

// Per-club team store. Reads storeUrl, storeDiscountCode, and
// (optional) storeLabel from clubs/{clubId} so each club sees their
// own gear shop, not Fire FC's. If the active team has no clubId, or
// the club doc has no storeUrl, render an empty state — a club that
// hasn't set up a store shouldn't see hardcoded Fire FC gear (Patrick
// 2026-06-23: "I am sure another club isn't going to try and buy
// Fire FC uniforms.").

interface ClubStore {
  storeUrl: string;
  discountCode?: string;
  clubName?: string;
  label?: string;
}

const TeamStore: React.FC = () => {
  const { selectedTeam } = useTeam();
  const [copied, setCopied] = useState(false);
  const [store, setStore] = useState<ClubStore | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const clubId = (selectedTeam as any)?.clubId;
      if (!clubId) { if (!cancelled) { setStore(null); setLoaded(true); } return; }
      try {
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (cancelled) return;
        if (!snap.exists()) { setStore(null); setLoaded(true); return; }
        const data: any = snap.data();
        if (!data?.storeUrl) { setStore(null); setLoaded(true); return; }
        setStore({
          storeUrl: data.storeUrl,
          discountCode: data.storeDiscountCode,
          clubName: data.name,
          label: data.storeLabel,
        });
      } catch (err) {
        console.warn('[team-store] load failed', err);
        if (!cancelled) setStore(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [(selectedTeam as any)?.clubId]);

  const copyCode = async () => {
    if (!store?.discountCode) return;
    try {
      await navigator.clipboard.writeText(store.discountCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this code:', store.discountCode);
    }
  };

  const headerCrumb = (
    <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary mb-2">
      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      Dashboard
    </Link>
  );

  if (!loaded) {
    return (
      <div className="min-h-screen bg-surface-base">
        <section className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/10">
          <div className="max-w-3xl mx-auto">{headerCrumb}</div>
        </section>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="min-h-screen bg-surface-base">
        <section className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/10">
          <div className="max-w-3xl mx-auto">
            {headerCrumb}
            <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Team Store</h1>
          </div>
        </section>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
          <p className="text-ink-primary/85 font-semibold mb-1">No store yet</p>
          <p className="text-ink-primary/55 text-sm">
            Your club hasn&apos;t set up a team store. A club admin can add a store link in club settings.
          </p>
        </div>
      </div>
    );
  }

  const label = store.label || (store.clubName ? `Official ${store.clubName} gear, member pricing.` : 'Official team gear, member pricing.');
  const displayHost = (() => {
    try { return new URL(store.storeUrl).host + new URL(store.storeUrl).pathname; }
    catch { return store.storeUrl; }
  })();

  return (
    <div className="min-h-screen bg-surface-base">
      <section className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/10">
        <div className="max-w-3xl mx-auto">
          {headerCrumb}
          <div className="flex items-center gap-3">
            <span className="flex-shrink-0 w-11 h-11 rounded-2xl bg-brand-primary/15 ring-1 ring-brand-primary/30 flex items-center justify-center">
              <svg className="w-5 h-5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            </span>
            <div>
              <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Team Store</h1>
              <p className="text-sm text-ink-primary/40 mt-0.5">{label}</p>
            </div>
          </div>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {store.discountCode && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-brand-primary-soft/30 overflow-hidden shadow-sm">
            <div className="bg-gradient-to-br from-brand-primary to-brand-primary px-5 py-3 text-white">
              <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">Member discount code</div>
              <div className="text-[11px] opacity-90 mt-0.5">Apply at checkout for the team rate.</div>
            </div>
            <div className="px-5 py-5 flex flex-col sm:flex-row items-center gap-3">
              <div className="flex-1 w-full">
                <code className="block w-full text-center sm:text-left text-2xl font-black tracking-[0.15em] text-ink-primary font-mono">
                  {store.discountCode}
                </code>
              </div>
              <button
                type="button"
                onClick={copyCode}
                className={`flex-shrink-0 w-full sm:w-auto px-5 py-3 rounded-xl font-bold text-sm tracking-wider uppercase transition-all ${
                  copied
                    ? 'bg-emerald-500/150 text-white'
                    : 'bg-surface-elevated text-ink-primary hover:bg-surface-input active:scale-95'
                }`}
              >
                {copied ? 'Copied!' : 'Copy code'}
              </button>
            </div>
          </div>
        )}

        <a
          href={store.storeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 block rounded-2xl bg-gradient-to-br from-surface-base to-surface-elevated ring-1 ring-brand-primary/30 text-white px-5 py-5 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Shop now</div>
              <div className="text-base font-bold mt-0.5 truncate">{displayHost}</div>
              <div className="text-[12px] text-ink-primary/40 mt-0.5">
                Opens in your browser.{store.discountCode ? ' Copy the code above first.' : ''}
              </div>
            </div>
            <span className="flex-shrink-0 w-10 h-10 rounded-full bg-brand-primary/20 ring-1 ring-brand-primary-soft/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-ink-primary" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </span>
          </div>
        </a>

        <p className="mt-5 text-[11px] text-ink-primary/50 text-center px-4 leading-relaxed">
          Questions about an order? Contact your club, not the app: the store is run by the retailer.
        </p>
      </div>
    </div>
  );
};

export default TeamStore;
