import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import type { Activity, OfferLetter, Registration } from '../types';

// Family-centric timeline. The :email param keys the family — that's
// the most stable handle pre-promotion (no user uid exists for cold
// registrations until they accept an offer and become a Player parent).
// Loads everything we know about this email: registrations, offers,
// resulting Players, and every Activity that referenced this email or
// the related registration/player ids. Renders chronologically.

interface FamilyData {
  parentEmail: string;
  registrations: Registration[];
  offers: OfferLetter[];
  players: any[];
  activities: Activity[];
}

const FamilyTimeline: React.FC = () => {
  const { email: rawEmail } = useParams<{ email: string }>();
  const email = decodeURIComponent(rawEmail || '').toLowerCase();
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);

  const [data, setData] = useState<FamilyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed || !email) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // Pull all registrations + filter client-side by parents[].email.
        // Could index parentEmails as an array on Registration for a
        // proper where(array-contains) query — punt to when scale demands.
        const regsSnap = await getDocs(query(collection(db, 'registrations'), orderBy('createdAt', 'desc')));
        const registrations: Registration[] = regsSnap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as Registration))
          .filter(r => (r.parents || []).some(p => p.email?.toLowerCase() === email));

        // Offers — match by parentEmail directly (already lowercased).
        const offersSnap = await getDocs(query(collection(db, 'offers'), where('parentEmail', '==', email)));
        const offers = offersSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as OfferLetter);

        // Players the email shows up on. Firestore doesn't support
        // array-contains-any with multiple values easily; we just pull
        // the players for any matching team + filter.
        const players: any[] = [];
        for (const r of registrations) {
          if (r.promotedToPlayerId) {
            const playerDocs = await getDocs(query(collection(db, 'players'), where('parentEmails', 'array-contains', email)));
            playerDocs.forEach(d => {
              if (!players.find(p => p.id === d.id)) players.push({ id: d.id, ...(d.data() as any) });
            });
            break;
          }
        }
        if (players.length === 0) {
          // Fallback: scan once just in case the parent has a Player from
          // a different path (e.g. manual invite outside the funnel).
          try {
            const playerDocs = await getDocs(query(collection(db, 'players'), where('parentEmails', 'array-contains', email)));
            playerDocs.forEach(d => players.push({ id: d.id, ...(d.data() as any) }));
          } catch {/* ignore */}
        }

        // Activities: pull every activity referencing this email + every
        // activity referencing one of the related registrations/players.
        // Two passes since Firestore can't OR.
        const actsByEmail = await getDocs(query(collection(db, 'activities'), where('parentEmail', '==', email)));
        const actsList: Activity[] = actsByEmail.docs.map(d => ({ id: d.id, ...(d.data() as any) } as Activity));
        const seen = new Set(actsList.map(a => a.id));
        for (const r of registrations) {
          const more = await getDocs(query(collection(db, 'activities'), where('registrationId', '==', r.id)));
          more.forEach(d => {
            if (!seen.has(d.id)) {
              actsList.push({ id: d.id, ...(d.data() as any) } as Activity);
              seen.add(d.id);
            }
          });
        }
        for (const p of players) {
          const more = await getDocs(query(collection(db, 'activities'), where('playerId', '==', p.id)));
          more.forEach(d => {
            if (!seen.has(d.id)) {
              actsList.push({ id: d.id, ...(d.data() as any) } as Activity);
              seen.add(d.id);
            }
          });
        }
        actsList.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());

        if (!cancelled) setData({ parentEmail: email, registrations, offers, players, activities: actsList });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Load failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email, allowed]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">Club admins only.</div>;
  }

  const parentName = useMemo(() => {
    if (!data) return '';
    for (const r of data.registrations) {
      const p = r.parents?.find(p => p.email?.toLowerCase() === email);
      if (p) return `${p.firstName} ${p.lastName}`.trim();
    }
    return '';
  }, [data, email]);

  const totalPaidCents = useMemo(() => {
    if (!data) return 0;
    return data.registrations.reduce((sum, r) => sum + (r.status === 'paid' || r.status === 'accepted' ? (r.amountPaidCents || r.registrationFeeCents || 0) : 0), 0);
  }, [data]);

  return (
    <div className="min-h-screen bg-slate-50">
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 py-5 border-b border-cyan-500/10">
        <div className="max-w-4xl mx-auto">
          <Link to="/club/registrations" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Registrations
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">{parentName || email}</h1>
          {parentName && <p className="text-sm text-slate-400 mt-0.5">{email}</p>}
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6 text-sm text-slate-500">Loading…</div>
        ) : error ? (
          <div className="bg-rose-50 ring-1 ring-rose-300 rounded-2xl p-4 text-sm text-rose-700">{error}</div>
        ) : !data ? (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6 text-sm text-slate-500">Nothing found for {email}.</div>
        ) : (
          <>
            {/* Summary tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Kids" value={String(data.registrations.length)} />
              <Tile label="Offers" value={String(data.offers.length)} />
              <Tile label="Players" value={String(data.players.length)} />
              <Tile label="Total paid" value={`$${(totalPaidCents / 100).toFixed(2)}`} />
            </div>

            {/* Kids list */}
            {data.registrations.length > 0 && (
              <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
                <div className="px-4 py-2 border-b border-slate-100">
                  <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600">Kids</h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {data.registrations.map(r => {
                    const promotedTo = data.players.find(p => p.id === r.promotedToPlayerId);
                    return (
                      <li key={r.id} className="px-4 py-3 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold text-slate-900">
                            {r.player.firstName} {r.player.lastName}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {r.player.ageGroup} · {r.player.gender}
                            {r.player.preferredPosition ? ` · ${r.player.preferredPosition}` : ''}
                            {r.player.playedBefore ? ' · returning' : ''}
                          </div>
                          {promotedTo && (
                            <Link
                              to={`/club/person/${promotedTo.id}`}
                              className="inline-block mt-1 text-[11px] font-extrabold uppercase tracking-widest text-cyan-700 hover:text-cyan-900"
                            >
                              Open profile →
                            </Link>
                          )}
                        </div>
                        <span className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-slate-100 text-slate-700 ring-1 ring-slate-200 shrink-0">
                          {r.status}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Offers */}
            {data.offers.length > 0 && (
              <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
                <div className="px-4 py-2 border-b border-slate-100">
                  <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600">Offers</h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {data.offers.map(o => (
                    <li key={o.id} className="px-4 py-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-bold text-slate-900">{o.teamName} <span className="text-slate-400 font-normal">→</span> {o.playerName}</div>
                        <div className="text-[11px] text-slate-500">From {o.coachName} · {toDate(o.createdAt).toLocaleDateString()}</div>
                      </div>
                      <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded shrink-0 ${
                        o.status === 'accepted' ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
                          : o.status === 'declined' ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-200'
                          : o.status === 'expired' ? 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'
                          : 'bg-violet-100 text-violet-700 ring-1 ring-violet-200'
                      }`}>{o.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Timeline */}
            <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-100">
                <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600">Timeline</h2>
              </div>
              {data.activities.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">No activity yet.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.activities.map(a => <TimelineRow key={a.id} activity={a} />)}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white rounded-xl ring-1 ring-slate-200 px-4 py-3">
    <div className="text-2xl font-black text-slate-900 leading-none">{value}</div>
    <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mt-1">{label}</div>
  </div>
);

const TimelineRow: React.FC<{ activity: Activity }> = ({ activity: a }) => {
  const ts = toDate(a.createdAt);
  return (
    <li className="px-4 py-3 flex items-start gap-3">
      <div className={`shrink-0 w-2 h-2 rounded-full mt-2 ${kindTone(a.kind)}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-800">
          <span className="font-bold">{a.actorName || 'System'}</span>{' '}
          <span className="text-slate-500">{verbFor(a.kind)}</span>{' '}
          <span className="font-bold">{a.payload?.playerName || a.payload?.teamName || ''}</span>
          {a.payload?.rating && <span className="ml-1 text-amber-600 font-bold">{a.payload.rating}★</span>}
          {a.payload?.totalCents && <span className="ml-1 text-emerald-700 font-bold">${(a.payload.totalCents / 100).toFixed(2)}</span>}
        </div>
        {a.payload?.note && <div className="text-[11px] text-slate-500 mt-0.5 italic">"{a.payload.note}"</div>}
        {a.payload?.subject && <div className="text-[11px] text-slate-500 mt-0.5">{a.payload.subject}</div>}
      </div>
      <div className="text-[10px] text-slate-400 shrink-0 mt-1 tabular-nums">{ts.toLocaleDateString()} · {ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
    </li>
  );
};

function kindTone(kind: Activity['kind']): string {
  if (kind === 'registration_submitted') return 'bg-cyan-500';
  if (kind === 'registration_paid' || kind === 'offer_accepted' || kind === 'player_promoted') return 'bg-emerald-500';
  if (kind === 'offer_sent' || kind === 'tryout_invited') return 'bg-violet-500';
  if (kind === 'offer_declined') return 'bg-rose-500';
  if (kind.startsWith('coach_')) return 'bg-amber-500';
  if (kind === 'email_sent') return 'bg-slate-400';
  return 'bg-slate-300';
}

function verbFor(kind: Activity['kind']): string {
  switch (kind) {
    case 'registration_submitted': return 'registered';
    case 'registration_paid': return 'paid for';
    case 'tryout_invited': return 'was invited to tryout for';
    case 'offer_sent': return 'sent an offer to';
    case 'offer_accepted': return 'accepted the offer from';
    case 'offer_declined': return 'declined the offer from';
    case 'player_promoted': return 'joined';
    case 'email_sent': return 'received an email';
    case 'fee_charged': return 'was charged';
    case 'coupon_redeemed': return 'redeemed coupon';
    case 'note_added': return 'noted on';
    case 'coach_favorited': return 'favorited';
    case 'coach_unfavorited': return 'unfavorited';
    case 'coach_rated': return 'rated';
    case 'coach_noted': return 'noted on';
    case 'coach_held': return 'placed a hold on';
    case 'coach_released': return 'released';
    default: return kind;
  }
}

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

export default FamilyTimeline;
