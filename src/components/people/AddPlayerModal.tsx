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
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

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
  // Adult-team mode: the player IS the user (no parent layer).
  // Patrick: 'i have an adult team looking to add it' — pickup
  // leagues, over-35s, etc. When on, the parent-invite section
  // becomes a self-signup invite that links the user as both
  // parent (for permissions) AND the player themself (for UI).
  const [isAdultPlayer, setIsAdultPlayer] = useState(false);
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
        ...(isAdultPlayer ? { isAdultPlayer: true } : {}),
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
      //    Adult players: the same invite goes to the player themself;
      //    isAdultPlayer flag carries through so consumeInvite stamps
      //    selfPlayerId on the joining user's doc.
      let inviteUrl: string | undefined;
      if (generateInvite) {
        const invite = await createPlayerInvite({
          teamId: teamIds[0],
          playerId: playerRef.id,
          createdBy: currentUid,
          isAdultPlayer: isAdultPlayer || undefined,
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
    <Sheet
      open={true}
      onClose={onClose}
      kicker={result ? 'On the squad' : 'Add to squad'}
      title={result ? `${result.playerName} is in.` : 'New player'}
      footer={result ? (
        <Button variant="outline" onClick={onClose} fullWidth>Done</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={!name.trim() || selectedTeams.size === 0}
            loading={busy}
          >
            Add to squad
          </Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3">
          {result.inviteUrl ? (
            <div className="rounded-lg ring-1 ring-brand-primary/30 bg-brand-primary/10 p-3 space-y-2">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Parent invite link</div>
              <div className="text-xs font-mono text-ink-primary break-all">{result.inviteUrl}</div>
              <Button variant="primary" onClick={copy} fullWidth size="sm">
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <p className="text-[10px] text-ink-primary/50">Send this to {parentEmail.trim() || 'the parent'}. Link expires in 30 days.</p>
            </div>
          ) : (
            <p className="text-[11px] text-ink-primary/50">No parent invite generated. You can send one anytime via the + Invite button.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <FormField label="Name" required>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Logan Smith"
              className={fieldInputClass}
              autoFocus
            />
          </FormField>

          <div className="grid grid-cols-2 gap-2">
            <FormField label="Jersey #">
              <input
                type="number"
                value={jerseyNumber}
                onChange={e => setJerseyNumber(e.target.value)}
                placeholder="5"
                className={fieldInputClass}
              />
            </FormField>
            <FormField label="Position">
              <select
                value={position}
                onChange={e => setPosition(e.target.value)}
                className={fieldInputClass}
              >
                <option value="">—</option>
                {positions.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </FormField>
          </div>

          <FormField label={`Team${clubTeams.length > 1 ? 's' : ''}`}>
            <div className="space-y-1 mt-1">
              {clubTeams.map(t => {
                const on = selectedTeams.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTeam(t.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg ring-1 text-sm ${
                      on ? 'bg-brand-primary/15 ring-brand-primary/40 text-brand-primary-soft' : 'bg-surface-base ring-line-default/10 text-ink-primary hover:bg-line-default/5'
                    }`}
                  >
                    <span className="font-semibold">{t.name}</span>
                    <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'bg-brand-primary border-brand-primary text-brand-primary-fg' : 'border-line-default/20'}`}>
                      {on && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
                    </span>
                  </button>
                );
              })}
            </div>
          </FormField>

          {/* Adult-player toggle. When on, the invite below becomes a
              self-signup invite (the player IS the user; no parent
              layer). UI labels in the app flip from 'your kid' to
              'you' once they accept. */}
          <label className="flex items-start gap-2 p-3 rounded-lg ring-1 ring-line-default/10 bg-surface-base cursor-pointer">
            <input
              type="checkbox"
              checked={isAdultPlayer}
              onChange={e => setIsAdultPlayer(e.target.checked)}
              className="mt-0.5 accent-brand-primary"
            />
            <div className="flex-1">
              <div className="text-xs font-bold text-ink-primary">Adult player (no parent)</div>
              <div className="text-[10px] text-ink-primary/55 mt-0.5">
                Pickup leagues, over-35s, adult rec teams. The invite goes to the player themself; they sign up and manage their own profile.
              </div>
            </div>
          </label>

          <div className="rounded-lg ring-1 ring-line-default/10 p-3 space-y-2 bg-surface-base">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={generateInvite}
                onChange={e => setGenerateInvite(e.target.checked)}
                className="accent-brand-primary"
              />
              <span className="text-xs font-bold text-ink-primary">
                {isAdultPlayer ? 'Also generate a player invite link' : 'Also generate a parent invite link'}
              </span>
            </label>
            {generateInvite && (
              <>
                <input
                  type="email"
                  value={parentEmail}
                  onChange={e => setParentEmail(e.target.value)}
                  placeholder={isAdultPlayer ? 'player@example.com (optional — for your records)' : 'parent@example.com (optional — for your records)'}
                  className={fieldInputClass}
                />
                <p className="text-[10px] text-ink-primary/50">
                  You'll get a share link to text or email {isAdultPlayer ? 'the player' : 'the parent'}. No automatic email is sent.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
};

export default AddPlayerModal;
