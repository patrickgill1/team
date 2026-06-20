import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
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
  // Send-reminder modal — pinned to a single form at a time. Fan-out
  // pushes parents of every kid in the picked scope (whole club or
  // a single team) who hasn't signed yet, deep-linking to /family/forms.
  const [sendingFor, setSendingFor] = useState<FormDefinition | null>(null);

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
    return <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">Club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-charcoal-950 px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Header — title block sits above the action button on mobile
            so neither competes for horizontal room. On desktop the
            button sits aligned to the title's top-right. Previously
            the button forced "+ New form" to wrap onto 3 lines and
            squeezed the description text into a thin column. */}
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-bone/50 hover:text-bone/85">← Club</Link>
          <div className="mt-1 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-black text-bone">Forms</h1>
              <p className="text-sm text-bone/65 mt-1 max-w-prose">
                Waivers, releases, consents, order forms. Each shows up on every player's checklist; admins mark signed as they come in.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 inline-flex items-center gap-1.5 self-start px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 text-white text-sm font-bold whitespace-nowrap"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New form
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/50">Loading…</div>
        ) : forms.length === 0 ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center">
            <p className="text-sm text-bone/65 mb-3">No forms yet. Player Waiver and Medical Release are usually the first two.</p>
            <button type="button" onClick={() => setCreating(true)} className="px-3 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500/150 text-white text-sm font-bold">
              Create form
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {forms.map(f => (
              <li key={f.id} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 hover:ring-crimson-400/40 p-4 transition">
                <button type="button" onClick={() => setEditing(f)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-bone">{f.name}</div>
                      {f.description && <p className="text-[11px] text-bone/50 mt-0.5">{f.description}</p>}
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[10px]">
                        {f.required && <span className="font-extrabold tracking-widest uppercase bg-rose-500/15 text-rose-300 ring-1 ring-rose-200 px-1.5 py-0.5 rounded">Required</span>}
                        {!f.isActive && <span className="font-extrabold tracking-widest uppercase bg-charcoal-950 text-bone/50 ring-1 ring-white/15 px-1.5 py-0.5 rounded">Archived</span>}
                        {f.seasonId && <span className="font-extrabold tracking-widest uppercase bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30 px-1.5 py-0.5 rounded">{seasons.find(s => s.id === f.seasonId)?.name || 'Season scoped'}</span>}
                        {(f.ageGroups || []).length > 0 && <span className="font-extrabold tracking-widest uppercase bg-crimson-500/15 text-crimson-300 ring-1 ring-crimson-400/30 px-1.5 py-0.5 rounded">{(f.ageGroups || []).join(', ')}</span>}
                      </div>
                    </div>
                  </div>
                </button>
                <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSendingFor(f)}
                    className="text-[10px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-charcoal-950 ring-1 ring-white/10 text-bone/85 hover:ring-crimson-400/40 hover:text-bone"
                  >
                    Send reminder
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(f)}
                    className="text-[10px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-charcoal-950 ring-1 ring-white/10 text-bone/85 hover:ring-crimson-400/40 hover:text-bone"
                  >
                    Edit
                  </button>
                </div>
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

      {sendingFor && clubId && (
        <SendReminderModal
          form={sendingFor}
          clubId={clubId}
          onClose={() => setSendingFor(null)}
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
      <div className="bg-charcoal-900 w-full sm:max-w-xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-black text-bone">{isNew ? 'New form' : 'Edit form'}</h2>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player Waiver" className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm" />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Short description (optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Standard liability waiver — required before first practice" className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm" />
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Body text (terms / instructions, optional)</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm leading-relaxed" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Scope to season (optional)</span>
              <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm">
                <option value="">Every season</option>
                {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Display order</span>
              <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm" />
            </label>
          </div>

          <div>
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Scope to age groups (optional)</span>
            <div className="flex flex-wrap gap-1.5">
              {AGE_GROUP_OPTIONS.map(ag => {
                const on = ageGroups.includes(ag);
                return (
                  <button key={ag} type="button" onClick={() => setAgeGroups(on ? ageGroups.filter(x => x !== ag) : [...ageGroups, ag])} className={`px-2.5 py-1 rounded text-[11px] font-bold ring-1 ${on ? 'bg-crimson-600 text-white ring-crimson-600' : 'bg-charcoal-900 text-bone/65 ring-white/10 hover:ring-crimson-400'}`}>{ag}</button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm text-bone/85">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              Required
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          </div>

          {error && <div className="rounded-lg bg-rose-500/15 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-300">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500/150 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : isNew ? 'Create form' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Send-reminder modal ───────────────────────────────────────────

interface SendReminderProps {
  form: FormDefinition;
  clubId: string;
  onClose: () => void;
}

const SendReminderModal: React.FC<SendReminderProps> = ({ form, clubId, onClose }) => {
  const [scope, setScope] = useState<'club' | 'team'>('club');
  const [teamId, setTeamId] = useState<string>('');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [unsignedCount, setUnsignedCount] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ recipients: number; pushOk: boolean } | null>(null);

  // Load every team in the club so the picker has options.
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'teams'), where('clubId', '==', clubId)));
        setTeams(snap.docs.map(d => ({ id: d.id, name: (d.data() as any).name || d.id })));
      } catch (err) {
        console.warn('team load failed', err);
      }
    })();
  }, [clubId]);

  // Recompute the unsigned count whenever the scope or team changes.
  // We resolve players in scope, then check form_signatures/${pid}_${fid}
  // for each — anything missing is a "to remind" target.
  useEffect(() => {
    let cancelled = false;
    setUnsignedCount(null);
    if (scope === 'team' && !teamId) return;
    (async () => {
      setComputing(true);
      try {
        let players: Array<{ id: string; parentEmails?: string[] }> = [];
        if (scope === 'club') {
          const snap = await getDocs(query(collection(db, 'players'), where('clubId', '==', clubId)));
          players = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        } else {
          const [s1, s2] = await Promise.all([
            getDocs(query(collection(db, 'players'), where('teamId', '==', teamId))),
            getDocs(query(collection(db, 'players'), where('teamIds', 'array-contains', teamId))),
          ]);
          const m = new Map<string, any>();
          for (const d of s1.docs) m.set(d.id, { id: d.id, ...(d.data() as any) });
          for (const d of s2.docs) if (!m.has(d.id)) m.set(d.id, { id: d.id, ...(d.data() as any) });
          players = Array.from(m.values());
        }
        players = players.filter((p: any) => p.isActive !== false);
        let unsigned = 0;
        await Promise.all(players.map(async (p) => {
          try {
            const sig = await getDoc(doc(db, 'form_signatures', `${p.id}_${form.id}`));
            if (!sig.exists()) unsigned++;
          } catch { /* treat as unsigned */ }
        }));
        if (!cancelled) setUnsignedCount(unsigned);
      } finally {
        if (!cancelled) setComputing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, teamId, clubId, form.id]);

  const handleSend = async () => {
    setSending(true);
    try {
      // Resolve players + their unsigned parents in scope.
      let players: Array<{ id: string; parentEmails?: string[] }> = [];
      if (scope === 'club') {
        const snap = await getDocs(query(collection(db, 'players'), where('clubId', '==', clubId)));
        players = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      } else {
        const [s1, s2] = await Promise.all([
          getDocs(query(collection(db, 'players'), where('teamId', '==', teamId))),
          getDocs(query(collection(db, 'players'), where('teamIds', 'array-contains', teamId))),
        ]);
        const m = new Map<string, any>();
        for (const d of s1.docs) m.set(d.id, { id: d.id, ...(d.data() as any) });
        for (const d of s2.docs) if (!m.has(d.id)) m.set(d.id, { id: d.id, ...(d.data() as any) });
        players = Array.from(m.values());
      }
      players = players.filter((p: any) => p.isActive !== false);

      const unsignedParents: string[] = [];
      await Promise.all(players.map(async (p) => {
        try {
          const sig = await getDoc(doc(db, 'form_signatures', `${p.id}_${form.id}`));
          if (sig.exists()) return;
          for (const e of (p.parentEmails || [])) {
            if (typeof e === 'string' && e) unsignedParents.push(e.toLowerCase().trim());
          }
        } catch { /* treat as unsigned */ }
      }));
      const uniqueEmails = Array.from(new Set(unsignedParents));

      // Fan-out push via the existing worker endpoint. sendPushToParentEmails
      // looks up FCM tokens per parent uid and skips families without
      // a registered device — the email itself isn't a fallback here.
      const { sendPushToParentEmails } = await import('../utils/notify');
      const pushOk = uniqueEmails.length > 0
        ? await sendPushToParentEmails(uniqueEmails, {
            title: 'Action needed — sign release',
            body: `${form.name}: tap to sign for your player.`,
            url: '/family/forms',
          })
        : true;
      setSent({ recipients: uniqueEmails.length, pushOk });
    } catch (err: any) {
      console.warn('send reminder failed', err);
      alert(err?.message || 'Send failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-charcoal-900 ring-1 ring-white/10 w-full sm:max-w-md sm:rounded-2xl overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-base font-black text-bone">Send signing reminder</h3>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>

        {sent ? (
          <div className="p-5 space-y-3 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30 text-emerald-300 flex items-center justify-center">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p className="text-sm font-bold text-bone">Reminder sent.</p>
            <p className="text-[12px] text-bone/60">
              {sent.recipients === 0
                ? 'No unsigned families in this scope.'
                : `Pushed to ${sent.recipients} parent${sent.recipients === 1 ? '' : 's'} who still needs to sign.`}
            </p>
            <button type="button" onClick={onClose} className="mt-2 w-full py-2.5 rounded-lg bg-crimson-600 hover:bg-crimson-500 text-white text-sm font-bold">
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Form</span>
              <div className="text-sm font-bold text-bone">{form.name}</div>
            </div>

            <div>
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Send to</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setScope('club')}
                  className={`px-3 py-2 rounded-lg ring-1 text-sm font-semibold ${
                    scope === 'club'
                      ? 'bg-crimson-500/15 ring-crimson-400/40 text-crimson-100'
                      : 'bg-charcoal-950 ring-white/10 text-bone hover:bg-white/5'
                  }`}
                >
                  Whole club
                </button>
                <button
                  type="button"
                  onClick={() => setScope('team')}
                  className={`px-3 py-2 rounded-lg ring-1 text-sm font-semibold ${
                    scope === 'team'
                      ? 'bg-crimson-500/15 ring-crimson-400/40 text-crimson-100'
                      : 'bg-charcoal-950 ring-white/10 text-bone hover:bg-white/5'
                  }`}
                >
                  One team
                </button>
              </div>
              {scope === 'team' && (
                <select
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="mt-2 w-full px-3 py-2 text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-crimson-400/40"
                >
                  <option value="">— Pick a team —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </div>

            <div className="rounded-lg bg-charcoal-950 ring-1 ring-white/10 px-3 py-2.5 text-[12px] text-bone/75">
              {computing
                ? 'Counting unsigned families…'
                : unsignedCount === null
                  ? 'Pick a scope to see how many families still need to sign.'
                  : unsignedCount === 0
                    ? 'Everyone in this scope has already signed.'
                    : `${unsignedCount} unsigned families in scope — tap Send to push them a reminder linking to the signing page.`}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
              <button
                type="button"
                disabled={sending || (scope === 'team' && !teamId) || unsignedCount === 0}
                onClick={handleSend}
                className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 text-white text-sm font-bold"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Forms;
