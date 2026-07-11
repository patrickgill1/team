import React, { useState } from 'react';
import { hashPin, isValidPin } from '../../utils/kidMode';
import { workerFetch } from '../../utils/workerFetch';

interface Props {
  playerId: string;
  playerName: string;
  open: boolean;
  onClose: () => void;
  onEnabled: () => void;
}

// Parent-facing modal to enable kid profile mode on a player. Sets
// a 4-digit PIN, confirms it, POSTs to /players/set-kid-mode. On
// success the caller can flip into kid mode via KidModePinModal.
const KidModeSetupModal: React.FC<Props> = ({ playerId, playerName, open, onClose, onEnabled }) => {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setPin('');
    setConfirm('');
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = async () => {
    setError(null);
    if (!isValidPin(pin)) { setError('PIN must be 4 digits.'); return; }
    if (pin !== confirm) { setError('PINs don\'t match.'); return; }
    setSubmitting(true);
    try {
      const pinHash = await hashPin(playerId, pin);
      const res = await workerFetch('/players/set-kid-mode', {
        method: 'POST',
        body: JSON.stringify({ playerId, action: 'enable', pinHash }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `set-kid-mode ${res.status}`);
      onEnabled();
      handleClose();
    } catch (err: any) {
      console.error('KidModeSetupModal enable failed', err);
      setError('Could not enable kid mode. Try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 shadow-2xl p-6 text-ink-primary">
        <h3 className="text-lg font-black tracking-tight">Give {playerName} their own view</h3>
        <p className="text-sm text-ink-primary/65 mt-1 leading-snug">
          Set a 4-digit PIN. {playerName} will use it to enter their view and to switch back to yours.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-widest font-bold text-ink-primary/60 block mb-1">PIN</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="w-full rounded-xl bg-line-default/10 ring-1 ring-line-default/20 px-3 py-2 text-xl font-black tracking-[0.5em] text-center outline-none focus:ring-brand-primary"
              placeholder="••••"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-widest font-bold text-ink-primary/60 block mb-1">Confirm</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="w-full rounded-xl bg-line-default/10 ring-1 ring-line-default/20 px-3 py-2 text-xl font-black tracking-[0.5em] text-center outline-none focus:ring-brand-primary"
              placeholder="••••"
            />
          </div>
        </div>

        {error && <p className="text-sm text-rose-500 mt-3">{error}</p>}

        <p className="text-[11px] text-ink-primary/45 mt-4 leading-snug">
          Forgot the PIN later? Any parent in the circle can reset it from Player Circle.
        </p>

        <div className="mt-5 flex gap-2">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="flex-1 px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/75 font-semibold text-sm hover:bg-line-default/15 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !pin || !confirm}
            className="flex-1 px-4 py-2 rounded-full bg-brand-primary text-white font-bold text-sm shadow hover:opacity-90 transition disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Enable'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default KidModeSetupModal;
