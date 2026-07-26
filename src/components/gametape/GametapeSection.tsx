// GametapeSection — inline section on Player Development. Subscribes
// to the player_clips collection scoped to this team + isActive, and
// splits the result into two subsections per the design:
//
//   From Coach  — active clips visible to at least one player in scope
//   Library     — clips this viewer has already watched or archived
//
// The Section owns:
//   • Firestore onSnapshot subscription
//   • Grouping into From Coach / Library
//   • Coach compose flow (opens GametapeComposeModal)
//   • Player "Got it" / archive worker calls (via gametapeApi)
//   • Hash-based deep link scroll (from push notification)
//
// The Card doesn't touch the network — it just fires callbacks.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import GametapeCard from './GametapeCard';
import GametapeComposeModal from './GametapeComposeModal';
import { markClipWatched, archiveClipForPlayer, deleteClip } from '../../utils/gametapeApi';
import type { GametapePlayer, GametapeViewer, PlayerClip } from '../../types';

interface Props {
  teamId: string;
  /** In coach view, the full roster; in parent/kid view, only the
   *  linked children. Drives Library filtering and the Got it target. */
  visiblePlayers: GametapePlayer[];
  /** 'coach' = show compose button + coach controls; anything else
   *  hides compose and renders parent/kid card variants. */
  effectiveView: GametapeViewer;
  /** Extra guard on top of `effectiveView` — if the surrounding page
   *  hides coach controls (e.g. a coach in parent-preview mode), also
   *  hide the compose button and coach kebab. */
  showCoachControls?: boolean;
  /** Total team roster count. Powers the "Watched by N of M" pill
   *  when a clip targets the whole team. */
  totalTeamPlayers?: number;
  /** When true, render nothing (no header, no empty-state card) if
   *  the viewer has no active clips and nothing in Library. Used on
   *  Dashboard so the section only shows up when there's something
   *  worth surfacing. Defaults to false so PlayerDevelopment and
   *  KidDashboard keep their always-render behavior. */
  silentWhenEmpty?: boolean;
  /** When true, skip the Library shelf entirely and only render the
   *  From Coach block. Used on Dashboard to keep the surface focused
   *  on what needs the viewer's attention; the full Library still
   *  lives on Player Development. Defaults to false. */
  hideLibrary?: boolean;
  /** Cap the From Coach queue displayed on this surface. When the
   *  actual queue is longer, render only the newest N cards + a
   *  "See all" chip that routes to Player Development so viewers can
   *  reach the full queue. Undefined = render every card (default).
   *  Dashboard passes 1 to stay focused on the newest clip. */
  maxVisibleActive?: number;
}

const COPY = {
  header: 'Gametape',
  headerSubtitle: 'Coach clips, one at a time. Watch, then tap Got it.',
  fromCoach: 'From Coach',
  library: 'Library',
  emptyCoachFromCoach: 'Drop your first clip. A 90-second moment beats a whole game reel every time.',
  emptyParentFromCoach: 'No clips yet. Your coach will drop tactical clips here when there is something worth focusing on this week.',
  emptyKidFromCoach: 'No clips yet. When coach sends you film, it lands here.',
  emptyLibrary: 'Watched clips land here. Come back anytime to rewatch.',
  postButton: 'Post a clip',
  deleteConfirm:
    "Delete this clip? Players will not see it anymore, and the video will be pulled from storage. This cannot be undone.",
  autoArchivedToast: (n: number) =>
    n === 1
      ? 'Oldest clip moved to Library. Keeps the queue short and honest.'
      : `Older clips moved to Library for ${n} players. Keeps the queue short and honest.`,
} as const;

function timestampToDate(t: any): Date | null {
  if (!t) return null;
  if (t instanceof Date) return t;
  if (typeof t?.toDate === 'function') { try { return t.toDate(); } catch { return null; } }
  if (typeof t?.seconds === 'number') return new Date(t.seconds * 1000);
  return null;
}

function timestampMap(raw: any): Record<string, Date | null> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Date | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = timestampToDate(v);
  }
  return out;
}

/** Firestore doc → PlayerClip. Defensive on every optional field so a
 *  half-written doc doesn't crash the render pass. */
function docToClip(id: string, raw: any): PlayerClip {
  const playerIds: string[] = Array.isArray(raw?.playerIds) ? raw.playerIds : [];
  const activeForPlayerIds: string[] = Array.isArray(raw?.activeForPlayerIds) ? raw.activeForPlayerIds : [];
  const watchedByPlayerIds: string[] = Array.isArray(raw?.watchedByPlayerIds) ? raw.watchedByPlayerIds : [];
  // Per-viewer independent-watched partition — see PlayerClip type
  // doc. Fall back to [] on legacy docs; they'll drift into the new
  // shape on next tap once the worker starts writing this field.
  const watchedByUserIds: string[] = Array.isArray(raw?.watchedByUserIds) ? raw.watchedByUserIds : [];
  const archivedForPlayerIds: string[] = Array.isArray(raw?.archivedForPlayerIds) ? raw.archivedForPlayerIds : [];
  return {
    id,
    teamId: String(raw?.teamId || ''),
    clubId: raw?.clubId ?? null,
    seasonId: raw?.seasonId ?? null,
    createdBy: String(raw?.createdBy || ''),
    createdByName: String(raw?.createdByName || 'Coach'),
    createdByPhotoUrl: raw?.createdByPhotoUrl ?? null,
    createdAt: timestampToDate(raw?.createdAt),
    updatedAt: timestampToDate(raw?.updatedAt),
    playerIds,
    targetsWholeTeam: raw?.targetsWholeTeam === true || playerIds.length === 0,
    parentIds: Array.isArray(raw?.parentIds) ? raw.parentIds : [],
    // Denormalized by the worker so youth-self-manage kids (U13+ with
    // their own account) pass firestore.rules read gate. See rules
    // line 1247-1250. Fall back to [] on legacy docs written before
    // this field existed so the reader stays crash-safe.
    selfPlayerUids: Array.isArray(raw?.selfPlayerUids) ? raw.selfPlayerUids : [],
    source: (raw?.source === 'youtube' || raw?.source === 'vimeo' || raw?.source === 'upload')
      ? raw.source
      : 'upload',
    note: String(raw?.note || ''),
    title: raw?.title ?? null,
    streamUid: raw?.streamUid ?? null,
    streamReady: raw?.streamReady ?? null,
    streamReadyAt: timestampToDate(raw?.streamReadyAt),
    posterTimeSeconds: raw?.posterTimeSeconds ?? null,
    durationSeconds: raw?.durationSeconds ?? null,
    fileSize: raw?.fileSize ?? null,
    fileName: raw?.fileName ?? null,
    contentType: raw?.contentType ?? null,
    embedUrl: raw?.embedUrl ?? null,
    externalVideoId: raw?.externalVideoId ?? null,
    thumbnailUrl: raw?.thumbnailUrl ?? null,
    activeForPlayerIds,
    watchedByPlayerIds,
    watchedByUserIds,
    watchedAt: timestampMap(raw?.watchedAt),
    archivedForPlayerIds,
    archivedAt: timestampMap(raw?.archivedAt),
    isActive: raw?.isActive !== false,
    deletedBy: raw?.deletedBy ?? null,
    deletedAt: timestampToDate(raw?.deletedAt),
  };
}

// Read the "gametape-<id>" fragment off the URL so a deep-linked push
// notification can highlight + scroll to the matching card. Safe to
// call in a browser or a Capacitor WebView; SSR gets an empty string.
function readDeepLinkClipId(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = (window.location.hash || '').replace(/^#/, '');
  const m = raw.match(/^gametape-(.+)$/);
  if (m) return m[1];
  const q = new URLSearchParams(window.location.search);
  const fromQuery = q.get('gametape');
  return fromQuery || null;
}

const GametapeSection: React.FC<Props> = ({
  teamId,
  visiblePlayers,
  effectiveView,
  showCoachControls = false,
  totalTeamPlayers,
  silentWhenEmpty = false,
  hideLibrary = false,
  maxVisibleActive,
}) => {
  // Hooks BEFORE any conditional return (React #310 guard).
  const { userData } = useAuth();
  // Per-viewer independent-watched: each user (self-account kid,
  // parent, co-parent) manages their own From Coach vs Library
  // partition. Threaded through useAuth rather than prop-drilled since
  // all consumer pages already gate on auth upstream.
  const currentUserUid = userData?.uid ?? null;
  const [clips, setClips] = useState<PlayerClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [deepLinkClipId, setDeepLinkClipId] = useState<string | null>(null);

  const visibleIdKey = useMemo(
    () => visiblePlayers.map(p => p.id).sort().join('|'),
    [visiblePlayers],
  );

  useEffect(() => {
    if (!teamId) return;
    setLoading(true);
    const q = query(
      collection(db, 'player_clips'),
      where('teamId', '==', teamId),
      where('isActive', '==', true),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next = snap.docs.map(d => docToClip(d.id, d.data()));
        setClips(next);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.warn('[gametape] onSnapshot failed', err);
        setLoading(false);
        setError('Could not load clips. Pull down to refresh.');
      },
    );
    return () => unsub();
  }, [teamId]);

  // Deep-link once on mount + whenever the fragment changes.
  useEffect(() => {
    const id = readDeepLinkClipId();
    if (id) setDeepLinkClipId(id);
    const onHash = () => {
      const next = readDeepLinkClipId();
      if (next) setDeepLinkClipId(next);
    };
    if (typeof window === 'undefined') return;
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Scroll the deep-linked card into view once its DOM node exists.
  useEffect(() => {
    if (!deepLinkClipId) return;
    if (typeof document === 'undefined') return;
    const el = document.getElementById(`gametape-${deepLinkClipId}`);
    if (el && typeof (el as any).scrollIntoView === 'function') {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* older browsers */ }
    }
  }, [deepLinkClipId, clips.length]);

  // Auto-dismiss toast so it doesn't linger.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const visibleIdSet = useMemo(
    () => new Set(visibleIdKey.split('|').filter(Boolean)),
    [visibleIdKey],
  );
  const isCoachViewer = effectiveView === 'coach' && showCoachControls;

  // Partition clips into From Coach / Library for THIS viewer.
  // Coach viewer: From Coach = any clip with at least one active target
  //               Library    = clip has no active targets left (everyone
  //                            watched or auto-archived)
  // Parent/kid:   From Coach = this user's uid is NOT in watchedByUserIds
  //               Library    = this user's uid IS in watchedByUserIds
  //   Every viewer maintains their own inbox independently: a parent
  //   tapping "I watched it" does not clear the clip from a co-parent
  //   or from a self-account kid, and vice versa. The homework cap
  //   (activeForPlayerIds) is still player-scoped and still bounds the
  //   worker's auto-archive; visibility here is purely per-uid.
  //
  //   Targeting gate is preserved: a clip that targets none of the
  //   viewer's visible players is dropped regardless of watched state.
  const { fromCoach, library } = useMemo(() => {
    const active: PlayerClip[] = [];
    const shelf: PlayerClip[] = [];
    for (const c of clips) {
      if (isCoachViewer) {
        const anyActive = (c.activeForPlayerIds || []).length > 0;
        if (anyActive) active.push(c);
        else shelf.push(c);
        continue;
      }
      const targets = c.targetsWholeTeam ? Array.from(visibleIdSet) : (c.playerIds || []);
      const mine = targets.filter(id => visibleIdSet.has(id));
      if (mine.length === 0) continue; // not for me
      const iWatched = !!currentUserUid && (c.watchedByUserIds || []).includes(currentUserUid);
      if (iWatched) shelf.push(c);
      else active.push(c);
    }
    return { fromCoach: active, library: shelf };
  }, [clips, isCoachViewer, visibleIdSet, currentUserUid]);

  // Silent-empty: on surfaces like Dashboard we don't want a header
  // + empty-state card taking up space when there is nothing to
  // show. During initial load we also render nothing so we don't
  // flash a skeleton that then disappears. Once the first snapshot
  // lands, we bail if there's no active clip (and Library is either
  // hidden or empty). Library is ignored when hideLibrary is set.
  if (silentWhenEmpty) {
    if (loading) return null;
    if (fromCoach.length === 0 && (hideLibrary || library.length === 0)) {
      return null;
    }
  }

  const handleWatch = async (clipId: string, playerId: string) => {
    try {
      await markClipWatched({ clipId, playerId });
    } catch (err: any) {
      console.warn('[gametape] watch failed', err);
      setToast('Could not mark as watched. Try again in a moment.');
      throw err; // let the card roll back its pause state
    }
  };

  const handleArchive = async (clipId: string, playerId: string) => {
    try {
      await archiveClipForPlayer({ clipId, playerId });
    } catch (err: any) {
      console.warn('[gametape] archive failed', err);
      setToast('Could not skip that clip. Try again in a moment.');
    }
  };

  const handleDelete = async (clipId: string) => {
    if (typeof window !== 'undefined' && !window.confirm(COPY.deleteConfirm)) return;
    try {
      await deleteClip({ clipId });
    } catch (err: any) {
      console.warn('[gametape] delete failed', err);
      setToast('Could not delete that clip. Try again in a moment.');
    }
  };

  const renderCard = (clip: PlayerClip, inLibrary: boolean) => {
    // Which of the viewer's players does this clip target?
    const targets = clip.targetsWholeTeam
      ? visiblePlayers
      : visiblePlayers.filter(p => clip.playerIds?.includes(p.id));

    // Coach counters: totalTargets is either the number of specifically
    // targeted players, or the whole team when targetsWholeTeam.
    const total = clip.targetsWholeTeam
      ? (typeof totalTeamPlayers === 'number' ? totalTeamPlayers : (visiblePlayers.length || 0))
      : (clip.playerIds?.length || 0);
    const watched = (clip.watchedByPlayerIds || []).length;

    return (
      <GametapeCard
        key={clip.id}
        clip={clip}
        viewer={isCoachViewer ? 'coach' : effectiveView}
        targetedPlayers={targets}
        watchedCount={Math.min(watched, total || watched)}
        totalTargets={total}
        onWatch={inLibrary ? undefined : (playerId) => handleWatch(clip.id, playerId)}
        onArchiveForPlayer={inLibrary ? undefined : (playerId) => handleArchive(clip.id, playerId)}
        onDelete={isCoachViewer ? () => handleDelete(clip.id) : undefined}
        inLibrary={inLibrary}
        highlighted={deepLinkClipId === clip.id}
      />
    );
  };

  return (
    <section className="mb-8" aria-labelledby="gametape-section-header">
      <header className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h2 id="gametape-section-header" className="text-xl font-bold text-ink-primary">
            {COPY.header}
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">{COPY.headerSubtitle}</p>
        </div>
        {isCoachViewer ? (
          <button
            type="button"
            onClick={() => setComposeOpen(true)}
            className="px-3 py-2 rounded-lg text-xs font-extrabold uppercase tracking-widest bg-brand-primary text-brand-primary-fg hover:bg-brand-primary-hov"
          >
            {COPY.postButton}
          </button>
        ) : null}
      </header>

      {toast ? (
        <div
          role="status"
          className="mb-3 rounded-lg bg-surface-elevated ring-1 ring-line-default/15 px-3 py-2 text-xs text-ink-primary"
        >
          {toast}
        </div>
      ) : null}

      {error ? (
        <div className="mb-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 ring-1 ring-rose-500/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {/* From Coach */}
      <div className="mb-6">
        <h3 className="text-xs font-extrabold uppercase tracking-widest text-ink-secondary mb-2">
          {COPY.fromCoach}
        </h3>
        {loading ? (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 h-24 animate-pulse" aria-hidden />
        ) : fromCoach.length === 0 ? (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-5 text-sm text-ink-secondary text-center">
            {isCoachViewer
              ? COPY.emptyCoachFromCoach
              : effectiveView === 'kid'
                ? COPY.emptyKidFromCoach
                : COPY.emptyParentFromCoach}
          </div>
        ) : (
          <div className="space-y-3">
            {(typeof maxVisibleActive === 'number' && maxVisibleActive > 0
              ? fromCoach.slice(0, maxVisibleActive)
              : fromCoach
            ).map(c => renderCard(c, false))}
            {typeof maxVisibleActive === 'number' &&
             maxVisibleActive > 0 &&
             fromCoach.length > maxVisibleActive ? (
              <Link
                to="/development"
                className="block rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 px-4 py-3 text-sm font-bold text-brand-primary hover:bg-brand-primary/5 text-center"
              >
                {fromCoach.length - maxVisibleActive === 1
                  ? '1 more clip waiting. See all →'
                  : `${fromCoach.length - maxVisibleActive} more clips waiting. See all →`}
              </Link>
            ) : null}
          </div>
        )}
      </div>

      {/* Library — only rendered when there's something in it, and
          skipped entirely when the surface opts out (e.g. Dashboard
          keeps the focus on "From Coach" only; full Library still
          lives on Player Development). */}
      {!hideLibrary && library.length > 0 ? (
        <div>
          <h3 className="text-xs font-extrabold uppercase tracking-widest text-ink-secondary mb-2">
            {COPY.library}
          </h3>
          <div className="space-y-3">
            {library.map(c => renderCard(c, true))}
          </div>
        </div>
      ) : null}

      {isCoachViewer ? (
        <GametapeComposeModal
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          teamId={teamId}
          players={visiblePlayers}
          onCreated={(res) => {
            if (res.autoArchivedCount > 0) {
              setToast(COPY.autoArchivedToast(res.autoArchivedCount));
            } else {
              setToast('Clip sent.');
            }
          }}
        />
      ) : null}
    </section>
  );
};

export default GametapeSection;
