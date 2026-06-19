import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { Survey, SurveyQuestion, SurveyQuestionType, SurveyResponse } from '../types';
import { isCoach, formatDate } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { getShareOrigin } from '../utils/origin';

// ─── Question Builder Helpers ─────────────────────────────────────────────────

const QUESTION_TYPE_LABELS: Record<SurveyQuestionType, string> = {
  rating: 'Rating Scale',
  text: 'Free Text',
  multiple_choice: 'Multiple Choice',
  yes_no: 'Yes / No',
};

const HOW_AM_I_DOING_TEMPLATE: Omit<Survey, 'id' | 'teamId' | 'createdBy' | 'createdByName' | 'responseCount' | 'createdAt'> = {
  title: 'How Am I Doing? – Coach Feedback',
  description: 'Quick anonymous survey so I can improve as a coach. Be honest!',
  isActive: true,
  isAnonymous: true,
  resultsPublic: false,
  questions: [
    { id: 'q1', type: 'rating', text: 'How would you rate training sessions overall?', required: true, maxRating: 5, order: 1 },
    { id: 'q2', type: 'rating', text: 'How well does the coach communicate?', required: true, maxRating: 5, order: 2 },
    { id: 'q3', type: 'rating', text: 'Does your child enjoy coming to training?', required: true, maxRating: 5, order: 3 },
    { id: 'q4', type: 'multiple_choice', text: 'What area should we focus on more?', required: false, options: ['Passing & Possession', 'Shooting & Finishing', 'Defending', 'Set Pieces', 'Fitness & Conditioning', 'Fun & Enjoyment'], order: 4 },
    { id: 'q5', type: 'text', text: 'Any other feedback or suggestions?', required: false, order: 5 },
  ],
};

const makeId = () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ─── Main Component ───────────────────────────────────────────────────────────

const Surveys: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { addDocument, updateDocument, deleteDocument } = useFirestore();

  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'create' | 'results'>('list');
  const [editingSurvey, setEditingSurvey] = useState<Survey | null>(null);
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);
  const [resultsTab, setResultsTab] = useState<'summary' | 'individual'>('summary');
  const [individualIndex, setIndividualIndex] = useState(0);

  // Builder state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);

  const userIsCoach = userData ? isCoach(userData.role) : false;

  // ─── Load surveys ────────────────────────────────────────────────────────
  const loadSurveys = useCallback(async () => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      const q = query(
        collection(db, 'surveys'),
        where('teamId', '==', selectedTeamId),
      );
      const snap = await getDocs(q);
      const data = snap.docs.map(d => {
        const raw = d.data();
        return { ...raw, id: d.id, createdAt: raw.createdAt?.toDate?.() || new Date(), updatedAt: raw.updatedAt?.toDate?.() } as Survey;
      });
      setSurveys(data.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
    } catch (err) {
      console.error('Error loading surveys', err);
    } finally {
      setLoading(false);
    }
  }, [selectedTeamId]);

  useEffect(() => { loadSurveys(); }, [loadSurveys]);

  // ─── Load responses for a survey ────────────────────────────────────────
  const loadResponses = async (survey: Survey) => {
    if (!userData || survey.createdBy !== userData.uid) {
      setResponses([]);
      setResponsesLoading(false);
      return;
    }
    setResponsesLoading(true);
    try {
      const q = query(
        collection(db, 'survey_responses'),
        where('surveyId', '==', survey.id),
      );
      const snap = await getDocs(q);
      const data = snap.docs.map(d => {
        const raw = d.data();
        return { ...raw, id: d.id, submittedAt: raw.submittedAt?.toDate?.() || new Date() } as SurveyResponse;
      });
      setResponses(data.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime()));
    } catch (err) {
      console.error('Error loading responses', err);
    } finally {
      setResponsesLoading(false);
    }
  };

  // ─── Create / Update survey ─────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedTeamId || !userData || !title.trim() || questions.length === 0) return;

    const surveyData: any = {
      title: title.trim(),
      description: description.trim(),
      teamId: selectedTeamId,
      questions,
      isActive: true,
      isAnonymous,
      resultsPublic: false,
      createdBy: userData.uid,
      createdByName: userData.name,
      responseCount: 0,
      createdAt: new Date(),
    };

    if (editingSurvey) {
      delete surveyData.createdAt;
      delete surveyData.createdBy;
      delete surveyData.createdByName;
      delete surveyData.responseCount;
      surveyData.updatedAt = new Date();
      await updateDocument('surveys', editingSurvey.id, surveyData);
    } else {
      const { withSeasonId } = await import('../utils/seasons');
      await addDocument('surveys', await withSeasonId(surveyData));
    }

    resetBuilder();
    setView('list');
    loadSurveys();
  };

  // ─── Delete survey ──────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this survey and all its responses?')) return;
    await deleteDocument('surveys', id);
    loadSurveys();
  };

  // ─── Toggle active ──────────────────────────────────────────────────────
  const handleToggleActive = async (survey: Survey) => {
    await updateDocument('surveys', survey.id, { isActive: !survey.isActive, updatedAt: new Date() });
    loadSurveys();
  };

  // ─── Copy share link ────────────────────────────────────────────────────
  const copyShareLink = (surveyId: string) => {
    const url = `${getShareOrigin()}/survey/${surveyId}`;
    navigator.clipboard.writeText(url);
    setCopySuccess(surveyId);
    setTimeout(() => setCopySuccess(null), 2000);
  };

  // ─── Builder helpers ────────────────────────────────────────────────────
  const resetBuilder = () => {
    setTitle('');
    setDescription('');
    setIsAnonymous(true);
    setQuestions([]);
    setEditingSurvey(null);
  };

  const addQuestion = (type: SurveyQuestionType) => {
    const q: SurveyQuestion = {
      id: makeId(),
      type,
      text: '',
      required: true,
      order: questions.length + 1,
      ...(type === 'rating' ? { maxRating: 5 } : {}),
      ...(type === 'multiple_choice' ? { options: ['Option 1', 'Option 2'] } : {}),
    };
    setQuestions([...questions, q]);
  };

  const updateQuestion = (id: string, patch: Partial<SurveyQuestion>) => {
    setQuestions(questions.map(q => (q.id === id ? { ...q, ...patch } : q)));
  };

  const removeQuestion = (id: string) => {
    setQuestions(questions.filter(q => q.id !== id).map((q, i) => ({ ...q, order: i + 1 })));
  };

  const moveQuestion = (id: string, dir: 'up' | 'down') => {
    const idx = questions.findIndex(q => q.id === id);
    if ((dir === 'up' && idx === 0) || (dir === 'down' && idx === questions.length - 1)) return;
    const next = [...questions];
    const swap = dir === 'up' ? idx - 1 : idx + 1;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setQuestions(next.map((q, i) => ({ ...q, order: i + 1 })));
  };

  const startEdit = (survey: Survey) => {
    setEditingSurvey(survey);
    setTitle(survey.title);
    setDescription(survey.description || '');
    setIsAnonymous(survey.isAnonymous);
    setQuestions(survey.questions);
    setView('create');
  };

  const useTemplate = () => {
    setTitle(HOW_AM_I_DOING_TEMPLATE.title);
    setDescription(HOW_AM_I_DOING_TEMPLATE.description || '');
    setIsAnonymous(HOW_AM_I_DOING_TEMPLATE.isAnonymous);
    setQuestions(HOW_AM_I_DOING_TEMPLATE.questions);
  };

  // ─── Results helpers ────────────────────────────────────────────────────
  const getAverageRating = (questionId: string): number => {
    const vals = responses.map(r => r.answers.find(a => a.questionId === questionId)?.value).filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return 0;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const getChoiceCounts = (questionId: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    responses.forEach(r => {
      const ans = r.answers.find(a => a.questionId === questionId);
      if (ans && typeof ans.value === 'string') {
        counts[ans.value] = (counts[ans.value] || 0) + 1;
      }
    });
    return counts;
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-crimson-400/30 border-t-cyan-500" />
      </div>
    );
  }

  if (!userIsCoach) {
    return (
      <div className="p-6">
        <Header title="Surveys" />
        <div className="card-modern p-8 text-center mt-4">
          <p className="text-crimson-500">Only coaches can manage surveys.</p>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESULTS VIEW
  // ════════════════════════════════════════════════════════════════════════
  if (view === 'results' && selectedSurvey) {
    const currentResp = responses[individualIndex];
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <Header title="Survey Results" subtitle={selectedSurvey.title} />

        <button onClick={() => { setView('list'); setSelectedSurvey(null); setResultsTab('summary'); setIndividualIndex(0); }} className="text-crimson-600 hover:text-crimson-700 text-sm font-medium mb-4 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Back to surveys
        </button>

        {responsesLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-10 w-10 border-2 border-crimson-400/30 border-t-cyan-500" /></div>
        ) : responses.length === 0 ? (
          <div className="card-modern p-8 text-center">
            <p className="text-crimson-400 text-lg">No responses yet</p>
            <button onClick={() => copyShareLink(selectedSurvey.id)} className="btn-primary mt-4 px-4 py-2 rounded-xl text-sm">
              Copy Share Link
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Header bar */}
            <div className="card-modern p-4 flex items-center justify-between">
              <span className="text-bone/65 font-medium">{responses.length} response{responses.length !== 1 ? 's' : ''}</span>
              {selectedSurvey.isAnonymous && <span className="text-xs bg-crimson-100 text-crimson-500 px-2 py-0.5 rounded-full">Anonymous</span>}
            </div>

            {/* Tab toggle */}
            <div className="flex rounded-xl overflow-hidden border border-crimson-400/30 w-fit">
              <button
                onClick={() => setResultsTab('summary')}
                className={`px-4 py-2 text-sm font-medium transition-colors ${resultsTab === 'summary' ? 'bg-crimson-500 text-white' : 'bg-charcoal-800 text-bone/65 hover:bg-white/[0.08]'}`}
              >
                Summary
              </button>
              <button
                onClick={() => { setResultsTab('individual'); setIndividualIndex(0); }}
                className={`px-4 py-2 text-sm font-medium transition-colors ${resultsTab === 'individual' ? 'bg-crimson-500 text-white' : 'bg-charcoal-800 text-bone/65 hover:bg-white/[0.08]'}`}
              >
                Individual
              </button>
            </div>

            {/* ── SUMMARY TAB ── */}
            {resultsTab === 'summary' && (
              <div className="space-y-4">
                {selectedSurvey.questions.map(q => (
                  <div key={q.id} className="card-modern p-5">
                    <h3 className="font-semibold text-charcoal-900 mb-3">{q.order}. {q.text}</h3>

                    {q.type === 'rating' && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="text-3xl font-bold text-crimson-600">{getAverageRating(q.id).toFixed(1)}</span>
                          <span className="text-crimson-400 text-sm">/ {q.maxRating || 5} avg</span>
                        </div>
                        <div className="h-2 bg-crimson-100 rounded-full overflow-hidden">
                          <div className="h-2 rounded-full bg-crimson-500 transition-all" style={{ width: `${(getAverageRating(q.id) / (q.maxRating || 5)) * 100}%` }} />
                        </div>
                        <div className="flex gap-1 mt-2">
                          {Array.from({ length: q.maxRating || 5 }, (_, i) => {
                            const count = responses.filter(r => r.answers.find(a => a.questionId === q.id)?.value === i + 1).length;
                            return (
                              <div key={i} className="flex-1 text-center">
                                <div className="text-xs text-crimson-400 mb-1">{i + 1}★</div>
                                <div className="h-8 bg-crimson-100 rounded relative overflow-hidden">
                                  <div className="absolute bottom-0 left-0 right-0 bg-crimson-400 rounded transition-all" style={{ height: responses.length ? `${(count / responses.length) * 100}%` : '0%' }} />
                                </div>
                                <div className="text-xs text-crimson-400 mt-1">{count}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {q.type === 'yes_no' && (() => {
                      const counts = getChoiceCounts(q.id);
                      const yes = counts['yes'] || 0;
                      const no = counts['no'] || 0;
                      const total = yes + no;
                      return (
                        <div className="flex gap-4">
                          <div className="flex-1 bg-emerald-500/15 rounded-xl p-3 text-center border border-emerald-400/30">
                            <div className="text-2xl font-bold text-emerald-600">{yes}</div>
                            <div className="text-xs text-emerald-500">Yes {total > 0 && `(${Math.round((yes / total) * 100)}%)`}</div>
                          </div>
                          <div className="flex-1 bg-rose-500/15 rounded-xl p-3 text-center border border-rose-400/30">
                            <div className="text-2xl font-bold text-rose-300">{no}</div>
                            <div className="text-xs text-rose-400">No {total > 0 && `(${Math.round((no / total) * 100)}%)`}</div>
                          </div>
                        </div>
                      );
                    })()}

                    {q.type === 'multiple_choice' && (() => {
                      const counts = getChoiceCounts(q.id);
                      const max = Math.max(...Object.values(counts), 1);
                      return (
                        <div className="space-y-2">
                          {(q.options || []).map(opt => (
                            <div key={opt} className="flex items-center gap-3">
                              <span className="text-sm text-bone/85 w-40 truncate">{opt}</span>
                              <div className="flex-1 h-6 bg-crimson-100 rounded-full overflow-hidden">
                                <div className="h-6 bg-crimson-400 rounded-full transition-all flex items-center pl-2" style={{ width: `${((counts[opt] || 0) / max) * 100}%`, minWidth: counts[opt] ? '28px' : '0' }}>
                                  {counts[opt] ? <span className="text-xs font-medium text-white">{counts[opt]}</span> : null}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    {q.type === 'text' && (
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {responses.map(r => {
                          const ans = r.answers.find(a => a.questionId === q.id);
                          if (!ans || !ans.value) return null;
                          return (
                            <div key={r.id} className="bg-crimson-500/15 rounded-lg p-3 text-sm text-bone/85 border border-crimson-400/30">
                              "{String(ans.value)}"
                              {!selectedSurvey.isAnonymous && r.respondentName && (
                                <span className="block text-xs text-crimson-400 mt-1">— {r.respondentName}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── INDIVIDUAL TAB ── */}
            {resultsTab === 'individual' && currentResp && (
              <div className="space-y-4">
                {/* Nav */}
                <div className="flex items-center justify-between card-modern p-3">
                  <button
                    onClick={() => setIndividualIndex(i => Math.max(0, i - 1))}
                    disabled={individualIndex === 0}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-crimson-100 text-bone/65 disabled:opacity-30 hover:bg-crimson-200 transition-colors"
                  >
                    ← Prev
                  </button>
                  <div className="text-center">
                    <span className="text-bone/65 font-medium text-sm">
                      {selectedSurvey.isAnonymous ? `Response ${individualIndex + 1}` : (currentResp.respondentName || 'Anonymous')}
                    </span>
                    <div className="text-xs text-crimson-400">{individualIndex + 1} of {responses.length} · {currentResp.submittedAt.toLocaleDateString()}</div>
                  </div>
                  <button
                    onClick={() => setIndividualIndex(i => Math.min(responses.length - 1, i + 1))}
                    disabled={individualIndex === responses.length - 1}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium bg-crimson-100 text-bone/65 disabled:opacity-30 hover:bg-crimson-200 transition-colors"
                  >
                    Next →
                  </button>
                </div>

                {/* Answers */}
                {selectedSurvey.questions.map(q => {
                  const ans = currentResp.answers.find(a => a.questionId === q.id);
                  return (
                    <div key={q.id} className="card-modern p-5">
                      <div className="text-xs font-medium text-crimson-400 uppercase tracking-wide mb-1">{QUESTION_TYPE_LABELS[q.type]}</div>
                      <h3 className="font-semibold text-charcoal-900 mb-3">{q.order}. {q.text}</h3>
                      {!ans || ans.value === undefined || ans.value === '' ? (
                        <span className="text-crimson-400 italic text-sm">No answer</span>
                      ) : q.type === 'rating' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-3xl font-bold text-crimson-600">{ans.value}</span>
                          <span className="text-crimson-400">/ {q.maxRating || 5}</span>
                          <span className="ml-1 text-amber-400 text-xl">{'★'.repeat(Number(ans.value))}{'☆'.repeat((q.maxRating || 5) - Number(ans.value))}</span>
                        </div>
                      ) : q.type === 'yes_no' ? (
                        <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${ans.value === 'yes' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                          {ans.value === 'yes' ? 'Yes' : 'No'}
                        </span>
                      ) : q.type === 'multiple_choice' ? (
                        <span className="inline-block bg-crimson-100 text-crimson-700 px-3 py-1 rounded-full text-sm font-medium">{String(ans.value)}</span>
                      ) : (
                        <p className="text-bone/85 text-sm bg-crimson-500/15 rounded-lg p-3 border border-crimson-400/30">"{String(ans.value)}"</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CREATE / EDIT VIEW
  // ════════════════════════════════════════════════════════════════════════
  if (view === 'create') {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <Header title={editingSurvey ? 'Edit Survey' : 'Create Survey'} />

        <button onClick={() => { resetBuilder(); setView('list'); }} className="text-crimson-600 hover:text-crimson-700 text-sm font-medium mb-4 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Back
        </button>

        {/* Template Button */}
        {!editingSurvey && questions.length === 0 && (
          <button onClick={useTemplate} className="w-full card-modern p-4 mb-4 border-2 border-dashed border-crimson-400/50 hover:border-crimson-400 hover:bg-crimson-500/10 transition-colors text-left">
            <div className="font-semibold text-charcoal-900">Use "How Am I Doing?" Template</div>
            <div className="text-sm text-crimson-500 mt-1">Pre-built anonymous coach feedback survey — 5 questions ready to go</div>
          </button>
        )}

        {/* Title & Description */}
        <div className="card-modern p-5 space-y-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-bone/85 mb-1">Survey Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. End of Season Feedback"
              className="w-full border border-crimson-400/30 rounded-xl px-4 py-2.5 text-charcoal-900 focus:ring-2 focus:ring-crimson-400 focus:border-crimson-400 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-bone/85 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Brief description shown to respondents…"
              className="w-full border border-crimson-400/30 rounded-xl px-4 py-2.5 text-charcoal-900 focus:ring-2 focus:ring-crimson-400 focus:border-crimson-400 outline-none resize-none"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isAnonymous} onChange={e => setIsAnonymous(e.target.checked)} className="w-4 h-4 rounded text-crimson-500 focus:ring-crimson-400" />
            <span className="text-sm text-bone/85">Anonymous responses</span>
          </label>
          <p className="text-xs text-crimson-500">Survey results are private and visible only to the survey creator.</p>
        </div>

        {/* Questions */}
        <div className="space-y-3 mb-4">
          {questions.map((q, idx) => (
            <div key={q.id} className="card-modern p-4 border-l-4 border-l-cyan-400">
              <div className="flex items-start justify-between gap-2 mb-3">
                <span className="text-xs font-semibold text-crimson-300 bg-crimson-500/15 px-2 py-0.5 rounded-full">{QUESTION_TYPE_LABELS[q.type]}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => moveQuestion(q.id, 'up')} disabled={idx === 0} className="p-1 text-crimson-400 hover:text-bone/85 disabled:opacity-30">↑</button>
                  <button onClick={() => moveQuestion(q.id, 'down')} disabled={idx === questions.length - 1} className="p-1 text-crimson-400 hover:text-bone/85 disabled:opacity-30">↓</button>
                  <button onClick={() => removeQuestion(q.id)} className="p-1 text-rose-400 hover:text-rose-300 ml-1">✕</button>
                </div>
              </div>

              <input
                type="text"
                value={q.text}
                onChange={e => updateQuestion(q.id, { text: e.target.value })}
                placeholder="Question text…"
                className="w-full border border-crimson-400/30 rounded-lg px-3 py-2 text-sm text-charcoal-900 focus:ring-2 focus:ring-crimson-400 focus:border-crimson-400 outline-none mb-2"
              />

              {q.type === 'rating' && (
                <div className="flex items-center gap-2 text-sm text-crimson-500">
                  <span>Max rating:</span>
                  <select value={q.maxRating || 5} onChange={e => updateQuestion(q.id, { maxRating: Number(e.target.value) })} className="border border-crimson-400/30 rounded-lg px-2 py-1 text-sm focus:ring-2 focus:ring-crimson-400 outline-none">
                    {[3, 4, 5, 7, 10].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              )}

              {q.type === 'multiple_choice' && (
                <div className="space-y-2 mt-1">
                  {(q.options || []).map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full border-2 border-crimson-300 flex-shrink-0" />
                      <input
                        type="text"
                        value={opt}
                        onChange={e => {
                          const next = [...(q.options || [])];
                          next[oi] = e.target.value;
                          updateQuestion(q.id, { options: next });
                        }}
                        className="flex-1 border border-crimson-400/30 rounded-lg px-3 py-1.5 text-sm text-charcoal-900 focus:ring-2 focus:ring-crimson-400 outline-none"
                      />
                      {(q.options || []).length > 2 && (
                        <button onClick={() => updateQuestion(q.id, { options: (q.options || []).filter((_, i) => i !== oi) })} className="text-rose-400 hover:text-rose-300 text-sm">✕</button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => updateQuestion(q.id, { options: [...(q.options || []), `Option ${(q.options || []).length + 1}`] })} className="text-crimson-600 hover:text-crimson-700 text-sm font-medium">+ Add option</button>
                </div>
              )}

              <label className="flex items-center gap-2 mt-2 text-sm text-crimson-500 cursor-pointer">
                <input type="checkbox" checked={q.required} onChange={e => updateQuestion(q.id, { required: e.target.checked })} className="w-3.5 h-3.5 rounded text-crimson-500 focus:ring-crimson-400" />
                Required
              </label>
            </div>
          ))}
        </div>

        {/* Add Question */}
        <div className="card-modern p-4 mb-6">
          <p className="text-sm font-medium text-bone/85 mb-3">Add a question</p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(QUESTION_TYPE_LABELS) as SurveyQuestionType[]).map(type => (
              <button
                key={type}
                onClick={() => addQuestion(type)}
                className="px-3 py-2.5 rounded-xl border border-crimson-400/30 hover:border-crimson-400 hover:bg-crimson-500/10 text-sm text-bone/85 font-medium transition-colors text-left"
              >
                {QUESTION_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={!title.trim() || questions.length === 0 || questions.some(q => !q.text.trim())}
          className="w-full btn-primary py-3 rounded-xl font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {editingSurvey ? 'Update Survey' : 'Create Survey'}
        </button>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LIST VIEW
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-charcoal-950">
      <Header
        title="Surveys"
        action={
          <button
            onClick={() => { resetBuilder(); setView('create'); }}
            aria-label="New survey"
            className="w-9 h-9 rounded-full bg-gradient-to-br from-crimson-500 to-charcoal-600 text-white flex items-center justify-center shadow-lg shadow-crimson-500/30 hover:from-crimson-400 hover:to-crimson-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        }
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {surveys.length === 0 ? (
          <div className="bg-charcoal-900 rounded-xl border border-white/10 p-8 text-center">
            <p className="text-bone/50 text-sm">No surveys yet. Tap + to create one.</p>
          </div>
        ) : (
          surveys.map(s => (
            <div key={s.id} className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden">
              {/* Type stripe — active = cyan, closed = slate */}
              <div className={`h-[3px] ${s.isActive ? 'bg-gradient-to-r from-emerald-500 to-crimson-500' : 'bg-white/15'}`} />
              <div className="px-4 py-3">
                <div className="flex items-start gap-2 flex-wrap mb-1">
                  <h3 className="font-bold text-bone text-base truncate flex-1">{s.title}</h3>
                  <span className={`text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border ${
                    s.isActive
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30'
                      : 'bg-white/[0.04] text-bone/50 border-white/10'
                  }`}>
                    {s.isActive ? 'Active' : 'Closed'}
                  </span>
                  {s.isAnonymous && (
                    <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-violet-50 text-violet-700 border-violet-200">
                      Anonymous
                    </span>
                  )}
                  <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                    Private
                  </span>
                </div>
                {s.description && (
                  <p className="text-sm text-bone/65 line-clamp-2 mt-1">{s.description}</p>
                )}
                <div className="mt-2 flex items-center gap-2 text-[11px] text-bone/50">
                  <span><span className="font-bold text-bone/85">{s.questions.length}</span> question{s.questions.length !== 1 ? 's' : ''}</span>
                  <span className="text-slate-300">·</span>
                  <span><span className="font-bold text-bone/85">{s.responseCount}</span> response{s.responseCount !== 1 ? 's' : ''}</span>
                  <span className="text-slate-300">·</span>
                  <span>{formatDate(s.createdAt)}</span>
                </div>

                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => copyShareLink(s.id)}
                    className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border bg-crimson-500/15 text-crimson-300 border-crimson-400/30 hover:bg-crimson-500/25 inline-flex items-center gap-1"
                  >
                    {copySuccess === s.id ? (
                      <><svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Copied</>
                    ) : (
                      <><svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Share</>
                    )}
                  </button>
                  {s.createdBy === userData?.uid && (
                    <button
                      onClick={() => { setSelectedSurvey(s); loadResponses(s); setView('results'); }}
                      className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border bg-charcoal-800 text-bone/65 border-white/10 hover:text-bone hover:bg-charcoal-700"
                    >
                      Results
                    </button>
                  )}
                  {s.createdBy === userData?.uid && (
                    <>
                      <button
                        onClick={() => startEdit(s)}
                        className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border bg-charcoal-800 text-bone/65 border-white/10 hover:text-bone hover:bg-charcoal-700"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleActive(s)}
                        className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border bg-charcoal-800 text-bone/65 border-white/10 hover:text-bone hover:bg-charcoal-700"
                      >
                        {s.isActive ? 'Close' : 'Reopen'}
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border bg-charcoal-800 text-rose-300 border-rose-400/30 hover:bg-rose-500/15"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Surveys;
