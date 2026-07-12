// BackfillConfirmModal — coach preview + confirm for retroactive XP.
//
// Two-endpoint flow:
//   1. Open → POST /xp/backfill-preview (dry-run computeBackfillPlan)
//   2. Confirm → POST /xp/backfill-commit with expectedTotalXp matching
//      the preview totals. Worker re-computes the plan fresh and 409s
//      if the numbers drifted (data changed between open and click).
//
// Atomic render: silent for 400ms, then progress hint, then fade-in
// the full preview (per feedback_atomic_render_over_skeletons). No
// shimmer skeletons. Amber for badge chips. Cyan-600 for the primary
// CTA. No emojis, no em dashes in coach-facing copy.
//
// Escape hatches:
//   - "Not now" closes the modal without persisting a dismissal
//     (XpIntroCard stays visible next session, per Patrick's Q4).
//   - "Turn on without retro credit" (only visible in first-enable
//     path) fires the commit with skipGrants=true — flips
//     xpConfig.enabled + backfilledAt without emitting any events.

import React, { useEffect, useState } from 'react';
import { workerFetch } from '../../utils/workerFetch';
import { debugWarn } from '../../utils/debug';
import type { BackfillPreviewResponse, BackfillPreviewLine } from '../../types';

interface Props {
  teamId: string;
  isOpen: boolean;
  triggerSource: 'first_enable' | 'post_enable';
  onClose: () => void;
  onCommitted: (summary: { xpGranted: number; badgesGranted: number; playerCount: number; skipped?: boolean }) => void;
}

const BackfillConfirmModal: React.FC<Props> = ({ teamId, isOpen, triggerSource, onClose, onCommitted }) => {
  const [preview, setPreview] = useState<BackfillPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // showHint gates the progress-hint copy. Starts false, flips true
  // after 400ms if the preview still hasn't landed. Prevents a
  // flash-of-hint for fast responses (per atomic render rule).
  const [showHint, setShowHint] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setError(null);
      setShowHint(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setShowHint(false);
    const hintTimer = setTimeout(() => { if (!cancelled) setShowHint(true); }, 400);

    (async () => {
      try {
        const res = await workerFetch('/xp/backfill-preview', {
          method: 'POST',
          body: JSON.stringify({ teamId }),
        });
        const data: any = await res.json();
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          setError(data?.error === 'not_coach_of_team'
            ? 'Only coaches on this team can preview retro credit.'
            : 'Could not load preview. Try again.');
        } else {
          setPreview(data as BackfillPreviewResponse);
        }
      } catch (err) {
        debugWarn('[backfill] preview fetch failed', err);
        if (!cancelled) setError('Could not load preview. Check your connection.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          clearTimeout(hintTimer);
          setShowHint(false);
        }
      }
    })();

    return () => { cancelled = true; clearTimeout(hintTimer); };
  }, [isOpen, teamId]);

  const commit = async (skipGrants: boolean) => {
    if (committing || !preview) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await workerFetch('/xp/backfill-commit', {
        method: 'POST',
        body: JSON.stringify({
          teamId,
          expectedTotalXp: skipGrants ? 0 : preview.totals.xp,
          skipGrants,
        }),
      });
      const data: any = await res.json();
      if (!res.ok || !data?.ok) {
        if (data?.error === 'preview_stale') {
          setError('Your team data changed since you opened this. Reopen to see the fresh preview.');
        } else if (data?.error === 'already_backfilled') {
          setError('Retro credit was already applied on this team.');
        } else {
          setError('Could not apply retro credit. Try again.');
        }
        setCommitting(false);
        return;
      }
      onCommitted({
        xpGranted: data.summary?.xpGranted ?? 0,
        badgesGranted: data.summary?.badgesGranted ?? 0,
        playerCount: data.summary?.playerCount ?? 0,
        skipped: data.skipped === true,
      });
      onClose();
    } catch (err) {
      debugWarn('[backfill] commit failed', err);
      setError('Could not apply retro credit. Check your connection.');
      setCommitting(false);
    }
  };

  if (!isOpen) return null;

  const totals = preview?.totals;
  const alreadyBackfilled = preview?.alreadyBackfilled === true;
  const nothingToGrant = preview && preview.lines.length === 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Retro XP credit"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-line-default/10">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400">Awards</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-ink-primary">
            {triggerSource === 'first_enable'
              ? 'Turn on XP with retro credit'
              : 'Grant retro credit for pre-XP achievements'}
          </h2>
          <p className="mt-1 text-[13px] text-ink-primary/65 leading-snug">
            This awards XP and badges for goals, assists, POTMs, streaks, and perfect attendance your players already earned. Runs once per team.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30 px-3 py-2 text-[13px] text-amber-100">
              {error}
            </div>
          )}

          {loading && showHint && (
            <p className="text-[13px] text-ink-primary/55 py-6 text-center animate-in fade-in duration-200">
              Reading history...
            </p>
          )}

          {!loading && preview && alreadyBackfilled && (
            <div className="text-center py-6">
              <p className="text-sm font-bold text-ink-primary">Retro credit already applied.</p>
              <p className="mt-1 text-[13px] text-ink-primary/60">Nothing to do here.</p>
            </div>
          )}

          {!loading && preview && !alreadyBackfilled && nothingToGrant && (
            <div className="text-center py-6">
              <p className="text-sm font-bold text-ink-primary">No historical achievements to backfill.</p>
              <p className="mt-1 text-[13px] text-ink-primary/60">
                {triggerSource === 'first_enable'
                  ? 'Turning on XP will start counting from today.'
                  : 'Everything is already accounted for.'}
              </p>
            </div>
          )}

          {!loading && preview && !alreadyBackfilled && !nothingToGrant && (
            <div className="animate-in fade-in duration-300">
              {/* Totals */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                <TotalTile label="XP" value={totals!.xp} tone="cyan" />
                <TotalTile label="Badges" value={totals!.badges} tone="amber" />
                <TotalTile label="Players" value={totals!.players} tone="ink" />
              </div>

              {/* Per-player rows */}
              <ul className="divide-y divide-line-default/10">
                {preview.lines.map(line => (
                  <PlayerRow key={line.playerId} line={line} />
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Sticky action bar */}
        <div className="px-5 pt-3 pb-4 border-t border-line-default/10 bg-surface-elevated flex flex-col gap-2">
          {!loading && preview && !alreadyBackfilled && (
            <button
              type="button"
              onClick={() => commit(false)}
              disabled={committing}
              className="w-full px-4 py-2.5 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white font-black text-sm shadow transition disabled:opacity-50"
            >
              {committing
                ? 'Applying...'
                : nothingToGrant
                  ? (triggerSource === 'first_enable' ? 'Turn on XP' : 'Close')
                  : `Apply retro credit${totals ? ` (+${totals.xp} XP)` : ''}`}
            </button>
          )}

          {!loading && preview && !alreadyBackfilled && triggerSource === 'first_enable' && !nothingToGrant && (
            <button
              type="button"
              onClick={() => commit(true)}
              disabled={committing}
              className="w-full text-[12px] font-semibold text-ink-primary/60 hover:text-ink-primary transition disabled:opacity-50"
            >
              Turn on without retro credit
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            disabled={committing}
            className="w-full px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 font-semibold text-sm hover:bg-line-default/15 transition disabled:opacity-50"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};

const TotalTile: React.FC<{ label: string; value: number; tone: 'cyan' | 'amber' | 'ink' }> = ({ label, value, tone }) => {
  const color = tone === 'cyan' ? 'text-cyan-500'
    : tone === 'amber' ? 'text-amber-400'
    : 'text-ink-primary';
  return (
    <div className="rounded-xl bg-surface-input px-3 py-3 text-center">
      <div className={`text-2xl font-black ${color}`}>{value}</div>
      <div className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mt-1">{label}</div>
    </div>
  );
};

const PlayerRow: React.FC<{ line: BackfillPreviewLine }> = ({ line }) => (
  <li className="py-3 flex items-start gap-3">
    <div className="relative w-10 h-10 rounded-full overflow-hidden ring-1 ring-amber-400/40 shrink-0 bg-line-default/10 flex items-center justify-center">
      {line.playerPhotoUrl ? (
        <img src={line.playerPhotoUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <span className="text-sm font-black text-ink-primary/70">{(line.playerName || '?').charAt(0).toUpperCase()}</span>
      )}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-black text-ink-primary truncate">{line.playerName}</span>
        <span className="text-[12px] font-black text-cyan-500 tabular-nums shrink-0">+{line.xpDelta} XP</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {line.badges.map((b, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 ring-1 ring-amber-400/40 px-2 py-0.5 text-[11px] font-bold text-amber-200"
          >
            {b.label}
            <span className="text-amber-300/70 font-normal">+{b.xp}</span>
          </span>
        ))}
      </div>
    </div>
  </li>
);

export default BackfillConfirmModal;
