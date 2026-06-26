// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';

/**
 * Three-tier email preference UI. Mirrors the structure documented
 * on User.emailPreferences in types/index.ts:
 *
 *   tier1 — transactional + coach. ALWAYS ON, no toggle. Surfaced
 *           as a read-only row so the user understands what they're
 *           still getting (and CAN'T opt out of, by design).
 *   tier2 — club + team email (opt-in default). Wall-post emails,
 *           team announcements, registration drips.
 *   tier3 — GoalKickr marketing (opt-in default). Newsletter, product
 *           announcements, growth campaigns. Mirrors what the
 *           unsubscribe link in any marketing email flips.
 *
 * Treat undefined === true (opted in). Writing sets explicit
 * boolean. lastUnsubscribedAt isn't surfaced here; that's for the
 * worker's re-engagement logic later.
 */

const EmailPreferences: React.FC = () => {
  const { userData } = useAuth();
  const initial = (userData as any)?.emailPreferences || {};
  const [tier2, setTier2] = useState(initial.tier2 !== false);
  const [tier3, setTier3] = useState(initial.tier3 !== false);
  const [saving, setSaving] = useState<'tier2' | 'tier3' | null>(null);

  useEffect(() => {
    const v = (userData as any)?.emailPreferences || {};
    setTier2(v.tier2 !== false);
    setTier3(v.tier3 !== false);
  }, [userData?.uid, (userData as any)?.emailPreferences]);

  const flip = async (which: 'tier2' | 'tier3') => {
    if (!userData || saving) return;
    const next = which === 'tier2' ? !tier2 : !tier3;
    setSaving(which);
    try {
      await updateDoc(doc(db, 'users', userData.uid), {
        [`emailPreferences.${which}`]: next,
        // If they're turning OFF, stamp the unsubscribe timestamp so
        // re-engagement flows can target this exact opt-out date.
        ...(next ? {} : { 'emailPreferences.lastUnsubscribedAt': new Date() }),
      });
      if (which === 'tier2') setTier2(next);
      else setTier3(next);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[email prefs] save failed', e);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="bg-charcoal-900 rounded-xl border border-white/10 overflow-hidden divide-y divide-white/5">
      {/* tier 1 — read-only, just to set expectations */}
      <Row
        label="Account + coach messages"
        hint="Password resets, billing receipts, parent whispers, RSVP confirmations. Always on (required)."
        on={true}
        readonly
      />
      <Row
        label="Club and team emails"
        hint="Wall post blasts, registration drips, team announcements."
        on={tier2}
        busy={saving === 'tier2'}
        onToggle={() => flip('tier2')}
      />
      <Row
        label="GoalKickr updates"
        hint="Product announcements, new features, occasional newsletter."
        on={tier3}
        busy={saving === 'tier3'}
        onToggle={() => flip('tier3')}
      />
    </div>
  );
};

const Row: React.FC<{
  label: string;
  hint: string;
  on: boolean;
  busy?: boolean;
  readonly?: boolean;
  onToggle?: () => void;
}> = ({ label, hint, on, busy, readonly, onToggle }) => (
  <div className="flex items-start justify-between gap-3 px-4 py-3">
    <div className="flex-1 min-w-0">
      <p className="text-sm font-bold text-bone">{label}</p>
      <p className="text-xs text-bone/55 mt-0.5 leading-snug">{hint}</p>
    </div>
    {readonly ? (
      <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded-full bg-charcoal-800 text-bone/55 ring-1 ring-white/10">
        Required
      </span>
    ) : (
      <button
        type="button"
        onClick={onToggle}
        disabled={!!busy}
        className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition ${
          on ? 'bg-brand-primary' : 'bg-white/15'
        } disabled:opacity-50`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            on ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    )}
  </div>
);

export default EmailPreferences;
