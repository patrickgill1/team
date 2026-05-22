// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';

interface TeamOption { id: string; name: string; ageGroup?: string }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  player: { id: string; name: string; teamId?: string; teamIds?: string[] } | null;
  teams: TeamOption[];
  /** Fires after the write completes so the caller can refresh. */
  onTransferred: () => void;
}

/**
 * Move a player from one team to another (transfer) or roster them on
 * multiple teams (share). v1 supports the canonical teamIds[] array and
 * also keeps the legacy `teamId` string in sync so older readers don't
 * break.
 */
const TransferPlayerModal: React.FC<Props> = ({ isOpen, onClose, player, teams, onTransferred }) => {
  const { userData } = useAuth();
  const { updateDocument } = useFirestore();
  const [destinationId, setDestinationId] = useState<string>('');
  const [mode, setMode] = useState<'move' | 'share'>('move');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !player) return null;

  const currentTeamIds: string[] = Array.isArray(player.teamIds) && player.teamIds.length > 0
    ? player.teamIds
    : (player.teamId ? [player.teamId] : []);

  const eligibleTeams = teams.filter((t) => !currentTeamIds.includes(t.id));

  const handleSubmit = async () => {
    if (!destinationId || !player || !userData) return;
    setSaving(true);
    setError(null);
    try {
      let nextTeamIds: string[];
      let nextPrimary: string;
      if (mode === 'move') {
        // Replace the player's roster — drop everything they were on,
        // anchor them on the new destination team.
        nextTeamIds = [destinationId];
        nextPrimary = destinationId;
      } else {
        // Share: keep existing teams, add the new one.
        nextTeamIds = Array.from(new Set([...currentTeamIds, destinationId]));
        nextPrimary = player.teamId || nextTeamIds[0];
      }
      await updateDocument('players', player.id, {
        teamIds: nextTeamIds,
        teamId: nextPrimary,
      });
      onTransferred();
      onClose();
      setDestinationId('');
      setMode('move');
    } catch (err: any) {
      console.error('[transfer] failed', err);
      setError(err?.message || 'Could not transfer the player. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 100,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-cyan-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Move {player.name}</h3>
            <p className="text-xs text-gray-500">Transfer to a new team, or share across multiple teams.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMode('move')}
              className={`p-3 rounded-xl text-left ring-1 transition ${
                mode === 'move'
                  ? 'ring-cyan-500 bg-cyan-50/60 shadow-sm'
                  : 'ring-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <p className="font-bold text-gray-900 text-sm">Transfer</p>
              <p className="text-xs text-gray-500 mt-0.5">Move to a new team (removes from old)</p>
            </button>
            <button
              onClick={() => setMode('share')}
              className={`p-3 rounded-xl text-left ring-1 transition ${
                mode === 'share'
                  ? 'ring-emerald-500 bg-emerald-50/60 shadow-sm'
                  : 'ring-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <p className="font-bold text-gray-900 text-sm">Share</p>
              <p className="text-xs text-gray-500 mt-0.5">Roster on a 2nd team (keep both)</p>
            </button>
          </div>

          {/* Current teams */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Currently on</p>
            <div className="flex flex-wrap gap-1.5">
              {currentTeamIds.length === 0 ? (
                <span className="text-sm text-gray-500">No team yet.</span>
              ) : currentTeamIds.map((id) => {
                const t = teams.find((x) => x.id === id);
                return (
                  <span key={id} className="text-xs font-semibold bg-gray-100 text-gray-800 px-2 py-1 rounded-md ring-1 ring-gray-200">
                    {t?.name || id}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Destination */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {mode === 'move' ? 'Move to' : 'Add to'}
            </label>
            <select
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
              style={{ fontSize: '16px' }}
            >
              <option value="">Choose a team…</option>
              {eligibleTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ''}</option>
              ))}
            </select>
            {eligibleTeams.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">No other teams available — this player is already on every team.</p>
            )}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!destinationId || saving}
            className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition-colors"
          >
            {saving ? 'Saving…' : mode === 'move' ? 'Transfer' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TransferPlayerModal;
