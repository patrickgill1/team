import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import { useClubId } from '../hooks/useClubId';
import type { RegistrationQuestion } from '../types';

// Admin form builder. Lets a club admin define the extra questions that
// land on the public /register form for a given season (or as the club
// default). One doc per club per scope:
//   - `${clubId}_default` — fallback used when no season-specific config
//   - `${clubId}_${seasonId}` — overrides default for that season

const QUESTION_TYPES: Array<{ value: RegistrationQuestion['type']; label: string }> = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'select', label: 'Dropdown' },
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'number', label: 'Number' },
];

const RegistrationFormBuilder: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const { clubId } = useClubId();

  const [seasons, setSeasons] = useState<any[]>([]);
  const [scope, setScope] = useState<string>('default');
  const [questions, setQuestions] = useState<RegistrationQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const docIdFor = (s: string) => s === 'default' ? `${clubId}_default` : `${clubId}_${s}`;

  // Load the list of seasons once.
  useEffect(() => {
    if (!allowed || !clubId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc')));
        if (!cancelled) setSeasons(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      } catch {/* ignore */}
    })();
    return () => { cancelled = true; };
  }, [allowed, clubId]);

  // Load the config for the selected scope.
  useEffect(() => {
    if (!allowed || !clubId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const snap = await getDoc(doc(db, 'registration_form_configs', docIdFor(scope)));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as any;
          setQuestions((data.questions || []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)));
        } else {
          setQuestions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, allowed, clubId]);

  const addQuestion = () => {
    setQuestions(prev => [
      ...prev,
      {
        id: `q_${Math.random().toString(36).slice(2, 9)}`,
        label: 'New question',
        type: 'text',
        required: false,
        order: prev.length,
      },
    ]);
  };

  const update = (i: number, patch: Partial<RegistrationQuestion>) => {
    setQuestions(prev => prev.map((q, idx) => idx === i ? { ...q, ...patch } : q));
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= questions.length) return;
    const next = questions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setQuestions(next.map((q, idx) => ({ ...q, order: idx })));
  };

  const remove = (i: number) => {
    setQuestions(prev => prev.filter((_, idx) => idx !== i).map((q, idx) => ({ ...q, order: idx })));
  };

  const handleSave = async () => {
    if (!clubId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const clean = questions
        .map((q, idx) => ({
          id: q.id,
          label: q.label.trim() || 'Untitled question',
          help: q.help?.trim() || undefined,
          type: q.type,
          options: q.type === 'select'
            ? (q.options || []).map(o => o.trim()).filter(Boolean)
            : undefined,
          required: !!q.required,
          returningOnly: !!q.returningOnly,
          order: idx,
        }));
      await setDoc(doc(db, 'registration_form_configs', docIdFor(scope)), {
        clubId,
        seasonId: scope === 'default' ? undefined : scope,
        questions: clean,
        updatedAt: serverTimestamp(),
        updatedBy: userData?.uid,
      }, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      console.error('save failed', err);
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">
        Club admins only.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-cyan-300 hover:text-white">
            ← Club
          </Link>
          <h1 className="text-2xl font-black text-white mt-1">Registration form</h1>
          <p className="text-sm text-white/60">
            Extra questions parents answer on the public registration page.
            Default applies whenever a season-specific form isn't set up.
          </p>
        </div>

        <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
            >
              <option value="default">Club default (used when season has no override)</option>
              {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-sm text-slate-500">Loading…</div>
        ) : (
          <>
            <div className="space-y-2">
              {questions.length === 0 && (
                <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-center text-sm text-slate-600">
                  No custom questions yet. The registration form will just ask the standard player + parent fields.
                </div>
              )}
              {questions.map((q, i) => (
                <QuestionRow
                  key={q.id}
                  question={q}
                  isFirst={i === 0}
                  isLast={i === questions.length - 1}
                  onChange={(patch) => update(i, patch)}
                  onMoveUp={() => move(i, -1)}
                  onMoveDown={() => move(i, 1)}
                  onRemove={() => remove(i)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={addQuestion}
                className="px-3 py-2 rounded-lg bg-white ring-1 ring-slate-200 hover:ring-cyan-400 text-sm font-bold text-slate-700"
              >
                + Add question
              </button>
              <div className="flex items-center gap-2">
                {saved && <span className="text-[11px] font-bold text-emerald-600">Saved</span>}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

interface RowProps {
  question: RegistrationQuestion;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<RegistrationQuestion>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

const QuestionRow: React.FC<RowProps> = ({ question, isFirst, isLast, onChange, onMoveUp, onMoveDown, onRemove }) => {
  const [optionsDraft, setOptionsDraft] = useState((question.options || []).join('\n'));
  useEffect(() => {
    setOptionsDraft((question.options || []).join('\n'));
  }, [question.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          value={question.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Question label"
          className="sm:col-span-2 px-3 py-2 rounded-lg ring-1 ring-slate-200 text-sm font-bold"
        />
        <select
          value={question.type}
          onChange={(e) => onChange({ type: e.target.value as RegistrationQuestion['type'] })}
          className="px-3 py-2 rounded-lg ring-1 ring-slate-200 text-sm"
        >
          {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <input
        value={question.help || ''}
        onChange={(e) => onChange({ help: e.target.value })}
        placeholder="Helper text (optional)"
        className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 text-sm"
      />
      {question.type === 'select' && (
        <textarea
          value={optionsDraft}
          onChange={(e) => {
            setOptionsDraft(e.target.value);
            onChange({ options: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) });
          }}
          placeholder="One option per line"
          rows={3}
          className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 text-sm"
        />
      )}
      <div className="flex items-center flex-wrap gap-3 text-[11px] text-slate-600">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={!!question.required} onChange={(e) => onChange({ required: e.target.checked })} />
          Required
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={!!question.returningOnly} onChange={(e) => onChange({ returningOnly: e.target.checked })} />
          Returning players only
        </label>
        <div className="flex-1" />
        <button type="button" disabled={isFirst} onClick={onMoveUp} className="px-2 py-1 rounded hover:bg-slate-100 disabled:opacity-30">↑</button>
        <button type="button" disabled={isLast} onClick={onMoveDown} className="px-2 py-1 rounded hover:bg-slate-100 disabled:opacity-30">↓</button>
        <button type="button" onClick={onRemove} className="px-2 py-1 rounded text-rose-600 hover:bg-rose-50 font-bold">Remove</button>
      </div>
    </div>
  );
};

export default RegistrationFormBuilder;
