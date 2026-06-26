import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite, createStaffInvite } from '../../utils/invites';
import { getShareOrigin } from '../../utils/origin';
import { FamilyRelationship, RELATIONSHIP_LABELS } from '../../types';

// Unified invite flow that lives on the People directory. Branches by
// who you're inviting so the model matches how coaches actually think:
//
//   Parent → pick the PLAYER they belong to → email or share link →
//            they sign up auto-linked to that player and inherit
//            access to every team the player is on (multi-team safe).
//
//   Staff  → pick a TEAM + role (head / assistant / manager) →
//            email or share link → they sign up with that role on
//            that team.
//
// Volunteers are intentionally NOT here — they don't need accounts;
// they sign up to event-specific volunteer slots without becoming users.

interface Player {
  id: string;
  name: string;
  jerseyNumber?: number;
  teamIds: string[];
  teamId?: string;
}
interface Team {
  id: string;
  name: string;
}

type InviteKind = 'parent' | 'staff';
type StaffRole = 'head_coach' | 'assistant_coach' | 'team_manager';

interface Props {
  clubTeams: Team[];
  clubPlayers: Player[];
  currentUid: string;
  onClose: () => void;
  /** Pin the modal to a specific player. Used from PersonAdmin's
   *  "Add Guardian" action — preselects the player and locks the
   *  invite kind to 'parent'. */
  defaultPlayerId?: string;
  defaultKind?: InviteKind;
}

const InvitePersonModal: React.FC<Props> = ({ clubTeams, clubPlayers, currentUid, onClose, defaultPlayerId, defaultKind }) => {
  const [kind, setKind] = useState<InviteKind>(defaultKind || 'parent');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>(defaultPlayerId || '');
  const [selectedTeamId, setSelectedTeamId] = useState<string>(clubTeams[0]?.id || '');
  const [staffRole, setStaffRole] = useState<StaffRole>('assistant_coach');
  const [relationship, setRelationship] = useState<FamilyRelationship>('parent');
  const [playerQuery, setPlayerQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Player picker: simple typeahead, sorted alphabetically.
  const playerMatches = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    const list = [...clubPlayers].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return list.slice(0, 50);
    return list.filter(p => p.name.toLowerCase().includes(q)).slice(0, 50);
  }, [clubPlayers, playerQuery]);

  const selectedPlayer = clubPlayers.find(p => p.id === selectedPlayerId);
  const selectedTeam = clubTeams.find(t => t.id === selectedTeamId);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setShareUrl(null);
    setCopied(false);
    try {
      let invite;
      if (kind === 'parent') {
        if (!selectedPlayer) { alert('Pick a player first.'); setBusy(false); return; }
        // Player invite is anchored to teamId for routing purposes — use
        // the player's primary team.
        const teamId = selectedPlayer.teamId || (selectedPlayer.teamIds || [])[0];
        if (!teamId) { alert("This player isn't on any team yet."); setBusy(false); return; }
        invite = await createPlayerInvite({
          teamId,
          playerId: selectedPlayer.id,
          createdBy: currentUid,
          relationship,
        });
      } else {
        if (!selectedTeam) { alert('Pick a team first.'); setBusy(false); return; }
        invite = await createStaffInvite({
          teamId: selectedTeam.id,
          role: staffRole,
          createdBy: currentUid,
        });
      }
      setShareUrl(`${getShareOrigin()}/join/${invite.id}`);
    } catch (err) {
      console.error('invite create failed', err);
      alert('Failed to create invite — try again.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this invite link:', shareUrl);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[92vh] sm:max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600">Invite someone</div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Kind toggle */}
        <div className="px-4 pt-3">
          <div className="flex gap-1">
            {([
              { k: 'parent' as const, label: 'Family' },
              { k: 'staff' as const, label: 'Coach / Manager' },
            ]).map(({ k, label }) => (
              <button
                key={k}
                onClick={() => { setKind(k); setShareUrl(null); }}
                className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest uppercase border ${
                  kind === k
                    ? 'bg-brand-primary-soft text-brand-primary border-brand-primary-soft'
                    : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1">
          {kind === 'parent' ? (
            <>
              <div className="text-[11px] text-slate-500">
                Family members are anchored to a player. They sign up via the share link and automatically inherit access to every team their player is on.
              </div>
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Relationship</label>
                <select
                  value={relationship}
                  onChange={e => setRelationship(e.target.value as FamilyRelationship)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {(Object.keys(RELATIONSHIP_LABELS) as FamilyRelationship[]).map(r => (
                    <option key={r} value={r}>{RELATIONSHIP_LABELS[r]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Pick player</label>
                <input
                  value={playerQuery}
                  onChange={e => setPlayerQuery(e.target.value)}
                  placeholder="Type a name…"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mb-1.5"
                />
                <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200">
                  {playerMatches.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-slate-400 text-center">No players match.</div>
                  ) : playerMatches.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPlayerId(p.id)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between border-b border-slate-100 last:border-b-0 ${
                        selectedPlayerId === p.id ? 'bg-brand-primary-soft text-brand-primary-dim font-bold' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span>{p.name}{p.jerseyNumber != null ? ` · #${p.jerseyNumber}` : ''}</span>
                      {selectedPlayerId === p.id && (
                        <svg className="w-3.5 h-3.5 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="text-[11px] text-slate-500">
                Coaches and managers are anchored to a team + role. They sign up via the share link and get added to that team with that role.
              </div>
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Team</label>
                <select
                  value={selectedTeamId}
                  onChange={e => setSelectedTeamId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {clubTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Role</label>
                <div className="flex gap-1">
                  {([
                    { r: 'head_coach' as const, label: 'Head coach' },
                    { r: 'assistant_coach' as const, label: 'Assistant' },
                    { r: 'team_manager' as const, label: 'Manager' },
                  ]).map(({ r, label }) => (
                    <button
                      key={r}
                      onClick={() => setStaffRole(r)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-extrabold tracking-widest uppercase border ${
                        staffRole === r
                          ? 'bg-brand-primary-soft text-brand-primary border-brand-primary-soft'
                          : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Generate / share */}
        <div className="px-4 pb-3">
          {shareUrl ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 space-y-2">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-700">Invite link</div>
              <div className="text-xs font-mono text-slate-900 break-all">{shareUrl}</div>
              <div className="flex gap-2">
                <button
                  onClick={copy}
                  className="flex-1 text-[11px] font-extrabold tracking-widest uppercase px-3 py-2 rounded-md bg-brand-primary text-white hover:bg-brand-primary"
                >
                  {copied ? '✓ Copied' : 'Copy link'}
                </button>
                {typeof navigator !== 'undefined' && (navigator as any).share && (
                  <button
                    onClick={async () => {
                      try { await (navigator as any).share({ url: shareUrl, title: 'GoalKickr invite' }); } catch {}
                    }}
                    className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-2 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                  >
                    Share
                  </button>
                )}
              </div>
              <p className="text-[10px] text-slate-500">Link expires in 30 days, good for up to 5 uses.</p>
            </div>
          ) : (
            <button
              onClick={generate}
              disabled={busy || (kind === 'parent' && !selectedPlayerId)}
              className="w-full text-xs font-extrabold tracking-widest uppercase px-3 py-2.5 rounded-lg bg-gradient-to-br from-brand-primary to-charcoal-600 text-white shadow-md shadow-brand-primary/30 disabled:opacity-40"
            >
              {busy ? 'Generating…' : 'Generate invite link'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default InvitePersonModal;
