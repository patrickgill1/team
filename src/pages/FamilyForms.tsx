// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { logActivity } from '../utils/activityLog';
import type { FormDefinition, Player, RegistrationQuestion } from '../types';

// Parent-facing inbox of unsigned waivers / releases / consents.
// Lists each kid + their pending forms; tapping one opens the inline
// sign UI (read full text → type your name → submit). Signing writes
// a form_signatures doc keyed ${playerId}_${formId} so the existing
// PersonAdmin checklist + the eligibility computer pick it up with
// zero schema work on their side.
//
// Push notifications from /club/forms deep-link here so a "we need
// you to sign X" tap lands exactly where the family can act.

interface PendingForm {
  player: Player;
  form: FormDefinition;
}

const FamilyForms: React.FC = () => {
  const { userData } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingForm[]>([]);
  const [signing, setSigning] = useState<{ playerId: string; formId: string } | null>(null);
  const [signedByName, setSignedByName] = useState('');
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [savingSig, setSavingSig] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userData?.uid) { setLoading(false); return; }
      try {
        setLoading(true);
        // Kids this parent has linked. Standard parentIds array-contains
        // path; falls back to email match for legacy parents whose
        // accounts predate parentIds.
        const kidsSnap = await getDocs(query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
        ));
        let kids: Player[] = kidsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Player);
        if (kids.length === 0 && userData.email) {
          const byEmail = await getDocs(query(
            collection(db, 'players'),
            where('parentEmails', 'array-contains', userData.email.toLowerCase()),
          ));
          kids = byEmail.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Player);
        }
        kids = kids.filter(k => k.isActive !== false);
        if (cancelled) return;

        // Forms scoped to each kid's club. Pull once per unique clubId
        // so a multi-club family doesn't refetch the same definitions.
        const clubIds = Array.from(new Set(kids.map(k => (k as any).clubId).filter(Boolean)));
        const formsByClub: Record<string, FormDefinition[]> = {};
        await Promise.all(clubIds.map(async (cid: string) => {
          try {
            const snap = await getDocs(query(
              collection(db, 'form_definitions'),
              where('clubId', '==', cid),
            ));
            formsByClub[cid] = snap.docs
              .map(d => ({ id: d.id, ...(d.data() as any) }) as FormDefinition)
              .filter(f => f.isActive !== false);
          } catch (err) {
            console.warn('form_definitions load failed for club', cid, err);
            formsByClub[cid] = [];
          }
        }));

        // Compute pending: for each kid x each applicable form, check
        // whether a form_signatures doc exists. We key by composite id
        // so it's a single getDoc per (kid, form) — cheap at this scale.
        const list: PendingForm[] = [];
        for (const kid of kids) {
          const clubId = (kid as any).clubId;
          const all = formsByClub[clubId] || [];
          // Age-group scoping is best-effort: the kid's primary teams
          // expose their ageGroup elsewhere, but we don't query for it
          // here. Coaches who only want a form to apply to U10 should
          // mark the form's ageGroups[] and the eligibility filter on
          // the form side will hide non-matching cards via the same
          // computation that runs in PersonAdmin.
          for (const form of all) {
            const hasQuestions = Array.isArray(form.questions) && form.questions.length > 0;
            const hasBody = !!(form.body && form.body.trim());
            const docId = `${kid.id}_${form.id}`;
            // Pending iff a required artifact is missing:
            //   pure signature → form_signatures must exist
            //   pure questionnaire → form_submissions must exist
            //   mixed → both must exist
            let signed = false;
            let submitted = false;
            try {
              const sigSnap = await getDoc(doc(db, 'form_signatures', docId));
              signed = sigSnap.exists();
            } catch { /* treat as unsigned */ }
            if (hasQuestions) {
              try {
                const subSnap = await getDoc(doc(db, 'form_submissions', docId));
                submitted = subSnap.exists();
              } catch { /* treat as unsubmitted */ }
            }
            const needsSign = hasBody && !signed;
            const needsSubmit = hasQuestions && !submitted;
            // If neither artifact is required (form has no body AND no
            // questions — basically empty), don't surface it.
            if (!hasBody && !hasQuestions) continue;
            if (needsSign || needsSubmit) list.push({ player: kid, form });
          }
        }
        // Required forms float to the top; within each group, alpha by
        // form name for predictable ordering.
        list.sort((a, b) => {
          if (a.form.required && !b.form.required) return -1;
          if (!a.form.required && b.form.required) return 1;
          return (a.form.name || '').localeCompare(b.form.name || '');
        });
        if (!cancelled) setPending(list);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, savedCount]);

  const groups = useMemo(() => {
    const m = new Map<string, { player: Player; forms: FormDefinition[] }>();
    for (const p of pending) {
      const k = p.player.id;
      if (!m.has(k)) m.set(k, { player: p.player, forms: [] });
      m.get(k)!.forms.push(p.form);
    }
    return Array.from(m.values());
  }, [pending]);

  const handleSign = async (player: Player, form: FormDefinition) => {
    const hasQuestions = Array.isArray(form.questions) && form.questions.length > 0;
    const hasBody = !!(form.body && form.body.trim());
    // Gate: signature input only required when there's a body to sign.
    // Question answers are gated by the per-question required check
    // below (caller side disables the Submit button when any required
    // answer is missing).
    if (hasBody && !signedByName.trim()) return;
    setSavingSig(true);
    try {
      const docId = `${player.id}_${form.id}`;
      const clubId = (player as any).clubId || form.clubId;

      if (hasQuestions) {
        const labels: Record<string, string> = {};
        (form.questions || []).forEach(q => { labels[q.id] = q.label; });
        await setDoc(doc(db, 'form_submissions', docId), {
          clubId,
          playerId: player.id,
          formDefinitionId: form.id,
          formName: form.name,
          answers,
          answerLabels: labels,
          submittedByName: signedByName.trim() || undefined,
          submittedAt: serverTimestamp(),
          source: 'family_forms',
          // Snapshot the allocation target so a later edit to the
          // form doesn't retroactively move this submission off / onto
          // a different event roster.
          linkedEventId: (form as any).allocateToEventId || null,
        } as any);
      }

      if (hasBody) {
        await setDoc(doc(db, 'form_signatures', docId), {
          clubId,
          playerId: player.id,
          formDefinitionId: form.id,
          formName: form.name,
          signedByName: signedByName.trim(),
          signedBy: 'parent',
          signedAt: serverTimestamp(),
          source: 'family_forms',
        } as any);
      }

      await logActivity({
        clubId,
        kind: 'form_signed',
        playerId: player.id,
        actorUid: userData?.uid || 'public',
        actorName: signedByName.trim() || (userData?.name || 'Parent'),
        payload: {
          formName: form.name,
          signedByName: signedByName.trim() || undefined,
          questionCount: hasQuestions ? (form.questions || []).length : 0,
          hasSignature: hasBody,
          source: 'family_forms',
        },
      });
      setSigning(null);
      setSignedByName('');
      setAnswers({});
      setSavedCount(c => c + 1);
    } catch (err) {
      console.warn('submit failed', err);
      alert('Submit failed — try again.');
    } finally {
      setSavingSig(false);
    }
  };

  if (!userData) {
    return (
      <div className="min-h-screen bg-charcoal-950 flex items-center justify-center p-6 text-bone/60 text-sm">
        Sign in to see your family's pending forms.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950 px-4 py-6 sm:py-10">
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <Link to="/dashboard" className="text-[11px] font-bold uppercase tracking-widest text-bone/50 hover:text-bone/85">← Home</Link>
          <h1 className="text-2xl font-black text-bone mt-1">Pending forms</h1>
          <p className="text-sm text-bone/60 mt-1 max-w-prose">
            Waivers, releases, and consents the club needs you to sign before your player is fully cleared to play.
          </p>
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-emerald-400/30 p-8 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30 text-emerald-300 flex items-center justify-center">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p className="text-sm font-bold text-bone">All caught up.</p>
            <p className="text-xs text-bone/55 mt-1">Every required form is signed.</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {groups.map(({ player, forms }) => (
              <li key={player.id} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
                <header className="px-4 py-3 border-b border-white/5 bg-charcoal-950/50">
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50">Player</div>
                  <div className="text-base font-black text-bone leading-tight">{player.name}</div>
                </header>
                <ul className="divide-y divide-white/5">
                  {forms.map(form => {
                    const openHere = signing?.playerId === player.id && signing.formId === form.id;
                    const hasQuestions = Array.isArray(form.questions) && form.questions.length > 0;
                    const hasBody = !!(form.body && form.body.trim());
                    const ctaLabel = hasQuestions && hasBody ? 'Fill & sign' : hasQuestions ? 'Fill out' : 'Sign';
                    const allRequiredAnswered = !hasQuestions || (form.questions || []).every(q => {
                      if (!q.required) return true;
                      const v = answers[q.id];
                      if (v === undefined || v === null) return false;
                      if (typeof v === 'string') return v.trim().length > 0;
                      return true;
                    });
                    const canSubmit = (hasBody ? !!signedByName.trim() : true) && allRequiredAnswered;
                    return (
                      <li key={form.id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-bone truncate">{form.name}</span>
                              {form.required && (
                                <span className="text-[9px] font-extrabold tracking-widest uppercase text-rose-300 bg-rose-500/10 ring-1 ring-rose-400/30 px-1.5 py-0.5 rounded">Required</span>
                              )}
                              {hasQuestions && (
                                <span className="text-[9px] font-extrabold tracking-widest uppercase text-bone/70 bg-white/10 ring-1 ring-white/15 px-1.5 py-0.5 rounded">{(form.questions || []).length} question{(form.questions || []).length === 1 ? '' : 's'}</span>
                              )}
                            </div>
                            {form.description && (
                              <p className="text-[12px] text-bone/60 mt-1 leading-snug">{form.description}</p>
                            )}
                          </div>
                          {!openHere && (
                            <button
                              type="button"
                              onClick={() => { setSigning({ playerId: player.id, formId: form.id }); setSignedByName(''); setAnswers({}); }}
                              className="shrink-0 text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-brand-primary hover:bg-brand-primary text-white"
                            >
                              {ctaLabel}
                            </button>
                          )}
                        </div>
                        {openHere && (
                          <div className="mt-3 rounded-xl bg-charcoal-950 ring-1 ring-white/10 p-3 space-y-3">
                            {form.body && (
                              <div className="max-h-56 overflow-y-auto rounded-lg bg-black/40 ring-1 ring-white/10 px-3 py-2 text-[12px] text-bone/85 whitespace-pre-wrap leading-relaxed">
                                {form.body}
                              </div>
                            )}
                            {hasQuestions && (
                              <ul className="space-y-3">
                                {(form.questions || []).map((q: RegistrationQuestion) => (
                                  <li key={q.id}>
                                    <QuestionInput question={q} value={answers[q.id]} onChange={(v) => setAnswers(prev => ({ ...prev, [q.id]: v }))} />
                                  </li>
                                ))}
                              </ul>
                            )}
                            {hasBody && (
                              <label className="block">
                                <span className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">Type your full name to sign</span>
                                <input
                                  type="text"
                                  value={signedByName}
                                  onChange={(e) => setSignedByName(e.target.value)}
                                  placeholder="First Last"
                                  className="w-full px-3 py-2.5 rounded-lg bg-charcoal-900 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
                                  style={{ fontSize: '16px' }}
                                />
                                <p className="text-[10px] text-bone/45 mt-1">Recorded as your e-signature for this release.</p>
                              </label>
                            )}
                            {!hasBody && hasQuestions && (
                              <label className="block">
                                <span className="block text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">Your name <span className="text-bone/40 normal-case tracking-normal">(optional, for the audit log)</span></span>
                                <input
                                  type="text"
                                  value={signedByName}
                                  onChange={(e) => setSignedByName(e.target.value)}
                                  placeholder="First Last"
                                  className="w-full px-3 py-2.5 rounded-lg bg-charcoal-900 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
                                  style={{ fontSize: '16px' }}
                                />
                              </label>
                            )}
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => { setSigning(null); setSignedByName(''); setAnswers({}); }}
                                className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={!canSubmit || savingSig}
                                onClick={() => handleSign(player, form)}
                                className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold"
                              >
                                {savingSig ? 'Submitting…' : ctaLabel}
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

// ── Question input renderer ────────────────────────────────────────
// Mirrors the inputs used in Register.tsx's CustomQuestion so a coach
// who builds a form here and a coach who builds a registration form
// get the same parent-facing experience.

const QuestionInput: React.FC<{
  question: RegistrationQuestion;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}> = ({ question, value, onChange }) => {
  const labelEl = (
    <span className="block text-[11px] font-semibold uppercase tracking-wider text-bone/65 mb-1">
      {question.label}
      {question.required && <span className="text-rose-300 ml-0.5">*</span>}
    </span>
  );
  const help = question.help ? (
    <p className="text-[11px] text-bone/45 mt-1">{question.help}</p>
  ) : null;

  switch (question.type) {
    case 'textarea':
      return (
        <label className="block">
          {labelEl}
          <textarea
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            required={!!question.required}
            className="w-full px-3 py-2 rounded-lg bg-charcoal-900 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
    case 'select':
      return (
        <label className="block">
          {labelEl}
          <select
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            required={!!question.required}
            className="w-full px-3 py-2 rounded-lg bg-charcoal-900 text-bone ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
          >
            <option value="">— Select —</option>
            {(question.options || []).map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          {help}
        </label>
      );
    case 'yes_no':
      return (
        <div>
          {labelEl}
          <div className="flex gap-2">
            {['Yes', 'No'].map(opt => {
              const selected = value === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => onChange(opt)}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ring-1 transition ${
                    selected
                      ? 'bg-brand-primary text-white ring-brand-primary'
                      : 'bg-charcoal-900 text-bone/80 ring-white/10 hover:ring-brand-primary-soft/40'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          {help}
        </div>
      );
    case 'number':
      return (
        <label className="block">
          {labelEl}
          <input
            type="number"
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            required={!!question.required}
            className="w-full px-3 py-2 rounded-lg bg-charcoal-900 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
    case 'text':
    default:
      return (
        <label className="block">
          {labelEl}
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            required={!!question.required}
            className="w-full px-3 py-2 rounded-lg bg-charcoal-900 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
  }
};

export default FamilyForms;
