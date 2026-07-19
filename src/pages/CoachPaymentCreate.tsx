import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import { grossUpCents, coachNetCents } from '../utils/pricing';
import { intervalLabel } from '../utils/paymentIntervals';
import type { PaymentRecurringInterval, CatalogItem, Player } from '../types';
import { workerFetch } from '../utils/workerFetch';
import { useTeamClubStripeStatus } from '../hooks/useTeamClubStripeStatus';
import StripeConnectBanner from '../components/coach/StripeConnectBanner';

/**
 * Coach Payment Create — /coach/payments/new
 *
 * Two-step flow: pick the kind (three warm cards, not radios), then a
 * kind-specific form. Confirm sheet at the end shows the parent's
 * price and the coach's net so the trade-off is obvious.
 *
 * Warm copy per feedback_copy_voice. Never "invoice" / "billing" —
 * always "collect" / "team dues" / "team store".
 */

type Kind = 'one_off' | 'recurring' | 'catalog';

const KIND_CARDS: Array<{ id: Kind; title: string; hint: string }> = [
  { id: 'one_off', title: 'One-time collection', hint: 'Tournament fees, uniforms, a single ask.' },
  { id: 'recurring', title: 'Recurring dues', hint: 'Monthly, season, or weekly. Charge every family on a cycle.' },
  { id: 'catalog', title: 'Team store', hint: 'Line items families can shop: spirit wear, extras, add-ons.' },
];

const CoachPaymentCreate: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [feeCoveredBy, setFeeCoveredBy] = useState<'player' | 'coach'>('player');
  const [feeDollars, setFeeDollars] = useState('');
  const [intervalDollars, setIntervalDollars] = useState('');
  const [interval, setInterval] = useState<PaymentRecurringInterval>('month');
  const [items, setItems] = useState<CatalogItem[]>([{ id: `it_${Date.now()}`, name: '', priceCents: 0 }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // When /payments/create returns club-not-stripe-ready the worker
  // hands back the exact clubId to onboard. Stash it so the fallback
  // banner uses the authoritative id instead of re-deriving.
  const [errClubId, setErrClubId] = useState<string | null>(null);
  const { clubId: stripeClubId, isReady: stripeIsReady, isLoading: stripeStatusLoading } = useTeamClubStripeStatus();
  // Roster + target-players picker state. Default mode is 'all' so the
  // existing "Everyone on the team" behavior is preserved when the coach
  // never touches the picker. When they flip to 'specific', every roster
  // player starts CHECKED (coach unchecks to exclude) so the fast path
  // stays "send it to almost everyone".
  const [roster, setRoster] = useState<Player[]>([]);
  const [targetMode, setTargetMode] = useState<'all' | 'specific'>('all');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  // Track profile photos that 404 / fail to load so the row falls back to
  // the initials/jersey chip instead of an empty 32x32 slot. Without this
  // a broken img just hides itself and the coach sees a nameless blob.
  const [brokenPhotoIds, setBrokenPhotoIds] = useState<Set<string>>(new Set());

  // Load active roster for the selected team so the picker can show real
  // photos + jersey numbers. Mirrors the pattern already used in
  // CoachPaymentDetail.tsx so any teamId-scoping quirks stay identical.
  useEffect(() => {
    if (!selectedTeamId) { setRoster([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamIds', 'array-contains', selectedTeamId));
        const snap = await getDocs(q);
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false) as Player[];
        list.sort((a, b) => {
          const ja = a.jerseyNumber ?? 999;
          const jb = b.jerseyNumber ?? 999;
          if (ja !== jb) return ja - jb;
          return (a.name || '').localeCompare(b.name || '');
        });
        if (!cancelled) {
          setRoster(list);
          setPickedIds(new Set(list.map(p => p.id)));
        }
      } catch (err) {
        console.warn('[coach-payment-create] roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const feeCents = Math.round((Number(feeDollars) || 0) * 100);
  const intervalCents = Math.round((Number(intervalDollars) || 0) * 100);

  const previewParentPrice = useMemo(() => {
    if (kind === 'one_off' && feeCents > 0) {
      return feeCoveredBy === 'player' ? grossUpCents(feeCents) : feeCents;
    }
    if (kind === 'recurring' && intervalCents > 0) {
      return feeCoveredBy === 'player' ? grossUpCents(intervalCents) : intervalCents;
    }
    return 0;
  }, [kind, feeCents, intervalCents, feeCoveredBy]);
  const previewCoachNet = useMemo(() => {
    if (kind === 'one_off' && feeCents > 0) {
      return feeCoveredBy === 'player' ? feeCents : coachNetCents(feeCents);
    }
    if (kind === 'recurring' && intervalCents > 0) {
      return feeCoveredBy === 'player' ? intervalCents : coachNetCents(intervalCents);
    }
    return 0;
  }, [kind, feeCents, intervalCents, feeCoveredBy]);

  const canSubmit = useMemo(() => {
    if (!kind || !title.trim()) return false;
    // Specific-players mode requires at least one player checked or the
    // request would ship with an empty targetPlayerIds[] and nobody would
    // ever see it.
    if (targetMode === 'specific' && pickedIds.size === 0) return false;
    if (kind === 'one_off') return feeCents >= 100;
    if (kind === 'recurring') return intervalCents >= 100;
    if (kind === 'catalog') return items.some(i => i.name.trim() && i.priceCents > 0);
    return false;
  }, [kind, title, feeCents, intervalCents, items, targetMode, pickedIds]);

  if (!coachOnThisTeam) return <Navigate to="/coach" replace />;

  const submit = async () => {
    if (!kind || !selectedTeamId) return;
    setBusy(true);
    setErr(null);
    setErrClubId(null);
    try {
      const body: any = {
        teamId: selectedTeamId,
        kind,
        title: title.trim(),
        feeCoveredBy,
        targetPlayerIds:
          targetMode === 'all'
            ? 'all'
            : roster
                .map(p => p.id)
                .filter(id => pickedIds.has(id)),
      };
      if (description.trim()) body.description = description.trim();
      if (kind === 'one_off') body.feeCents = feeCents;
      if (kind === 'recurring') { body.intervalCents = intervalCents; body.interval = interval; }
      if (kind === 'catalog') {
        body.items = items
          .filter(i => i.name.trim() && i.priceCents > 0)
          .map((i, idx) => ({
            id: i.id || `it_${Date.now()}_${idx}`,
            name: i.name.trim(),
            priceCents: i.priceCents,
            description: i.description,
            maxPerPlayer: i.maxPerPlayer,
            isActive: true,
          }));
      }
      const res = await workerFetch('/payments/create', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        if (data?.error === 'club-not-stripe-ready') {
          setErrClubId(String(data?.clubId || stripeClubId || ''));
          setErr(data?.hint || 'Set up payments first so families can pay.');
        } else {
          setErr(data?.hint || data?.error || 'Could not create. Try again.');
        }
        setBusy(false);
        return;
      }
      navigate(`/coach/payments/${data.id}`);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title="New team payment"
        subtitle={selectedTeam ? selectedTeam.name : ''}
      />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <Link to="/coach/payments" className="text-brand-primary-soft text-xs font-black uppercase tracking-widest hover:text-brand-primary">
          &larr; Back
        </Link>

        {/* Top-of-form banner is suppressed once the submit path has
            surfaced its own contextual banner via errClubId. Otherwise the
            coach sees two identical "Set up payments" cards on the same
            page. Ref: verifier finding #2 (2026-07-18). */}
        {!stripeStatusLoading && !stripeIsReady && !errClubId && (
          <StripeConnectBanner clubId={stripeClubId} returnTo="/coach/payments" />
        )}

        {!kind && (
          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Pick a type</p>
              <p className="text-ink-primary/70 text-sm mt-1">What are you collecting for?</p>
            </div>
            {KIND_CARDS.map(card => (
              <button
                key={card.id}
                type="button"
                onClick={() => setKind(card.id)}
                className="w-full text-left rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 hover:ring-brand-primary/40 transition p-4 sm:p-5"
              >
                <p className="text-sm font-black text-ink-primary">{card.title}</p>
                <p className="text-[12px] text-ink-primary/60 mt-1 leading-snug">{card.hint}</p>
              </button>
            ))}
          </div>
        )}

        {kind && (
          <div className="space-y-4">
            <div>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">
                {KIND_CARDS.find(c => c.id === kind)?.title}
              </p>
              <button
                type="button"
                onClick={() => setKind(null)}
                className="text-[11px] text-ink-primary/50 hover:text-ink-primary/80"
              >
                Change
              </button>
            </div>

            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Title</span>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder={kind === 'catalog' ? 'Team store' : kind === 'recurring' ? 'Team dues' : 'Vegas tournament'}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Details (optional)</span>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What families should know."
                rows={2}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none resize-none"
              />
            </label>

            {kind === 'one_off' && (
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Amount per player</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-ink-primary/60 font-black">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    value={feeDollars}
                    onChange={e => setFeeDollars(e.target.value)}
                    placeholder="50.00"
                    className="flex-1 px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
                  />
                </div>
                <p className="text-[11px] text-ink-primary/50 mt-1">
                  Multi-kid families pay once per rostered child.
                </p>
              </label>
            )}

            {kind === 'recurring' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Amount</span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-ink-primary/60 font-black">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="1"
                      value={intervalDollars}
                      onChange={e => setIntervalDollars(e.target.value)}
                      placeholder="120.00"
                      className="flex-1 px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
                    />
                  </div>
                </label>
                <label className="block">
                  <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Cycle</span>
                  <select
                    value={interval}
                    onChange={e => setInterval(e.target.value as PaymentRecurringInterval)}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
                  >
                    <option value="week">Every week</option>
                    <option value="month">Every month</option>
                    <option value="season">Every season (4 mo)</option>
                    <option value="year">Every year</option>
                  </select>
                </label>
                <p className="col-span-2 text-[11px] text-ink-primary/50 -mt-1">
                  Charged per family, not per player. Parents cancel any time.
                </p>
              </div>
            )}

            {kind === 'catalog' && (
              <div className="space-y-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Items</p>
                {items.map((item, idx) => (
                  <div key={item.id} className="rounded-xl bg-surface-elevated ring-1 ring-line-default/15 p-3 space-y-2">
                    <input
                      type="text"
                      value={item.name}
                      onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, name: e.target.value } : it))}
                      placeholder="Team hoodie"
                      className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/15 text-ink-primary text-sm outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-ink-primary/60 font-black">$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="1"
                        value={item.priceCents ? (item.priceCents / 100).toString() : ''}
                        onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, priceCents: Math.round((Number(e.target.value) || 0) * 100) } : it))}
                        placeholder="35.00"
                        className="flex-1 px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/15 text-ink-primary text-sm outline-none"
                      />
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setItems(items.filter((_, i) => i !== idx))}
                          className="text-xs text-ink-primary/50 hover:text-ink-primary"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setItems([...items, { id: `it_${Date.now()}_${items.length}`, name: '', priceCents: 0 }])}
                  className="w-full py-2 rounded-lg bg-brand-primary/10 text-brand-primary text-xs font-black uppercase tracking-widest hover:bg-brand-primary/20 transition"
                >
                  Add another item
                </button>
              </div>
            )}

            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4">
              <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Who covers the processing fee?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFeeCoveredBy('player')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                    feeCoveredBy === 'player'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  Player
                </button>
                <button
                  type="button"
                  onClick={() => setFeeCoveredBy('coach')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                    feeCoveredBy === 'coach'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  You
                </button>
              </div>
              {(kind === 'one_off' || kind === 'recurring') && previewParentPrice > 0 && (
                <div className="mt-3 text-[12px] text-ink-primary/70 leading-snug">
                  {feeCoveredBy === 'player'
                    ? `Parents will see $${(previewParentPrice / 100).toFixed(2)}${kind === 'recurring' ? ` ${intervalLabel(interval)}` : ''}. You net $${(previewCoachNet / 100).toFixed(2)}.`
                    : `Parents will see $${(previewParentPrice / 100).toFixed(2)}${kind === 'recurring' ? ` ${intervalLabel(interval)}` : ''}. You net $${(previewCoachNet / 100).toFixed(2)} after processing.`}
                </div>
              )}
            </div>

            {/* Who is this for — target-players picker. Default is
                Everyone; flipping to specific reveals the roster with
                every player pre-checked so the coach unchecks to
                exclude. Coach-only surface (route already guards). */}
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4">
              <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Who is this for?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTargetMode('all')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                    targetMode === 'all'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  Everyone
                </button>
                <button
                  type="button"
                  onClick={() => setTargetMode('specific')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                    targetMode === 'specific'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  Pick specific players
                </button>
              </div>

              {targetMode === 'all' && (
                <p className="mt-3 text-[12px] text-ink-primary/60 leading-snug">
                  Every rostered family sees this request. Add or remove players from the roster and the list keeps up.
                </p>
              )}

              {targetMode === 'specific' && (
                <div className="mt-3 space-y-2">
                  <p className="text-[12px] text-ink-primary/70 leading-snug">
                    {kind === 'catalog'
                      ? 'Skip a family or share with a subset. Only checked players see this store.'
                      : 'Skip a family or bill a subset. Only checked players get billed and pinged.'}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-ink-primary/55">
                      {pickedIds.size} of {roster.length} selected
                    </p>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setPickedIds(new Set(roster.map(p => p.id)))}
                        className="text-[11px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setPickedIds(new Set())}
                        className="text-[11px] font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary transition"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  {roster.length === 0 ? (
                    <p className="text-[12px] text-ink-primary/55 py-2">
                      No active players on this roster yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line-default/10 rounded-xl bg-surface-base ring-1 ring-line-default/15 max-h-72 overflow-y-auto">
                      {roster.map(p => {
                        const checked = pickedIds.has(p.id);
                        const rawPhotoUrl = (p as any).profilePhotoUrl as string | undefined;
                        const photoUrl = rawPhotoUrl && !brokenPhotoIds.has(p.id) ? rawPhotoUrl : undefined;
                        return (
                          <li key={p.id}>
                            <label className="flex items-center gap-3 p-2 sm:p-3 cursor-pointer select-none hover:bg-line-default/[0.04]">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={e => {
                                  setPickedIds(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(p.id);
                                    else next.delete(p.id);
                                    return next;
                                  });
                                }}
                                className="w-4 h-4 accent-brand-primary rounded shrink-0"
                              />
                              {photoUrl ? (
                                <img
                                  src={photoUrl}
                                  alt={p.name}
                                  className="w-8 h-8 rounded-full object-cover ring-1 ring-brand-primary-soft shrink-0"
                                  onError={() => {
                                    setBrokenPhotoIds(prev => {
                                      if (prev.has(p.id)) return prev;
                                      const next = new Set(prev);
                                      next.add(p.id);
                                      return next;
                                    });
                                  }}
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-brand-primary/15 flex items-center justify-center shrink-0">
                                  <span className="text-[11px] font-black text-brand-primary">
                                    {p.jerseyNumber != null ? `#${p.jerseyNumber}` : (p.name || '?').slice(0, 1).toUpperCase()}
                                  </span>
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-black text-ink-primary truncate">{p.name}</p>
                                {p.jerseyNumber != null && (
                                  <p className="text-[11px] text-ink-primary/55">#{p.jerseyNumber}</p>
                                )}
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {err && errClubId && (
              <StripeConnectBanner
                clubId={errClubId}
                headline="Set up payments before sending this out"
                body={err}
                returnTo="/coach/payments"
              />
            )}
            {err && !errClubId && (
              <p className="text-xs text-rose-400">{err}</p>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || busy}
              className="w-full py-3 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest hover:bg-brand-primary/90 transition disabled:opacity-50"
            >
              {busy ? 'Setting up...' : kind === 'catalog' ? 'Open the store' : 'Send it out'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CoachPaymentCreate;
