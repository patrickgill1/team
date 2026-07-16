import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, collection, addDoc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { Survey, SurveyQuestion, SurveyAnswer } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { visibleQuestionIds, pruneHiddenAnswers } from '../utils/surveyConditions';

// Compact "Back to app" bar shown when an authed user is viewing the
// public-survey route from inside the app shell. Without it, parents
// who tap a survey link in chat get trapped on the survey page with
// no way to navigate to the rest of the app (Patrick: "there is no
// way to leave the survey to get back to the parts of the app").
// Unauthed visitors (cold link in email/SMS) never see this — the
// survey page still behaves as a clean public form for them.
const InAppSurveyBackBar: React.FC = () => {
  const { userData } = useAuth();
  if (!userData) return null;
  return (
    <div className="sticky top-0 z-40 bg-surface-base text-ink-primary px-4 py-2.5 flex items-center justify-between shadow">
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-ink-primary"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to GoalKickr
      </Link>
      <span className="text-[10px] text-ink-primary/40 uppercase tracking-widest">Survey</span>
    </div>
  );
};

// ─── localStorage helpers ─────────────────────────────────────────────────────
const RESPONDENT_KEY = 'survey_respondent_name';
const SUBMITTED_KEY = 'survey_submitted';

const getRespondentName = (): string => localStorage.getItem(RESPONDENT_KEY) || '';
const setRespondentName = (name: string) => localStorage.setItem(RESPONDENT_KEY, name);
const hasSubmitted = (surveyId: string): boolean => {
  const list = JSON.parse(localStorage.getItem(SUBMITTED_KEY) || '[]');
  return list.includes(surveyId);
};
const markSubmitted = (surveyId: string) => {
  const list = JSON.parse(localStorage.getItem(SUBMITTED_KEY) || '[]');
  list.push(surveyId);
  localStorage.setItem(SUBMITTED_KEY, JSON.stringify(list));
};
const getRespondentToken = (): string => {
  let token = localStorage.getItem('survey_token');
  if (!token) {
    token = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('survey_token', token);
  }
  return token;
};

// ─── Star Rating Component ────────────────────────────────────────────────────
const StarRating: React.FC<{ value: number; max: number; onChange: (v: number) => void }> = ({ value, max, onChange }) => (
  <div className="flex gap-1">
    {Array.from({ length: max }, (_, i) => (
      <button
        key={i}
        type="button"
        onClick={() => onChange(i + 1)}
        className={`text-2xl sm:text-3xl transition-transform hover:scale-110 ${i < value ? 'text-amber-400' : 'text-gray-300'}`}
      >
        ★
      </button>
    ))}
  </div>
);

// ─── Main Component ───────────────────────────────────────────────────────────
const PublicSurvey: React.FC = () => {
  const { surveyId } = useParams<{ surveyId: string }>();

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'identify' | 'fill' | 'thanks'>('identify');
  const [name, setName] = useState(getRespondentName());
  // Widened to include string[] for multi-select MC (checkboxes). Every
  // consumer branches on Array.isArray(value) rather than trusting the
  // question type, so a source flipped single ↔ multi keeps behaving.
  const [answers, setAnswers] = useState<Record<string, string | number | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, boolean>>({});

  // Already submitted check
  const alreadySubmitted = surveyId ? hasSubmitted(surveyId) : false;

  // Which questions are currently visible given the answers so far. Conditional
  // rules (see src/utils/surveyConditions.ts) let a coach hide follow-ups
  // behind a Yes/No or Multiple Choice parent. Recomputed on every answer
  // change; also drives the required-field guard, the progress caption, and
  // the submitted payload.
  const visibleIds = useMemo(() => {
    if (!survey) return new Set<string>();
    return visibleQuestionIds(survey.questions, answers);
  }, [survey, answers]);
  const visibleQuestions = useMemo(
    () => (survey ? survey.questions.filter(q => visibleIds.has(q.id)) : []),
    [survey, visibleIds],
  );
  // Answered count is scoped to currently-visible questions so flipping a
  // parent Y/N doesn't cause the "N of M" caption to jump around.
  const answeredCount = useMemo(
    () => visibleQuestions.filter(q => answers[q.id] !== undefined && answers[q.id] !== '').length,
    [visibleQuestions, answers],
  );

  // ─── Load survey (real-time) ─────────────────────────────────────────
  useEffect(() => {
    if (!surveyId) return;
    const unsub = onSnapshot(
      doc(db, 'surveys', surveyId),
      snap => {
        if (!snap.exists()) { setError('Survey not found'); setLoading(false); return; }
        const raw = snap.data();
        setSurvey({ ...raw, id: snap.id, createdAt: raw.createdAt?.toDate?.() || new Date() } as Survey);
        setLoading(false);
      },
      () => { setError('Could not load survey'); setLoading(false); },
    );
    return () => unsub();
  }, [surveyId]);

  // ─── Submit ──────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!survey || !surveyId) return;

    // Only currently-visible questions can be required. Hidden branches (e.g.
    // "which restaurant" when the parent said No to dinner) should never
    // block submission. Empty spans single-value ('' / undefined) AND empty
    // array (multi-select MC with nothing picked), so required means
    // "at least one pick" regardless of question shape.
    const errors: Record<string, boolean> = {};
    visibleQuestions.forEach(q => {
      if (!q.required) return;
      const v = answers[q.id];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
        errors[q.id] = true;
      }
    });
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      // Only submit answers to visible questions. Answers to previously-visible
      // but now-hidden questions were already pruned by pruneHiddenAnswers on
      // parent-answer change; this filter is belt-and-suspenders. Same
      // "unanswered" definition as the required guard above so multi-select
      // MC empty arrays don't ship as junk.
      const answerArray: SurveyAnswer[] = visibleQuestions
        .filter(q => {
          const v = answers[q.id];
          if (v === undefined || v === '') return false;
          if (Array.isArray(v) && v.length === 0) return false;
          return true;
        })
        .map(q => ({ questionId: q.id, value: answers[q.id] }));

      await addDoc(collection(db, 'survey_responses'), {
        surveyId,
        respondentName: survey.isAnonymous ? null : (name.trim() || 'Anonymous'),
        respondentToken: getRespondentToken(),
        answers: answerArray,
        submittedAt: new Date(),
      });

      // Increment response count
      await updateDoc(doc(db, 'surveys', surveyId), { responseCount: increment(1) });

      if (!survey.isAnonymous && name.trim()) setRespondentName(name.trim());
      markSubmitted(surveyId);
      setStep('thanks');
    } catch (err) {
      console.error('Error submitting survey', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const setAnswer = (questionId: string, value: string | number | string[]) => {
    setAnswers(prev => {
      const next = { ...prev, [questionId]: value };
      // If this question is a source for any conditional child, changing its
      // answer might now hide previously-visible children. Prune any orphan
      // answers so we don't submit responses the parent never intended.
      const pruned = survey ? pruneHiddenAnswers(survey.questions, next) : next;
      // Also drop stale required-field errors for questions that are now
      // hidden. Otherwise a respondent who saw a red "This is required"
      // highlight, then flipped the parent to hide the child, then flipped
      // back to show the child again, would see the stale red highlight
      // even though they haven't tried to submit since.
      if (survey) {
        const visible = visibleQuestionIds(survey.questions, pruned);
        setValidationErrors(errs => {
          const n = { ...errs };
          delete n[questionId];
          Object.keys(n).forEach(qid => { if (!visible.has(qid)) delete n[qid]; });
          return n;
        });
      } else {
        setValidationErrors(errs => { const n = { ...errs }; delete n[questionId]; return n; });
      }
      return pruned;
    });
  };

  // Toggle a single option on a multi-select MC. Order-preserved by the
  // question's option index (not click order) so results are stable
  // across submits + across renders.
  const toggleMultiChoice = (question: SurveyQuestion, option: string) => {
    const opts = question.options || [];
    const current = answers[question.id];
    const currentArr = Array.isArray(current) ? current : [];
    const nextSet = new Set(currentArr);
    if (nextSet.has(option)) nextSet.delete(option); else nextSet.add(option);
    const next = opts.filter(o => nextSet.has(o));
    setAnswer(question.id, next);
  };

  // ─── Loading ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
      </div>
    );
  }

  // ─── Error ───────────────────────────────────────────────────────────
  if (error || !survey) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <div className="text-5xl mb-4">😕</div>
          <h1 className="text-xl font-bold text-ink-primary mb-2">{error || 'Survey not found'}</h1>
          <p className="text-ink-primary/50 text-sm">This link might be invalid or the survey may have been removed.</p>
        </div>
      </div>
    );
  }

  // ─── Closed ──────────────────────────────────────────────────────────
  if (!survey.isActive) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 mx-auto mb-4 text-ink-primary/40">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <h1 className="text-xl font-bold text-ink-primary mb-2">Survey closed</h1>
          <p className="text-ink-primary/50 text-sm">This one's not taking responses anymore.</p>
        </div>
      </div>
    );
  }

  // ─── Already submitted ──────────────────────────────────────────────
  if (alreadySubmitted || step === 'thanks') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <div className="text-5xl mb-4">🎉</div>
          <h1 className="text-xl font-bold text-ink-primary mb-2">Thank You!</h1>
          <p className="text-ink-primary/50 text-sm">Your response has been recorded. We appreciate your feedback!</p>
        </div>
      </div>
    );
  }

  // ─── Identify step (only for non-anonymous surveys) ──────────────────
  if (!survey.isAnonymous && step === 'identify') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="w-full max-w-md mx-auto my-auto">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-ink-primary">{survey.title}</h1>
            {survey.description && <p className="text-ink-primary/50 mt-2 text-sm">{survey.description}</p>}
          </div>
          <div className="bg-surface-elevated rounded-2xl shadow-sm border border-line-default/10 p-6">
            <label className="block text-sm font-medium text-ink-primary/85 mb-2">Your name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-primary-soft focus:border-brand-primary-soft outline-none"
              autoFocus
            />
            <button
              onClick={() => setStep('fill')}
              disabled={!name.trim()}
              className="w-full mt-4 bg-gradient-to-r from-brand-primary to-brand-primary text-white font-semibold py-3 rounded-xl shadow-sm hover:from-brand-primary hover:to-brand-primary disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Start Survey
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Fill survey ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base">
      <InAppSurveyBackBar />
      <div className="max-w-lg mx-auto py-8 px-4 sm:px-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-ink-primary">{survey.title}</h1>
          {survey.description && <p className="text-ink-primary/50 mt-2 text-sm">{survey.description}</p>}
          {survey.isAnonymous && (
            <div className="inline-flex items-center gap-1 mt-2 text-xs text-ink-primary/40 bg-line-default/[0.08] px-3 py-1 rounded-full">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
              Your responses are anonymous
            </div>
          )}
        </div>

        {/* Progress caption — scoped to currently-visible questions so a
            conditional branch flip doesn't make the denominator jump. */}
        {visibleQuestions.length > 0 && (
          <p className="text-center text-xs text-ink-primary/50 mb-3">
            {answeredCount} of {visibleQuestions.length} answered
          </p>
        )}

        {/* Questions */}
        <div className="space-y-4">
          {visibleQuestions.map((q, visibleIdx) => (
            <div key={q.id} className={`bg-surface-elevated rounded-2xl shadow-sm border p-5 transition-colors ${validationErrors[q.id] ? 'border-rose-400/40 bg-rose-500/10' : 'border-line-default/10'}`}>
              <h3 className="font-medium text-ink-primary mb-1">
                {/* Number by visible index — hidden branches shouldn't leave
                    gaps like "1, 3, 5" for the respondent. */}
                {visibleIdx + 1}. {q.text}
                {q.required && <span className="text-rose-400 ml-1">*</span>}
              </h3>
              {validationErrors[q.id] && (
                // Multi-select needs its own copy: "This question is
                // required" reads as a single-answer prompt when the
                // control is a checkbox group.
                <p className="text-xs text-rose-300 mb-2">
                  {q.type === 'multiple_choice' && q.allowMultiple
                    ? 'Pick at least one option.'
                    : 'This question is required'}
                </p>
              )}

              {/* Rating */}
              {q.type === 'rating' && (
                <div className="mt-3">
                  <StarRating value={(answers[q.id] as number) || 0} max={q.maxRating || 5} onChange={v => setAnswer(q.id, v)} />
                </div>
              )}

              {/* Yes / No */}
              {q.type === 'yes_no' && (
                <div className="flex gap-3 mt-3">
                  {['yes', 'no'].map(opt => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswer(q.id, opt)}
                      className={`flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm border-2 transition-colors ${
                        answers[q.id] === opt
                          ? opt === 'yes'
                            ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                            : 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                          : 'border-line-default/15 text-ink-primary/65 hover:border-line-default/30'
                      }`}
                    >
                      {opt === 'yes' ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      )}
                      {opt === 'yes' ? 'Yes' : 'No'}
                    </button>
                  ))}
                </div>
              )}

              {/* Multiple Choice — single-select (radio) */}
              {q.type === 'multiple_choice' && !q.allowMultiple && (
                <div className="space-y-2 mt-3">
                  {(q.options || []).map(opt => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswer(q.id, opt)}
                      className={`w-full text-left px-4 py-3 rounded-xl border-2 text-sm transition-colors ${
                        answers[q.id] === opt
                          ? 'border-brand-primary-soft/40 bg-brand-primary/15 text-brand-primary-soft font-medium'
                          : 'border-line-default/10 text-ink-primary/85 hover:border-gray-300'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}

              {/* Multiple Choice — multi-select (checkboxes). Answer is a
                  string[] preserved in the question's option order. */}
              {q.type === 'multiple_choice' && q.allowMultiple && (() => {
                const current = answers[q.id];
                const currentArr = Array.isArray(current) ? current : [];
                return (
                  <div className="space-y-2 mt-3">
                    {(q.options || []).map(opt => {
                      const checked = currentArr.includes(opt);
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => toggleMultiChoice(q, opt)}
                          aria-pressed={checked}
                          className={`w-full flex items-center gap-3 text-left px-4 py-3 rounded-xl border-2 text-sm transition-colors ${
                            checked
                              ? 'border-brand-primary-soft/40 bg-brand-primary/15 text-brand-primary-soft font-medium'
                              : 'border-line-default/10 text-ink-primary/85 hover:border-gray-300'
                          }`}
                        >
                          <span
                            className={`w-5 h-5 rounded-md border-2 flex-shrink-0 flex items-center justify-center ${
                              checked
                                ? 'border-brand-primary bg-brand-primary'
                                : 'border-line-default/30 bg-surface-base'
                            }`}
                          >
                            {checked && (
                              <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                          <span className="flex-1">{opt}</span>
                        </button>
                      );
                    })}
                    <p className="text-[11px] text-ink-primary/50 pt-0.5">Pick as many as apply.</p>
                  </div>
                );
              })()}

              {/* Text */}
              {q.type === 'text' && (
                <textarea
                  value={(answers[q.id] as string) || ''}
                  onChange={e => setAnswer(q.id, e.target.value)}
                  rows={3}
                  placeholder="Type your answer…"
                  className="w-full bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-brand-primary-soft focus:border-brand-primary-soft outline-none resize-none mt-3"
                />
              )}

              {/* Date — native picker; answer is an ISO 'YYYY-MM-DD'
                  string. No new Date(iso) anywhere downstream so the day
                  doesn't shift in MDT. */}
              {q.type === 'date' && (
                <input
                  type="date"
                  value={(answers[q.id] as string) || ''}
                  onChange={e => setAnswer(q.id, e.target.value)}
                  className="w-full bg-surface-base text-ink-primary [color-scheme:dark] placeholder:text-ink-primary/40 border border-line-default/15 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-brand-primary-soft focus:border-brand-primary-soft outline-none mt-3"
                />
              )}
            </div>
          ))}
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full mt-6 bg-gradient-to-r from-brand-primary to-brand-primary text-white font-semibold py-3.5 rounded-xl shadow-sm hover:from-brand-primary hover:to-brand-primary disabled:opacity-60 transition-all flex items-center justify-center gap-2"
        >
          {submitting ? (
            <><div className="animate-spin rounded-full h-5 w-5 border-2 border-line-default/30 border-t-white" /> Submitting…</>
          ) : (
            'Submit Response'
          )}
        </button>

        <p className="text-center text-xs text-ink-primary/40 mt-4">
          Powered by GoalKickr
        </p>
      </div>
    </div>
  );
};

export default PublicSurvey;
