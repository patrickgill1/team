// @ts-nocheck
// CoachGrantXpModal — the primary "grant live XP" UX. Coach picks
// who, how much, and the reason, then ships. Bulk-friendly: works
// for one kid or the whole squad. Saved reasons land as tap-to-fill
// chips. All writes route through worker /xp/grant-coach so the
// daily-200 per-player cap is enforced server-side (see 2026-07-17
// XP rebalance in worker/src/writeGuards.ts + src/utils/xpLevel.ts).
//
// Presets are a convenience layer, not the primary path — the live
// gesture always leads.
//
// Partial-failure fix (audit 2026-07-11): on partial-success, we
// setSelectedIds(new Set(failedIds)) so a natural "tap again" retry
// only hits the players that failed, not the successful ones. Prior
// version left selectedIds unchanged and re-granted the winners.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Player, Team, CoachRewardPreset } from '../../types';
import { workerFetch } from '../../utils/workerFetch';

interface Props {
  open: boolean;
  onClose: () => void;
  team: Team;
  roster: Player[];
  defaultSelectedIds?: string[];
}

const QUICK_AMOUNTS = [5, 10, 25, 50];
const AMOUNT_MIN = 1;
// AMOUNT_MAX must stay in lockstep with worker COACH_LIVE_XP_PER_PLAYER_PER_DAY
// (writeGuards.ts) so a coach never types a valid-looking amount that the
// server rejects. Both dropped 500 -> 200 in the 2026-07-17 XP rebalance.
const AMOUNT_MAX = 200;
// Soft-warn at 25% of daily budget so a "big moment" grant still feels
// bold without blowing the whole day's ceiling on one recognition.
const AMOUNT_SOFT_WARN = 50;
const REASON_MAX = 80;
const PLAYERS_MAX = 40;

const normLabel = (s: string) => s.trim().toLowerCase();

const CoachGrantXpModal: React.FC<Props> = ({
  open,
  onClose,
  team,
  roster,
  defaultSelectedIds,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(defaultSelectedIds || [])
  );
  const [search, setSearch] = useState('');
  const [amount, setAmount] = useState<number>(10);
  const [reason, setReason] = useState('');
  const [saveAsPreset, setSaveAsPreset] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [inRetry, setInRetry] = useState(false);
  const [flash, setFlash] = useState<null | { granted: number; total: number }>(null);
  const [managePresets, setManagePresets] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set(defaultSelectedIds || []));
    setSearch('');
    setReason('');
    setAmount(10);
    setSaveAsPreset(true);
    setBusy(false);
    setError(null);
    setFailedIds(new Set());
    setInRetry(false);
    setFlash(null);
    setManagePresets(false);
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open, defaultSelectedIds]);

  const activeRoster = useMemo(
    () => roster.filter((p: any) => p && p.isActive !== false),
    [roster]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeRoster;
    return activeRoster.filter(p => (p.name || '').toLowerCase().includes(q));
  }, [activeRoster, search]);

  const presets: CoachRewardPreset[] = useMemo(() => {
    const raw = (team as any)?.xpConfig?.coachRewards;
    return Array.isArray(raw) ? raw : [];
  }, [team]);

  const trimmedReason = reason.trim();
  // Case-insensitive dedup so "Winning team" and "winning team" collapse.
  const savedMatch = presets.find(p => normLabel(p.label) === normLabel(trimmedReason) && p.amount === amount);
  const total = amount * selectedIds.size;
  const overSoft = amount >= AMOUNT_SOFT_WARN;
  const canSubmit =
    !busy
    && selectedIds.size > 0
    && selectedIds.size <= PLAYERS_MAX
    && amount >= AMOUNT_MIN
    && amount <= AMOUNT_MAX
    && trimmedReason.length > 0
    && trimmedReason.length <= REASON_MAX;

  const toggle = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setFailedIds(prev => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev); n.delete(id); return n;
    });
  };

  const selectAll = () => setSelectedIds(new Set(activeRoster.map(p => p.id)));
  const clearAll = () => setSelectedIds(new Set());

  const applyPreset = (p: CoachRewardPreset) => {
    setReason(p.label);
    setAmount(p.amount);
    setSaveAsPreset(false);
  };

  const handleGrant = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workerFetch('/xp/grant-coach', {
        method: 'POST',
        body: JSON.stringify({
          teamId: team.id,
          playerIds: Array.from(selectedIds),
          amount,
          reason: trimmedReason,
          savePreset: saveAsPreset && !savedMatch,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        const code = String(data?.error || '');
        if (code === 'xp_not_enabled') setError('XP is off for this team. Turn it on in Team settings.');
        else if (code === 'amount_out_of_range') setError(data?.message || 'Amount out of range.');
        else if (code === 'too_many_players') setError(data?.message || `Max ${PLAYERS_MAX} players per grant.`);
        else if (code === 'reason_required' || code === 'reason_too_long') setError('Add a short reason.');
        else setError(data?.message || 'Could not grant. Try again.');
        setBusy(false);
        return;
      }
      const results: Array<{ playerId: string; ok: boolean; error?: string }> = Array.isArray(data.results) ? data.results : [];
      const failed = new Set(results.filter(r => !r.ok).map(r => r.playerId));
      if (failed.size > 0) {
        // Retry state: shrink selectedIds to just the failed players so
        // the next Grant tap doesn't re-grant the successful ones.
        // Also flip inRetry so the CTA copy reflects the state.
        setFailedIds(failed);
        setSelectedIds(failed);
        setInRetry(true);
        const granted = Number(data.granted || 0);
        setError(`Sent to ${granted}. ${failed.size} could not be granted. Fix and retry, or Cancel.`);
        setBusy(false);
        return;
      }
      try { (navigator as any)?.vibrate?.(10); } catch { /* ignore */ }
      setFlash({ granted: Number(data.granted || selectedIds.size), total });
      closeTimerRef.current = window.setTimeout(() => { onClose(); }, 700);
    } catch (err: any) {
      setError(err?.message || 'Network error. Try again.');
      setBusy(false);
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    try {
      const res = await workerFetch('/xp/reward-presets', {
        method: 'POST',
        body: JSON.stringify({ teamId: team.id, action: 'delete', presetId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(data?.message || 'Could not delete preset.');
      }
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    }
  };

  if (!open) return null;

  const ctaLabel = busy
    ? 'Granting...'
    : selectedIds.size === 0
      ? 'Pick players'
      : inRetry
        ? `Retry ${selectedIds.size} · ${total} XP`
        : `Grant ${amount} to ${selectedIds.size} · ${total} XP`;

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-full sm:max-w-lg h-[92vh] sm:h-auto sm:max-h-[85vh] bg-surface-elevated text-ink-primary ring-1 ring-line-default/15 shadow-2xl flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <header className="px-4 py-3 border-b border-line-default/10 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest font-black text-brand-primary-soft">Grant XP</p>
            <h3 className="text-base font-black tracking-tight text-ink-primary">Hand it out</h3>
            <p className="text-[11px] text-ink-primary/55 mt-0.5">Live grants. Pick who, how much, and why.</p>
          </div>
          <button
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"
            className="p-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 hover:bg-line-default/15 transition disabled:opacity-40"
            disabled={busy}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
          {flash && (
            <div className="rounded-xl bg-brand-primary/15 ring-1 ring-brand-primary/40 px-3 py-2 text-[12px] text-brand-primary-soft leading-snug">
              Granted. {flash.total} XP total.
            </div>
          )}

          {/* Section 1 — WHO */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">Who</p>
              <span className="text-[11px] font-semibold text-brand-primary-soft">{selectedIds.size} selected</span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary/30 hover:bg-brand-primary/25 transition"
              >
                All roster
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-line-default/10 text-ink-primary/70 ring-1 ring-line-default/20 hover:bg-line-default/15 transition"
              >
                Clear
              </button>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search roster..."
              className="w-full rounded-xl bg-surface-input border border-line-default/15 text-ink-primary placeholder:text-ink-primary/40 text-sm px-3 py-2 focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/40 focus:outline-none"
              style={{ fontSize: '16px' }}
            />
            <div className="mt-2 max-h-56 overflow-y-auto rounded-xl ring-1 ring-line-default/10 divide-y divide-line-default/10">
              {filtered.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-ink-primary/50">No players match.</div>
              )}
              {filtered.map(p => {
                const on = selectedIds.has(p.id);
                const failed = failedIds.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition ${on ? 'bg-brand-primary/10' : 'hover:bg-line-default/5'}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(p.id)}
                      className="w-4 h-4 rounded accent-brand-primary"
                    />
                    <span className="text-sm text-ink-primary flex-1 truncate">
                      {p.name || 'Player'}
                      {typeof (p as any).jerseyNumber === 'number' && (
                        <span className="ml-1.5 text-[10px] text-ink-primary/50">#{(p as any).jerseyNumber}</span>
                      )}
                    </span>
                    {failed && (
                      <span
                        className="w-2 h-2 rounded-full bg-rose-500 ring-2 ring-rose-500/30"
                        title="Grant failed for this player"
                      />
                    )}
                  </label>
                );
              })}
            </div>
          </section>

          {/* Section 2 — HOW MUCH */}
          <section>
            <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55 mb-2">How much</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {QUICK_AMOUNTS.map(q => {
                const on = amount === q;
                return (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setAmount(q)}
                    className={`text-sm font-bold px-3 py-1.5 rounded-full ring-1 transition ${
                      on
                        ? 'bg-brand-primary text-white ring-brand-primary'
                        : 'bg-line-default/10 text-ink-primary ring-line-default/20 hover:bg-line-default/15'
                    }`}
                  >
                    +{q}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={AMOUNT_MIN}
                max={AMOUNT_MAX}
                value={amount}
                onChange={(e) => {
                  const v = Math.max(AMOUNT_MIN, Math.min(AMOUNT_MAX, Math.round(Number(e.target.value) || 0)));
                  setAmount(v);
                }}
                className="w-24 rounded-xl bg-surface-input border border-line-default/15 text-ink-primary text-sm px-3 py-2 focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/40 focus:outline-none"
                style={{ fontSize: '16px' }}
              />
              <span className="text-[11px] text-ink-primary/50">XP per player</span>
              {overSoft && (
                <span className="ml-auto text-[11px] font-bold text-brand-primary-soft">Big one.</span>
              )}
            </div>
          </section>

          {/* Section 3 — REASON */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">Reason</p>
              <span className="text-[11px] text-ink-primary/50">{trimmedReason.length}/{REASON_MAX}</span>
            </div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              placeholder="Winning team, effort of the drill..."
              className="w-full rounded-xl bg-surface-input border border-line-default/15 text-ink-primary placeholder:text-ink-primary/40 text-sm px-3 py-2 focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/40 focus:outline-none"
              style={{ fontSize: '16px' }}
            />

            {presets.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-ink-primary/45">Saved</p>
                  <button
                    type="button"
                    onClick={() => setManagePresets(v => !v)}
                    className="text-[11px] font-semibold text-brand-primary-soft hover:underline"
                  >
                    {managePresets ? 'Done' : 'Manage'}
                  </button>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                  {presets.map(p => (
                    <div key={p.id} className="shrink-0">
                      {managePresets ? (
                        <button
                          type="button"
                          onClick={() => handleDeletePreset(p.id)}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40 hover:bg-rose-500/25 transition inline-flex items-center gap-1.5"
                          title="Delete preset"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                          <span className="truncate max-w-[10rem]">{p.label}</span>
                          <span className="opacity-70">·</span>
                          <span>+{p.amount}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => applyPreset(p)}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-line-default/10 text-ink-primary ring-1 ring-line-default/20 hover:bg-brand-primary/15 hover:ring-brand-primary/40 transition inline-flex items-center gap-1.5"
                        >
                          <span className="truncate max-w-[10rem]">{p.label}</span>
                          <span className="opacity-60">·</span>
                          <span className="text-brand-primary-soft">+{p.amount}</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {trimmedReason.length > 0 && !savedMatch && !managePresets && (
              <label className="mt-3 inline-flex items-center gap-2 text-[12px] text-ink-primary/70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveAsPreset}
                  onChange={(e) => setSaveAsPreset(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-brand-primary"
                />
                <span>Save as preset</span>
              </label>
            )}
            {savedMatch && (
              <p className="mt-3 text-[11px] text-ink-primary/50">This one's already saved.</p>
            )}
          </section>

          {error && (
            <div className="rounded-xl bg-amber-500/15 ring-1 ring-amber-400/30 px-3 py-2 text-[12px] text-amber-100 leading-snug">
              {error}
            </div>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-line-default/10 flex items-center gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/75 font-semibold text-sm hover:bg-line-default/15 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGrant}
            disabled={!canSubmit}
            className="flex-1 min-w-[10rem] px-4 py-2 rounded-full bg-brand-primary text-white font-bold text-sm shadow-md hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50"
          >
            {ctaLabel}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default CoachGrantXpModal;
