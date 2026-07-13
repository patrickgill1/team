// InviteCodeModal — manual invite-code entry surface for parents
// who received a code (not a tapped link) from their coach.
//
// Use case: Android parents not yet added to the Play Store beta
// tester list can't install the app, so they land on
// goalkickr.com in the browser. Or a coach dictates the code
// verbally / writes it on a bulletin board. Both flows want a
// "paste your code and go" fallback that skips deep-link
// entirely.
//
// Code shape: 12 alphanumeric characters from
// ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I / O / 0 / 1 to avoid
// visual confusion). Matches the slug in utils/invites.ts. We
// normalize casing + strip anything outside that set, then send
// the user to /join/{code} which is the same route a tapped
// link uses. Every validation error on the code itself surfaces
// downstream in InviteJoin.

import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface Props {
  open: boolean;
  onClose: () => void;
}

const ALLOWED_CHARS = /[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
const EXPECTED_LENGTH = 12;

function normalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').match(ALLOWED_CHARS)?.join('').slice(0, EXPECTED_LENGTH) || '';
}

const InviteCodeModal: React.FC<Props> = ({ open, onClose }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    if (open) {
      setCode('');
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  const valid = code.length === EXPECTED_LENGTH;

  const submit = () => {
    if (!valid || busy) return;
    setBusy(true);
    // Same route a tapped invite link would land on. InviteJoin
    // handles fetch + error surfaces (invalid / revoked / expired
    // / already-consumed) with its own copy, so we don't try to
    // pre-validate here.
    navigate(`/join/${code}`);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Enter invite code"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 shadow-2xl p-6 text-ink-primary"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-black tracking-tight">Enter invite code</h2>
        <p className="mt-1 text-[13px] text-ink-primary/65 leading-snug">
          Paste or type the 12-character code your coach shared. Same as tapping the invite link.
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="mt-4"
          autoComplete="off"
        >
          <input
            ref={inputRef}
            type="text"
            value={code}
            onChange={(e) => setCode(normalize(e.target.value))}
            maxLength={EXPECTED_LENGTH}
            placeholder="ABCDEFGH2345"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            className="w-full rounded-xl bg-line-default/10 ring-1 ring-line-default/20 px-4 py-3 text-xl font-black tracking-[0.25em] text-center outline-none focus:ring-2 focus:ring-brand-primary disabled:opacity-60 font-mono uppercase"
            aria-label="Invite code"
          />

          <p className="mt-2 text-[11px] text-ink-primary/45 text-center tabular-nums">
            {code.length}/{EXPECTED_LENGTH}
          </p>

          <button
            type="submit"
            disabled={!valid || busy}
            className="mt-4 w-full px-4 py-3 rounded-xl bg-brand-primary hover:brightness-110 text-white font-black text-sm shadow disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {busy ? 'Opening...' : 'Continue'}
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mt-2 w-full px-4 py-2 text-[12px] font-semibold text-ink-primary/55 hover:text-ink-primary transition disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
};

export default InviteCodeModal;
