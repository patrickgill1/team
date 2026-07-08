import React, { useMemo, useState } from 'react';
import { Player, CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';

// Post-match player rating (adult teams). Coach or captain grades
// each player 1-10 with an optional short note. Stored on the event
// under playerRatings keyed by playerId — one entry per player, most
// recent rater wins. Feeds a season-form aggregate in Stats later.
//
// Deliberately simple: a per-player row with a numeric 1-10 stepper
// and an optional single-line note. No sub-scores, no per-metric
// breakdown — semi-pro clubs varies too much on what they track to
// design that up front.

interface PlayerRatingSheetProps {
  event: CalendarEvent;
  players: Player[];
  onClose: () => void;
}

const RATING_MIN = 1;
const RATING_MAX = 10;

const PlayerRatingSheet: React.FC<PlayerRatingSheetProps> = ({ event, players, onClose }) => {
  const { userData } = useAuth();
  const { updateEvent } = useFirestore();

  const existing = (event.playerRatings || {}) as Record<string, {
    playerId: string;
    playerName: string;
    rating: number;
    note?: string;
    ratedBy: string;
    ratedByName?: string;
    ratedAt: any;
  }>;

  // Local edit state — pre-seed with existing ratings so a re-open
  // doesn't wipe the last pass. Missing player → default 7 (average
  // performance) so a coach can rate deltas instead of typing every
  // player from zero.
  const initial = useMemo(() => {
    const out: Record<string, { rating: number; note: string }> = {};
    players.forEach(p => {
      const prev = existing[p.id];
      out[p.id] = {
        rating: prev?.rating ?? 7,
        note: prev?.note ?? '',
      };
    });
    return out;
  }, [players, existing]);

  const [drafts, setDrafts] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bump = (playerId: string, delta: number) => {
    setDrafts(prev => {
      const cur = prev[playerId]?.rating ?? 7;
      const next = Math.max(RATING_MIN, Math.min(RATING_MAX, cur + delta));
      return { ...prev, [playerId]: { ...prev[playerId], rating: next } };
    });
  };

  const set = (playerId: string, patch: Partial<{ rating: number; note: string }>) => {
    setDrafts(prev => ({ ...prev, [playerId]: { ...prev[playerId], ...patch } }));
  };

  const save = async () => {
    if (!userData) return;
    setSaving(true);
    setError(null);
    try {
      // Merge, don't overwrite — the coach might have rated only a
      // subset, or a captain and coach are both filling out entries
      // from different devices.
      const merged: typeof existing = { ...existing };
      const now = new Date();
      players.forEach(p => {
        const draft = drafts[p.id];
        if (!draft) return;
        merged[p.id] = {
          playerId: p.id,
          playerName: p.name,
          rating: draft.rating,
          note: draft.note.trim() || undefined,
          ratedBy: userData.uid,
          ratedByName: userData.name || 'Coach',
          ratedAt: now,
        };
      });
      await updateEvent(event.id, { playerRatings: merged });
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not save ratings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Rate players"
    >
      <div
        className="w-full sm:max-w-2xl max-h-[90vh] flex flex-col bg-surface-elevated rounded-t-3xl sm:rounded-3xl ring-1 ring-line-default/15 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-surface-elevated/95 backdrop-blur border-b border-line-default/10 px-5 py-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">Post-match ratings</p>
            <p className="text-sm font-bold text-ink-primary mt-0.5">{event.title || 'Match'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-primary/60 hover:text-ink-primary text-xs font-bold uppercase tracking-widest"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
          {players.length === 0 ? (
            <p className="text-sm text-ink-primary/60 text-center py-8">No players to rate.</p>
          ) : (
            players.map(p => {
              const draft = drafts[p.id] || { rating: 7, note: '' };
              return (
                <div key={p.id} className="rounded-2xl bg-surface-input ring-1 ring-line-default/10 p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-line-default/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {p.profilePhotoUrl ? (
                        <img src={p.profilePhotoUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-xs font-black text-ink-primary/70">
                          {p.jerseyNumber ? `#${p.jerseyNumber}` : p.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-ink-primary truncate">{p.name}</p>
                      {p.position && (
                        <p className="text-[10px] uppercase tracking-widest font-black text-ink-primary/45">{p.position}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => bump(p.id, -1)}
                        disabled={draft.rating <= RATING_MIN}
                        className="w-8 h-8 rounded-full bg-line-default/10 hover:bg-line-default/20 text-ink-primary font-black text-lg disabled:opacity-30"
                        aria-label="Decrease rating"
                      >
                        −
                      </button>
                      <span
                        className={`min-w-[3rem] text-center text-xl font-black tabular-nums ${
                          draft.rating >= 8 ? 'text-emerald-300' :
                          draft.rating >= 6 ? 'text-brand-primary-soft' :
                          draft.rating >= 4 ? 'text-amber-300' :
                          'text-rose-300'
                        }`}
                      >
                        {draft.rating}
                      </span>
                      <button
                        type="button"
                        onClick={() => bump(p.id, 1)}
                        disabled={draft.rating >= RATING_MAX}
                        className="w-8 h-8 rounded-full bg-line-default/10 hover:bg-line-default/20 text-ink-primary font-black text-lg disabled:opacity-30"
                        aria-label="Increase rating"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={draft.note}
                    onChange={(e) => set(p.id, { note: e.target.value.slice(0, 120) })}
                    className="mt-2 w-full px-3 py-1.5 text-xs bg-surface-base text-ink-primary border border-line-default/10 rounded-lg placeholder-ink-primary/35"
                    placeholder="Note (optional) — e.g. MOTM, quiet game, aerial dominance"
                  />
                </div>
              );
            })
          )}
        </div>

        {error && <p className="px-5 pb-2 text-xs text-rose-300">{error}</p>}

        <div className="sticky bottom-0 bg-surface-elevated/95 backdrop-blur border-t border-line-default/10 px-5 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg bg-line-default/5 hover:bg-line-default/10 ring-1 ring-line-default/10 text-xs font-extrabold tracking-widest uppercase text-ink-primary/70"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || players.length === 0}
            className="flex-1 px-4 py-2.5 rounded-lg bg-brand-primary text-white text-xs font-extrabold uppercase tracking-widest hover:bg-brand-primary-soft hover:text-charcoal-950 disabled:opacity-60 transition"
          >
            {saving ? 'Saving…' : 'Save ratings'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PlayerRatingSheet;
