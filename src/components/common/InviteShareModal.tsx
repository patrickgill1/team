import React, { useState } from 'react';
import { inviteUrl, smsShareLink, type FetchedInvite } from '../../utils/invites';
import type { Invite } from '../../types';

/**
 * Shared modal for any flow that has just created an invite. Renders the
 * shareable link with Copy / SMS / Done buttons. Caller is responsible for
 * actually creating the invite — this is presentational.
 */

interface Props {
  invite: Invite | FetchedInvite | null;
  open: boolean;
  onClose: () => void;
  // Optional context to personalize the share copy.
  playerName?: string;
}

const InviteShareModal: React.FC<Props> = ({ invite, open, onClose, playerName }) => {
  const [copied, setCopied] = useState(false);

  if (!open || !invite) return null;

  const url = inviteUrl(invite.id);
  const subject = invite.type === 'player' && playerName ? `${playerName}'s Fire FC profile` : 'Join Fire FC';
  const smsBody =
    invite.type === 'player' && playerName
      ? `Join ${playerName} on Fire FC: ${url}`
      : invite.type === 'coach'
        ? `Coach invite for Fire FC: ${url}`
        : invite.type === 'team_manager'
          ? `Team manager invite for Fire FC: ${url}`
          : `Join Fire FC: ${url}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback prompt
      window.prompt('Copy this link:', url);
    }
  };

  const handleSms = () => {
    const link = `sms:&body=${encodeURIComponent(smsBody)}`;
    window.location.href = link;
  };

  const handleNativeShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: subject, text: smsBody, url });
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.warn('share failed', err);
      }
    } else {
      handleCopy();
    }
  };

  const labelByType: Record<string, string> = {
    player: playerName ? `Invite a parent for ${playerName}` : 'Player invite',
    coach: invite.role === 'head_coach' ? 'Head coach invite' : 'Assistant coach invite',
    team_manager: 'Team manager invite',
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gradient-to-br from-fire-900 via-fire-950 to-black ring-1 ring-cyan-500/15 rounded-3xl shadow-2xl max-w-md w-full overflow-hidden text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative overflow-hidden p-6 border-b border-cyan-500/15">
          <div className="absolute -top-12 -right-12 w-48 h-48 bg-cyan-500/15 rounded-full blur-3xl pointer-events-none" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[10px] font-bold uppercase tracking-wider mb-3 backdrop-blur">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Invite ready
            </div>
            <h2 className="text-2xl font-black leading-tight">{labelByType[invite.type] || 'Invite'}</h2>
            <p className="text-white/70 text-sm mt-1">
              {invite.type === 'player'
                ? "Text or AirDrop this link. The first parent that taps it gets auto-linked — no email collection on your end."
                : 'Anyone with this link can join the team in the named role. Reusable up to the limit shown below.'}
            </p>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-3">
            <p className="text-[10px] uppercase tracking-widest font-bold text-white/50 mb-1">Share link</p>
            <p className="text-sm font-mono break-all text-cyan-200">{url}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white text-fire-800 font-bold text-sm shadow hover:scale-[1.02] transition"
            >
              {copied ? '✓ Copied' : '📋 Copy'}
            </button>
            <button
              onClick={handleSms}
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white/15 ring-1 ring-white/20 text-white font-semibold text-sm hover:bg-white/25 transition backdrop-blur"
            >
              💬 Text
            </button>
          </div>

          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <button
              onClick={handleNativeShare}
              className="w-full px-4 py-3 rounded-xl bg-white/10 ring-1 ring-white/15 text-white font-semibold text-sm hover:bg-white/20 transition"
            >
              ⤴ Share…
            </button>
          )}

          <div className="pt-2 border-t border-white/10 text-xs text-white/55 space-y-0.5">
            <p>Expires {invite.expiresAt instanceof Date ? invite.expiresAt.toLocaleDateString() : new Date(invite.expiresAt).toLocaleDateString()}</p>
            <p>{invite.maxUses == null ? 'Unlimited uses' : `${(invite as any).usedCount || 0} of ${invite.maxUses} uses`}</p>
          </div>

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-white/70 hover:text-white text-sm font-semibold transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default InviteShareModal;
