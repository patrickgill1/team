import type { MedicalProfile } from '../types';

// Critical alerts derived from a player's medical profile. Drives the
// red banner at the top of PersonAdmin and (future) game-day surfaces.
// Three levels:
//   critical: life-threatening + game-day-actionable (EpiPen, active concussion w/o clearance)
//   warning:  notable but not immediately dangerous (severe allergy w/o EpiPen, active EAP)
//   info:     awareness only (active meds, expired physical)

export type MedicalAlertLevel = 'critical' | 'warning' | 'info';

export interface MedicalAlert {
  level: MedicalAlertLevel;
  title: string;
  detail?: string;
}

export function deriveMedicalAlerts(m: MedicalProfile | undefined | null): MedicalAlert[] {
  if (!m) return [];
  const alerts: MedicalAlert[] = [];

  // EpiPen on any allergy → critical.
  const epipenAllergies = (m.allergies || []).filter(a => a.hasEpiPen);
  if (epipenAllergies.length > 0) {
    alerts.push({
      level: 'critical',
      title: `EpiPen required · ${epipenAllergies.map(a => a.substance).join(', ')}`,
      detail: epipenAllergies.map(a => a.notes).filter(Boolean).join(' · ') || undefined,
    });
  }

  // Life-threatening allergies without EpiPen also critical — the
  // coach needs to know even if the EpiPen flag wasn't set.
  const lifeThreatening = (m.allergies || []).filter(a => a.severity === 'life-threatening' && !a.hasEpiPen);
  if (lifeThreatening.length > 0) {
    alerts.push({
      level: 'critical',
      title: `Life-threatening allergy · ${lifeThreatening.map(a => a.substance).join(', ')}`,
      detail: 'EpiPen flag not set — confirm with the family.',
    });
  }

  // Active concussion = had a concussion but no return-to-play clearance.
  const activeConcussion = (m.concussions || []).find(c => !c.clearedToReturnAt);
  if (activeConcussion) {
    alerts.push({
      level: 'critical',
      title: 'Active concussion — not cleared',
      detail: `Reported ${toDate(activeConcussion.date).toLocaleDateString()}. Do NOT play until cleared.`,
    });
  }

  // Conditions with EAPs → warning (the coach needs the plan in their pocket).
  const eapConditions = (m.conditions || []).filter(c => c.eap?.trim());
  for (const c of eapConditions) {
    alerts.push({
      level: 'warning',
      title: `Emergency plan · ${c.name}`,
      detail: c.eap,
    });
  }

  // Severe non-EpiPen allergies → warning.
  const severeAllergies = (m.allergies || []).filter(a => a.severity === 'severe' && !a.hasEpiPen);
  if (severeAllergies.length > 0) {
    alerts.push({
      level: 'warning',
      title: `Severe allergy · ${severeAllergies.map(a => a.substance).join(', ')}`,
      detail: severeAllergies.map(a => a.notes).filter(Boolean).join(' · ') || undefined,
    });
  }

  // Active meds → info (don't clutter the banner with each).
  if ((m.medications || []).length > 0) {
    alerts.push({
      level: 'info',
      title: `${m.medications!.length} active medication${m.medications!.length === 1 ? '' : 's'}`,
    });
  }

  // Physical expiry — most leagues require annual. Warn if > 1 year.
  if (m.lastPhysicalAt) {
    const phys = toDate(m.lastPhysicalAt);
    const ageDays = (Date.now() - phys.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 365) {
      alerts.push({
        level: 'warning',
        title: 'Sports physical expired',
        detail: `Last physical ${phys.toLocaleDateString()}.`,
      });
    }
  }

  return alerts;
}

export function isMedicalComplete(m: MedicalProfile | undefined | null): boolean {
  if (!m) return false;
  // Minimum viable: at least one allergy row (even if "none known"
  // recorded as a NKA row) + one emergency contact OR primaryCare
  // OR last physical date. Loose — we just want to know the admin
  // actually opened and saved the form once.
  const hasAnyAllergyEntry = (m.allergies || []).length > 0;
  const hasContact = !!(m.primaryCare?.phone || m.primaryCare?.name);
  const hasPhysical = !!m.lastPhysicalAt;
  const hasGeneral = !!m.generalNotes?.trim();
  return hasAnyAllergyEntry || hasContact || hasPhysical || hasGeneral;
}

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}
