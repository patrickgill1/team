import React, { useEffect, useState } from 'react';
import { collection, doc, getDocs, onSnapshot, query, where, documentId } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite } from '../../utils/invites';
import { isTeamStaff } from '../../utils/helpers';
import InviteShareModal from '../common/InviteShareModal';
import type { Invite, Player } from '../../types';
import KidModeSetupModal from './KidModeSetupModal';
import KidModePinModal from './KidModePinModal';
import KidChatShadowModal from '../kidChat/KidChatShadowModal';
import { setDedicatedKidPlayerId, getDedicatedKidPlayerId, clearDedicatedKidPlayerId } from '../../utils/kidMode';
import { workerFetch } from '../../utils/workerFetch';

// Player Circle card for the player profile Overview tab. Shows
// the current circle (parents / guardians) with real names + a
// single Add to circle button when the viewer has standing:
//   - Viewer already in this player's parentIds (add co-parent /
//     grandparent), OR
//   - Viewer is team staff and the circle is empty (empty state)
//
// Everything else goes to the PlayerCard's own action row — this
// card is here so parents landing on their kid's profile see the
// circle and can invite from the natural spot (their kid's page).
//
// Distinct from PlayerCard so the profile file stays under control
// and this card can be reused from other detail surfaces later.

interface Props {
  player: Player & { parentIds?: string[]; parentEmails?: string[] };
  viewerUid: string;
  viewerEmail: string;
  viewerRole: string;
}

interface CircleMember {
  uid: string;
  name: string;
  photoURL?: string;
  isViewer: boolean;
}

const PlayerCircleCard: React.FC<Props> = ({ player, viewerUid, viewerEmail, viewerRole }) => {
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [activeInvite, setActiveInvite] = useState<Invite | null>(null);
  const [showKidSetup, setShowKidSetup] = useState(false);
  const [showKidPin, setShowKidPin] = useState(false);
  const [showKidShadow, setShowKidShadow] = useState(false);
  const [dedicatedHere, setDedicatedHere] = useState<string | null>(() => getDedicatedKidPlayerId());
  const [confirmingDedicated, setConfirmingDedicated] = useState(false);
  const [busyDisable, setBusyDisable] = useState(false);

  const parentIds: string[] = Array.isArray(player.parentIds) ? player.parentIds : [];
  const viewerIsInCircle = parentIds.includes(viewerUid);
  const viewerIsStaff = isTeamStaff(viewerRole);
  const circleEmpty = parentIds.length === 0;
  const canInvite = viewerIsInCircle || (viewerIsStaff && circleEmpty);
  // Subscribe to the player doc so kidMode.enabled updates live after
  // the worker write — otherwise the setup modal succeeds but the tile
  // stays on "Give X their own view" because the prop is a snapshot
  // from PlayerProfile's initial load.
  const [liveKidMode, setLiveKidMode] = useState<any>((player as any).kidMode);
  useEffect(() => {
    if (!player.id) return;
    const unsub = onSnapshot(doc(db, 'players', player.id), (snap) => {
      if (!snap.exists()) return;
      const data: any = snap.data();
      setLiveKidMode(data?.kidMode);
    }, err => console.warn('[kid-mode] player subscribe failed', err));
    return () => unsub();
  }, [player.id]);
  const kidModeEnabled = liveKidMode?.enabled === true;
  const canManageKidMode = viewerIsInCircle;
  const firstName = (player.name || '').split(' ')[0] || 'player';

  useEffect(() => {
    let cancelled = false;
    if (parentIds.length === 0) { setMembers([]); setLoading(false); return; }
    (async () => {
      try {
        // Resolve up to 30 parents at a time (Firestore `in` limit).
        // Real families rarely have more than a handful; the chunking
        // is defense against edge cases (co-parents + grandparents
        // both on one player).
        const chunks: string[][] = [];
        for (let i = 0; i < parentIds.length; i += 30) chunks.push(parentIds.slice(i, i + 30));
        const rows: CircleMember[] = [];
        for (const chunk of chunks) {
          const snap = await getDocs(query(
            collection(db, 'users'),
            where(documentId(), 'in', chunk),
          ));
          snap.docs.forEach((d) => {
            const data: any = d.data() || {};
            rows.push({
              uid: d.id,
              name: data.name || data.displayName || data.email || 'Guardian',
              photoURL: data.photoURL || data.profilePhotoUrl,
              isViewer: d.id === viewerUid,
            });
          });
        }
        rows.sort((a, b) => (a.isViewer ? -1 : b.isViewer ? 1 : a.name.localeCompare(b.name)));
        if (!cancelled) setMembers(rows);
      } catch (err) {
        console.error('PlayerCircleCard load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [parentIds.join(','), viewerUid]);

  const invite = async () => {
    if (generatingInvite) return;
    setGeneratingInvite(true);
    try {
      const teamId = (player as any).teamId || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '');
      if (!teamId) throw new Error('No team on player');
      const inv = await createPlayerInvite({
        teamId,
        playerId: player.id,
        createdBy: viewerUid,
      });
      setActiveInvite(inv);
    } catch (err) {
      console.error('createPlayerInvite failed', err);
      alert('Could not generate invite link.');
    } finally {
      setGeneratingInvite(false);
    }
  };

  return (
    <>
      <div className="relative overflow-visible rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m3-1.13a4 4 0 1 1 4-4 4 4 0 0 1-4 4zm6-4a3 3 0 1 1 0-6" />
          </svg>
          <span className="text-[11px] uppercase tracking-widest font-black text-ink-primary/55">Player Circle</span>
          {parentIds.length > 0 && (
            <span className="text-[10px] uppercase tracking-widest font-black text-ink-primary/45">
              {parentIds.length}
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-ink-primary/45">Loading circle…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-primary/70 leading-snug">
            {circleEmpty
              ? 'No one is in the circle yet. Invite a parent or guardian to see this player’s updates, media, and messages.'
              : 'Circle members are loading. Refresh if this stays empty.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <div
                key={m.uid}
                className={`inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full ring-1 ${
                  m.isViewer ? 'bg-brand-primary-soft/15 ring-brand-primary-soft/40' : 'bg-line-default/[0.06] ring-line-default/15'
                }`}
                title={m.isViewer ? 'You' : m.name}
              >
                {m.photoURL ? (
                  <img src={m.photoURL} alt="" className="w-6 h-6 rounded-full object-cover" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-line-default/15 flex items-center justify-center text-[10px] font-bold text-ink-primary">
                    {m.name.charAt(0)}
                  </div>
                )}
                <span className="text-xs font-semibold text-ink-primary truncate max-w-[140px]">
                  {m.isViewer ? 'You' : m.name}
                </span>
              </div>
            ))}
          </div>
        )}

        {canInvite && (
          <div className="mt-3 pt-3 border-t border-line-default/10">
            <button
              onClick={invite}
              disabled={generatingInvite}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-brand-primary-soft/20 ring-1 ring-brand-primary-soft/40 text-ink-primary hover:bg-brand-primary-soft/30 text-xs font-bold backdrop-blur transition disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v6m3-3h-6m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              {generatingInvite ? 'Generating…' : circleEmpty ? 'Start the circle' : 'Add to circle'}
            </button>
            <p className="text-[11px] text-ink-primary/45 mt-2 leading-snug">
              Send a one-tap link to a co-parent, grandparent, or other guardian. They'll be linked to this player as soon as they open it.
            </p>
          </div>
        )}

        {/* Kid profile mode tiles. Only surfaced to parents already
            in the circle (viewerIsInCircle). Kid mode is a UI-only
            constraint — no separate Firebase Auth user, no rules
            changes; parent's uid stays the actor at the auth layer. */}
        {canManageKidMode && (
          <div className="mt-3 pt-3 border-t border-line-default/10 space-y-2">
            {!kidModeEnabled ? (
              <button
                onClick={() => setShowKidSetup(true)}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-full bg-line-default/[0.06] ring-1 ring-brand-primary-soft/30 text-ink-primary hover:bg-brand-primary-soft/15 text-xs font-bold transition"
              >
                <svg className="w-3.5 h-3.5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Give {firstName} their own view
              </button>
            ) : (
              <>
                <button
                  onClick={() => setShowKidPin(true)}
                  className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-full bg-brand-primary text-white text-xs font-bold shadow hover:opacity-90 transition"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 12h15" />
                  </svg>
                  Enter {firstName}'s view
                </button>
                <button
                  onClick={() => setShowKidShadow(true)}
                  className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-full bg-line-default/[0.06] ring-1 ring-line-default/25 text-ink-primary text-xs font-bold hover:bg-line-default/10 transition"
                >
                  <svg className="w-3.5 h-3.5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.4C3.5 15.4 3 13.7 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  See {firstName}'s chats
                </button>
                {dedicatedHere === player.id ? (
                  <button
                    onClick={() => { clearDedicatedKidPlayerId(); setDedicatedHere(null); }}
                    className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/75 text-[11px] font-semibold hover:bg-line-default/15 transition"
                  >
                    ✓ This is {firstName}'s device (tap to unmark)
                  </button>
                ) : confirmingDedicated ? (
                  <div className="rounded-xl bg-line-default/5 ring-1 ring-line-default/15 p-3 space-y-2">
                    <p className="text-[11px] text-ink-primary/70 leading-snug">
                      Make this device open in {firstName}'s view by default? PIN unlocks parent view.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmingDedicated(false)}
                        className="flex-1 px-3 py-1.5 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-[11px] font-semibold text-ink-primary/70"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => { setDedicatedKidPlayerId(player.id); setDedicatedHere(player.id); setConfirmingDedicated(false); }}
                        className="flex-1 px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-bold"
                      >
                        Yes, make it {firstName}'s
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingDedicated(true)}
                    className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/75 text-[11px] font-semibold hover:bg-line-default/15 transition"
                  >
                    Make this {firstName}'s device
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (busyDisable) return;
                    if (!window.confirm(`Turn off ${firstName}'s view? You can enable it again anytime.`)) return;
                    setBusyDisable(true);
                    try {
                      const res = await workerFetch('/players/set-kid-mode', {
                        method: 'POST',
                        body: JSON.stringify({ playerId: player.id, action: 'disable' }),
                      });
                      const data: any = await res.json().catch(() => ({}));
                      if (!res.ok || !data?.ok) throw new Error(data?.error || `disable-${res.status}`);
                      if (dedicatedHere === player.id) { clearDedicatedKidPlayerId(); setDedicatedHere(null); }
                    } catch (err) {
                      console.error('disable kid mode failed', err);
                      alert('Could not turn off kid view. Try again.');
                    } finally {
                      setBusyDisable(false);
                    }
                  }}
                  disabled={busyDisable}
                  className="w-full text-[11px] font-semibold text-ink-primary/50 hover:text-ink-primary/70 transition disabled:opacity-50"
                >
                  {busyDisable ? 'Turning off…' : `Turn off ${firstName}'s view`}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <InviteShareModal
        invite={activeInvite}
        open={!!activeInvite}
        onClose={() => setActiveInvite(null)}
        playerName={player.name}
      />

      <KidModeSetupModal
        playerId={player.id}
        playerName={firstName}
        open={showKidSetup}
        onClose={() => setShowKidSetup(false)}
        onEnabled={() => { /* onSnapshot listeners will refresh player.kidMode */ }}
      />

      <KidModePinModal
        open={showKidPin}
        onClose={() => setShowKidPin(false)}
        mode="enter"
        playerId={player.id}
        playerName={firstName}
      />

      <KidChatShadowModal
        open={showKidShadow}
        onClose={() => setShowKidShadow(false)}
        player={player}
      />
    </>
  );
};

export default PlayerCircleCard;
