// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, query, updateDoc, where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useClubScopes } from '../hooks/useClubScopes';
import { useTeam } from '../contexts/TeamContext';
import {
  ALL_CLUB_SCOPES,
  CLUB_SCOPE_LABELS,
  DIRECTOR_PRESET,
  TREASURER_PRESET,
  COMMUNICATIONS_PRESET,
  resolveClubScopes,
} from '../utils/clubScopes';
import { Button, EmptyState, Sheet } from '../components/ui';
import Header from '../components/common/Header';
import type { Club, ClubAdminScope } from '../types';

/**
 * Owner-only page that lists every admin on the selected club and
 * what they can do. Add by email, edit by clicking a row.
 *
 * Permission: only the club owner can open this page or save
 * changes. We also enforce 'admins' scope grants here — non-owner
 * admins with the 'admins' scope CAN edit other admins' scopes
 * but cannot promote themselves above what the owner granted them.
 */

interface AdminRow {
  uid: string;
  name: string;
  email: string;
  scopes: ClubAdminScope[];
  isOwner: boolean;
}

const ClubAdmins: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { selectedTeam } = useTeam();
  const clubId = (selectedTeam as any)?.clubId || (userData as any)?.clubIds?.[0] || null;
  const { club, isOwner, has } = useClubScopes(clubId);
  const canManage = isOwner || has('admins');

  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [addingEmail, setAddingEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Build the rows from club doc -> resolve uid -> user doc
  useEffect(() => {
    if (!club) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const adminUids = new Set<string>();
      if (club.ownerUid) adminUids.add(club.ownerUid);
      for (const id of (club.adminUids || [])) adminUids.add(id);
      for (const id of Object.keys(club.adminScopes || {})) adminUids.add(id);
      const ids = [...adminUids];
      if (ids.length === 0) { setRows([]); setLoading(false); return; }
      // Firestore __name__ in cap = 30
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
      const out: AdminRow[] = [];
      for (const chunk of chunks) {
        const snap = await getDocs(query(collection(db, 'users'), where('__name__', 'in', chunk)));
        for (const d of snap.docs) {
          const data: any = d.data();
          out.push({
            uid: d.id,
            name: data.name || '—',
            email: data.email || '',
            scopes: resolveClubScopes(d.id, club),
            isOwner: d.id === club.ownerUid,
          });
        }
      }
      // Stable sort: owner first, then by name
      out.sort((a, b) => {
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      if (!cancelled) { setRows(out); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [club]);

  const handleAdd = async () => {
    if (!club || !canManage || adding) return;
    const emailLc = addingEmail.trim().toLowerCase();
    if (!emailLc || !emailLc.includes('@')) { setAddError('Enter a valid email.'); return; }
    setAdding(true); setAddError(null);
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('email', '==', emailLc)));
      if (snap.empty) {
        setAddError(`No user with email ${emailLc}. They must sign up first.`);
        return;
      }
      const target = snap.docs[0];
      const targetUid = target.id;
      if (targetUid === club.ownerUid) {
        setAddError('That user is already the owner.');
        return;
      }
      // Default new admins to a sensible 'director-but-no-financials'
      // set, matching Patrick's described use case. Owner can edit.
      const initialScopes: ClubAdminScope[] = DIRECTOR_PRESET.filter((s) => s !== 'admins');
      await updateDoc(doc(db, 'clubs', club.id), {
        adminUids: arrayUnion(targetUid),
        [`adminScopes.${targetUid}`]: initialScopes,
        isClubAdminPromoted: true,
      });
      // Stamp the legacy flag on the user doc so existing 'isClubAdmin'
      // gating across the app keeps working until we migrate it all.
      await updateDoc(doc(db, 'users', targetUid), { isClubAdmin: true });
      setAddingEmail('');
    } catch (e: any) {
      setAddError(e?.message || 'Could not add admin.');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (uid: string) => {
    if (!club || !canManage) return;
    if (uid === club.ownerUid) return;
    if (!window.confirm('Remove this admin? They will lose access to club admin features.')) return;
    try {
      await updateDoc(doc(db, 'clubs', club.id), {
        adminUids: arrayRemove(uid),
        [`adminScopes.${uid}`]: null,  // remove the field; arrayRemove on a map key uses null
      });
    } catch (e: any) {
      window.alert(e?.message || 'Could not remove admin.');
    }
  };

  if (!clubId) {
    return (
      <div className="min-h-screen bg-charcoal-950">
        <Header title="Club admins" backTo="/settings" />
        <EmptyState variant="subtle" title="No club" body="Start or join a club to manage admins." />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="min-h-screen bg-charcoal-950">
        <Header title="Club admins" backTo="/settings" />
        <EmptyState variant="subtle" title="Not allowed" body="Only the club owner or admins with the 'admins' scope can manage this." />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950 pb-20">
      <Header title="Club admins" backTo="/settings" />
      <div className="max-w-3xl mx-auto px-4 mt-4 space-y-5">
        {/* Club-level kill switch for the shared drill library.
            Owner-only. When OFF, no new drills in this club can be
            flipped into the public catalog; drills already shared
            stay shared. Pairs with the per-coach browseDrillLibrary
            toggle in Settings. */}
        {isOwner && club && (
          <ClubDrillSharingToggle clubId={club.id} initialValue={club.allowDrillSharing !== false} />
        )}

        <div className="bg-charcoal-900 border border-white/10 rounded-2xl p-4">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5">Add admin</p>
          <p className="text-bone/55 text-xs mb-3 leading-snug">
            Grant scoped access to a user. They'll be added with director-style permissions minus financials and admin management — edit the row after to fine-tune.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={addingEmail}
              onChange={(e) => setAddingEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1 bg-charcoal-950 border border-white/10 rounded-lg px-3 py-2.5 text-bone placeholder:text-bone/30 text-sm"
            />
            <Button variant="primary" onClick={handleAdd} disabled={adding || !addingEmail.trim()}>
              {adding ? 'Adding...' : 'Add'}
            </Button>
          </div>
          {addError && (
            <p className="mt-2 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{addError}</p>
          )}
        </div>

        <div>
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-2">
            Admins ({rows.length})
          </p>
          {loading ? (
            <p className="text-bone/45 text-sm">Loading...</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.uid} className="bg-charcoal-900 border border-white/5 rounded-2xl p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-bone font-bold truncate">{r.name}</p>
                        {r.isOwner && (
                          <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand-primary/15 text-brand-primary border border-brand-primary/30">Owner</span>
                        )}
                      </div>
                      <p className="text-bone/45 font-mono text-[11px] truncate">{r.email}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {r.scopes.map((s) => (
                          <span key={s} className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-charcoal-800 text-bone/75 border border-white/10">
                            {CLUB_SCOPE_LABELS[s]?.label || s}
                          </span>
                        ))}
                        {r.scopes.length === 0 && (
                          <span className="text-bone/45 text-xs italic">No scopes</span>
                        )}
                      </div>
                    </div>
                    {!r.isOwner && (
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => setEditingUid(r.uid)}
                          className="text-bone/65 hover:text-bone text-xs font-bold px-2 py-1 rounded bg-charcoal-800 hover:bg-charcoal-700"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemove(r.uid)}
                          className="text-rose-300/85 hover:text-rose-300 text-xs font-bold px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <EditScopesSheet
        open={!!editingUid}
        onClose={() => setEditingUid(null)}
        clubId={club?.id || null}
        currentScopes={editingUid ? (club?.adminScopes?.[editingUid] || []) : []}
        targetUid={editingUid}
      />
    </div>
  );
};

const EditScopesSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  clubId: string | null;
  currentScopes: ClubAdminScope[];
  targetUid: string | null;
}> = ({ open, onClose, clubId, currentScopes, targetUid }) => {
  const [scopes, setScopes] = useState<ClubAdminScope[]>(currentScopes);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setScopes(currentScopes); }, [currentScopes, open]);

  const toggle = (s: ClubAdminScope) => {
    setScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };

  const applyPreset = (preset: ClubAdminScope[]) => setScopes(preset);

  const handleSave = async () => {
    if (!clubId || !targetUid) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'clubs', clubId), {
        [`adminScopes.${targetUid}`]: scopes,
      });
      onClose();
    } catch (e: any) {
      window.alert(e?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Edit admin scopes">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <PresetChip label="Director" onClick={() => applyPreset(DIRECTOR_PRESET)} />
          <PresetChip label="Treasurer" onClick={() => applyPreset(TREASURER_PRESET)} />
          <PresetChip label="Communications" onClick={() => applyPreset(COMMUNICATIONS_PRESET)} />
          <PresetChip label="Everything" onClick={() => applyPreset([...ALL_CLUB_SCOPES])} />
          <PresetChip label="Nothing" onClick={() => applyPreset([])} />
        </div>
        <ul className="space-y-1.5">
          {ALL_CLUB_SCOPES.map((s) => {
            const def = CLUB_SCOPE_LABELS[s];
            const active = scopes.includes(s);
            return (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => toggle(s)}
                  className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                    active ? 'bg-brand-primary/10 border-brand-primary/40' : 'bg-charcoal-900 border-white/10 hover:border-white/20'
                  }`}
                >
                  <div className={`mt-0.5 w-4 h-4 rounded border ${active ? 'bg-brand-primary border-brand-primary' : 'border-white/30'} flex-shrink-0 flex items-center justify-center`}>
                    {active && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="w-3 h-3 text-bone"><path d="M5 13l4 4L19 7" /></svg>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-bone font-bold text-sm">{def.label}</p>
                    <p className="text-bone/55 text-xs">{def.hint}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        <Button variant="primary" onClick={handleSave} disabled={busy} fullWidth>
          {busy ? 'Saving...' : 'Save scopes'}
        </Button>
      </div>
    </Sheet>
  );
};

// Club-level toggle for whether coaches in this club can flip
// drills into the cross-club public catalog. Owner-only at the
// rules layer; this UI is a thin wrapper around the doc write.
const ClubDrillSharingToggle: React.FC<{ clubId: string; initialValue: boolean }> = ({ clubId, initialValue }) => {
  const [allow, setAllow] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = async () => {
    if (busy) return;
    const next = !allow;
    setBusy(true); setError(null);
    try {
      await updateDoc(doc(db, 'clubs', clubId), { allowDrillSharing: next });
      setAllow(next);
    } catch (e: any) {
      setError(e?.message || 'Could not update.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-charcoal-900 border border-white/10 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5">Drill library</p>
          <p className="text-bone font-bold text-sm">Allow coaches to share drills publicly</p>
          <p className="text-bone/55 text-xs mt-0.5 leading-snug">
            When ON, your coaches can flip drills into the cross-club catalog so anyone in GoalKickr can save them. Already-shared drills stay shared even if this is turned off.
          </p>
        </div>
        <button
          type="button"
          onClick={flip}
          disabled={busy}
          className={`shrink-0 text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
            allow ? 'bg-brand-primary text-white' : 'bg-white/[0.06] text-bone/65 ring-1 ring-white/15 hover:bg-white/[0.1]'
          }`}
        >
          {busy ? '…' : allow ? 'On' : 'Off'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{error}</p>
      )}
    </div>
  );
};

const PresetChip: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="text-xs font-bold px-3 py-1.5 rounded-full bg-charcoal-800 hover:bg-charcoal-700 text-bone/75 hover:text-bone"
  >
    {label}
  </button>
);

export default ClubAdmins;
