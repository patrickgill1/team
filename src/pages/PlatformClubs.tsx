import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isOwner } from '../utils/helpers';
import type { Club } from '../types';

// Platform-owner-only control panel. Lists every Club in the project
// with the one knob the owner needs but club admins must NEVER see:
// `platformFeeBps` — GoalKickr's slice of every transaction passed
// through `application_fee_amount` on Stripe Checkout. Gated by the
// hard-coded OWNER_EMAILS allowlist in helpers.ts so a club admin
// can't navigate to this URL and zero out their own fee.
//
// Also surfaces:
//  - Total platform revenue across all clubs
//  - Per-club earnings ($X.XX from N payments)
//  - Default fee for new clubs (persisted to platform_settings/defaults
//    so the worker can lazy-fill on first payment)

const fmtMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const PlatformClubs: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isOwner(userData);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const [defaultBps, setDefaultBps] = useState<string>('0');
  const [defaultBpsSaved, setDefaultBpsSaved] = useState<number>(0);
  const [savingDefault, setSavingDefault] = useState(false);

  const reload = async () => {
    try {
      setLoading(true);
      const [clubsSnap, defaultsSnap] = await Promise.all([
        getDocs(collection(db, 'clubs')),
        getDoc(doc(db, 'platform_settings', 'defaults')).catch(() => null),
      ]);
      const list = clubsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Club);
      setClubs(list);
      setDrafts(Object.fromEntries(list.map(c => [c.id, String(c.platformFeeBps ?? 0)])));
      const defaults = defaultsSnap?.exists() ? defaultsSnap.data() : null;
      const dBps = Number(defaults?.platformFeeBps || 0);
      setDefaultBpsSaved(dBps);
      setDefaultBps(String(dBps));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (allowed) void reload(); }, [allowed]);

  const handleSave = async (club: Club) => {
    const next = Math.max(0, Math.min(10000, Math.round(Number(drafts[club.id] || 0))));
    if (next === (club.platformFeeBps ?? 0)) return;
    setSaving(club.id);
    try {
      await updateDoc(doc(db, 'clubs', club.id), {
        platformFeeBps: next,
        platformFeeBpsAppliedFromDefault: false,
        updatedAt: serverTimestamp(),
      });
      setClubs(prev => prev.map(c => c.id === club.id
        ? { ...c, platformFeeBps: next, platformFeeBpsAppliedFromDefault: false }
        : c));
    } finally {
      setSaving(null);
    }
  };

  const handleSaveDefault = async () => {
    const next = Math.max(0, Math.min(10000, Math.round(Number(defaultBps || 0))));
    if (next === defaultBpsSaved) return;
    setSavingDefault(true);
    try {
      await setDoc(doc(db, 'platform_settings', 'defaults'), {
        platformFeeBps: next,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setDefaultBpsSaved(next);
    } finally {
      setSavingDefault(false);
    }
  };

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-ink-primary/65 text-sm">
        <div className="text-center">
          <div className="text-2xl font-black text-ink-primary mb-2">Restricted</div>
          <p>Platform owner only. This page sets the per-club platform fee — it's intentionally invisible to club admins.</p>
        </div>
      </div>
    );
  }

  const totalEarnedCents = clubs.reduce((sum, c) => sum + (c.platformFeeCentsCollected || 0), 0);
  const totalPayments = clubs.reduce((sum, c) => sum + (c.platformFeePaymentsCount || 0), 0);
  const earningClubs = clubs.filter(c => (c.platformFeeCentsCollected || 0) > 0).length;
  const defaultDirty = Math.round(Number(defaultBps || 0)) !== defaultBpsSaved;

  return (
    <div className="min-h-screen bg-surface-base px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary/85">← Back</Link>
          <h1 className="text-2xl font-black text-ink-primary mt-1">Platform · Clubs</h1>
          <p className="text-sm text-ink-primary/65">
            Per-club GoalKickr platform fee. Stored as basis points (100 = 1%) and applied as the
            <code className="text-[11px] bg-surface-base px-1.5 py-0.5 rounded mx-1">application_fee_amount</code>
            on every checkout. Defaults to 0 (club keeps everything minus the standard card-processing fee).
          </p>
          <p className="text-[11px] text-amber-300 mt-2">
            Disclose the fee on your terms before raising it on an existing club. Surprise platform fees are how SaaS relationships die.
          </p>
        </div>

        {/* Total revenue */}
        <div className="bg-gradient-to-br from-emerald-500/10 via-surface-elevated to-surface-elevated rounded-2xl ring-1 ring-emerald-500/30 p-5">
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-300 mb-1">Platform revenue · lifetime</p>
          <div className="flex items-baseline gap-3 flex-wrap">
            <div className="text-3xl font-black text-ink-primary tabular-nums">{fmtMoney(totalEarnedCents)}</div>
            <div className="text-sm text-ink-primary/55">
              {totalPayments.toLocaleString()} payment{totalPayments === 1 ? '' : 's'} across {earningClubs} club{earningClubs === 1 ? '' : 's'}
            </div>
          </div>
          {totalEarnedCents === 0 && (
            <p className="text-[11px] text-ink-primary/40 mt-2">No earnings yet. Set a default fee below and earnings will start accruing on the next paid registration.</p>
          )}
        </div>

        {/* Default for new clubs */}
        <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="font-bold text-ink-primary">Default for new clubs</h2>
              <p className="text-[11px] text-ink-primary/55 mt-0.5">
                Applied to clubs that haven't been set explicitly. The worker stamps this onto the club's <code className="text-[10px] bg-surface-base px-1 rounded">platformFeeBps</code> field on their first paid registration.
              </p>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65 mb-1">
                Default platform fee (basis points)
              </span>
              <input
                type="number"
                min={0}
                max={10000}
                value={defaultBps}
                onChange={(e) => setDefaultBps(e.target.value)}
                className="w-full px-3 py-2 rounded-lg ring-1 ring-line-default/10 focus:ring-2 focus:ring-brand-primary-soft text-sm bg-surface-base text-ink-primary"
              />
              <p className="text-[10px] text-ink-primary/50 mt-1">
                {Math.round(Number(defaultBps || 0)) === 0
                  ? 'No default — new clubs start at 0%.'
                  : `${(Number(defaultBps) / 100).toFixed(2)}% — on a $300 registration that's ${fmtMoney((300 * Number(defaultBps)) / 100)}.`}
              </p>
            </label>
            <button
              type="button"
              disabled={!defaultDirty || savingDefault}
              onClick={handleSaveDefault}
              className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 disabled:opacity-30 text-white text-sm font-bold"
            >
              {savingDefault ? 'Saving…' : 'Save default'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-6 text-sm text-ink-primary/50">Loading…</div>
        ) : clubs.length === 0 ? (
          <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-8 text-center text-sm text-ink-primary/50">No clubs in the project.</div>
        ) : (
          <ul className="space-y-2">
            {clubs.map(c => {
              const bps = Number(drafts[c.id] || 0);
              const dirty = bps !== (c.platformFeeBps ?? 0);
              const connected = !!c.stripeAccountId;
              const earned = c.platformFeeCentsCollected || 0;
              const payments = c.platformFeePaymentsCount || 0;
              return (
                <li key={c.id} className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 p-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <div className="font-black text-ink-primary">{c.name}</div>
                      <div className="text-[11px] text-ink-primary/50 mt-0.5">
                        {c.id}
                        {' · '}
                        {connected
                          ? <span className="text-emerald-300 font-bold">Payments on</span>
                          : <span className="text-ink-primary/40">Payments off</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {(c.platformFeeBps ?? 0) > 0 && (
                        <span className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-300">
                          Live · {((c.platformFeeBps ?? 0) / 100).toFixed(2)}%
                        </span>
                      )}
                      {c.platformFeeBpsAppliedFromDefault && (
                        <span className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-surface-base text-ink-primary/55 ring-1 ring-line-default/10" title="This club's fee was filled from the platform default at first payment.">
                          From default
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Earnings */}
                  <div className="mb-3 bg-line-default/[0.04] rounded-lg px-3 py-2 flex items-baseline justify-between">
                    <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/40">Earned</span>
                    <span className="text-sm font-bold text-ink-primary tabular-nums">
                      {fmtMoney(earned)}
                      {payments > 0 && <span className="text-ink-primary/40 font-normal text-xs"> · {payments} payment{payments === 1 ? '' : 's'}</span>}
                    </span>
                  </div>

                  <div className="flex items-end gap-2">
                    <label className="flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65 mb-1">
                        Platform fee (basis points)
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        value={drafts[c.id] ?? ''}
                        onChange={(e) => setDrafts(prev => ({ ...prev, [c.id]: e.target.value }))}
                        className="w-full px-3 py-2 rounded-lg ring-1 ring-line-default/10 focus:ring-2 focus:ring-brand-primary-soft text-sm bg-surface-base text-ink-primary"
                      />
                      <p className="text-[10px] text-ink-primary/50 mt-1">
                        {bps === 0
                          ? 'No platform fee — club keeps everything'
                          : `${(bps / 100).toFixed(2)}% — on a $300 registration, GoalKickr nets ${fmtMoney((300 * bps) / 100)}`}
                      </p>
                    </label>
                    <button
                      type="button"
                      disabled={!dirty || saving === c.id}
                      onClick={() => handleSave(c)}
                      className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 disabled:opacity-30 text-white text-sm font-bold"
                    >
                      {saving === c.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>

                  {!connected && (
                    <p className="text-[11px] text-amber-300 mt-2">
                      No effect until this club completes payments onboarding.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default PlatformClubs;
