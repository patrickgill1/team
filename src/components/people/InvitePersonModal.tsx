import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite, createStaffInvite } from '../../utils/invites';
import { getShareOrigin } from '../../utils/origin';
import { FamilyRelationship, RELATIONSHIP_LABELS } from '../../types';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

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
    <Sheet
      open={true}
      onClose={onClose}
      kicker="Invite someone"
      title={kind === 'parent' ? 'Add a family member' : 'Add a coach or manager'}
      footer={shareUrl ? (
        <Button variant="outline" onClick={onClose} fullWidth>Done</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={generate}
            disabled={kind === 'parent' && !selectedPlayerId}
            loading={busy}
          >
            Generate link
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        {/* Kind toggle */}
        <div className="flex gap-1">
          {([
            { k: 'parent' as const, label: 'Family' },
            { k: 'staff' as const, label: 'Coach / Manager' },
          ]).map(({ k, label }) => (
            <button
              key={k}
              type="button"
              onClick={() => { setKind(k); setShareUrl(null); }}
              className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest uppercase ring-1 transition ${
                kind === k
                  ? 'bg-brand-primary/15 text-brand-primary-soft ring-brand-primary/40'
                  : 'bg-charcoal-950 text-bone/70 ring-white/10 hover:bg-white/5'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {kind === 'parent' ? (
          <>
            <p className="text-[11px] text-bone/55 leading-snug">
              Family members are anchored to a player. They sign up via the share link and automatically inherit access to every team their player is on.
            </p>
            <FormField label="Relationship">
              <select
                value={relationship}
                onChange={e => setRelationship(e.target.value as FamilyRelationship)}
                className={fieldInputClass}
              >
                {(Object.keys(RELATIONSHIP_LABELS) as FamilyRelationship[]).map(r => (
                  <option key={r} value={r}>{RELATIONSHIP_LABELS[r]}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Pick player">
              <input
                value={playerQuery}
                onChange={e => setPlayerQuery(e.target.value)}
                placeholder="Type a name…"
                className={`${fieldInputClass} mb-1.5`}
              />
              <div className="max-h-44 overflow-y-auto rounded-lg ring-1 ring-white/10">
                {playerMatches.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-bone/40 text-center">No players match.</div>
                ) : playerMatches.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPlayerId(p.id)}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between border-b border-white/[0.04] last:border-b-0 ${
                      selectedPlayerId === p.id ? 'bg-brand-primary/15 text-brand-primary-soft font-bold' : 'hover:bg-white/5 text-bone'
                    }`}
                  >
                    <span>{p.name}{p.jerseyNumber != null ? ` · #${p.jerseyNumber}` : ''}</span>
                    {selectedPlayerId === p.id && (
                      <svg className="w-3.5 h-3.5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </FormField>
          </>
        ) : (
          <>
            <p className="text-[11px] text-bone/55 leading-snug">
              Coaches and managers are anchored to a team + role. They sign up via the share link and get added to that team with that role.
            </p>
            <FormField label="Team">
              <select
                value={selectedTeamId}
                onChange={e => setSelectedTeamId(e.target.value)}
                className={fieldInputClass}
              >
                {clubTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </FormField>
            <FormField label="Role">
              <div className="flex gap-1 mt-1">
                {([
                  { r: 'head_coach' as const, label: 'Head coach' },
                  { r: 'assistant_coach' as const, label: 'Assistant' },
                  { r: 'team_manager' as const, label: 'Manager' },
                ]).map(({ r, label }) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setStaffRole(r)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-[10px] font-extrabold tracking-widest uppercase ring-1 transition ${
                      staffRole === r
                        ? 'bg-brand-primary/15 text-brand-primary-soft ring-brand-primary/40'
                        : 'bg-charcoal-950 text-bone/70 ring-white/10 hover:bg-white/5'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </FormField>
          </>
        )}

        {shareUrl && (
          <div className="rounded-lg ring-1 ring-emerald-400/30 bg-emerald-500/10 p-3 space-y-2">
            <div className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-200">Invite link</div>
            <div className="text-xs font-mono text-bone break-all">{shareUrl}</div>
            <div className="flex gap-2">
              <Button variant="primary" onClick={copy} size="sm" fullWidth>
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              {typeof navigator !== 'undefined' && (navigator as any).share && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try { await (navigator as any).share({ url: shareUrl, title: 'GoalKickr invite' }); } catch {}
                  }}
                >
                  Share
                </Button>
              )}
            </div>
            <p className="text-[10px] text-bone/55">Link expires in 30 days, good for up to 5 uses.</p>
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default InvitePersonModal;
