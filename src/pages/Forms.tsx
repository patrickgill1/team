import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import { useClubId } from '../hooks/useClubId';
import type { FormDefinition } from '../types';

// Manager for club-wide form definitions (Player Waiver, Medical
// Release, Photo Consent, Uniform Order, etc.). Per-player signature
// state lives elsewhere — this is where the templates are defined.

const AGE_GROUP_OPTIONS = ['U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18'];

const Forms: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const { clubId } = useClubId();

  const [forms, setForms] = useState<FormDefinition[]>([]);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormDefinition | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = async () => {
    if (!allowed || !clubId) return;
    try {
      setLoading(true);
      const [fSnap, sSnap] = await Promise.all([
        getDocs(query(collection(db, 'form_definitions'), where('clubId', '==', clubId), orderBy('order', 'asc'))),
        getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc'))),
      ]);
      setForms(fSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as FormDefinition));
      setSeasons(sSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
    } catch (err) {
      // Order index may not exist yet — fall back to unordered read.
      try {
        const fSnap = await getDocs(query(collection(db, 'form_definitions'), where('clubId', '==', clubId)));
        const list = fSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as FormDefinition);
        list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setForms(list);
      } catch {/* ignore */}
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [allowed, clubId]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">Club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-700">← Club</Link>
            <h1 className="text-2xl font-black text-fire-950 mt-1">Forms</h1>
            <p className="text-sm text-slate-600">
              Waivers, releases, consents, order forms. Each shows up on every player's checklist; admins mark signed as they come in.
            </p>
          </div>
          <button type="button" onClick={() => setCreating(true)} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold">
            + New form
          </button>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-sm text-slate-500">Loading…</div>
        ) : forms.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-8 text-center">
            <p className="text-sm text-slate-600 mb-3">No forms yet. Player Waiver and Medical Release are usually the first two.</p>
            <button type="button" onClick={() => setCreating(true)} className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold">
              Create form
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {forms.map(f => (
              <li key={f.id}>
                <button type="button" onClick={() => setEditing(f)} className="w-full text-left bg-white rounded-2xl ring-1 ring-gray-200 hover:ring-cyan-400 p-4 transition">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-fire-950">{f.name}</div>
                      {f.description && <p className="text-[11px] text-slate-500 mt-0.5">{f.description}</p>}
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[10px]">
                        {f.required && <span className="font-extrabold tracking-widest uppercase bg-rose-50 text-rose-700 ring-1 ring-rose-200 px-1.5 py-0.5 rounded">Required</span>}
                        {!f.isActive && <span className="font-extrabold tracking-widest uppercase bg-slate-100 text-slate-500 ring-1 ring-slate-300 px-1.5 py-0.5 rounded">Archived</span>}
                        {f.seasonId && <span className="font-extrabold tracking-widest uppercase bg-amber-50 text-amber-700 ring-1 ring-amber-200 px-1.5 py-0.5 rounded">{seasons.find(s => s.id === f.seasonId)?.name || 'Season scoped'}</span>}
                        {(f.ageGroups || []).length > 0 && <span className="font-extrabold tracking-widest uppercase bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">{(f.ageGroups || []).join(', ')}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <Editor
          form={editing}
          seasons={seasons}
          clubId={clubId!}
          userData={userData}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
};

interface EditorProps {
  form: FormDefinition | null;
  seasons: any[];
  clubId: string;
  userData: any;
  onClose: () => void;
  onSaved: () => void;
}

const Editor: React.FC<EditorProps> = ({ form, seasons, clubId, userData, onClose, onSaved }) => {
  const isNew = !form;
  const [name, setName] = useState(form?.name || '');
  const [description, setDescription] = useState(form?.description || '');
  const [body, setBody] = useState(form?.body || '');
  const [required, setRequired] = useState(form?.required ?? true);
  const [isActive, setIsActive] = useState(form?.isActive ?? true);
  const [seasonId, setSeasonId] = useState(form?.seasonId || '');
  const [ageGroups, setAgeGroups] = useState<string[]>(form?.ageGroups || []);
  const [order, setOrder] = useState<number>(form?.order ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = !!(name.trim() && !saving);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const payload: any = {
        clubId,
        name: name.trim(),
        description: description.trim() || undefined,
        body: body.trim() || undefined,
        required,
        isActive,
        seasonId: seasonId || undefined,
        ageGroups: ageGroups.length > 0 ? ageGroups : undefined,
        order: Math.max(0, Math.round(Number(order) || 0)),
        updatedAt: serverTimestamp(),
      };
      if (isNew) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = userData?.uid;
        payload.createdByName = userData?.name;
        const id = `form_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await setDoc(doc(db, 'form_definitions', id), payload);
      } else {
        await updateDoc(doc(db, 'form_definitions', form!.id), payload);
      }
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-black text-fire-950">{isNew ? 'New form' : 'Edit form'}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player Waiver" className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm" />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Short description (optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Standard liability waiver — required before first practice" className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm" />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Body text (terms / instructions, optional)</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm leading-relaxed" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Scope to season (optional)</span>
              <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm">
                <option value="">Every season</option>
                {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Display order</span>
              <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm" />
            </label>
          </div>

          <div>
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Scope to age groups (optional)</span>
            <div className="flex flex-wrap gap-1.5">
              {AGE_GROUP_OPTIONS.map(ag => {
                const on = ageGroups.includes(ag);
                return (
                  <button key={ag} type="button" onClick={() => setAgeGroups(on ? ageGroups.filter(x => x !== ag) : [...ageGroups, ag])} className={`px-2.5 py-1 rounded text-[11px] font-bold ring-1 ${on ? 'bg-cyan-600 text-white ring-cyan-600' : 'bg-white text-slate-600 ring-slate-200 hover:ring-cyan-400'}`}>{ag}</button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              Required
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          </div>

          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : isNew ? 'Create form' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Forms;
