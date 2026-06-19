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
        nextTeamIds = [destinationId];
        nextPrimary = destinationId;
      } else {
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
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm"
      style={{
        zIndex: 100,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={onClose}
    >
      <div
        className="bg-charcoal-900 rounded-t-2xl sm:rounded-2xl shadow-2xl ring-1 ring-white/10 w-full sm:max-w-lg max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-gradient-to-r from-crimson-500/10 to-transparent">
          <div>
            <h3 className="text-lg font-black text-bone">Move {player.name}</h3>
            <p className="text-xs text-bone/50">Transfer to a new team, or share across multiple teams.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-bone/60" aria-label="Close">
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
                  ? 'ring-crimson-400/60 bg-crimson-500/15 shadow-sm'
                  : 'ring-white/10 bg-charcoal-950 hover:bg-white/5'
              }`}
            >
              <p className="font-bold text-bone text-sm">Transfer</p>
              <p className="text-xs text-bone/50 mt-0.5">Move to a new team (removes from old)</p>
            </button>
            <button
              onClick={() => setMode('share')}
              className={`p-3 rounded-xl text-left ring-1 transition ${
                mode === 'share'
                  ? 'ring-emerald-400/60 bg-emerald-500/15 shadow-sm'
                  : 'ring-white/10 bg-charcoal-950 hover:bg-white/5'
              }`}
            >
              <p className="font-bold text-bone text-sm">Share</p>
              <p className="text-xs text-bone/50 mt-0.5">Roster on a 2nd team (keep both)</p>
            </button>
          </div>

          {/* Current teams */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-bone/50 mb-1">Currently on</p>
            <div className="flex flex-wrap gap-1.5">
              {currentTeamIds.length === 0 ? (
                <span className="text-sm text-bone/50">No team yet.</span>
              ) : currentTeamIds.map((id) => {
                const t = teams.find((x) => x.id === id);
                return (
                  <span key={id} className="text-xs font-semibold bg-white/5 text-bone px-2 py-1 rounded-md ring-1 ring-white/10">
                    {t?.name || id}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Destination */}
          <div>
            <label className="block text-sm font-medium text-bone/80 mb-1">
              {mode === 'move' ? 'Move to' : 'Add to'}
            </label>
            {eligibleTeams.length === 0 ? (
              <div className="rounded-xl bg-amber-500/10 ring-1 ring-amber-400/30 px-3 py-2.5">
                <p className="text-sm font-semibold text-amber-200">No other teams to {mode === 'move' ? 'move' : 'share'} to.</p>
                <p className="text-xs text-amber-100/70 mt-1">
                  {mode === 'share'
                    ? `${player.name} is already on every team in this club. Create a new team first, then come back.`
                    : `${player.name} is already on every team in this club.`}
                </p>
              </div>
            ) : (
              <select
                value={destinationId}
                onChange={(e) => setDestinationId(e.target.value)}
                className="w-full bg-charcoal-950 text-bone border border-white/10 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-crimson-400/40 text-base"
                style={{ fontSize: '16px' }}
              >
                <option value="">Choose a team…</option>
                {eligibleTeams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ''}</option>
                ))}
              </select>
            )}
          </div>

          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>

        <div className="border-t border-white/5 p-4 flex items-center justify-end gap-2 bg-charcoal-950/60">
          <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-bone/70 hover:text-bone">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!destinationId || saving}
            className="bg-crimson-600 hover:bg-crimson-700 disabled:bg-white/10 disabled:text-bone/40 text-white font-semibold rounded-xl px-5 py-2 text-sm transition-colors"
          >
            {saving ? 'Saving…' : mode === 'move' ? 'Transfer' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TransferPlayerModal;
