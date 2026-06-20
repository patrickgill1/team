import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin, isCoach } from '../utils/helpers';
import { useClubId } from '../hooks/useClubId';
import type { OfferTemplate } from '../types';

// Manager for reusable offer letter templates. Lives at
// /club/offer-templates. Coaches + admins both manage their own; the
// SendOffer modal filters by team + position to surface only matches.

const OfferTemplates: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData) || (userData?.role ? isCoach(userData.role) : false);
  const { clubId } = useClubId();

  const [templates, setTemplates] = useState<OfferTemplate[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OfferTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = async () => {
    if (!allowed || !clubId) return;
    try {
      setLoading(true);
      const [tplSnap, teamSnap] = await Promise.all([
        getDocs(query(collection(db, 'offer_templates'), where('clubId', '==', clubId), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'teams'), where('clubId', '==', clubId))),
      ]);
      setTemplates(tplSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as OfferTemplate));
      setTeams(teamSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [allowed, clubId]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">Coaches + club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-charcoal-950 px-4 py-6 sm:py-10">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Header — stacks title block above the action button on
            mobile so neither wraps awkwardly into the other. Mirrors
            the Forms / Tasks header pattern for consistency. */}
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-bone/50 hover:text-bone/85">← Club</Link>
          <div className="mt-1 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-black text-bone">Offer templates</h1>
              <p className="text-sm text-bone/65 mt-1 max-w-prose">
                Reusable message bodies for the Send Offer flow. Scope by team + position so the right templates surface for the right candidates.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 inline-flex items-center gap-1.5 self-start px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold whitespace-nowrap"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New template
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/50">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center">
            <p className="text-sm text-bone/65 mb-3">No templates yet. Build one and the SendOffer modal will offer it as a quick-pick.</p>
            <button type="button" onClick={() => setCreating(true)} className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500/150 text-white text-sm font-bold">
              Create template
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {templates.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="w-full text-left bg-charcoal-900 rounded-2xl ring-1 ring-white/10 hover:ring-violet-400 p-4 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-bone">{t.name}</div>
                      <div className="text-[11px] text-bone/50 mt-0.5">
                        {teams.find(x => x.id === t.teamId)?.name || 'Any team'}
                        {t.position ? ` · ${t.position}` : ' · Any position'}
                      </div>
                    </div>
                    {!t.isActive && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase bg-charcoal-950 text-bone/50 ring-1 ring-white/15 px-1.5 py-0.5 rounded shrink-0">Archived</span>
                    )}
                  </div>
                  <p className="text-xs text-bone/65 mt-2 line-clamp-3 whitespace-pre-wrap">{t.message}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <Editor
          template={editing}
          teams={teams}
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
  template: OfferTemplate | null;
  teams: any[];
  clubId: string;
  userData: any;
  onClose: () => void;
  onSaved: () => void;
}

const Editor: React.FC<EditorProps> = ({ template, teams, clubId, userData, onClose, onSaved }) => {
  const isNew = !template;
  const [name, setName] = useState(template?.name || '');
  const [teamId, setTeamId] = useState(template?.teamId || '');
  const [position, setPosition] = useState(template?.position || '');
  const [message, setMessage] = useState(template?.message || '');
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = !!(name.trim() && message.trim() && !saving);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const payload: any = {
        clubId,
        name: name.trim(),
        teamId: teamId || undefined,
        position: position.trim() || undefined,
        message: message.trim(),
        isActive,
        updatedAt: serverTimestamp(),
      };
      if (isNew) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = userData?.uid;
        payload.createdByName = userData?.name;
        const id = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await setDoc(doc(db, 'offer_templates', id), payload);
      } else {
        await updateDoc(doc(db, 'offer_templates', template!.id), payload);
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
          <h2 className="font-black text-bone">{isNew ? 'New template' : 'Edit template'}</h2>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="U10 Forward — Welcome Aboard" className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400 text-sm" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Scope to team (optional)</span>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400 text-sm">
                <option value="">Any team</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ''}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Scope to position (optional)</span>
              <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Forward" className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400 text-sm" />
            </label>
          </div>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Message body</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={10} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400 text-sm leading-relaxed" />
            <p className="text-[10px] text-bone/50 mt-1">Plain text. The coach can still edit this after picking the template.</p>
          </label>

          <label className="flex items-center gap-2 text-sm text-bone/85">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active (uncheck to archive without deleting)
          </label>

          {error && <div className="rounded-lg bg-rose-500/15 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-300">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500/150 disabled:opacity-50 text-white text-sm font-bold"
          >
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OfferTemplates;
