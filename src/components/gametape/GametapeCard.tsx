// GametapeCard — one row inside GametapeSection. Contract:
//
//   Coach view:
//     - Kebab menu (Edit / Delete)
//     - "Watched by N of M" pill in the footer
//     - No Got it button
//
//   Parent / Kid view:
//     - Prominent Got it button in the footer
//     - Optional "Move to Library" affordance for archived rows
//     - No kebab menu (they don't own the clip)
//
// Pausing: when a viewer taps Got it, we flip a local `pausedByAction`
// flag so the video stops immediately, then the parent Section
// dismisses the card once the write completes.

import React, { useMemo, useState } from 'react';
import GametapeVideoPlayer from './GametapeVideoPlayer';
import type { PlayerClip, GametapeViewer, GametapePlayer } from '../../types';

interface Props {
  clip: PlayerClip;
  viewer: GametapeViewer;
  /** The players from this viewer's scope that this clip targets.
   *  Parent/kid views may see multiple children of the same family
   *  in the array; the "Got it" tap acts on the first one that still
   *  has the clip active. Coaches pass the union of targeted players. */
  targetedPlayers: GametapePlayer[];
  /** For the coach footer: how many of `totalTargets` have watched. */
  watchedCount?: number;
  totalTargets?: number;
  /** Fires when a parent/kid taps Got it. The Section owns the
   *  worker POST + subsequent snapshot refresh. */
  onWatch?: (playerId: string) => Promise<void> | void;
  /** Coach edit (opens the compose modal in edit mode). */
  onEdit?: () => void;
  /** Coach hard-delete (soft-delete on the doc; pulls Stream video). */
  onDelete?: () => void;
  /** Parent/kid archive from Library. Present only when this row is
   *  currently rendered in the "From Coach" subsection and the viewer
   *  wants to skip without watching. Coaches use `onDelete` instead. */
  onArchiveForPlayer?: (playerId: string) => void;
  /** When true, this card sits in the Library subsection. Suppresses
   *  the Got it button. */
  inLibrary?: boolean;
  /** Highlight the card (deep-linked from a push notification). */
  highlighted?: boolean;
}

function formatRelativeShort(d: Date | null | undefined): string {
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const KebabIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </svg>
);

const GametapeCard: React.FC<Props> = ({
  clip,
  viewer,
  targetedPlayers,
  watchedCount = 0,
  totalTargets = 0,
  onWatch,
  onEdit,
  onDelete,
  onArchiveForPlayer,
  inLibrary = false,
  highlighted = false,
}) => {
  // Hooks BEFORE any conditional returns.
  const [menuOpen, setMenuOpen] = useState(false);
  const [watching, setWatching] = useState(false);
  const [pausedByAction, setPausedByAction] = useState(false);
  const [watchSuccess, setWatchSuccess] = useState(false);

  const authorInitials = useMemo(() => initials(clip.createdByName), [clip.createdByName]);
  const relTime = useMemo(() => formatRelativeShort(clip.createdAt || null), [clip.createdAt]);
  const notePreview = clip.note || '';

  // Coach targeting summary (footer left):
  const targetSummary = useMemo(() => {
    if (clip.targetsWholeTeam) return 'Whole team';
    if (targetedPlayers.length === 0) {
      const n = clip.playerIds?.length ?? 0;
      if (n <= 1) return '1 player';
      return `${n} players`;
    }
    if (targetedPlayers.length === 1) return targetedPlayers[0].name;
    if (targetedPlayers.length === 2) return `${targetedPlayers[0].name} + ${targetedPlayers[1].name}`;
    return `${targetedPlayers[0].name} + ${targetedPlayers.length - 1} others`;
  }, [clip.targetsWholeTeam, clip.playerIds, targetedPlayers]);

  const coachWatchedLabel = useMemo(() => {
    if (!totalTargets) return 'Not watched yet';
    if (watchedCount >= totalTargets) return "Everyone's watched it";
    if (watchedCount <= 0) return 'Not watched yet';
    return `Watched by ${watchedCount} of ${totalTargets}`;
  }, [watchedCount, totalTargets]);

  // Which of the viewer's players still has this clip active?
  // If none, the Got it button hides (already watched or archived).
  const activePlayerId = useMemo(() => {
    for (const p of targetedPlayers) {
      if (clip.activeForPlayerIds?.includes(p.id)) return p.id;
    }
    return null;
  }, [targetedPlayers, clip.activeForPlayerIds]);

  // Show Got it whenever the current player is still an active target
  // AND we have a write handler. Coach-who-is-also-parent-of-target
  // sees it too, so a coach testing on their own kid's page can mark
  // it watched (activePlayerId only resolves to a player the viewer's
  // targetedPlayers actually include, so cross-kid marking isn't
  // possible from here).
  const showGotIt = !inLibrary && !!activePlayerId && !!onWatch;

  const handleGotIt = async () => {
    if (!activePlayerId || !onWatch || watching) return;
    setWatching(true);
    setPausedByAction(true);
    try {
      await onWatch(activePlayerId);
      setWatchSuccess(true);
    } catch {
      // Roll pause back so the viewer can retry.
      setPausedByAction(false);
    } finally {
      setWatching(false);
    }
  };

  const outerClass = `bg-surface-elevated ring-1 ${highlighted ? 'ring-brand-primary/60' : 'ring-line-default/10'} rounded-2xl overflow-hidden`;

  return (
    <article
      className={outerClass}
      id={`gametape-${clip.id}`}
      aria-labelledby={`gametape-header-${clip.id}`}
    >
      {/* Header */}
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        {clip.createdByPhotoUrl ? (
          <img
            src={clip.createdByPhotoUrl}
            alt=""
            className="h-9 w-9 rounded-full object-cover ring-1 ring-line-default/20"
          />
        ) : (
          <div className="h-9 w-9 rounded-full bg-brand-primary-soft text-brand-primary flex items-center justify-center text-xs font-extrabold">
            {authorInitials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div id={`gametape-header-${clip.id}`} className="text-sm font-bold text-ink-primary truncate">
            {clip.createdByName || 'Coach'}
          </div>
          <div className="text-[11px] text-ink-secondary flex items-center gap-1.5">
            {relTime ? <span>{relTime}</span> : null}
            {relTime ? <span aria-hidden>·</span> : null}
            <span className="truncate">{targetSummary}</span>
          </div>
        </div>

        {viewer === 'coach' ? (
          <div className="relative">
            <button
              type="button"
              aria-label="Clip options"
              onClick={() => setMenuOpen(v => !v)}
              className="p-1.5 rounded-lg text-ink-secondary hover:bg-line-default/10"
            >
              <KebabIcon />
            </button>
            {menuOpen ? (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-10 bg-transparent"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-20 min-w-[10rem] bg-surface-elevated ring-1 ring-line-default/20 rounded-xl shadow-lg py-1"
                >
                  {onEdit ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); onEdit(); }}
                      className="w-full text-left px-3 py-2 text-sm text-ink-primary hover:bg-line-default/10"
                    >
                      Edit clip
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); onDelete(); }}
                      className="w-full text-left px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                    >
                      Delete clip
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Video */}
      <div className="px-4">
        <GametapeVideoPlayer clip={clip} paused={pausedByAction} />
      </div>

      {/* Note */}
      {notePreview ? (
        <div className="px-4 pt-3">
          <p className="text-sm text-ink-primary/90 leading-snug whitespace-pre-wrap">{notePreview}</p>
        </div>
      ) : null}

      {/* Footer */}
      <footer className="px-4 py-3 mt-2 border-t border-line-default/10 flex items-center justify-between gap-3">
        {viewer === 'coach' ? (
          <>
            <div
              className={`text-xs font-bold uppercase tracking-wide ${
                totalTargets && watchedCount >= totalTargets
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-ink-secondary'
              }`}
            >
              {coachWatchedLabel}
            </div>
            <div className="text-[11px] text-ink-secondary">
              {clip.source === 'upload' ? 'Native clip' : clip.source === 'youtube' ? 'YouTube' : 'Vimeo'}
            </div>
          </>
        ) : showGotIt ? (
          <>
            <div className="text-[11px] text-ink-secondary">
              {viewer === 'kid' ? 'Watch it, then tap:' : 'Tap when the player has watched:'}
            </div>
            <button
              type="button"
              onClick={handleGotIt}
              disabled={watching || watchSuccess}
              className="px-4 py-2 rounded-lg text-sm font-extrabold bg-brand-primary text-brand-primary-fg hover:bg-brand-primary-hov disabled:opacity-60"
            >
              {watchSuccess
                ? (viewer === 'kid' ? 'Nice. Coach will see.' : 'Marked as watched.')
                : watching
                  ? 'Marking…'
                  : 'Got it'}
            </button>
          </>
        ) : inLibrary ? (
          <div className="text-[11px] text-ink-secondary italic">
            In Library. Rewatch anytime.
          </div>
        ) : (
          <div className="text-[11px] text-ink-secondary italic">
            Already watched.
          </div>
        )}

        {viewer !== 'coach' && !inLibrary && activePlayerId && onArchiveForPlayer ? (
          <button
            type="button"
            onClick={() => onArchiveForPlayer(activePlayerId)}
            className="text-[11px] text-ink-secondary hover:text-ink-primary underline"
          >
            Skip
          </button>
        ) : null}
      </footer>
    </article>
  );
};

export default GametapeCard;
