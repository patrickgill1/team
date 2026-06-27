import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, collection, addDoc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { Survey, SurveyQuestion, SurveyAnswer } from '../types';
import { useAuth } from '../contexts/AuthContext';

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
    <div className="sticky top-0 z-40 bg-charcoal-950 text-white px-4 py-2.5 flex items-center justify-between shadow">
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-widest text-brand-primary-soft hover:text-white"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        Back to GoalKickr
      </Link>
      <span className="text-[10px] text-white/40 uppercase tracking-widest">Survey</span>
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
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, boolean>>({});

  // Already submitted check
  const alreadySubmitted = surveyId ? hasSubmitted(surveyId) : false;

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

    // Validate required questions
    const errors: Record<string, boolean> = {};
    survey.questions.forEach(q => {
      if (q.required && (answers[q.id] === undefined || answers[q.id] === '')) {
        errors[q.id] = true;
      }
    });
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      const answerArray: SurveyAnswer[] = survey.questions
        .filter(q => answers[q.id] !== undefined && answers[q.id] !== '')
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
      setError('Something went wrong — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  const setAnswer = (questionId: string, value: string | number) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }));
    setValidationErrors(prev => { const n = { ...prev }; delete n[questionId]; return n; });
  };

  // ─── Loading ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
      </div>
    );
  }

  // ─── Error ───────────────────────────────────────────────────────────
  if (error || !survey) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <div className="text-5xl mb-4">😕</div>
          <h1 className="text-xl font-bold text-bone mb-2">{error || 'Survey not found'}</h1>
          <p className="text-bone/50 text-sm">This link might be invalid or the survey may have been removed.</p>
        </div>
      </div>
    );
  }

  // ─── Closed ──────────────────────────────────────────────────────────
  if (!survey.isActive) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-12 h-12 mx-auto mb-4 text-bone/40">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <h1 className="text-xl font-bold text-bone mb-2">Survey closed</h1>
          <p className="text-bone/50 text-sm">This one's not taking responses anymore.</p>
        </div>
      </div>
    );
  }

  // ─── Already submitted ──────────────────────────────────────────────
  if (alreadySubmitted || step === 'thanks') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="text-center max-w-sm mx-auto my-auto">
          <div className="text-5xl mb-4">🎉</div>
          <h1 className="text-xl font-bold text-bone mb-2">Thank You!</h1>
          <p className="text-bone/50 text-sm">Your response has been recorded. We appreciate your feedback!</p>
        </div>
      </div>
    );
  }

  // ─── Identify step (only for non-anonymous surveys) ──────────────────
  if (!survey.isAnonymous && step === 'identify') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white p-6 flex flex-col">
        <InAppSurveyBackBar />
        <div className="w-full max-w-md mx-auto my-auto">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-bone">{survey.title}</h1>
            {survey.description && <p className="text-bone/50 mt-2 text-sm">{survey.description}</p>}
          </div>
          <div className="bg-charcoal-900 rounded-2xl shadow-sm border border-white/10 p-6">
            <label className="block text-sm font-medium text-bone/85 mb-2">Your name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Enter your name"
              className="w-full border border-white/10 rounded-xl px-4 py-3 text-bone focus:ring-2 focus:ring-brand-primary-soft focus:border-brand-primary-soft outline-none"
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
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <InAppSurveyBackBar />
      <div className="max-w-lg mx-auto py-8 px-4 sm:px-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-bone">{survey.title}</h1>
          {survey.description && <p className="text-bone/50 mt-2 text-sm">{survey.description}</p>}
          {survey.isAnonymous && (
            <div className="inline-flex items-center gap-1 mt-2 text-xs text-bone/40 bg-white/[0.08] px-3 py-1 rounded-full">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
              Your responses are anonymous
            </div>
          )}
        </div>

        {/* Questions */}
        <div className="space-y-4">
          {survey.questions.map(q => (
            <div key={q.id} className={`bg-charcoal-900 rounded-2xl shadow-sm border p-5 transition-colors ${validationErrors[q.id] ? 'border-rose-400/40 bg-rose-500/10' : 'border-white/10'}`}>
              <h3 className="font-medium text-bone mb-1">
                {q.order}. {q.text}
                {q.required && <span className="text-rose-400 ml-1">*</span>}
              </h3>
              {validationErrors[q.id] && <p className="text-xs text-rose-300 mb-2">This question is required</p>}

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
                      className={`flex-1 py-3 rounded-xl font-medium text-sm border-2 transition-colors ${
                        answers[q.id] === opt
                          ? opt === 'yes'
                            ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                            : 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                          : 'border-white/10 text-bone/65 hover:border-gray-300'
                      }`}
                    >
                      {opt === 'yes' ? '👍 Yes' : '👎 No'}
                    </button>
                  ))}
                </div>
              )}

              {/* Multiple Choice */}
              {q.type === 'multiple_choice' && (
                <div className="space-y-2 mt-3">
                  {(q.options || []).map(opt => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setAnswer(q.id, opt)}
                      className={`w-full text-left px-4 py-3 rounded-xl border-2 text-sm transition-colors ${
                        answers[q.id] === opt
                          ? 'border-brand-primary-soft/40 bg-brand-primary/15 text-brand-primary-soft font-medium'
                          : 'border-white/10 text-bone/85 hover:border-gray-300'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}

              {/* Text */}
              {q.type === 'text' && (
                <textarea
                  value={(answers[q.id] as string) || ''}
                  onChange={e => setAnswer(q.id, e.target.value)}
                  rows={3}
                  placeholder="Type your answer…"
                  className="w-full border border-white/10 rounded-xl px-4 py-3 text-sm text-bone focus:ring-2 focus:ring-brand-primary-soft focus:border-brand-primary-soft outline-none resize-none mt-3"
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
            <><div className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white" /> Submitting…</>
          ) : (
            'Submit Response'
          )}
        </button>

        <p className="text-center text-xs text-bone/40 mt-4">
          Powered by GoalKickr
        </p>
      </div>
    </div>
  );
};

export default PublicSurvey;
