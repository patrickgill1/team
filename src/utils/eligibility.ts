import type { FormDefinition, FormSignature, Registration } from '../types';

// "Can this kid play?" — the one boolean a coach actually wants to scan
// before tomorrow's practice. Combines: on a team, registration paid,
// all required forms signed. Returns a status + per-gate breakdown so
// the UI can show why a kid is pending.

export type EligibilityStatus = 'ready' | 'pending' | 'blocked' | 'unknown';

export interface EligibilityGate {
  ok: boolean;
  label: string;
  /** Optional detail rendered under the gate row when not ok. */
  hint?: string;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  gates: EligibilityGate[];
  /** Convenience counts for quick at-a-glance UIs (badge dot etc.). */
  passedCount: number;
  totalCount: number;
}

export interface EligibilityInput {
  player: { teamId?: string; teamIds?: string[] };
  registrations: Registration[];
  forms: FormDefinition[];
  formSigs: Map<string, FormSignature>;
}

export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const hasTeam = !!input.player.teamId || (input.player.teamIds?.length ?? 0) > 0;

  // "Paid" is loose by design — any non-pending registration counts. A
  // family that's been invited to tryouts but not formally paid yet
  // still passes because admin manually advanced their status (manual
  // mark-paid is a common path before Stripe Connect is live).
  const latest = input.registrations[0];
  const paidStatuses: Registration['status'][] = ['paid', 'tryout_invited', 'offer_sent', 'accepted'];
  const hasPaid = !!latest && paidStatuses.includes(latest.status);
  // If there's no registration at all we treat fee as a non-blocker —
  // the kid may be a manually-rostered legacy player. Coaches will
  // notice "No registration on file" elsewhere.
  const hasRegistration = !!latest;

  const requiredForms = input.forms.filter(f => f.required);
  const unsignedRequired = requiredForms.filter(f => !input.formSigs.has(f.id));
  const allRequiredSigned = unsignedRequired.length === 0;

  const gates: EligibilityGate[] = [
    {
      ok: hasTeam,
      label: hasTeam ? 'Rostered on a team' : 'Not on any team',
      hint: hasTeam ? undefined : 'Assign to a team from the Teams tab.',
    },
    {
      ok: !hasRegistration || hasPaid,
      label: !hasRegistration
        ? 'No registration required'
        : hasPaid ? 'Registration paid' : 'Registration not paid',
      hint: hasRegistration && !hasPaid
        ? `Latest registration is "${latest!.status.replace('_', ' ')}"`
        : undefined,
    },
    {
      ok: allRequiredSigned,
      label: allRequiredSigned
        ? requiredForms.length === 0
          ? 'No required forms'
          : `All ${requiredForms.length} required form${requiredForms.length === 1 ? '' : 's'} signed`
        : `${unsignedRequired.length} required form${unsignedRequired.length === 1 ? '' : 's'} unsigned`,
      hint: allRequiredSigned ? undefined : unsignedRequired.map(f => f.name).join(', '),
    },
  ];

  const passedCount = gates.filter(g => g.ok).length;
  const totalCount = gates.length;
  const blockerCount = totalCount - passedCount;

  let status: EligibilityStatus;
  if (passedCount === totalCount) status = 'ready';
  else if (blockerCount === 1) status = 'pending';
  else status = 'blocked';

  return { status, gates, passedCount, totalCount };
}

export function eligibilityTone(status: EligibilityStatus): { bg: string; text: string; ring: string; dot: string; label: string } {
  // Dark-mode tints: bone+colored-300 on a translucent colored wash so the
  // card reads against the charcoal-950 page background. The text token
  // is what the parent uses for both the pill label AND the card heading;
  // anything below ~AA-on-dark fails for kids reading on outdoor fields.
  switch (status) {
    case 'ready':
      return { bg: 'bg-emerald-500/15', text: 'text-emerald-200', ring: 'ring-emerald-400/30', dot: 'bg-emerald-400', label: 'Ready to play' };
    case 'pending':
      return { bg: 'bg-amber-500/15', text: 'text-amber-200', ring: 'ring-amber-400/30', dot: 'bg-amber-400', label: 'Almost ready' };
    case 'blocked':
      return { bg: 'bg-rose-500/15', text: 'text-rose-200', ring: 'ring-rose-400/30', dot: 'bg-rose-400', label: 'Not eligible' };
    case 'unknown':
    default:
      return { bg: 'bg-white/5', text: 'text-bone/70', ring: 'ring-white/15', dot: 'bg-white/40', label: 'Status unknown' };
  }
}
