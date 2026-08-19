import React, { useState, useEffect } from 'react';
import { Player, PlayerStats, GameStat } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { isXpSourceEnabled } from '../../utils/xpSource';

interface StatsTrackerProps {
  isOpen: boolean;
  onClose: () => void;
  players: Player[];
  onStatsRecorded: (stats: GameStat) => void;
  gameId?: string;
  opponent?: string;
  initialPlayerId?: string;
}

const StatsTracker: React.FC<StatsTrackerProps> = ({
  isOpen,
  onClose,
  players,
  onStatsRecorded,
  gameId,
  opponent = 'Opponent',
  initialPlayerId = ''
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { addGameStat, updatePlayerStats } = useFirestore();

  const [selectedPlayer, setSelectedPlayer] = useState(initialPlayerId);
  const [statData, setStatData] = useState({
    goals: 0,
    assists: 0,
    saves: 0,
    yellowCards: 0,
    redCards: 0,
    minutesPlayed: 0
  });
  const [keyPlays, setKeyPlays] = useState<string[]>(['']);
  const [successMessage, setSuccessMessage] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 2026-07-14: catch-up entry mode — Patrick's other coach was
  // entering historical stats manually and accidentally triggered
  // first-goal / first-assist badges + XP for the player. Preview
  // below tells coach what WILL fire; checkbox lets them opt out
  // when the entry is retroactive.
  const [skipGrants, setSkipGrants] = useState(false);
  // Attribution error toast — surfaced when resolveTripId… throws
  // during save. Coach can retry; second failure marks the pending
  // stat row via pendingTripAttribution:true so a bg re-attribution
  // job can pick it up. Mirrors the GameDay endGame pattern.
  const [attributionToast, setAttributionToast] = useState<{
    kind: 'retry' | 'fallback';
    onRetry?: () => void;
  } | null>(null);

  const selectedPlayerData = players.find(p => p.id === selectedPlayer);

  // Preview: which badges + how much XP would land if we submitted
  // right now. Uses the same 0→N crossing rules as
  // src/utils/badgeGrants.ts:maybeGrantFirstStatBadges so what the
  // coach sees here is what actually fires.
  const anyBadgeEnabled = isXpSourceEnabled(selectedTeam as any, 'firstGoal')
    || isXpSourceEnabled(selectedTeam as any, 'firstAssist')
    || isXpSourceEnabled(selectedTeam as any, 'firstSave');
  const previewBadges: Array<{ slug: string; label: string; xp: number }> = (() => {
    if (!selectedPlayerData || !anyBadgeEnabled) return [];
    const cur = selectedPlayerData.stats || ({} as any);
    const positions: string[] = Array.isArray((selectedPlayerData as any).positions)
      ? (selectedPlayerData as any).positions
      : ((selectedPlayerData as any).position ? [(selectedPlayerData as any).position] : []);
    const isKeeper = positions.includes('Goalkeeper');
    const isKeeperOrD = isKeeper || positions.includes('Defender');
    const out: Array<{ slug: string; label: string; xp: number }> = [];
    const existingBadges = ((selectedPlayerData as any).badges) || {};
    if (isXpSourceEnabled(selectedTeam as any, 'firstGoal')
      && !existingBadges.first_goal && (cur.goals || 0) === 0 && statData.goals > 0) {
      out.push({ slug: 'first_goal', label: 'First Goal', xp: 100 });
    }
    if (isXpSourceEnabled(selectedTeam as any, 'firstAssist')
      && !existingBadges.first_assist && (cur.assists || 0) === 0 && statData.assists > 0) {
      out.push({ slug: 'first_assist', label: 'First Assist', xp: 100 });
    }
    if (isKeeper && isXpSourceEnabled(selectedTeam as any, 'firstSave')
      && !existingBadges.first_save && (cur.saves || 0) === 0 && statData.saves > 0) {
      out.push({ slug: 'first_save', label: 'First Save', xp: 100 });
    }
    return out;
  })();
  const previewXpTotal = previewBadges.reduce((s, b) => s + b.xp, 0);

  useEffect(() => {
    if (initialPlayerId) {
      setSelectedPlayer(initialPlayerId);
    }
  }, [initialPlayerId]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    if (isOpen) {
      // Reset form when modal opens
      setStatData({
        goals: 0,
        assists: 0,
        saves: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0
      });
      setKeyPlays(['']);
      setError('');
      setSuccessMessage('');
      if (!initialPlayerId) {
        setSelectedPlayer('');
      }
    }
  }, [isOpen, initialPlayerId]);

  const generateId = () => {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedPlayer || !userData || !selectedPlayerData) {
      setError('Please select a player');
      return;
    }

    setIsSubmitting(true);
    setError('');
    setAttributionToast(null);

    // Resolve tripId. Prefer the event-doc path (real gameId → look up
    // event.date + event.tripAssignmentOverride); fall back to "now"
    // resolution for synthetic gameIds. When a tripId comes back, this
    // stat write is TRIP-scoped: don't bump the player.stats season
    // aggregate and don't fire first-stat badges (kept for the
    // regulation journey). See GameDay endGame for the sibling pattern.
    //
    // Group A change: resolveTripId… now THROWS on hard errors. We
    // catch here, surface a persistent retry toast, and continue with
    // the save marked pendingTripAttribution:true — a background job
    // (or coach retry) can back-patch the tripId later.
    let resolvedTripId: string | undefined;
    let attributionFailed = false;
    try {
      const { resolveTripIdByEventId, resolveTripIdForGame } = await import('../../utils/tripAttribution');
      const r = gameId
        ? await resolveTripIdByEventId(gameId, selectedTeamId)
        : await resolveTripIdForGame({ teamId: selectedTeamId, gameDate: new Date() });
      resolvedTripId = r.tripId;
    } catch (err) {
      console.warn('[statstracker] trip attribution failed', err);
      attributionFailed = true;
    }

    try {
      const filteredKeyPlays = keyPlays.filter(play => play.trim() !== '');

      // Create game stat record. When attribution failed we tag the row
      // with pendingTripAttribution:true so a bg job (or manual retry)
      // can retag once the trip lookup is reachable again. We also skip
      // the season-aggregate bump + badges in that case so we don't
      // burn a kid's "first goal" moment before we know if it's a trip.
      const gameStatData: Omit<GameStat, 'id' | 'createdAt'> = {
        playerId: selectedPlayer,
        playerName: selectedPlayerData.name,
        gameId: gameId || generateId(),
        gameDate: new Date(),
        opponent: opponent,
        minutesPlayed: statData.minutesPlayed,
        teamId: selectedTeamId,
        goals: statData.goals,
        assists: statData.assists,
        yellowCards: statData.yellowCards,
        redCards: statData.redCards,
        saves: statData.saves,
        keyPlays: filteredKeyPlays,
        recordedBy: userData.uid,
        recordedByName: userData.name,
        updatedAt: new Date(),
        ...(resolvedTripId ? { tripId: resolvedTripId } : {}),
        ...(attributionFailed ? { pendingTripAttribution: true } : {}),
      } as any;

      const statId = await addGameStat(gameStatData);

      // Update player's aggregate stats — guard each field individually
      // (older players may have stats missing some keys, which would produce NaN)
      const currentStats = selectedPlayerData.stats || {} as Partial<PlayerStats>;

      const updatedStats: PlayerStats = {
        goals: (currentStats.goals || 0) + statData.goals,
        assists: (currentStats.assists || 0) + statData.assists,
        saves: (currentStats.saves || 0) + statData.saves,
        yellowCards: (currentStats.yellowCards || 0) + statData.yellowCards,
        redCards: (currentStats.redCards || 0) + statData.redCards,
        minutesPlayed: (currentStats.minutesPlayed || 0) + statData.minutesPlayed,
        gamesPlayed: (currentStats.gamesPlayed || 0) + 1,
        cleanSheets: currentStats.cleanSheets || 0
      };

      // Trip stats DON'T bump player.stats — keeps that aggregate
      // regulation-only by default (matches GameDay endGame behavior).
      // When attribution failed we ALSO skip the bump so a still-
      // unresolved trip game doesn't pollute season aggregates.
      if (!resolvedTripId && !attributionFailed) {
        await updatePlayerStats(selectedPlayer, updatedStats);
      }
      // Fire first-stat badges on 0→N crossings. Non-fatal.
      // 2026-07-14: skipGrants suppresses this for catch-up / historical
      // entries so a coach filling in past games doesn't burn the
      // player's real "first goal" moment. Stats still land; XP+badges
      // just don't fire.
      // Trip stats also suppress badges so a kid's "first goal" moment
      // isn't burned on a tournament goal.
      // Attribution failure ALSO suppresses badges (see comment above).
      if (!skipGrants && !resolvedTripId && !attributionFailed) {
        try {
          const { maybeGrantFirstStatBadges } = await import('../../utils/badgeGrants');
          void maybeGrantFirstStatBadges(
            selectedPlayer,
            currentStats,
            updatedStats,
            {
              existingBadges: (selectedPlayerData as any).badges,
              context: opponent || 'Match',
              team: selectedTeam as any,
            },
          );
        } catch { /* non-fatal */ }
      }

      const newGameStat: GameStat = {
        id: statId,
        ...gameStatData,
        createdAt: new Date()
      };

      onStatsRecorded(newGameStat);

      if (attributionFailed) {
        // Save landed. Surface retry toast so coach can re-run
        // attribution. Don't auto-close — coach needs to see the toast.
        setAttributionToast({
          kind: 'retry',
          onRetry: () => { void retryAttributionForStat(statId, selectedPlayer, currentStats, updatedStats); },
        });
        setSuccessMessage(`Stats saved for ${selectedPlayerData.name} — trip tag pending.`);
      } else {
        setSuccessMessage(`Stats recorded for ${selectedPlayerData.name}!`);
        // Close modal after successful submission
        setTimeout(() => {
          onClose();
        }, 1500);
      }

    } catch (error) {
      console.error('Error recording stats:', error);
      setError('Failed to record stats. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Retry the attribution + trip-bucket write for a stat row that was
  // saved with pendingTripAttribution:true. On success, patch the
  // stat/{id} doc with tripId and clear the flag. On second failure,
  // swap the toast to the fallback copy — the flag stays set so a bg
  // job can re-run when the coach is back online.
  const retryAttributionForStat = async (
    statId: string,
    playerId: string,
    prevStats: Partial<PlayerStats>,
    nextStats: PlayerStats,
  ) => {
    setAttributionToast(null);
    let resolvedTripId: string | undefined;
    try {
      const { resolveTripIdByEventId, resolveTripIdForGame } = await import('../../utils/tripAttribution');
      const r = gameId
        ? await resolveTripIdByEventId(gameId, selectedTeamId)
        : await resolveTripIdForGame({ teamId: selectedTeamId, gameDate: new Date() });
      resolvedTripId = r.tripId;
    } catch (err) {
      console.warn('[statstracker] retry: trip attribution still failing', err);
      setAttributionToast({ kind: 'fallback' });
      return;
    }
    try {
      const { doc, updateDoc, deleteField } = await import('firebase/firestore');
      const { db } = await import('../../utils/firebase');
      await updateDoc(doc(db, 'stats', statId), {
        ...(resolvedTripId ? { tripId: resolvedTripId } : {}),
        pendingTripAttribution: deleteField(),
      } as any);
      // If attribution came back with NO tripId (season game after
      // all), catch up the player.stats bump + badges we skipped on the
      // failed first attempt.
      if (!resolvedTripId) {
        try { await updatePlayerStats(playerId, nextStats); } catch { /* non-fatal */ }
        if (!skipGrants) {
          try {
            const { maybeGrantFirstStatBadges } = await import('../../utils/badgeGrants');
            void maybeGrantFirstStatBadges(
              playerId,
              prevStats,
              nextStats,
              {
                existingBadges: (selectedPlayerData as any)?.badges,
                context: opponent || 'Match',
                team: selectedTeam as any,
              },
            );
          } catch { /* non-fatal */ }
        }
      }
      setSuccessMessage(resolvedTripId ? 'Trip tag applied.' : 'Season stats caught up.');
      setTimeout(() => onClose(), 1200);
    } catch (err) {
      console.error('[statstracker] retry back-patch failed', err);
      setAttributionToast({ kind: 'fallback' });
    }
  };

  const updateStatValue = (field: keyof typeof statData, value: number) => {
    setStatData(prev => ({
      ...prev,
      [field]: Math.max(0, value)
    }));
  };

  const addKeyPlay = () => {
    setKeyPlays([...keyPlays, '']);
  };

  const updateKeyPlay = (index: number, value: string) => {
    const updated = [...keyPlays];
    updated[index] = value;
    setKeyPlays(updated);
  };

  const removeKeyPlay = (index: number) => {
    setKeyPlays(keyPlays.filter((_, i) => i !== index));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-elevated rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-surface-elevated border-b border-line-default/15 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-ink-primary">Record Player Stats</h2>
            <button
              onClick={onClose}
              className="text-ink-muted hover:text-ink-secondary transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6">
          {successMessage && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
              <p className="text-green-600 text-sm">{successMessage}</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}

          {/* Attribution error toast — mirrors the GameDay endGame
              pattern. Persistent (no auto-dismiss). Coach taps Retry
              to re-run the attribution + trip-bucket write. Second
              failure switches to the fallback copy; the stat row was
              already saved with pendingTripAttribution:true so a bg
              job can re-run when the coach is back online. */}
          {attributionToast && (
            <div
              role="alert"
              className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-center justify-between gap-3"
            >
              <p className="text-amber-800 text-sm font-medium">
                {attributionToast.kind === 'retry'
                  ? "Couldn't tag stats to your trip. Tap to retry."
                  : "Still couldn't reach the trip. Save these stats and I'll retag when you're back online."}
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                {attributionToast.kind === 'retry' && attributionToast.onRetry && (
                  <button
                    type="button"
                    onClick={attributionToast.onRetry}
                    className="text-[11px] tracking-widest uppercase font-black bg-amber-600 text-white rounded-full px-3 py-1 hover:bg-amber-700 transition-colors"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setAttributionToast(null)}
                  className="text-amber-700 hover:text-amber-900 text-sm font-bold"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Player Selection */}
            <div>
              <label className="block text-sm font-medium text-ink-primary/80 mb-2">
                Select Player *
              </label>
              <select
                value={selectedPlayer}
                onChange={(e) => setSelectedPlayer(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                required
              >
                <option value="">Choose a player...</option>
                {players.map(player => (
                  <option key={player.id} value={player.id}>
                    #{player.jerseyNumber} {player.name} ({player.position})
                  </option>
                ))}
              </select>
            </div>

            {/* Game Info */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Opponent
                </label>
                <input
                  type="text"
                  value={opponent}
                  disabled
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg bg-surface-base"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Minutes Played
                </label>
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={statData.minutesPlayed}
                  onChange={(e) => updateStatValue('minutesPlayed', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Goals
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.goals}
                  onChange={(e) => updateStatValue('goals', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Assists
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.assists}
                  onChange={(e) => updateStatValue('assists', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              {/* Saves: keeper-only. We check selectedPlayerData rather
                  than the player list since this card is tied to one
                  player at a time. */}
              {(() => {
                const positions: string[] = Array.isArray((selectedPlayerData as any)?.positions) && (selectedPlayerData as any).positions.length > 0
                  ? (selectedPlayerData as any).positions
                  : (selectedPlayerData?.position ? [selectedPlayerData.position] : []);
                const isKeeper = positions.some(p => p?.toLowerCase() === 'goalkeeper');
                if (!isKeeper) return null;
                return (
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                      Saves
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={statData.saves}
                      onChange={(e) => updateStatValue('saves', parseInt(e.target.value) || 0)}
                      disabled={isSubmitting}
                      className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  </div>
                );
              })()}

              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Yellow Cards
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.yellowCards}
                  onChange={(e) => updateStatValue('yellowCards', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                  Red Cards
                </label>
                <input
                  type="number"
                  min="0"
                  value={statData.redCards}
                  onChange={(e) => updateStatValue('redCards', parseInt(e.target.value) || 0)}
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>
            </div>

            {/* Key Plays */}
            <div>
              <label className="block text-sm font-medium text-ink-primary/80 mb-2">
                Key Plays (Optional)
              </label>
              <div className="space-y-2">
                {keyPlays.map((play, index) => (
                  <div key={index} className="flex space-x-2">
                    <input
                      type="text"
                      value={play}
                      onChange={(e) => updateKeyPlay(index, e.target.value)}
                      placeholder="Describe a key play..."
                      disabled={isSubmitting}
                      className="flex-1 px-3 py-2 border border-line-default/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                    {keyPlays.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeKeyPlay(index)}
                        disabled={isSubmitting}
                        className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              
              {keyPlays.length < 5 && (
                <button
                  type="button"
                  onClick={addKeyPlay}
                  disabled={isSubmitting}
                  className="mt-2 text-brand-primary-soft hover:text-brand-primary text-sm font-medium"
                >
                  + Add Key Play
                </button>
              )}
            </div>

            {/* XP + badge preview — Patrick 2026-07-14. When manual
                entry would trigger first-stat crossings, tell the
                coach BEFORE they submit and give them an opt-out for
                catch-up entries. */}
            {anyBadgeEnabled && previewBadges.length > 0 && (
              <div className="pt-4 border-t border-line-default/15">
                <div className="p-3 rounded-xl bg-amber-500/10 ring-1 ring-amber-400/40">
                  <p className="text-[11px] font-black uppercase tracking-widest text-amber-700 mb-1.5">
                    This will award XP + {previewBadges.length === 1 ? 'a badge' : 'badges'}
                  </p>
                  <ul className="space-y-1">
                    {previewBadges.map(b => (
                      <li key={b.slug} className="text-sm text-ink-primary/90 flex items-center gap-2">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                        <span className="font-bold">{b.label}</span>
                        <span className="text-amber-700 font-black text-[11px]">+{b.xp} XP</span>
                      </li>
                    ))}
                    <li className="text-[12px] text-ink-primary/60 mt-1.5 tabular-nums">
                      Total: +{previewXpTotal} XP
                    </li>
                  </ul>
                  <label className="flex items-start gap-2 mt-3 pt-3 border-t border-amber-500/20 cursor-pointer text-[13px] text-ink-primary/85">
                    <input
                      type="checkbox"
                      checked={skipGrants}
                      onChange={e => setSkipGrants(e.target.checked)}
                      className="mt-0.5 flex-shrink-0"
                    />
                    <span>
                      <span className="font-bold">This is a catch-up entry — don&rsquo;t award XP or badges.</span>
                      <span className="block text-[11.5px] text-ink-primary/55 mt-0.5">
                        Use when you&rsquo;re logging past games so the player&rsquo;s real &ldquo;first goal&rdquo; moment still counts when it happens live.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex space-x-4 pt-4 border-t border-line-default/15">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="flex-1 bg-surface-raised hover:bg-line-default/20 text-ink-primary font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !selectedPlayer}
                className="flex-1 bg-surface-tint hover:bg-surface-raised text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
              >
                {isSubmitting ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                ) : (
                  'Record Stats'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default StatsTracker;