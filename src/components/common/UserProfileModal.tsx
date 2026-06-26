// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';

interface Props {
  uid: string;
  onClose: () => void;
  /** Optional handler — e.g. open a DM with this user. */
  onStartDm?: (uid: string, name: string) => void;
}

interface Profile {
  uid: string;
  name: string;
  role?: string;
  coachLevel?: string;
  photoURL?: string | null;
  email?: string;
  phoneNumber?: string;
  privacy?: { showPhone?: boolean; showEmail?: boolean; showAddress?: boolean };
  teamIds?: string[];
}

interface TeamRow { id: string; name: string; role: string }
interface PlayerRow { id: string; name: string; teamIds: string[] }

/**
 * Rich user profile bottom-sheet (mobile) / centered modal (desktop).
 * Replaces the missing "View Profile" affordance the chat action sheet
 * advertised but had nowhere to go.
 *
 * Shows:
 *   - Avatar + name + role badge
 *   - Contact strip (email / phone) gated by the target's privacy prefs
 *   - "Chat" button → opens/starts a DM (when onStartDm is supplied)
 *   - Contact button (tel:/mailto:) when contact info is visible
 *   - Teams the user is on, with their role per team
 *   - Players linked to the user (parent → kids) when applicable
 */
const UserProfileModal: React.FC<Props> = ({ uid, onClose, onStartDm }) => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (cancelled || !snap.exists()) { setProfile(null); return; }
        const u = snap.data() as any;
        const p: Profile = {
          uid: snap.id,
          name: u.name || 'Member',
          role: u.role,
          coachLevel: u.coachLevel,
          photoURL: u.photoURL || u.profilePhotoUrl || null,
          email: u.email,
          phoneNumber: u.phoneNumber,
          privacy: u.privacy,
          teamIds: Array.isArray(u.teamIds) ? u.teamIds : (u.teamId ? [u.teamId] : []),
        };
        setProfile(p);

        // Teams the user is on. Looked up by id rather than scanning
        // /teams; cheaper for typical 1–3 team membership.
        if (p.teamIds && p.teamIds.length > 0) {
          try {
            const teamRows: TeamRow[] = [];
            for (const tid of p.teamIds.slice(0, 12)) {
              try {
                const ts = await getDoc(doc(db, 'teams', tid));
                if (ts.exists()) {
                  const t = ts.data() as any;
                  const role = p.role === 'coach'
                    ? (Array.isArray(t.coachIds) && t.coachIds.includes(uid) ? (t.headCoachId === uid ? 'Head Coach' : 'Assistant Coach') : 'Coach')
                    : p.role === 'team_manager' ? 'Team Manager'
                    : 'Guardian';
                  teamRows.push({ id: ts.id, name: t.name || 'Team', role });
                }
              } catch { /* skip */ }
            }
            if (!cancelled) setTeams(teamRows);
          } catch { /* ignore */ }
        }

        // Linked players — parent → kids. Best signal is players whose
        // parentIds array contains this uid.
        try {
          const pSnap = await getDocs(query(collection(db, 'players'), where('parentIds', 'array-contains', uid)));
          if (!cancelled) {
            setPlayers(pSnap.docs.map(d => ({
              id: d.id,
              name: (d.data() as any).name || 'Player',
              teamIds: Array.isArray((d.data() as any).teamIds) ? (d.data() as any).teamIds : [],
            })));
          }
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uid]);

  const initials = useMemo(() => {
    if (!profile?.name) return '?';
    return profile.name.split(' ').filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  }, [profile?.name]);

  const showEmail = !!(profile?.email && (profile?.privacy?.showEmail ?? true));
  const showPhone = !!(profile?.phoneNumber && (profile?.privacy?.showPhone ?? true));
  const teamNameById = useMemo(() => Object.fromEntries(teams.map(t => [t.id, t.name])), [teams]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden"
      >
        {/* Branded navy header — same chrome as the new chat action sheet
            so the two surfaces feel like siblings. */}
        <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 py-3 flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white px-1"
          >
            Close
          </button>
          <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Profile</div>
          <span className="w-12" aria-hidden />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-brand-primary-soft border-t-cyan-500" />
            </div>
          ) : !profile ? (
            <div className="px-4 py-12 text-center text-sm text-slate-500">Profile not found.</div>
          ) : (
            <>
              {/* Identity card */}
              <div className="px-4 pt-5 pb-4 flex items-start gap-4">
                {profile.photoURL ? (
                  <img src={profile.photoURL} alt={profile.name} className="w-16 h-16 rounded-full object-cover ring-2 ring-brand-primary-soft" />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-primary to-charcoal-600 text-white text-xl font-extrabold flex items-center justify-center">
                    {initials}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-extrabold text-slate-900 leading-tight">{profile.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                    {profile.role === 'coach' && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-brand-primary-soft text-brand-primary border border-brand-primary-soft">
                        {profile.coachLevel === 'head_coach' ? 'Head Coach' : 'Coach'}
                      </span>
                    )}
                    {profile.role === 'team_manager' && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                        Team Manager
                      </span>
                    )}
                    {profile.role === 'parent' && (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-slate-50 text-slate-700 border border-slate-200">
                        Guardian
                      </span>
                    )}
                  </div>
                  {(showEmail || showPhone) && (
                    <div className="mt-2 space-y-0.5">
                      {showEmail && (
                        <a href={`mailto:${profile.email}`} className="block text-xs text-brand-primary hover:text-brand-primary-dim truncate">
                          {profile.email}
                        </a>
                      )}
                      {showPhone && (
                        <a href={`tel:${profile.phoneNumber}`} className="block text-xs text-brand-primary hover:text-brand-primary-dim">
                          {profile.phoneNumber}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Quick-action row */}
              <div className="px-4 pb-3 grid grid-cols-2 gap-2">
                {onStartDm && (
                  <button
                    onClick={() => onStartDm(profile.uid, profile.name)}
                    className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-brand-primary-soft text-brand-primary border border-brand-primary-soft text-xs font-extrabold tracking-widest uppercase hover:bg-brand-primary-soft"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    Chat
                  </button>
                )}
                {showPhone && (
                  <a
                    href={`tel:${profile.phoneNumber}`}
                    className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-extrabold tracking-widest uppercase hover:bg-emerald-100"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    Call
                  </a>
                )}
              </div>

              {/* Teams */}
              {teams.length > 0 && (
                <div>
                  <div className="px-4 pt-2 pb-1 text-[10px] font-extrabold tracking-widest uppercase text-slate-500 bg-slate-50 border-y border-slate-100">
                    Teams
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {teams.map(t => (
                      <li key={t.id} className="px-4 py-3">
                        <div className="text-sm font-semibold text-slate-900">{t.name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{t.role}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Linked players (when this is a parent) */}
              {players.length > 0 && (
                <div>
                  <div className="px-4 pt-2 pb-1 text-[10px] font-extrabold tracking-widest uppercase text-slate-500 bg-slate-50 border-y border-slate-100">
                    Players
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {players.map(p => (
                      <li key={p.id} className="px-4 py-3">
                        <div className="text-sm font-semibold text-slate-900">{p.name}</div>
                        {p.teamIds.length > 0 && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {p.teamIds.map(tid => teamNameById[tid] || 'Team').join(' · ')}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!showEmail && !showPhone && players.length === 0 && (
                <div className="px-4 py-6 text-center text-[11px] text-slate-400 italic">
                  This member's contact info is private.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserProfileModal;
