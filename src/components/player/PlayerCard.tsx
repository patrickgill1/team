import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Player } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { isCoach } from '../../utils/helpers';
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../../utils/firebase';

interface PlayerCardProps {
  player: Player;
  onEdit?: (player: Player) => void;
  onDelete?: (playerId: string) => void;
  showActions?: boolean;
}

const PlayerCard: React.FC<PlayerCardProps> = ({ 
  player, 
  onEdit, 
  onDelete, 
  showActions = true 
}) => {
  const { userData } = useAuth();
  const { deleteDocument } = useFirestore();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const canEdit = isUserCoach && showActions;

  const handleDelete = async () => {
    if (!onDelete) return;
    
    setIsDeleting(true);
    try {
      await deleteDocument('players', player.id);
      onDelete(player.id);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Error deleting player:', error);
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

  return (
    <>
      <div className="card-modern overflow-hidden">
        {/* Header with jersey number, position, and profile photo */}
        <div className="bg-gradient-to-br from-fire-900 via-fire-950 to-black border-b border-cyan-500/10 px-4 py-3 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {/* Profile Photo or Jersey Number */}
              <div className="relative">
                {player.profilePhotoUrl ? (
                  <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-white/30">
                    <img
                      src={player.profilePhotoUrl}
                      alt={player.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="bg-white/20 rounded-full w-12 h-12 flex items-center justify-center">
                    <span className="text-xl font-bold">
                      {player.jerseyNumber ? `#${player.jerseyNumber}` : '?'}
                    </span>
                  </div>
                )}
                {/* Jersey number badge if profile photo exists */}
                {player.profilePhotoUrl && player.jerseyNumber && (
                  <div className="absolute -bottom-1 -right-1 bg-white/90 rounded-full w-6 h-6 flex items-center justify-center">
                    <span className="text-xs font-bold text-cyan-300">#{player.jerseyNumber}</span>
                  </div>
                )}
              </div>
              <div>
                <Link to={`/player/${player.id}`} className="hover:underline">
                  <h3 className="text-lg font-semibold">{player.name}</h3>
                </Link>
                <div className="flex items-center space-x-2">
                  {player.position && (
                    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-white/20 text-white">
                      {player.position}
                    </span>
                  )}
                  {age && (
                    <span className="text-xs text-cyan-100">
                      Age {age}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {canEdit && (
              <div className="flex space-x-2">
                <button
                  onClick={() => onEdit && onEdit(player)}
                  className="p-2 hover:bg-white/20 rounded-full transition-colors duration-200"
                  title="Edit Player"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-2 hover:bg-rose-500/30 rounded-full transition-colors duration-200"
                  title="Delete Player"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats section */}
        <div className="p-4">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-center p-3 bg-cyan-500/10 rounded-2xl">
              <div className="text-2xl font-bold text-cyan-300">{player.stats?.goals || 0}</div>
              <div className="text-sm text-gray-300">Goals</div>
            </div>
            <div className="text-center p-3 bg-emerald-500/100/10 rounded-2xl">
              <div className="text-2xl font-bold text-emerald-300">{player.stats?.assists || 0}</div>
              <div className="text-sm text-gray-300">Assists</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="text-center p-3 bg-amber-500/10 rounded-2xl">
              <div className="text-2xl font-bold text-amber-300">{player.stats?.saves || 0}</div>
              <div className="text-sm text-gray-300">Saves</div>
            </div>
            <div className="text-center p-3 bg-fuchsia-500/10 rounded-2xl">
              <div className="text-2xl font-bold text-fuchsia-300">{player.stats?.gamesPlayed || 0}</div>
              <div className="text-sm text-gray-300">Games</div>
            </div>
          </div>

          {/* Additional Info for coaches */}
          {isUserCoach && (
            <div className="mt-4 pt-4 border-t border-white/10 space-y-3">
              {/* "My Child" link toggle */}
              {userData && (
                <button
                  onClick={async () => {
                    try {
                      const isLinked = player.parentIds?.includes(userData.uid);
                      const playerRef = doc(db, 'players', player.id);
                      if (isLinked) {
                        await updateDoc(playerRef, { parentIds: arrayRemove(userData.uid) });
                      } else {
                        await updateDoc(playerRef, { parentIds: arrayUnion(userData.uid) });
                      }
                    } catch (err) {
                      console.error('Error linking parent:', err);
                    }
                  }}
                  className={`inline-flex items-center space-x-1 text-xs px-2 py-1 rounded-full transition-colors ${
                    player.parentIds?.includes(userData.uid)
                      ? 'bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
                      : 'bg-white/5 text-gray-400 hover:bg-white/10'
                  }`}
                  title={player.parentIds?.includes(userData.uid) ? 'Unlink as my child' : 'Link as my child'}
                >
                  <span>{player.parentIds?.includes(userData.uid) ? '👨‍👦' : '🔗'}</span>
                  <span>{player.parentIds?.includes(userData.uid) ? 'My Child' : 'My Child?'}</span>
                </button>
              )}

              {/* Medical Info */}
              {player.medicalInfo && (
                <div className="text-sm text-gray-300">
                  <span className="font-medium text-rose-300">Medical Info:</span>
                  <p className="text-xs mt-1 text-rose-300 bg-rose-500/10 p-2 rounded-xl">
                    {player.medicalInfo}
                  </p>
                </div>
              )}

              {/* Emergency Contacts */}
              {player.emergencyContacts && player.emergencyContacts.length > 0 && (
                <div className="text-sm text-gray-300">
                  <span className="font-medium">Emergency Contacts:</span>
                  <div className="mt-1 space-y-1">
                    {player.emergencyContacts.map((contact, index) => (
                      <div key={index} className="text-xs">
                        <span className="font-medium">{contact.name}</span>
                        <span className="text-gray-400"> ({contact.relationship})</span>
                        {contact.isPrimary && <span className="text-cyan-300 ml-1">• Primary</span>}
                        <br />
                        <a
                          href={`tel:${contact.phoneNumber}`}
                          className="text-cyan-300 hover:text-cyan-300"
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

        {/* Action buttons for parents */}
        {!isUserCoach && showActions && (
          <div className="px-4 pb-4">
            <button
              onClick={() => onEdit && onEdit(player)}
              className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200"
            >
              View/Update Stats
            </button>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card-modern max-w-md w-full p-6">
            <div className="flex items-center mb-4">
              <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-rose-100">
                <svg className="h-6 w-6 text-rose-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-white mb-2">Delete Player</h3>
              <p className="text-sm text-gray-400 mb-6">
                Are you sure you want to delete <strong>{player.name}</strong>? This action cannot be undone and will remove all associated statistics.
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                  className="flex-1 bg-white/5 hover:bg-white/10 text-gray-800 font-semibold py-2 px-4 rounded-xl transition duration-200 disabled:opacity-50"
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
                    'Delete'
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