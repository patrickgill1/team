import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isOwner } from '../utils/helpers';
import type { Club } from '../types';

// Platform-owner-only control panel. Lists every Club in the project
// with the one knob the owner needs but club admins must NEVER see:
// `platformFeeBps` — Fire FC's slice of every transaction passed
// through `application_fee_amount` on Stripe Checkout. Gated by the
// hard-coded OWNER_EMAILS allowlist in helpers.ts so a club admin
// can't navigate to this URL and zero out their own fee.

const PlatformClubs: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isOwner(userData);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      const snap = await getDocs(collection(db, 'clubs'));
      const list = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Club);
      setClubs(list);
      setDrafts(Object.fromEntries(list.map(c => [c.id, String(c.platformFeeBps ?? 0)])));
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
        updatedAt: serverTimestamp(),
      });
      setClubs(prev => prev.map(c => c.id === club.id ? { ...c, platformFeeBps: next } : c));
    } finally {
      setSaving(null);
    }
  };

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">
        <div className="text-center">
          <div className="text-2xl font-black text-slate-900 mb-2">Restricted</div>
          <p>Platform owner only. This page sets the per-club platform fee — it's intentionally invisible to club admins.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-700">← Back</Link>
          <h1 className="text-2xl font-black text-fire-950 mt-1">Platform · Clubs</h1>
          <p className="text-sm text-slate-600">
            Per-club Fire FC platform fee. Stored as basis points (100 = 1%) and passed to Stripe as
            <code className="text-[11px] bg-slate-100 px-1.5 py-0.5 rounded mx-1">application_fee_amount</code>
            on every Checkout Session. Defaults to 0 (club keeps everything minus Stripe's flat take).
          </p>
          <p className="text-[11px] text-amber-700 mt-2">
            ⚠ Disclose the fee on your terms before raising it on an existing club. Surprise platform fees are how SaaS relationships die.
          </p>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-sm text-slate-500">Loading…</div>
        ) : clubs.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-8 text-center text-sm text-slate-500">No clubs in the project.</div>
        ) : (
          <ul className="space-y-2">
            {clubs.map(c => {
              const bps = Number(drafts[c.id] || 0);
              const dirty = bps !== (c.platformFeeBps ?? 0);
              const connected = !!c.stripeAccountId;
              return (
                <li key={c.id} className="bg-white rounded-2xl ring-1 ring-gray-200 p-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <div className="font-black text-fire-950">{c.name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {c.id}
                        {' · '}
                        {connected
                          ? <span className="text-emerald-700 font-bold">Stripe connected</span>
                          : <span className="text-slate-400">No Stripe</span>}
                      </div>
                    </div>
                    {(c.platformFeeBps ?? 0) > 0 && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300">
                        Live · {((c.platformFeeBps ?? 0) / 100).toFixed(2)}%
                      </span>
                    )}
                  </div>

                  <div className="flex items-end gap-2">
                    <label className="flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">
                        Platform fee (basis points)
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        value={drafts[c.id] ?? ''}
                        onChange={(e) => setDrafts(prev => ({ ...prev, [c.id]: e.target.value }))}
                        className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
                      />
                      <p className="text-[10px] text-slate-500 mt-1">
                        {bps === 0
                          ? 'No platform fee — club keeps everything'
                          : `${(bps / 100).toFixed(2)}% — on a $300 registration, Fire FC nets $${((300 * bps) / 10000).toFixed(2)}`}
                      </p>
                    </label>
                    <button
                      type="button"
                      disabled={!dirty || saving === c.id}
                      onClick={() => handleSave(c)}
                      className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-30 text-white text-sm font-bold"
                    >
                      {saving === c.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>

                  {!connected && (
                    <p className="text-[11px] text-amber-700 mt-2">
                      No effect until this club completes Stripe Connect onboarding.
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
