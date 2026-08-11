import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { logActivity } from '../../utils/activityLog';
import type { MedicalProfile } from '../../types';

// Full structured medical editor. Each section (allergies, conditions,
// medications, concussions) is an add/edit/remove list. Pre-fills from
// the legacy free-text Player.medicalInfo field on first open so admin
// can fold notes into rows. Saves to Player.medical and writes a
// medical_updated activity for the audit trail.

interface Props {
  player: any; // Firestore player doc with optional medical + medicalInfo
  actorUid: string;
  actorName: string;
  onClose: () => void;
  onSaved: () => void;
}

type AnyRow = Record<string, any>;

const newRow = (extra: Record<string, any> = {}): AnyRow => ({
  id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  ...extra,
});

const MedicalEditModal: React.FC<Props> = ({ player, actorUid, actorName, onClose, onSaved }) => {
  const initial: MedicalProfile = player.medical || {};

  const [allergies, setAllergies] = useState<AnyRow[]>(initial.allergies || []);
  const [conditions, setConditions] = useState<AnyRow[]>(initial.conditions || []);
  const [medications, setMedications] = useState<AnyRow[]>(initial.medications || []);
  const [concussions, setConcussions] = useState<AnyRow[]>(initial.concussions || []);
  const [primaryCare, setPrimaryCare] = useState(initial.primaryCare || {});
  const [insurance, setInsurance] = useState(initial.insurance || {});
  const [lastPhysicalAt, setLastPhysicalAt] = useState<string>(initial.lastPhysicalAt ? toDateInput(initial.lastPhysicalAt) : '');
  const [bloodType, setBloodType] = useState<string>(initial.bloodType || '');
  const [generalNotes, setGeneralNotes] = useState<string>(
    initial.generalNotes || player.medicalInfo || '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upd = <T,>(setter: React.Dispatch<React.SetStateAction<T[]>>, i: number, patch: Partial<T>) => {
    setter(prev => prev.map((row, idx) => idx === i ? { ...(row as any), ...patch } : row));
  };
  const rm = <T,>(setter: React.Dispatch<React.SetStateAction<T[]>>, i: number) => {
    setter(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: MedicalProfile = {
        allergies: allergies.map(a => ({
          id: a.id,
          substance: String(a.substance || '').trim(),
          severity: a.severity || undefined,
          hasEpiPen: !!a.hasEpiPen,
          notes: a.notes?.trim() || undefined,
        })).filter(a => a.substance),
        conditions: conditions.map(c => ({
          id: c.id,
          name: String(c.name || '').trim(),
          severity: c.severity || undefined,
          eap: c.eap?.trim() || undefined,
          notes: c.notes?.trim() || undefined,
        })).filter(c => c.name),
        medications: medications.map(m => ({
          id: m.id,
          name: String(m.name || '').trim(),
          dosage: m.dosage?.trim() || undefined,
          schedule: m.schedule?.trim() || undefined,
          notes: m.notes?.trim() || undefined,
        })).filter(m => m.name),
        concussions: concussions.map(c => ({
          id: c.id,
          date: c.date ? new Date(c.date) : new Date(),
          severity: c.severity || undefined,
          clearedToReturnAt: c.clearedToReturnAt ? new Date(c.clearedToReturnAt) : undefined,
          notes: c.notes?.trim() || undefined,
        })),
        primaryCare: (primaryCare.name || primaryCare.phone || primaryCare.practice)
          ? {
              name: primaryCare.name?.trim() || undefined,
              phone: primaryCare.phone?.trim() || undefined,
              practice: primaryCare.practice?.trim() || undefined,
            }
          : undefined,
        insurance: (insurance.carrier || insurance.policyNumber || insurance.groupNumber)
          ? {
              carrier: insurance.carrier?.trim() || undefined,
              policyNumber: insurance.policyNumber?.trim() || undefined,
              groupNumber: insurance.groupNumber?.trim() || undefined,
            }
          : undefined,
        lastPhysicalAt: lastPhysicalAt ? new Date(lastPhysicalAt) : undefined,
        bloodType: (bloodType || undefined) as MedicalProfile['bloodType'],
        generalNotes: generalNotes.trim() || undefined,
        updatedAt: new Date(),
        updatedByUid: actorUid,
        updatedByName: actorName,
      };

      await updateDoc(doc(db, 'players', player.id), {
        medical: payload,
        // Clear the legacy field once admin has folded it in — keeps
        // the migration one-way and avoids the editor showing stale
        // unstructured text next time.
        ...(player.medicalInfo && generalNotes.trim() ? { medicalInfo: null } : {}),
        updatedAt: serverTimestamp(),
      });

      await logActivity({
        clubId: player.clubId,
        kind: 'medical_updated',
        playerId: player.id,
        teamId: player.teamId,
        actorUid,
        actorName,
        payload: {
          allergiesCount: payload.allergies?.length || 0,
          conditionsCount: payload.conditions?.length || 0,
          medsCount: payload.medications?.length || 0,
          concussionsCount: payload.concussions?.length || 0,
          hasEpiPen: (payload.allergies || []).some(a => a.hasEpiPen),
        },
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Medical profile</h2>
            <p className="text-[11px] text-ink-primary/55">{player.name}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {player.medicalInfo && !(initial.generalNotes || '').trim() && (
            <div className="rounded-lg bg-amber-50 ring-1 ring-amber-300 px-3 py-2 text-[11px] text-amber-900">
              Legacy notes auto-loaded into <b>General notes</b> below — fold them into the structured sections, then save to clear the old field.
            </div>
          )}

          {/* Allergies */}
          <Section
            title="Allergies"
            onAdd={() => setAllergies([...allergies, newRow({ substance: '', hasEpiPen: false })])}
          >
            {allergies.length === 0 && <Empty text="None known. Add a row even if 'No known allergies' is the answer — confirms the field has been reviewed." />}
            {allergies.map((a, i) => (
              <Row key={a.id} onRemove={() => rm(setAllergies, i)}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <input value={a.substance || ''} onChange={(e) => upd(setAllergies, i, { substance: e.target.value })} placeholder="Peanuts" className="col-span-2 sm:col-span-1 input-sm" />
                  <select value={a.severity || ''} onChange={(e) => upd(setAllergies, i, { severity: e.target.value })} className="input-sm">
                    <option value="">Severity</option>
                    <option value="mild">Mild</option>
                    <option value="moderate">Moderate</option>
                    <option value="severe">Severe</option>
                    <option value="life-threatening">Life-threatening</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                    <input type="checkbox" checked={!!a.hasEpiPen} onChange={(e) => upd(setAllergies, i, { hasEpiPen: e.target.checked })} />
                    EpiPen
                  </label>
                  <input value={a.notes || ''} onChange={(e) => upd(setAllergies, i, { notes: e.target.value })} placeholder="Notes" className="input-sm" />
                </div>
              </Row>
            ))}
          </Section>

          {/* Conditions */}
          <Section
            title="Conditions"
            onAdd={() => setConditions([...conditions, newRow({ name: '' })])}
          >
            {conditions.length === 0 && <Empty text="Asthma, diabetes, ADHD, seizure disorder, etc. EAP = what to do during an episode." />}
            {conditions.map((c, i) => (
              <Row key={c.id} onRemove={() => rm(setConditions, i)}>
                <div className="grid grid-cols-2 gap-2">
                  <input value={c.name || ''} onChange={(e) => upd(setConditions, i, { name: e.target.value })} placeholder="Asthma" className="input-sm" />
                  <select value={c.severity || ''} onChange={(e) => upd(setConditions, i, { severity: e.target.value })} className="input-sm">
                    <option value="">Severity</option>
                    <option value="mild">Mild</option>
                    <option value="moderate">Moderate</option>
                    <option value="severe">Severe</option>
                  </select>
                </div>
                <textarea value={c.eap || ''} onChange={(e) => upd(setConditions, i, { eap: e.target.value })} rows={2} placeholder="Emergency action plan (what to do in an episode)" className="input-sm mt-2 w-full" />
                <input value={c.notes || ''} onChange={(e) => upd(setConditions, i, { notes: e.target.value })} placeholder="Notes" className="input-sm mt-2 w-full" />
              </Row>
            ))}
          </Section>

          {/* Medications */}
          <Section
            title="Medications"
            onAdd={() => setMedications([...medications, newRow({ name: '' })])}
          >
            {medications.length === 0 && <Empty text="Active prescriptions the kid takes. Useful so coaches know what to expect (e.g. mid-game behavior changes if a dose is missed)." />}
            {medications.map((m, i) => (
              <Row key={m.id} onRemove={() => rm(setMedications, i)}>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <input value={m.name || ''} onChange={(e) => upd(setMedications, i, { name: e.target.value })} placeholder="Albuterol" className="input-sm" />
                  <input value={m.dosage || ''} onChange={(e) => upd(setMedications, i, { dosage: e.target.value })} placeholder="2 puffs" className="input-sm" />
                  <input value={m.schedule || ''} onChange={(e) => upd(setMedications, i, { schedule: e.target.value })} placeholder="As needed" className="input-sm" />
                </div>
                <input value={m.notes || ''} onChange={(e) => upd(setMedications, i, { notes: e.target.value })} placeholder="Notes" className="input-sm mt-2 w-full" />
              </Row>
            ))}
          </Section>

          {/* Concussions */}
          <Section
            title="Concussion history"
            onAdd={() => setConcussions([...concussions, newRow({ date: new Date().toISOString().slice(0, 10) })])}
          >
            {concussions.length === 0 && <Empty text="Critical for soccer — kids with an active concussion (no clearance) get a critical alert at the top of their profile until cleared." />}
            {concussions.map((c, i) => (
              <Row key={c.id} onRemove={() => rm(setConcussions, i)}>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block text-[10px] font-bold uppercase text-ink-primary/55">
                    Date
                    <input type="date" value={toDateInput(c.date)} onChange={(e) => upd(setConcussions, i, { date: e.target.value })} className="input-sm w-full mt-0.5" />
                  </label>
                  <label className="block text-[10px] font-bold uppercase text-ink-primary/55">
                    Severity
                    <select value={c.severity || ''} onChange={(e) => upd(setConcussions, i, { severity: e.target.value })} className="input-sm w-full mt-0.5">
                      <option value="">—</option>
                      <option value="mild">Mild</option>
                      <option value="moderate">Moderate</option>
                      <option value="severe">Severe</option>
                    </select>
                  </label>
                  <label className="block text-[10px] font-bold uppercase text-ink-primary/55">
                    Cleared to return
                    <input type="date" value={toDateInput(c.clearedToReturnAt)} onChange={(e) => upd(setConcussions, i, { clearedToReturnAt: e.target.value })} className="input-sm w-full mt-0.5" />
                  </label>
                </div>
                <input value={c.notes || ''} onChange={(e) => upd(setConcussions, i, { notes: e.target.value })} placeholder="Notes" className="input-sm mt-2 w-full" />
              </Row>
            ))}
          </Section>

          {/* Care + insurance + physical */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Primary care doctor — name">
              <input value={primaryCare.name || ''} onChange={(e) => setPrimaryCare({ ...primaryCare, name: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Primary care — phone">
              <input value={primaryCare.phone || ''} onChange={(e) => setPrimaryCare({ ...primaryCare, phone: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Practice">
              <input value={primaryCare.practice || ''} onChange={(e) => setPrimaryCare({ ...primaryCare, practice: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Insurance carrier">
              <input value={insurance.carrier || ''} onChange={(e) => setInsurance({ ...insurance, carrier: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Policy number">
              <input value={insurance.policyNumber || ''} onChange={(e) => setInsurance({ ...insurance, policyNumber: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Group number">
              <input value={insurance.groupNumber || ''} onChange={(e) => setInsurance({ ...insurance, groupNumber: e.target.value })} className="input-sm w-full" />
            </Field>
            <Field label="Last sports physical">
              <input type="date" value={lastPhysicalAt} onChange={(e) => setLastPhysicalAt(e.target.value)} className="input-sm w-full" />
            </Field>
            <Field label="Blood type (optional)">
              <select value={bloodType} onChange={(e) => setBloodType(e.target.value)} className="input-sm w-full">
                <option value="">—</option>
                {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>

          <Field label="General notes">
            <textarea value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)} rows={3} placeholder="Anything that doesn't fit elsewhere" className="input-sm w-full" />
          </Field>

          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Save medical profile'}
          </button>
        </div>

        <style>{`.input-sm{padding:.5rem .75rem;border:1px solid rgb(226 232 240);border-radius:.5rem;font-size:.875rem;}.input-sm:focus{outline:none;box-shadow:0 0 0 2px rgb(103 232 249 / .6);}`}</style>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; onAdd: () => void; children: React.ReactNode }> = ({ title, onAdd, children }) => (
  <div>
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-slate-700">{title}</h3>
      <button type="button" onClick={onAdd} className="text-[11px] font-bold text-brand-primary hover:text-brand-primary-dim">+ Add</button>
    </div>
    <div className="space-y-2">{children}</div>
  </div>
);

const Row: React.FC<{ onRemove: () => void; children: React.ReactNode }> = ({ onRemove, children }) => (
  <div className="bg-slate-50 ring-1 ring-slate-200 rounded-xl p-3 relative">
    <button type="button" onClick={onRemove} className="absolute top-1.5 right-2 text-slate-400 hover:text-rose-600 text-lg leading-none">×</button>
    {children}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">{label}</span>
    {children}
  </label>
);

const Empty: React.FC<{ text: string }> = ({ text }) => <p className="text-[11px] text-ink-primary/55">{text}</p>;

function toDateInput(v: any): string {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : (v?.toDate?.() || new Date(v));
  if (isNaN(d.getTime?.())) return '';
  return d.toISOString().slice(0, 10);
}

export default MedicalEditModal;
