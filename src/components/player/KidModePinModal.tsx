import React, { useEffect, useRef, useState } from 'react';
import { useViewMode } from '../../contexts/ViewModeContext';

type Mode = 'enter' | 'exit';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  mode: Mode;
  /** Required when mode='enter'. Ignored on exit (comes from context). */
  playerId?: string;
  playerName?: string;
}

// Single PIN-entry modal reused for entering AND exiting kid mode.
// PIN verification runs against the player doc's stored hash via
// ViewModeContext (enterKidMode / exitKidMode) — no worker round-trip.
const KidModePinModal: React.FC<Props> = ({ open, onClose, onSuccess, mode, playerId, playerName }) => {
  const { enterKidMode, exitKidMode } = useViewMode();
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setError(null);
      setSubmitting(false);
      // Focus the input on open so it's ready for immediate entry.
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (candidate: string) => {
    if (candidate.length !== 4 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const ok = mode === 'enter'
        ? await enterKidMode(String(playerId), candidate)
        : await exitKidMode(candidate);
      if (!ok) {
        setError('Wrong PIN.');
        setPin('');
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), 30);
        return;
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      console.warn('KidModePinModal submit failed', err);
      setError('Something went wrong. Try again.');
      setSubmitting(false);
    }
  };

  const onChange = (raw: string) => {
    const next = raw.replace(/\D/g, '').slice(0, 4);
    setPin(next);
    setError(null);
    // Auto-submit on full 4 digits — feels like a lock screen, not a form.
    if (next.length === 4) submit(next);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 shadow-2xl p-6 text-ink-primary text-center">
        <h3 className="text-base font-black tracking-tight">
          {mode === 'enter'
            ? `Enter ${playerName || 'player'}'s view`
            : 'Switch back to parent view'}
        </h3>
        <p className="text-xs text-ink-primary/55 mt-1">Enter the 4-digit PIN.</p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={pin}
          onChange={(e) => onChange(e.target.value)}
          disabled={submitting}
          className="mt-4 w-full rounded-xl bg-line-default/10 ring-1 ring-line-default/20 px-3 py-3 text-2xl font-black tracking-[0.6em] text-center outline-none focus:ring-brand-primary disabled:opacity-60"
          placeholder="••••"
          aria-label="PIN"
        />

        {error && <p className="text-sm text-rose-500 mt-3">{error}</p>}

        <button
          onClick={onClose}
          disabled={submitting}
          className="mt-4 text-xs font-semibold text-ink-primary/55 hover:text-ink-primary transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default KidModePinModal;
