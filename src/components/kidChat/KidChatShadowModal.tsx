import React, { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Player, Team } from '../../types';
import KidChatRoom from './KidChatRoom';

interface Props {
  open: boolean;
  onClose: () => void;
  player: Player;
}

// Parent shadow view. Read-only kid chat for the player's team. No
// composer, no send button — parents see every message a kid on the
// team posts. Coaches would use this same view for moderation, but
// they can already moderate inline from KidDashboard when they open
// a kid's view; the shadow modal is specifically the parent's
// safety window.
const KidChatShadowModal: React.FC<Props> = ({ open, onClose, player }) => {
  const [team, setTeam] = useState<Team | null>(null);

  useEffect(() => {
    if (!open) return;
    const teamId = player.teamId || (Array.isArray((player as any).teamIds) ? (player as any).teamIds[0] : '');
    if (!teamId) return;
    const unsub = onSnapshot(doc(db, 'teams', teamId), (snap) => {
      if (!snap.exists()) { setTeam(null); return; }
      setTeam({ id: snap.id, ...(snap.data() as any) } as Team);
    });
    return () => unsub();
  }, [open, player.teamId]);

  if (!open) return null;
  const firstName = (player.name || 'kid').split(' ')[0];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:max-w-lg h-[85vh] sm:h-[70vh] rounded-t-2xl sm:rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 shadow-2xl flex flex-col overflow-hidden">
        <header className="px-4 py-3 border-b border-line-default/10 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-widest font-black text-brand-primary-soft">Shadow read</p>
            <h3 className="text-base font-black tracking-tight truncate">{firstName}'s team chat</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 hover:bg-line-default/15 transition"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 min-h-0 p-2">
          <KidChatRoom
            actingAsPlayer={null}
            team={team}
            canPost={false}
            variant="full"
          />
        </div>

        <p className="text-[10px] text-ink-primary/45 px-4 py-2 border-t border-line-default/10">
          You see every message posted in the kid room. Long-press or hover a message to remove it.
        </p>
      </div>
    </div>
  );
};

export default KidChatShadowModal;
