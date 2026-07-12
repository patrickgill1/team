import React, { useEffect, useRef, useState } from 'react';
import { useViewMode } from '../../contexts/ViewModeContext';
import { debugWarn } from '../../utils/debug';

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
//
// PIN input is split across four per-digit slots so no single DOM
// node ever holds the whole PIN as a copyable value. Prior version
// used one <input type="password"> whose value attribute rendered
// as `value="3448"` in DevTools plus a Chromium "password field not
// in a form" warning — flagged 2026-07-12 as a real-user-visible
// leak. Split fixes both: DevTools shows one digit per slot at most,
// no single attribute contains the whole PIN, and the wrapping
// <form> satisfies the Chromium heuristic. Also: no
// autoComplete="one-time-code" (this is a persistent PIN, not an
// SMS OTP; that hint made the browser treat it as a login field).
const KidModePinModal: React.FC<Props> = ({ open, onClose, onSuccess, mode, playerId, playerName }) => {
  const { enterKidMode, exitKidMode } = useViewMode();
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (open) {
      setDigits(['', '', '', '']);
      setError(null);
      setSubmitting(false);
      setTimeout(() => refs.current[0]?.focus(), 30);
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
        setDigits(['', '', '', '']);
        setSubmitting(false);
        setTimeout(() => refs.current[0]?.focus(), 30);
        return;
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      debugWarn('KidModePinModal submit failed', err);
      setError('Something went wrong. Try again.');
      setSubmitting(false);
    }
  };

  // setDigit handles three cases:
  //   1. Empty change (delete key) — clear this slot, do not advance.
  //   2. Single-digit typing — fill this slot, advance focus, auto-
  //      submit when all four are filled.
  //   3. Multi-digit paste (OTP autofill, clipboard) — distribute
  //      from slot 0 regardless of which slot got the paste event,
  //      then auto-submit if full.
  const setDigit = (idx: number, raw: string) => {
    const stripped = raw.replace(/\D/g, '');
    if (!stripped) {
      setDigits(prev => {
        const next = [...prev];
        next[idx] = '';
        return next;
      });
      setError(null);
      return;
    }
    if (stripped.length > 1) {
      const next = ['', '', '', ''];
      for (let i = 0; i < Math.min(stripped.length, 4); i++) next[i] = stripped[i];
      setDigits(next);
      setError(null);
      const filled = next.filter(Boolean).length;
      setTimeout(() => {
        if (filled >= 4) {
          submit(next.join(''));
        } else {
          refs.current[Math.min(filled, 3)]?.focus();
        }
      }, 0);
      return;
    }
    setDigits(prev => {
      const next = [...prev];
      next[idx] = stripped;
      const filled = next.filter(Boolean).length;
      const targetIdx = Math.min(idx + 1, 3);
      setTimeout(() => {
        if (filled >= 4) {
          submit(next.join(''));
        } else {
          refs.current[targetIdx]?.focus();
        }
      }, 0);
      return next;
    });
    setError(null);
  };

  const onKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      // Empty slot + backspace: jump back and clear the previous
      // slot in one motion so users don't have to backspace twice.
      e.preventDefault();
      setDigits(prev => {
        const next = [...prev];
        next[idx - 1] = '';
        return next;
      });
      refs.current[idx - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      refs.current[idx - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && idx < 3) {
      e.preventDefault();
      refs.current[idx + 1]?.focus();
      return;
    }
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (digits.every(Boolean)) submit(digits.join(''));
          }}
          className="mt-4 flex items-center justify-center gap-2"
          autoComplete="off"
        >
          {digits.map((d, idx) => (
            <input
              key={idx}
              ref={(el) => { refs.current[idx] = el; }}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]*"
              maxLength={4}
              value={d}
              onChange={(e) => setDigit(idx, e.target.value)}
              onKeyDown={(e) => onKeyDown(idx, e)}
              disabled={submitting}
              className="w-12 h-14 rounded-xl bg-line-default/10 ring-1 ring-line-default/20 text-2xl font-black text-center outline-none focus:ring-2 focus:ring-brand-primary disabled:opacity-60"
              aria-label={`PIN digit ${idx + 1}`}
            />
          ))}
        </form>

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
