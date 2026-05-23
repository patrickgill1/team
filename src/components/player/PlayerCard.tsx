import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Player, Invite } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { isCoach, isTeamStaff } from '../../utils/helpers';
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite } from '../../utils/invites';
import InviteShareModal from '../common/InviteShareModal';
import { reactivatePlayerForCurrentSeason } from '../../utils/seasons';

interface PlayerCardProps {
  player: Player;
  onEdit?: (player: Player) => void;
  onDelete?: (playerId: string) => void;
  showActions?: boolean;
}

const positionDot = (pos?: string): string => {
  switch (pos) {
    case 'Goalkeeper': return 'bg-amber-400';
    case 'Defender': return 'bg-sky-400';
    case 'Midfielder': return 'bg-emerald-400';
    case 'Forward':
    case 'Striker': return 'bg-rose-400';
    case 'Winger': return 'bg-orange-400';
    default: return 'bg-cyan-400';
  }
};

const MiniStat: React.FC<{ label: string; value: number; accent: 'emerald' | 'cyan' | 'amber' | 'violet' }> = ({ label, value, accent }) => {
  const ring =
    accent === 'emerald' ? 'text-emerald-300' :
    accent === 'cyan' ? 'text-cyan-300' :
    accent === 'amber' ? 'text-amber-300' :
    'text-violet-300';
  return (
    <div className="rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur p-2.5 text-center overflow-hidden">
      <div className={`text-xl sm:text-2xl font-black ${ring}`}>{value}</div>
      {/* tracking-tight + leading-none so the label fits even on the narrowest
          card width; 'ASSISTS' was clipping to 'ASSIS' on the previous
          tracking-wider value. */}
      <div className="text-[9px] sm:text-[10px] uppercase tracking-tight leading-none text-white/70 font-bold mt-0.5 truncate">{label}</div>
    </div>
  );
};

const PlayerCard: React.FC<PlayerCardProps> = ({
  player,
  onEdit,
  onDelete,
  showActions = true
}) => {
  const { userData } = useAuth();
  const { updateDocument } = useFirestore();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [activeInvite, setActiveInvite] = useState<Invite | null>(null);

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const isUserStaff = userData ? isTeamStaff(userData.role) : false;
  const canEdit = isUserCoach && showActions;
  const canInviteParents = isUserStaff && showActions;

  const handleInviteParent = async () => {
    if (!userData) return;
    setGeneratingInvite(true);
    try {
      const inv = await createPlayerInvite({
        teamId: player.teamId,
        playerId: player.id,
        createdBy: userData.uid,
      });
      setActiveInvite(inv);
    } catch (err) {
      console.error('Failed to create invite', err);
      alert('Could not generate invite link. Try again.');
    } finally {
      setGeneratingInvite(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setIsDeleting(true);
    try {
      // Soft delete: mark as inactive instead of hard-deleting the doc.
      // The Players list filters by isActive so the player visually
      // disappears, but their record + stats + media references are
      // preserved and can be restored from the Archived view. Prior
      // hard-delete had no recovery path and silently lost players.
      await updateDocument('players', player.id, { isActive: false });
      onDelete(player.id);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Error archiving player:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const calculateAge = (dateOfBirth?: Date): number | null => {
    if (!dateOfBirth) return null;
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  const age = calculateAge(player.dateOfBirth);
  const isMyChild = userData ? player.parentIds?.includes(userData.uid) : false;

  const toggleMyChild = async () => {
    if (!userData) return;
    try {
      const playerRef = doc(db, 'players', player.id);
      if (isMyChild) {
        await updateDoc(playerRef, { parentIds: arrayRemove(userData.uid) });
      } else {
        await updateDoc(playerRef, { parentIds: arrayUnion(userData.uid) });
      }
    } catch (err) {
      console.error('Error linking parent:', err);
    }
  };

  return (
    <>
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-fire-700 via-fire-800 to-navy-900 p-5 sm:p-6 text-white shadow-2xl ring-1 ring-white/10">
        {/* decorative blobs */}
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-10 w-56 h-56 bg-rose-500/20 rounded-full blur-3xl pointer-events-none" />

        {/* Edit / Delete actions */}
        {canEdit && (
          <div className="absolute top-3 right-3 z-10 flex space-x-1">
            <button
              onClick={() => onEdit && onEdit(player)}
              className="p-2 bg-white/10 hover:bg-white/20 ring-1 ring-white/15 rounded-full text-white backdrop-blur transition-colors"
              title="Edit Player"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="p-2 bg-white/10 hover:bg-amber-500/40 ring-1 ring-white/15 rounded-full text-white backdrop-blur transition-colors"
              title="Archive player (preserves stats; can be restored)"
            >
              {/* Archive box icon (less alarming than a trash can) */}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </button>
          </div>
        )}

        <div className="relative">
          {/* Position pill */}
          {player.position && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[10px] font-bold uppercase tracking-wider mb-4 backdrop-blur">
              <span className={`w-2 h-2 rounded-full ${positionDot(player.position)}`} />
              {player.position}
            </div>
          )}

          {/* Photo + Name row */}
          <div className="flex items-center gap-4 mb-5">
            <div className="relative flex-shrink-0">
              {player.profilePhotoUrl ? (
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full overflow-hidden ring-2 ring-white/25 shadow-lg">
                  <img
                    src={player.profilePhotoUrl}
                    alt={player.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white/10 ring-2 ring-white/25 shadow-lg flex items-center justify-center backdrop-blur">
                  <span className="text-2xl font-black text-white">
                    {player.jerseyNumber ? `#${player.jerseyNumber}` : player.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              {player.profilePhotoUrl && player.jerseyNumber != null && (
                <span className="absolute -bottom-1 -right-1 bg-white text-fire-800 rounded-full min-w-[28px] h-7 px-1.5 flex items-center justify-center text-xs font-black shadow-lg ring-2 ring-fire-900">
                  #{player.jerseyNumber}
                </span>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <Link to={`/player/${player.id}`} className="hover:underline">
                {/* Let long names wrap to 2 lines instead of truncating to
                    'Ryd…' / 'Hect…'. Looked broken on iPad-width cards. */}
                <h3 className="text-xl sm:text-2xl font-black tracking-tight leading-tight break-words line-clamp-2">{player.name}</h3>
              </Link>
              <p className="text-white/70 text-sm font-medium mt-0.5">
                {player.jerseyNumber != null && !player.profilePhotoUrl ? `Jersey #${player.jerseyNumber}` : ''}
                {player.jerseyNumber != null && !player.profilePhotoUrl && age ? ' · ' : ''}
                {age ? `Age ${age}` : (player.jerseyNumber != null && !player.profilePhotoUrl ? '' : 'Player')}
              </p>
            </div>
          </div>

          {/* Mini stat tiles */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            <MiniStat label="Goals" value={player.stats?.goals || 0} accent="emerald" />
            <MiniStat label="Assists" value={player.stats?.assists || 0} accent="cyan" />
            <MiniStat label="Saves" value={player.stats?.saves || 0} accent="amber" />
            <MiniStat label="Games" value={player.stats?.gamesPlayed || 0} accent="violet" />
          </div>

          {/* Inactive-player banner + reactivate */}
          {!player.isActive && isUserCoach && (
            <div className="rounded-xl bg-amber-400/10 ring-1 ring-amber-300/30 p-3 mb-3 flex items-center justify-between gap-3 backdrop-blur">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-amber-200">Past Player</p>
                <p className="text-xs text-white/70 mt-0.5">Profile + clips + history preserved.</p>
              </div>
              <button
                onClick={async () => {
                  try {
                    await reactivatePlayerForCurrentSeason(player.id, player.teamId, player.jerseyNumber, player.position);
                  } catch (err) {
                    console.error('Reactivate failed', err);
                    alert('Could not reactivate. Try again.');
                  }
                }}
                className="px-3 py-2 rounded-full bg-emerald-400/20 ring-1 ring-emerald-300/40 text-emerald-200 hover:bg-emerald-400/30 text-xs font-semibold backdrop-blur transition whitespace-nowrap"
              >
                ↺ Bring Back
              </button>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 items-center">
            <Link
              to={`/player/${player.id}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-fire-800 font-bold text-sm shadow hover:scale-105 transition"
            >
              View Profile →
            </Link>
            {canInviteParents && (
              <button
                onClick={handleInviteParent}
                disabled={generatingInvite}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-cyan-400/20 ring-1 ring-cyan-300/40 text-cyan-200 hover:bg-cyan-400/30 text-xs font-semibold backdrop-blur transition disabled:opacity-50"
                title="Generate a one-tap link to share with a parent"
              >
                {generatingInvite ? '…' : '✉ Invite Parent'}
              </button>
            )}
            {isUserCoach && userData && (
              <button
                onClick={toggleMyChild}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold backdrop-blur transition ${
                  isMyChild
                    ? 'bg-emerald-400/20 ring-1 ring-emerald-300/40 text-emerald-200 hover:bg-emerald-400/30'
                    : 'bg-white/15 ring-1 ring-white/20 text-white hover:bg-white/25'
                }`}
                title={isMyChild ? 'Unlink as my child' : 'Link as my child'}
              >
                {isMyChild ? '✓ My Child' : 'My Child?'}
              </button>
            )}
            {!isUserCoach && showActions && (
              <button
                onClick={() => onEdit && onEdit(player)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 ring-1 ring-white/20 text-white font-semibold text-sm hover:bg-white/25 transition backdrop-blur"
              >
                Update Stats
              </button>
            )}
          </div>

          {/* Coach-only footer info */}
          {isUserCoach && (player.medicalInfo || (player.emergencyContacts && player.emergencyContacts.length > 0)) && (
            <div className="mt-4 pt-4 border-t border-white/10 space-y-3">
              {player.medicalInfo && (
                <div className="rounded-xl bg-rose-500/15 ring-1 ring-rose-300/30 p-3 backdrop-blur">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-rose-200 mb-1">Medical Info</p>
                  <p className="text-xs text-rose-100">{player.medicalInfo}</p>
                </div>
              )}

              {player.emergencyContacts && player.emergencyContacts.length > 0 && (
                <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-3 backdrop-blur">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1.5">Emergency Contacts</p>
                  <div className="space-y-1.5">
                    {player.emergencyContacts.map((contact, index) => (
                      <div key={index} className="text-xs text-white/85">
                        <span className="font-semibold">{contact.name}</span>
                        <span className="text-white/60"> ({contact.relationship})</span>
                        {contact.isPrimary && <span className="text-cyan-300 ml-1">• Primary</span>}
                        <a
                          href={`tel:${contact.phoneNumber}`}
                          className="block text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                        >
                          {contact.phoneNumber}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <InviteShareModal
        invite={activeInvite}
        open={!!activeInvite}
        onClose={() => setActiveInvite(null)}
        playerName={player.name}
      />

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card-modern max-w-md w-full p-6">
            <div className="flex items-center mb-4">
              <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-rose-100">
                <svg className="h-6 w-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-fire-950 mb-2">Archive Player</h3>
              <p className="text-sm text-gray-500 mb-6">
                Archive <strong>{player.name}</strong>? They'll be removed from the active roster but their stats, photos, and history are preserved. You can restore them later from the Archived view.
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-2 px-4 rounded-xl transition duration-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200 disabled:opacity-50 flex items-center justify-center"
                >
                  {isDeleting ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    'Archive'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default PlayerCard;
