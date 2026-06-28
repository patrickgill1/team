// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { syncParentTeams } from '../../utils/syncParentTeams';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

interface TeamOption { id: string; name: string; ageGroup?: string }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  player: {
    id: string;
    name: string;
    teamId?: string;
    teamIds?: string[];
    parentIds?: string[];
  } | null;
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

  const currentTeamIds: string[] = player
    ? (Array.isArray(player.teamIds) && player.teamIds.length > 0
       ? player.teamIds
       : (player.teamId ? [player.teamId] : []))
    : [];

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
      await syncParentTeams({
        parentIds: player.parentIds,
        teamIds: nextTeamIds,
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
    <Sheet
      open={isOpen && !!player}
      onClose={onClose}
      kicker="Move player"
      title={player ? `Move ${player.name}` : ''}
      subtitle="Transfer to a new team, or share across multiple teams."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!destinationId}
            loading={saving}
          >
            {mode === 'move' ? 'Transfer' : 'Share'}
          </Button>
        </>
      }
    >
      {player && (
      <div className="space-y-4">
        {/* Mode toggle */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('move')}
            className={`p-3 rounded-xl text-left ring-1 transition ${
              mode === 'move'
                ? 'ring-brand-primary-soft/60 bg-brand-primary/15 shadow-sm'
                : 'ring-line-default/10 bg-surface-base hover:bg-line-default/5'
            }`}
          >
            <p className="font-bold text-ink-primary text-sm">Transfer</p>
            <p className="text-xs text-ink-primary/50 mt-0.5">Move to a new team (removes from old)</p>
          </button>
          <button
            type="button"
            onClick={() => setMode('share')}
            className={`p-3 rounded-xl text-left ring-1 transition ${
              mode === 'share'
                ? 'ring-emerald-400/60 bg-emerald-500/15 shadow-sm'
                : 'ring-line-default/10 bg-surface-base hover:bg-line-default/5'
            }`}
          >
            <p className="font-bold text-ink-primary text-sm">Share</p>
            <p className="text-xs text-ink-primary/50 mt-0.5">Roster on a 2nd team (keep both)</p>
          </button>
        </div>

        {/* Current teams */}
        <div>
          <p className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/55 mb-1.5">Currently on</p>
          <div className="flex flex-wrap gap-1.5">
            {currentTeamIds.length === 0 ? (
              <span className="text-sm text-ink-primary/50">No team yet.</span>
            ) : currentTeamIds.map((id) => {
              const t = teams.find((x) => x.id === id);
              return (
                <span key={id} className="text-xs font-semibold bg-line-default/5 text-ink-primary px-2 py-1 rounded-md ring-1 ring-line-default/10">
                  {t?.name || id}
                </span>
              );
            })}
          </div>
        </div>

        {/* Destination */}
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
          <FormField label={mode === 'move' ? 'Move to' : 'Add to'}>
            <select
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              className={fieldInputClass}
              style={{ fontSize: '16px' }}
            >
              <option value="">Choose a team…</option>
              {eligibleTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ''}</option>
              ))}
            </select>
          </FormField>
        )}

        {error && <p className="text-sm text-rose-300">{error}</p>}
      </div>
      )}
    </Sheet>
  );
};

export default TransferPlayerModal;
