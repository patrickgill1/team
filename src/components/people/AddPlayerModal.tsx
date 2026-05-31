import React, { useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
  arrayUnion,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite } from '../../utils/invites';
import { getShareOrigin } from '../../utils/origin';

// Combined "Add Player + Invite Parent" flow. Saves the round-trip
// when a coach is bringing in a brand-new family — one form does
// (a) creates the player doc, (b) creates a player_membership row
// per team picked, (c) optionally generates a parent invite share
// link that the coach can paste to the parent.

interface Team {
  id: string;
  name: string;
  clubId?: string;
}

interface Props {
  clubTeams: Team[];
  defaultTeamId?: string;
  currentUid: string;
  onClose: () => void;
  onCreated: (player: { id: string; name: string }, inviteUrl?: string) => void;
}

const AddPlayerModal: React.FC<Props> = ({ clubTeams, defaultTeamId, currentUid, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [position, setPosition] = useState('');
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(
    new Set(defaultTeamId ? [defaultTeamId] : (clubTeams[0] ? [clubTeams[0].id] : []))
  );
  const [parentEmail, setParentEmail] = useState('');
  const [generateInvite, setGenerateInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ playerName: string; inviteUrl?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const positions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'Striker'];

  const toggleTeam = (id: string) => {
    const next = new Set(selectedTeams);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedTeams(next);
  };

  const save = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { alert('Player name is required.'); return; }
    if (selectedTeams.size === 0) { alert('Pick at least one team.'); return; }
    setBusy(true);
    try {
      const teamIds = Array.from(selectedTeams);
      const primaryTeam = clubTeams.find(t => t.id === teamIds[0]);
      const clubId = primaryTeam?.clubId || 'club_unknown';

      // 1. Create the player doc. Includes clubId + teamIds + legacy
      //    teamId so all read-paths (old and new) see the player.
      const playerData: any = {
        name: trimmed,
        clubId,
        teamId: teamIds[0],
        teamIds,
        isActive: true,
        createdAt: serverTimestamp(),
        ...(jerseyNumber ? { jerseyNumber: parseInt(jerseyNumber, 10) || undefined } : {}),
        ...(position ? { position, positions: [position] } : {}),
        ...(parentEmail.trim() ? { parentEmails: [parentEmail.trim().toLowerCase()] } : {}),
      };
      const playerRef = await addDoc(collection(db, 'players'), playerData);

      // 2. Create a player_membership per team chosen.
      for (const teamId of teamIds) {
        const team = clubTeams.find(t => t.id === teamId);
        await addDoc(collection(db, 'player_memberships'), {
          clubId: team?.clubId || clubId,
          teamId,
          seasonId: 'season_active',
          playerId: playerRef.id,
          jerseyNumber: jerseyNumber ? parseInt(jerseyNumber, 10) || undefined : undefined,
          position: position || undefined,
          isActive: true,
          joinedAt: serverTimestamp(),
        });

        // 3. Backwards compat: append player to team.playerIds.
        await updateDoc(doc(db, 'teams', teamId), {
          playerIds: arrayUnion(playerRef.id),
        });
      }

      // 4. Optional: generate a parent invite link for this player.
      let inviteUrl: string | undefined;
      if (generateInvite) {
        const invite = await createPlayerInvite({
          teamId: teamIds[0],
          playerId: playerRef.id,
          createdBy: currentUid,
        });
        inviteUrl = `${getShareOrigin()}/join/${invite.id}`;
      }

      setResult({ playerName: trimmed, inviteUrl });
      onCreated({ id: playerRef.id, name: trimmed }, inviteUrl);
    } catch (err) {
      console.error('add player failed', err);
      alert('Failed to add player — try again.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this invite link:', result.inviteUrl);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[92vh] sm:max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600">
            {result ? 'Player added' : 'Add player'}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {result ? (
          <div className="px-4 py-4 space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <div className="text-sm font-bold text-emerald-900">{result.playerName} added to the roster.</div>
            </div>
            {result.inviteUrl ? (
              <div className="rounded-lg border border-cyan-200 bg-cyan-50/50 p-3 space-y-2">
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-700">Parent invite link</div>
                <div className="text-xs font-mono text-slate-900 break-all">{result.inviteUrl}</div>
                <button
                  onClick={copy}
                  className="w-full text-[11px] font-extrabold tracking-widest uppercase px-3 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-500"
                >
                  {copied ? '✓ Copied' : 'Copy link'}
                </button>
                <p className="text-[10px] text-slate-500">Send this to {parentEmail.trim() || "the parent"}. Link expires in 30 days.</p>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">No parent invite generated. You can send one anytime via the + Invite button.</p>
            )}
            <button
              onClick={onClose}
              className="w-full text-xs font-extrabold tracking-widest uppercase px-3 py-2.5 rounded-lg bg-slate-900 text-white"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-4 py-3 space-y-3 overflow-y-auto flex-1">
            {/* Name */}
            <div>
              <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Name <span className="text-rose-500">*</span></label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Logan Smith"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                autoFocus
              />
            </div>

            {/* Jersey + Position side-by-side */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Jersey #</label>
                <input
                  type="number"
                  value={jerseyNumber}
                  onChange={e => setJerseyNumber(e.target.value)}
                  placeholder="5"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Position</label>
                <select
                  value={position}
                  onChange={e => setPosition(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="">—</option>
                  {positions.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {/* Teams */}
            <div>
              <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Team{clubTeams.length > 1 ? 's' : ''}</label>
              <div className="space-y-1">
                {clubTeams.map(t => {
                  const on = selectedTeams.has(t.id);
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleTeam(t.id)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${
                        on ? 'bg-cyan-50 border-cyan-200 text-cyan-900' : 'bg-white border-slate-200 text-slate-700 hover:border-slate-400'
                      }`}
                    >
                      <span className="font-semibold">{t.name}</span>
                      <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'bg-cyan-600 border-cyan-600 text-white' : 'border-slate-300'}`}>
                        {on && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Parent invite (optional) */}
            <div className="rounded-lg border border-slate-200 p-3 space-y-2 bg-slate-50/50">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={generateInvite}
                  onChange={e => setGenerateInvite(e.target.checked)}
                  className="rounded text-cyan-600 focus:ring-cyan-500"
                />
                <span className="text-xs font-bold text-slate-800">Also generate a parent invite link</span>
              </label>
              {generateInvite && (
                <>
                  <input
                    type="email"
                    value={parentEmail}
                    onChange={e => setParentEmail(e.target.value)}
                    placeholder="parent@example.com (optional — for your records)"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  />
                  <p className="text-[10px] text-slate-500">You'll get a share link to text or email the parent. No automatic email is sent.</p>
                </>
              )}
            </div>

            <button
              onClick={save}
              disabled={busy || !name.trim() || selectedTeams.size === 0}
              className="w-full text-xs font-extrabold tracking-widest uppercase px-3 py-2.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/30 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Add player'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AddPlayerModal;
