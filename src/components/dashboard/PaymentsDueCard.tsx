// PaymentsDueCard — dashboard card that renders only when the parent
// has one or more outstanding payment_requests across any team. Aggregate
// total across kids + subtle brand-primary CTA into /payments.
//
// Live listener on payment_requests scoped to the parent's teams;
// silent when there is nothing due so the dashboard stays quiet.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import type { PaymentRequest, Player } from '../../types';
import { grossUpCents } from '../../utils/pricing';

interface Props {
  players: Player[];
}

const PaymentsDueCard: React.FC<Props> = ({ players }) => {
  const { userData } = useAuth();
  const [requests, setRequests] = useState<PaymentRequest[]>([]);

  useEffect(() => {
    const teamIds = Array.from(new Set(players.flatMap(p => (p as any).teamIds || []))) as string[];
    if (teamIds.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < teamIds.length; i += 10) chunks.push(teamIds.slice(i, i + 10));
    const bag: Record<string, PaymentRequest> = {};
    const unsubs = chunks.map(chunk => {
      const q = query(
        collection(db, 'payment_requests'),
        where('teamId', 'in', chunk),
        where('status', '==', 'active'),
      );
      return onSnapshot(q, (snap) => {
        for (const d of snap.docs) {
          const data: any = d.data();
          bag[d.id] = {
            id: d.id,
            ...data,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || 0),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0),
          } as PaymentRequest;
        }
        setRequests(Object.values(bag));
      });
    });
    return () => unsubs.forEach(u => u());
  }, [players.map(p => p.id).join(',')]);

  const { outstandingCount, totalCents } = useMemo(() => {
    if (!userData?.uid) return { outstandingCount: 0, totalCents: 0 };
    const uid = userData.uid;
    let total = 0;
    let count = 0;
    for (const pr of requests) {
      const kidsOnTeam = players.filter(p => ((p as any).teamIds || []).includes(pr.teamId));
      const kidsOnRequest = pr.targetPlayerIds === 'all'
        ? kidsOnTeam
        : kidsOnTeam.filter(p => (pr.targetPlayerIds as string[]).includes(p.id));
      if (kidsOnRequest.length === 0) continue;
      const paidStripe = (pr.paidUids || []).includes(uid);
      const paidCash = (pr.paidByCoach || []).includes(uid)
        || kidsOnRequest.some(k => (pr.paidByCoachPlayerIds || []).includes(k.id));
      const subscribed = pr.kind === 'recurring' && !!(pr.stripeSubscriptionIds || {})[uid];
      if (paidStripe || paidCash || subscribed) continue;
      if (pr.kind === 'catalog') continue; // shopping is optional
      count += 1;
      if (pr.kind === 'one_off' && pr.feeCents != null) {
        const perKid = pr.feeCoveredBy === 'player' ? grossUpCents(pr.feeCents) : pr.feeCents;
        total += perKid * kidsOnRequest.length;
      } else if (pr.kind === 'recurring' && pr.intervalCents != null) {
        total += pr.feeCoveredBy === 'player' ? grossUpCents(pr.intervalCents) : pr.intervalCents;
      }
    }
    return { outstandingCount: count, totalCents: total };
  }, [requests, players, userData?.uid]);

  if (outstandingCount === 0) return null;

  return (
    <Link
      to="/payments"
      className="block rounded-2xl bg-surface-elevated ring-1 ring-brand-primary/25 hover:ring-brand-primary/50 transition p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">Payments due</p>
          <p className="text-sm font-black text-ink-primary mt-0.5">
            {outstandingCount === 1 ? '1 payment waiting' : `${outstandingCount} payments waiting`}
          </p>
          <p className="text-[11px] text-ink-primary/55 mt-0.5">Tap to review and pay.</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-black text-ink-primary tabular-nums">${(totalCents / 100).toFixed(2)}</p>
        </div>
      </div>
    </Link>
  );
};

export default PaymentsDueCard;
