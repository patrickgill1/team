import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import type { OfferLetter, Registration } from '../types';

// Admin dashboard with the metrics clubs actually want to see at a
// glance: registrations by age + status, conversion funnel through
// the offer flow, fees collected, coupon redemption. Pure read —
// queries all registrations + offers and aggregates client-side, fine
// at any reasonable club scale.

const Reports: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [offers, setOffers] = useState<OfferLetter[]>([]);
  const [seasonFilter, setSeasonFilter] = useState<string>('all');
  const [seasons, setSeasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [rSnap, oSnap, sSnap] = await Promise.all([
          getDocs(query(collection(db, 'registrations'), orderBy('createdAt', 'desc'))),
          getDocs(query(collection(db, 'offers'), orderBy('createdAt', 'desc'))),
          getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc'))),
        ]);
        if (cancelled) return;
        setRegistrations(rSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Registration));
        setOffers(oSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as OfferLetter));
        setSeasons(sSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [allowed]);

  const filteredRegs = useMemo(() => {
    if (seasonFilter === 'all') return registrations;
    return registrations.filter(r => r.seasonId === seasonFilter);
  }, [registrations, seasonFilter]);

  const filteredOffers = useMemo(() => {
    if (seasonFilter === 'all') return offers;
    const okRegIds = new Set(filteredRegs.map(r => r.id));
    return offers.filter(o => okRegIds.has(o.registrationId));
  }, [offers, filteredRegs, seasonFilter]);

  // ── Aggregations ────────────────────────────────────────────────

  const byAge = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filteredRegs) {
      const k = r.player?.ageGroup || '?';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredRegs]);

  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filteredRegs) m.set(r.status, (m.get(r.status) || 0) + 1);
    return Array.from(m.entries());
  }, [filteredRegs]);

  // Conversion funnel — counts at each stage. A reg can be in multiple
  // (e.g. paid AND offered), so we count "ever reached" not "currently."
  const funnel = useMemo(() => {
    const offered = new Set(filteredOffers.map(o => o.registrationId));
    const accepted = new Set(filteredOffers.filter(o => o.status === 'accepted').map(o => o.registrationId));
    const declined = new Set(filteredOffers.filter(o => o.status === 'declined').map(o => o.registrationId));
    const submitted = filteredRegs.length;
    const paid = filteredRegs.filter(r =>
      r.status === 'paid' || r.status === 'tryout_invited' || r.status === 'offer_sent' || r.status === 'accepted'
    ).length;
    return {
      submitted,
      paid,
      offered: offered.size,
      accepted: accepted.size,
      declined: declined.size,
    };
  }, [filteredRegs, filteredOffers]);

  // Fee collection — sum of amountPaidCents (or registrationFeeCents
  // when missing) for any registration that's paid or further.
  const fees = useMemo(() => {
    let collected = 0;
    let owed = 0;
    let surcharge = 0;
    for (const r of filteredRegs) {
      const isPaid = r.status === 'paid' || r.status === 'tryout_invited' || r.status === 'offer_sent' || r.status === 'accepted';
      const amount = r.amountPaidCents || r.registrationFeeCents || 0;
      if (isPaid) collected += amount;
      else owed += amount;
      surcharge += r.stripeSurchargeCents || 0;
    }
    return { collected, owed, surcharge };
  }, [filteredRegs]);

  const coupons = useMemo(() => {
    const m = new Map<string, { count: number; discountCents: number }>();
    for (const r of filteredRegs) {
      if (!r.couponCode) continue;
      const k = r.couponCode;
      const entry = m.get(k) || { count: 0, discountCents: 0 };
      entry.count++;
      entry.discountCents += r.couponDiscountCents || 0;
      m.set(k, entry);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].count - a[1].count);
  }, [filteredRegs]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">Club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-charcoal-950 px-4 py-6 sm:py-10">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-bone/50 hover:text-bone/85">← Club</Link>
            <h1 className="text-2xl font-black text-bone mt-1">Reports</h1>
            <p className="text-sm text-bone/65">Funnel + fees + coupon usage. Filter by season.</p>
          </div>
          <select
            value={seasonFilter}
            onChange={(e) => setSeasonFilter(e.target.value)}
            className="text-sm border border-white/15 rounded-lg px-3 py-2"
          >
            <option value="all">All seasons</option>
            {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/50">Loading…</div>
        ) : (
          <>
            {/* Top-line tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Registered" value={String(funnel.submitted)} />
              <Tile label="Paid" value={String(funnel.paid)} />
              <Tile label="Offers sent" value={String(funnel.offered)} />
              <Tile label="Rostered" value={String(funnel.accepted)} />
            </div>

            {/* Funnel */}
            <Section title="Conversion funnel">
              <FunnelRow label="Submitted" value={funnel.submitted} of={funnel.submitted} tone="cyan" />
              <FunnelRow label="Paid" value={funnel.paid} of={funnel.submitted} tone="emerald" />
              <FunnelRow label="Offered" value={funnel.offered} of={funnel.submitted} tone="violet" />
              <FunnelRow label="Accepted" value={funnel.accepted} of={funnel.submitted} tone="emerald" />
              <FunnelRow label="Declined" value={funnel.declined} of={funnel.submitted} tone="rose" />
            </Section>

            {/* By age group */}
            <Section title="By age group">
              {byAge.length === 0
                ? <Empty text="No registrations yet." />
                : <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {byAge.map(([k, n]) => (
                      <div key={k} className="rounded-lg ring-1 ring-white/10 bg-white/[0.04] p-2 text-center">
                        <div className="text-lg font-black text-bone">{n}</div>
                        <div className="text-[10px] font-extrabold uppercase tracking-widest text-bone/50">{k}</div>
                      </div>
                    ))}
                  </div>}
            </Section>

            {/* Status breakdown */}
            <Section title="Status breakdown">
              {byStatus.length === 0
                ? <Empty text="Nothing to break down yet." />
                : <ul className="space-y-1">
                    {byStatus.map(([status, n]) => (
                      <li key={status} className="flex items-center justify-between text-sm">
                        <span className="text-bone/85">{status}</span>
                        <span className="font-bold text-bone tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>}
            </Section>

            {/* Fees */}
            <Section title="Fee collection">
              <div className="grid grid-cols-3 gap-2">
                <Tile label="Collected" value={fmtCents(fees.collected)} />
                <Tile label="Owed" value={fmtCents(fees.owed)} />
                <Tile label="Processing fees" value={fmtCents(fees.surcharge)} />
              </div>
            </Section>

            {/* Coupon usage */}
            <Section title="Coupon redemption">
              {coupons.length === 0
                ? <Empty text="No coupons redeemed in this window." />
                : <ul className="space-y-1">
                    {coupons.map(([code, info]) => (
                      <li key={code} className="flex items-center justify-between text-sm">
                        <span className="font-bold text-bone tracking-wider">{code}</span>
                        <span className="text-bone/65 tabular-nums">{info.count}× · {fmtCents(info.discountCents)} off</span>
                      </li>
                    ))}
                  </ul>}
            </Section>
          </>
        )}
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
    <div className="px-4 py-2 border-b border-white/5">
      <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-bone/65">{title}</h2>
    </div>
    <div className="p-4">{children}</div>
  </div>
);

const Tile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-charcoal-900 rounded-xl ring-1 ring-white/10 px-4 py-3">
    <div className="text-2xl font-black text-bone leading-none tabular-nums">{value}</div>
    <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mt-1">{label}</div>
  </div>
);

const FunnelRow: React.FC<{ label: string; value: number; of: number; tone: 'cyan' | 'emerald' | 'violet' | 'rose' }> = ({ label, value, of, tone }) => {
  const pct = of > 0 ? Math.round((value / of) * 100) : 0;
  const bg = {
    cyan: 'bg-brand-primary/150',
    emerald: 'bg-emerald-500/150',
    violet: 'bg-violet-500/150',
    rose: 'bg-rose-500/150',
  }[tone];
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-bold text-bone/85">{label}</span>
        <span className="text-bone/65 tabular-nums">{value} <span className="text-bone/40">({pct}%)</span></span>
      </div>
      <div className="h-2 rounded-full bg-charcoal-950 overflow-hidden mt-1">
        <div className={`h-full ${bg}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-xs text-bone/50">{text}</p>
);

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

export default Reports;
