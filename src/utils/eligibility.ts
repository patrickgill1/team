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
  switch (status) {
    case 'ready':
      return { bg: 'bg-emerald-50', text: 'text-emerald-800', ring: 'ring-emerald-300', dot: 'bg-emerald-500', label: 'Ready to play' };
    case 'pending':
      return { bg: 'bg-amber-50', text: 'text-amber-800', ring: 'ring-amber-300', dot: 'bg-amber-500', label: 'Almost ready' };
    case 'blocked':
      return { bg: 'bg-rose-50', text: 'text-rose-800', ring: 'ring-rose-300', dot: 'bg-rose-500', label: 'Not eligible' };
    case 'unknown':
    default:
      return { bg: 'bg-slate-50', text: 'text-slate-600', ring: 'ring-slate-300', dot: 'bg-slate-400', label: 'Status unknown' };
  }
}
