import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import HouseholdLinkModal from '../components/club/HouseholdLinkModal';
import type { Activity, Household, OfferLetter, Registration } from '../types';

// Family-centric timeline. The :email param keys the family — that's
// the most stable handle pre-promotion (no user uid exists for cold
// registrations until they accept an offer and become a Player parent).
// Loads everything we know about this email: registrations, offers,
// resulting Players, and every Activity that referenced this email or
// the related registration/player ids. Renders chronologically.

interface FamilyData {
  parentEmail: string;
  emails: string[]; // all household emails included in the rollup
  household: Household | null;
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!allowed || !email) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);

        // 1. Look up the household for this email. If one exists, we
        // aggregate across ALL household emails. If not, fall back to
        // single-email mode (current behavior).
        let household: Household | null = null;
        let emails: string[] = [email];
        try {
          const hhSnap = await getDocs(query(
            collection(db, 'households'),
            where('parentEmails', 'array-contains', email),
          ));
          if (hhSnap.docs[0]) {
            household = { id: hhSnap.docs[0].id, ...(hhSnap.docs[0].data() as any) } as Household;
            emails = Array.from(new Set((household.parentEmails || []).map(e => e.toLowerCase())));
            if (!emails.includes(email)) emails.push(email);
          }
        } catch {/* household lookup failed — proceed in single-email mode */}

        // 2. Registrations — match by ANY household email.
        // 2026-07-14: LIST rule requires clubId scope. Pull the caller's
        // clubId from userData; skip if missing (page 403s cleanly).
        const callerClubId: string | null = (userData as any)?.clubIds?.[0] || (userData as any)?.clubId || null;
        const regsSnap = callerClubId
          ? await getDocs(query(collection(db, 'registrations'), where('clubId', '==', callerClubId), orderBy('createdAt', 'desc')))
          : { docs: [] as any[] };
        const registrations: Registration[] = regsSnap.docs
          .map((d: any) => ({ id: d.id, ...(d.data() as any) } as Registration))
          .filter(r => (r.parents || []).some(p => emails.includes(p.email?.toLowerCase() || '')));

        // 3. Offers — collect for each email (no `in` query needed for
        // a small set; one query per email).
        const offers: OfferLetter[] = [];
        const seenOffer = new Set<string>();
        for (const e of emails) {
          const os = await getDocs(query(collection(db, 'offers'), where('parentEmail', '==', e)));
          os.forEach(d => {
            if (seenOffer.has(d.id)) return;
            seenOffer.add(d.id);
            offers.push({ id: d.id, ...(d.data() as any) } as OfferLetter);
          });
        }

        // 4. Players — one array-contains query per email.
        const players: any[] = [];
        const seenPlayer = new Set<string>();
        for (const e of emails) {
          try {
            const ps = await getDocs(query(collection(db, 'players'), where('parentEmails', 'array-contains', e)));
            ps.forEach(d => {
              if (seenPlayer.has(d.id)) return;
              seenPlayer.add(d.id);
              players.push({ id: d.id, ...(d.data() as any) });
            });
          } catch {/* ignore */}
        }

        // 5. Activities — by email, by registration, by player.
        const actsList: Activity[] = [];
        const seenAct = new Set<string>();
        const pushAct = (d: any) => {
          if (seenAct.has(d.id)) return;
          seenAct.add(d.id);
          actsList.push({ id: d.id, ...(d.data() as any) } as Activity);
        };
        for (const e of emails) {
          const s = await getDocs(query(collection(db, 'activities'), where('parentEmail', '==', e)));
          s.forEach(pushAct);
        }
        for (const r of registrations) {
          const s = await getDocs(query(collection(db, 'activities'), where('registrationId', '==', r.id)));
          s.forEach(pushAct);
        }
        for (const p of players) {
          const s = await getDocs(query(collection(db, 'activities'), where('playerId', '==', p.id)));
          s.forEach(pushAct);
        }
        actsList.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());

        if (!cancelled) setData({ parentEmail: email, emails, household, registrations, offers, players, activities: actsList });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Load failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email, allowed, reloadKey]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-ink-primary/65 text-sm">Club admins only.</div>;
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
    <div className="min-h-screen bg-surface-base">
      <section className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 sm:px-6 py-5 border-b border-brand-primary/10">
        <div className="max-w-4xl mx-auto">
          <Link to="/club/registrations" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-brand-primary-soft hover:text-ink-primary mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Registrations
          </Link>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">{parentName || email}</h1>
              {parentName && <p className="text-sm text-ink-primary/40 mt-0.5">{email}</p>}
            </div>
            <button
              type="button"
              onClick={() => setLinkOpen(true)}
              className="shrink-0 px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary-soft text-white text-xs font-extrabold uppercase tracking-widest"
            >
              + Link email
            </button>
          </div>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {loading ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-6 text-sm text-ink-primary/50">Loading…</div>
        ) : error ? (
          <div className="bg-rose-500/15 ring-1 ring-rose-300 rounded-2xl p-4 text-sm text-rose-300">{error}</div>
        ) : !data ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-6 text-sm text-ink-primary/50">Nothing found for {email}.</div>
        ) : (
          <>
            {/* Household banner — only when multi-email linked. */}
            {data.household && data.emails.length > 1 && (
              <div className="bg-brand-primary/15 ring-1 ring-brand-primary-soft rounded-2xl p-3 flex items-start gap-3">
                <svg className="w-4 h-4 text-brand-primary mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Household · {data.emails.length} emails</div>
                  <div className="text-xs text-brand-primary-dim mt-0.5 truncate">
                    {data.emails.map(e => (
                      <Link key={e} to={`/club/family/${encodeURIComponent(e)}`} className={`inline-block mr-2 ${e === email ? 'font-extrabold' : 'underline hover:text-brand-primary-soft'}`}>
                        {e}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Summary tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label="Kids" value={String(data.registrations.length)} />
              <Tile label="Offers" value={String(data.offers.length)} />
              <Tile label="Players" value={String(data.players.length)} />
              <Tile label="Total paid" value={`$${(totalPaidCents / 100).toFixed(2)}`} />
            </div>

            {/* Kids list */}
            {data.registrations.length > 0 && (
              <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
                <div className="px-4 py-2 border-b border-line-default/5">
                  <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65">Kids</h2>
                </div>
                <ul className="divide-y divide-line-default/5">
                  {data.registrations.map(r => {
                    const promotedTo = data.players.find(p => p.id === r.promotedToPlayerId);
                    return (
                      <li key={r.id} className="px-4 py-3 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold text-ink-primary">
                            {r.player.firstName} {r.player.lastName}
                          </div>
                          <div className="text-[11px] text-ink-primary/50">
                            {r.player.ageGroup} · {r.player.gender}
                            {r.player.preferredPosition ? ` · ${r.player.preferredPosition}` : ''}
                            {r.player.playedBefore ? ' · returning' : ''}
                          </div>
                          {promotedTo && (
                            <Link
                              to={`/club/person/${promotedTo.id}`}
                              className="inline-block mt-1 text-[11px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary-dim"
                            >
                              Open profile →
                            </Link>
                          )}
                        </div>
                        <span className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-surface-base text-ink-primary/85 ring-1 ring-line-default/10 shrink-0">
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
              <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
                <div className="px-4 py-2 border-b border-line-default/5">
                  <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65">Offers</h2>
                </div>
                <ul className="divide-y divide-line-default/5">
                  {data.offers.map(o => (
                    <li key={o.id} className="px-4 py-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-bold text-ink-primary">{o.teamName} <span className="text-ink-primary/40 font-normal">→</span> {o.playerName}</div>
                        <div className="text-[11px] text-ink-primary/50">From {o.coachName} · {toDate(o.createdAt).toLocaleDateString()}</div>
                      </div>
                      <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded shrink-0 ${
                        o.status === 'accepted' ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-300'
                          : o.status === 'declined' ? 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-200'
                          : o.status === 'expired' ? 'bg-surface-base text-ink-primary/50 ring-1 ring-line-default/10'
                          : 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-200'
                      }`}>{o.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Timeline */}
            <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
              <div className="px-4 py-2 border-b border-line-default/5">
                <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65">Timeline</h2>
              </div>
              {data.activities.length === 0 ? (
                <div className="p-6 text-center text-sm text-ink-primary/50">No activity yet.</div>
              ) : (
                <ul className="divide-y divide-line-default/5">
                  {data.activities.map(a => <TimelineRow key={a.id} activity={a} />)}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {linkOpen && data && userData?.uid && (
        <HouseholdLinkModal
          clubId={data.registrations[0]?.clubId || (userData as any)?.clubId || ''}
          currentEmail={email}
          currentHousehold={data.household}
          actorUid={userData.uid}
          actorName={userData.name || 'Admin'}
          onClose={() => setLinkOpen(false)}
          onLinked={() => { setLinkOpen(false); setReloadKey(k => k + 1); }}
        />
      )}
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-surface-elevated rounded-xl ring-1 ring-line-default/10 px-4 py-3">
    <div className="text-2xl font-black text-ink-primary leading-none">{value}</div>
    <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 mt-1">{label}</div>
  </div>
);

const TimelineRow: React.FC<{ activity: Activity }> = ({ activity: a }) => {
  const ts = toDate(a.createdAt);
  return (
    <li className="px-4 py-3 flex items-start gap-3">
      <div className={`shrink-0 w-2 h-2 rounded-full mt-2 ${kindTone(a.kind)}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink-primary/90">
          <span className="font-bold">{a.actorName || 'System'}</span>{' '}
          <span className="text-ink-primary/50">{verbFor(a.kind)}</span>{' '}
          <span className="font-bold">{a.payload?.playerName || a.payload?.teamName || ''}</span>
          {a.payload?.rating && <span className="ml-1 text-amber-600 font-bold">{a.payload.rating}★</span>}
          {a.payload?.totalCents && <span className="ml-1 text-emerald-300 font-bold">${(a.payload.totalCents / 100).toFixed(2)}</span>}
        </div>
        {a.payload?.note && <div className="text-[11px] text-ink-primary/50 mt-0.5 italic">"{a.payload.note}"</div>}
        {a.payload?.subject && <div className="text-[11px] text-ink-primary/50 mt-0.5">{a.payload.subject}</div>}
      </div>
      <div className="text-[10px] text-ink-primary/40 shrink-0 mt-1 tabular-nums">{ts.toLocaleDateString()} · {ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
    </li>
  );
};

function kindTone(kind: Activity['kind']): string {
  if (kind === 'registration_submitted') return 'bg-brand-primary';
  if (kind === 'registration_paid' || kind === 'offer_accepted' || kind === 'player_promoted') return 'bg-emerald-500';
  if (kind === 'offer_sent' || kind === 'tryout_invited') return 'bg-violet-500';
  if (kind === 'offer_declined') return 'bg-rose-500';
  if (kind.startsWith('coach_')) return 'bg-amber-500';
  if (kind === 'email_sent') return 'bg-line-default/40';
  return 'bg-line-default/25';
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
