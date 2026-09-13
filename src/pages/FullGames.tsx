import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { where, orderBy } from 'firebase/firestore';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { FullGame } from '../types';
import { canManageTeamMedia, formatDate } from '../utils/helpers';
import YouTubeSmartEmbed from '../components/common/YouTubeSmartEmbed';
import { uploadToR2 } from '../utils/r2Upload';
import { uploadToStream, streamThumbnailUrl, checkVideoLimit } from '../utils/streamUpload';
import { canUploadFullGameFile } from '../utils/videoQuota';
import { checkUploadQuota, probeVideoDuration, incrementTeamVideoUsage, type QuotaCheck } from '../utils/videoQuota';
import VideoQuotaModal from '../components/common/VideoQuotaModal';
import StreamPlayer from '../components/common/StreamPlayer';
import { getShareOrigin } from '../utils/origin';

// Extract YouTube video ID from any common YouTube URL shape.
function extractYouTubeId(input: string): string | null {
  if (!input) return null;
  const url = input.trim();
  // Already an ID (11 chars, alphanumeric, -, _)
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1).split('/')[0] || null;
    }
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      // /embed/ID or /shorts/ID or /live/ID
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['embed', 'shorts', 'live', 'v'].includes(p));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // Fall through to regex fallback
  }
  const m = url.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

const FullGames: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const navigate = useNavigate();
  const { getDocuments, addDocument, updateDocument, deleteDocument, getEventsByTeam } = useFirestore();

  const [games, setGames] = useState<FullGame[]>([]);
  const [quotaBlocked, setQuotaBlocked] = useState<QuotaCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedGame, setSelectedGame] = useState<FullGame | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formTitle, setFormTitle] = useState('');
  const [formOpponent, setFormOpponent] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formResult, setFormResult] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Link to a calendar event (optional). Populated by picking one from
  // the "Link to game event" dropdown at the top of the form —
  // auto-fills opponent + date and stamps eventId on the doc so the
  // Highlights tab's per-game section can join full_games ↔ events
  // exactly instead of falling back to the opponent+date fuzzy match.
  const [formEventId, setFormEventId] = useState('');
  const [gameEvents, setGameEvents] = useState<Array<{ id: string; label: string; opponent: string; date: Date }>>([]);

  // Source toggle: upload a file to our site, or paste a YouTube link.
  // Free / addon tier defaults to youtube — the upload option is
  // gated behind the pro tier (Full Game Film, $29.99/mo). See
  // canUploadFullGameFile / videoQuota.ts for the rationale
  // (Cloudflare Stream cost per team on a 90-min game).
  const [formSource, setFormSource] = useState<'upload' | 'youtube'>('youtube');
  const [formFile, setFormFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  // For edit mode, keep track of existing R2 video so user knows it's already there
  const [existingVideoUrl, setExistingVideoUrl] = useState<string | undefined>(undefined);
  const [existingVideoKey, setExistingVideoKey] = useState<string | undefined>(undefined);
  const [existingVideoFileName, setExistingVideoFileName] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canManageMedia = canManageTeamMedia(userData, selectedTeam);
  const canUploadFiles = canUploadFullGameFile(selectedTeam);

  const loadGames = async () => {
    if (!selectedTeamId) {
      setGames([]);
      setLoading(false);
      return;
    }
    try {
      const docs = await getDocuments('full_games', [
        where('teamId', '==', selectedTeamId),
        orderBy('gameDate', 'desc'),
      ]);
      // Client-side isActive filter (soft-delete pattern) — avoids a
      // Firestore composite index for (teamId, isActive, gameDate)
      // that we'd need for a server-side filter. Legacy games missing
      // the field (never soft-deleted) show as active by default.
      const active = (docs as FullGame[]).filter(g => (g as any).isActive !== false);
      setGames(active);
    } catch (err) {
      console.error('Failed to load full games:', err);
      setGames([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadGames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeamId]);

  // Load recent game events for the "Link to game event" dropdown.
  // Uses the same cached helper as the rest of the app so we don't
  // trip the missing-composite-index case (previous shape queried
  // (teamId, type, date) directly and silently returned nothing when
  // the index wasn't provisioned). Scoped 180 days back + 30 days
  // forward so the picker is scannable but covers a full season.
  useEffect(() => {
    if (!selectedTeamId) { setGameEvents([]); return; }
    (async () => {
      try {
        const all = await getEventsByTeam(selectedTeamId);
        const cutoffPast = Date.now() - 180 * 24 * 3600 * 1000;
        const cutoffFuture = Date.now() + 30 * 24 * 3600 * 1000;
        const rows = (all as any[])
          .filter(e => e.type === 'game')
          .map(e => {
            const date: Date = e.date?.toDate ? e.date.toDate() : new Date(e.date);
            const opponent = String(e.opponent || '').trim();
            return { id: e.id, opponent, date };
          })
          .filter(e => !isNaN(e.date.getTime()) && e.date.getTime() >= cutoffPast && e.date.getTime() <= cutoffFuture)
          .sort((a, b) => b.date.getTime() - a.date.getTime())
          .map(e => ({
            ...e,
            label: `${e.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} — vs ${e.opponent || 'Opponent'}`,
          }));
        setGameEvents(rows);
      } catch (err) {
        console.warn('Could not load game events for full-game linker', err);
        setGameEvents([]);
      }
    })();
  }, [selectedTeamId, getEventsByTeam]);

  // Picking a calendar event auto-fills opponent + date on the form
  // so the coach doesn't have to re-type what the schedule already
  // knows. Stamps eventId on the doc via handleSubmit's payload.
  const handlePickEvent = (id: string) => {
    setFormEventId(id);
    if (!id) return;
    const ev = gameEvents.find(g => g.id === id);
    if (!ev) return;
    if (ev.opponent) setFormOpponent(ev.opponent);
    setFormDate(ev.date.toISOString().slice(0, 10));
    // Only overwrite the title when it's blank — respect the coach's
    // typing so a "Rivalry Game" custom title survives the pick.
    if (!formTitle.trim()) setFormTitle(`vs ${ev.opponent || 'Opponent'}`);
  };

  // Deep-link support: /full-games?game=<id> auto-opens that game
  // in the viewer once the list has loaded. Lets the Highlights tab's
  // per-game "Full Game" tile land the user directly on the video
  // instead of a game picker. Consumes the param once so a manual
  // close doesn't immediately re-open.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    const wantId = searchParams.get('game');
    if (!wantId || loading) return;
    if (deepLinkConsumedRef.current === wantId) return;
    const target = games.find(g => g.id === wantId);
    if (target) {
      setSelectedGame(target);
      deepLinkConsumedRef.current = wantId;
      const next = new URLSearchParams(searchParams);
      next.delete('game');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, games, loading, setSearchParams]);

  const resetForm = () => {
    setFormTitle('');
    setFormOpponent('');
    setFormDate('');
    setFormUrl('');
    setFormResult('');
    setFormNotes('');
    setEditingId(null);
    setFormEventId('');
    // Reset defaults to the tier's default source. Pro teams pick
    // upload naturally; free/addon default to youtube.
    setFormSource(canUploadFiles ? 'upload' : 'youtube');
    setFormFile(null);
    setUploadProgress(0);
    setExistingVideoUrl(undefined);
    setExistingVideoKey(undefined);
    setExistingVideoFileName(undefined);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const openAddForm = () => {
    resetForm();
    setFormDate(new Date().toISOString().slice(0, 10));
    setShowForm(true);
  };

  const openEditForm = (game: FullGame) => {
    setEditingId(game.id);
    setFormEventId(((game as any).eventId as string | undefined) || '');
    setFormTitle(game.title);
    setFormOpponent(game.opponent || '');
    const d = game.gameDate instanceof Date ? game.gameDate : (game.gameDate as any)?.toDate?.() || new Date();
    setFormDate(d.toISOString().slice(0, 10));
    setFormUrl(game.youtubeUrl || '');
    setFormResult(game.result || '');
    setFormNotes(game.notes || '');
    // Determine source from existing data
    const hasR2 = !!game.videoUrl;
    setFormSource(hasR2 ? 'upload' : 'youtube');
    setExistingVideoUrl(game.videoUrl);
    setExistingVideoKey(game.videoKey);
    setExistingVideoFileName(game.videoFileName);
    setFormFile(null);
    setUploadProgress(0);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userData || !selectedTeamId) return;
    if (!formTitle.trim() || !formDate) {
      alert('Title and date are required.');
      return;
    }

    let payload: Partial<FullGame> = {
      teamId: selectedTeamId,
      title: formTitle.trim(),
      opponent: formOpponent.trim() || undefined,
      gameDate: new Date(formDate),
      result: formResult.trim() || undefined,
      notes: formNotes.trim() || undefined,
      addedBy: userData.uid,
      addedByName: userData.name || userData.email || 'Coach',
      // Explicit calendar-event join — supersedes the opponent+date
      // fuzzy match in HighlightsNetflixTab. Optional (some coaches
      // upload before the event exists), null-clears on unlink.
      ...(formEventId ? { eventId: formEventId } : { eventId: null } as any),
    };

    if (formSource === 'youtube') {
      const youtubeId = extractYouTubeId(formUrl);
      if (!youtubeId) {
        alert('Please enter a valid YouTube link.');
        return;
      }
      payload.source = 'youtube';
      payload.youtubeUrl = formUrl.trim();
      payload.youtubeId = youtubeId;
      // Clear any prior r2 fields when switching
      (payload as any).videoUrl = null;
      (payload as any).videoKey = null;
      (payload as any).videoFileName = null;
      (payload as any).videoSize = null;
      (payload as any).videoContentType = null;
    } else {
      // Upload mode. Belt-and-suspenders tier gate — the UI already
      // shunts free/addon coaches to the upgrade page when they tap
      // Upload, but a tampered client (or a downgraded team editing
      // an old R2 game) hitting Save with formFile set would slip
      // past the UI. Refuse here too.
      if (!canUploadFiles && formFile) {
        alert('Uploading video files requires the Full Game Film tier ($29.99/mo). Paste a YouTube link instead, or upgrade under Team Settings.');
        return;
      }
      if (!formFile && !existingVideoUrl) {
        alert('Please choose a video file to upload.');
        return;
      }
      if (formFile && !formFile.type.startsWith('video/')) {
        alert('Please choose a video file (MP4, MOV, etc.).');
        return;
      }
      // Shared 500 MB client cap. Blocks before any XHR / serverless
      // invocation. Under 100 MB is silent; 100-500 MB confirms.
      if (formFile) {
        const decision = checkVideoLimit(formFile);
        if (!decision.ok) {
          alert(decision.message);
          return;
        }
        if (decision.warn && decision.message) {
          if (!window.confirm(decision.message)) return;
        }
      }
      payload.source = 'stream';
      // Clear youtube fields when switching
      (payload as any).youtubeUrl = null;
      (payload as any).youtubeId = null;
    }

    setSaving(true);
    try {
      // Upload to Cloudflare Stream first if needed
      if (formSource === 'upload' && formFile) {
        // Quota gate. Full game film is by definition >60s, so
        // free + Highlights+ teams will always fail the duration
        // check here. Tier 2 (Full Game Film) is the only path
        // that allows native upload of a full game. YouTube embeds
        // are the free alternative, hence the modal CTA.
        const durationSec = await probeVideoDuration(formFile);
        const quota = await checkUploadQuota(selectedTeamId!, { durationSeconds: durationSec ?? undefined });
        if (!quota.allowed) {
          setQuotaBlocked(quota);
          setSaving(false);
          setUploadProgress(0);
          return;
        }
        setUploadProgress(0);
        const result = await uploadToStream(
          formFile,
          { name: formTitle, teamId: selectedTeamId },
          p => setUploadProgress(p),
        );
        payload.streamUid = result.uid;
        payload.videoUrl = result.hlsUrl;
        payload.videoFileName = formFile.name;
        payload.videoSize = formFile.size;
        payload.videoContentType = formFile.type;
        // R2 fields are no longer used for new uploads.
        (payload as any).videoKey = null;
        // Bump team video usage so the Tier 2 100-hour cap can be
        // enforced. Stored minutes drive the next upload's check.
        void incrementTeamVideoUsage(selectedTeamId!, durationSec);
      } else if (formSource === 'upload' && existingVideoUrl) {
        // Editing without replacing the file — keep existing video fields
        payload.videoUrl = existingVideoUrl;
        payload.videoKey = existingVideoKey;
        payload.videoFileName = existingVideoFileName;
      }

      // Strip undefined so Firestore doesn't complain (keep null — used to clear fields)
      Object.keys(payload).forEach(k => (payload as any)[k] === undefined && delete (payload as any)[k]);

      if (editingId) {
        await updateDocument('full_games', editingId, payload);
      } else {
        const { withSeasonId } = await import('../utils/seasons');
        await addDocument('full_games', await withSeasonId(payload));
      }
      setShowForm(false);
      resetForm();
      await loadGames();
    } catch (err) {
      console.error('Failed to save game:', err);
      alert('Failed to save. ' + ((err as Error)?.message || 'Please try again.'));
    } finally {
      setSaving(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (game: FullGame) => {
    const g = game as any;
    // Bytes-side warning matters — full games are big and CF Stream
    // charges by minutes stored. Old copy said "the uploaded video
    // file will remain in storage" which was BOTH wrong (it stayed,
    // costing money forever) AND misleading. New copy names what's
    // actually going away: the entry + the underlying file (or just
    // the entry, for YouTube links which we don't host).
    const isHosted = !!g.streamUid || !!game.videoUrl;
    const msg = isHosted
      ? `Delete "${game.title}"? The video file will be removed from Cloudflare Stream too — this frees your storage but can't be undone.`
      : `Delete "${game.title}"? This only removes the link, not the YouTube video.`;
    if (!window.confirm(msg)) return;
    try {
      // 1) Soft-delete the Firestore doc first — matches the app's
      //    standing pattern (memory: never hard-delete user-facing
      //    records, PITR isn't on). Prior shape hard-deleted, which
      //    made "undo" impossible if the coach mis-tapped.
      const now = new Date();
      await updateDocument('full_games', game.id, {
        isActive: false,
        deletedAt: now,
        deletedBy: userData?.uid || null,
      });
      // 2) Best-effort delete the underlying blobs. Fire-and-forget so
      //    a CF API blip doesn't strand the Firestore soft-delete.
      //    Prior shape skipped this ENTIRELY — every "deleted" full
      //    game kept eating Cloudflare Stream minutes forever, which
      //    is exactly why the account hit its 1000-min cap even
      //    though the app claimed those games were gone.
      if (g.streamUid) {
        void (async () => {
          try {
            const { deleteStreamVideo } = await import('../utils/streamUpload');
            const res = await deleteStreamVideo(g.streamUid);
            if (!res.ok) console.warn('[full-games] Stream delete failed', g.streamUid, res.error);
          } catch (err) {
            console.warn('[full-games] Stream delete threw', err);
          }
        })();
      }
      if (game.videoUrl && /^https?:\/\//i.test(game.videoUrl)) {
        void (async () => {
          try {
            const { deleteR2Object } = await import('../utils/r2Upload');
            const res = await deleteR2Object(game.videoUrl!);
            if (!res.ok) console.warn('[full-games] R2 delete failed', game.videoUrl, res.error);
          } catch (err) {
            console.warn('[full-games] R2 delete threw', err);
          }
        })();
      }
      await loadGames();
      if (selectedGame?.id === game.id) setSelectedGame(null);
    } catch (err) {
      console.error('Failed to delete game:', err);
      alert('Failed to delete.');
    }
  };

  const groupedByYear = useMemo(() => {
    const map = new Map<number, FullGame[]>();
    for (const g of games) {
      const d = g.gameDate instanceof Date ? g.gameDate : (g.gameDate as any)?.toDate?.() || new Date();
      const year = d.getFullYear();
      if (!map.has(year)) map.set(year, []);
      map.get(year)!.push(g);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [games]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary-soft/30 border-t-cyan-500" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-ink-primary">🎬 Full Games</h1>
            <p className="text-sm text-ink-primary/50 mt-1">Watch full match recordings hosted on GoalKickr or YouTube.</p>
          </div>
          {canManageMedia && (selectedTeam?.videoTier || 'free') === 'free' && (
            <button
              onClick={() => navigate('/upgrade/video')}
              className="px-3 py-1.5 rounded-full text-[11px] font-extrabold uppercase tracking-widest bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40 hover:bg-amber-500/25 transition-colors"
            >
              Upgrade
            </button>
          )}
        </div>
        {canManageMedia && (
          <button
            onClick={openAddForm}
            className="inline-flex items-center space-x-1.5 bg-brand-primary hover:bg-brand-primary text-white text-sm font-medium px-4 py-2 rounded-lg"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            <span>Add Game</span>
          </button>
        )}
      </div>

      {/* Empty state */}
      {games.length === 0 ? (
        <div className="text-center py-16 bg-surface-elevated rounded-xl border border-line-default/10">
          <div className="text-5xl mb-4">📺</div>
          <h3 className="text-lg font-medium text-ink-primary">No Full Games Yet</h3>
          <p className="text-ink-primary/50 text-sm mt-1 max-w-sm mx-auto">
            {canManageMedia
              ? 'Add a YouTube link to share a full game recording with the team.'
              : 'Full game recordings will appear here once the coach adds them.'}
          </p>
          {canManageMedia && (
            <button
              onClick={openAddForm}
              className="mt-4 inline-flex items-center bg-brand-primary hover:bg-brand-primary text-white text-sm font-medium px-4 py-2 rounded-lg"
            >
              Add First Game
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {groupedByYear.map(([year, yearGames]) => (
            <div key={year}>
              <h2 className="text-sm font-semibold text-ink-primary/50 uppercase tracking-wide mb-3">{year} Season</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {yearGames.map(g => (
                  <div key={g.id} className="bg-surface-elevated rounded-xl border border-line-default/10 overflow-hidden hover:shadow-md transition-shadow flex flex-col">
                    <button
                      type="button"
                      onClick={() => setSelectedGame(g)}
                      className="relative aspect-video w-full bg-black group"
                    >
                      {g.streamUid ? (
                        <img
                          src={streamThumbnailUrl(g.streamUid, { height: 360, time: g.posterTimeSeconds != null ? `${g.posterTimeSeconds}s` : undefined })}
                          alt={g.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : g.videoUrl ? (
                        <video
                          src={g.videoUrl}
                          className="w-full h-full object-cover"
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : g.youtubeId ? (
                        <img
                          src={`https://i.ytimg.com/vi/${g.youtubeId}/hqdefault.jpg`}
                          alt={g.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-white/40 text-4xl">⚽</div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                        <div className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg ${
                          g.videoUrl ? 'bg-brand-primary' : 'bg-red-600'
                        }`}>
                          <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                      </div>
                      {g.videoUrl && (
                        <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-brand-primary/90 text-white text-[10px] font-semibold tracking-wide">FIRE FC</span>
                      )}
                    </button>
                    <div className="p-4 flex-1 flex flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-ink-primary text-sm leading-snug line-clamp-2">{g.title}</h3>
                        {g.result && (
                          <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded ${
                            g.result.startsWith('W') ? 'bg-green-100 text-emerald-300'
                              : g.result.startsWith('L') ? 'bg-red-100 text-rose-300'
                              : 'bg-line-default/[0.08] text-ink-primary/85'
                          }`}>
                            {g.result}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-primary/50 mt-1 space-y-0.5">
                        {g.opponent && <div>vs {g.opponent}</div>}
                        <div>{formatDate(g.gameDate as any)}</div>
                      </div>
                      <div className="flex items-center justify-between mt-3 pt-3 border-t border-line-default/5">
                        <button
                          onClick={() => setSelectedGame(g)}
                          className="text-xs text-brand-primary hover:underline font-medium"
                        >
                          Watch →
                        </button>
                        {canManageMedia && (
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() => openEditForm(g)}
                              className="text-xs text-ink-primary/50 hover:text-ink-primary/85"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDelete(g)}
                              className="text-xs text-rose-300 hover:text-rose-300"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Watch modal */}
      {selectedGame && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 theme-ok"
          onClick={() => setSelectedGame(null)}
        >
          {/* Close button. 2026-09-13 fix: on iOS the top-4 placement
              lands the X UNDER the notch / status bar overlay, making
              it unclickable. Combine with env(safe-area-inset-top) so
              it always sits below the system chrome. Also bumped
              z-index to 60 in case the swap-fallback YouTube poster
              card (z-50 iframes) draws over it. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setSelectedGame(null); }}
            className="fixed right-4 text-white/90 hover:text-white text-3xl w-10 h-10 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 z-[60] theme-ok"
            style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
            aria-label="Close"
          >
            ×
          </button>
          <div
            className="max-w-5xl w-full"
            onClick={e => e.stopPropagation()}
          >
            <div className="aspect-video w-full bg-black rounded-lg overflow-hidden">
              {selectedGame.streamUid ? (
                <StreamPlayer
                  uid={selectedGame.streamUid}
                  autoplay
                  title={selectedGame.title}
                  className="w-full h-full"
                />
              ) : selectedGame.videoUrl ? (
                <video
                  src={selectedGame.videoUrl}
                  className="w-full h-full"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <YouTubeSmartEmbed
                  youtubeId={selectedGame.youtubeId}
                  title={selectedGame.title}
                  caption={selectedGame.opponent ? `vs ${selectedGame.opponent}` : undefined}
                  className="relative w-full h-full rounded-lg overflow-hidden bg-black ring-1 ring-white/10 theme-ok"
                />
              )}
            </div>
            <div className="mt-3 text-white">
              <h2 className="text-lg font-semibold">{selectedGame.title}</h2>
              <div className="text-sm text-white/70 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {selectedGame.opponent && <span>vs {selectedGame.opponent}</span>}
                <span>{formatDate(selectedGame.gameDate as any)}</span>
                {selectedGame.result && <span className="font-medium">{selectedGame.result}</span>}
              </div>
              {selectedGame.notes && <p className="text-sm text-white/80 mt-2">{selectedGame.notes}</p>}
              <div className="flex flex-wrap items-center gap-3 mt-3">
                <a
                  href={`${getShareOrigin()}/game/${selectedGame.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-line-default/10 hover:bg-line-default/20 rounded-lg text-sm font-medium"
                >
                  <span>Open share page</span>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14 3h7m0 0v7m0-7L10 14M5 5h6v2H7v10h10v-4h2v6H5V5z" /></svg>
                </a>
                {selectedGame.youtubeUrl && !selectedGame.videoUrl && (
                  <a
                    href={selectedGame.youtubeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-line-default/5 hover:bg-line-default/10 rounded-lg text-xs text-white/60 font-medium"
                  >
                    <span>YouTube source</span>
                  </a>
                )}
                <button
                  onClick={async () => {
                    const url = `${getShareOrigin()}/game/${selectedGame.id}`;
                    const data = { title: selectedGame.title, url };
                    try {
                      if (navigator.share) await navigator.share(data);
                      else { await navigator.clipboard.writeText(url); alert('Link copied to clipboard!'); }
                    } catch (err) {
                      if ((err as any)?.name !== 'AbortError') {
                        try { await navigator.clipboard.writeText(url); alert('Link copied to clipboard!'); } catch {}
                      }
                    }
                  }}
                  className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-line-default/10 hover:bg-line-default/20 rounded-lg text-sm font-medium"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                  <span>Share</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-surface-elevated rounded-xl max-w-lg w-full my-auto">
            <form onSubmit={handleSubmit} className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-ink-primary">
                  {editingId ? 'Edit Game' : 'Add Full Game'}
                </h2>
                <button
                  type="button"
                  onClick={() => { setShowForm(false); resetForm(); }}
                  className="text-ink-primary/40 hover:text-ink-primary/65 text-2xl leading-none"
                >
                  ×
                </button>
              </div>

              <div className="space-y-4">
                {gameEvents.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">
                      Link to game event <span className="text-ink-primary/50 font-normal">(optional)</span>
                    </label>
                    <select
                      value={formEventId}
                      onChange={e => handlePickEvent(e.target.value)}
                      className="w-full px-3 py-2 bg-surface-input text-ink-primary border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                    >
                      <option value="">Not linked to a specific event</option>
                      {gameEvents.map(ev => (
                        <option key={ev.id} value={ev.id}>{ev.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-ink-primary/50 mt-1 leading-snug">
                      Auto-fills opponent and date, and connects this recording to that game on the Highlights tab.
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">Title *</label>
                  <input
                    type="text"
                    value={formTitle}
                    onChange={e => setFormTitle(e.target.value)}
                    placeholder="e.g. Spring Tournament Final"
                    className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                    required
                  />
                </div>

                {/* Stack on mobile — grid-cols-2 at 375px crammed the
                    Opponent input into ~160px and the native iOS date
                    picker rendered taller, so the two fields looked
                    mismatched. Full-width single column on phone
                    reads cleaner; sm+ still gets the two-up layout. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Date *</label>
                    <input
                      type="date"
                      value={formDate}
                      onChange={e => setFormDate(e.target.value)}
                      className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-primary/85 mb-1">Opponent</label>
                    <input
                      type="text"
                      value={formOpponent}
                      onChange={e => setFormOpponent(e.target.value)}
                      placeholder="e.g. Lightning FC"
                      className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">Video Source</label>
                  <div className="grid grid-cols-2 gap-2 mb-3 p-1 bg-line-default/[0.08] rounded-lg">
                    <button
                      type="button"
                      onClick={() => {
                        if (canUploadFiles) {
                          setFormSource('upload');
                        } else {
                          // Free / addon can't upload files — take them
                          // to the upgrade page. Full Game Film ($29.99)
                          // is the tier that unlocks R2 file upload
                          // (Cloudflare Stream storage is too pricey to
                          // give away at $0-10/mo).
                          navigate('/upgrade/video');
                        }
                      }}
                      className={`relative px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        formSource === 'upload'
                          ? 'bg-surface-elevated text-brand-primary-soft shadow-sm'
                          : canUploadFiles
                          ? 'text-ink-primary/65 hover:text-ink-primary'
                          : 'text-ink-primary/40'
                      }`}
                      title={canUploadFiles ? 'Upload file to GoalKickr' : 'Upgrade to Full Game Film to upload files'}
                    >
                      Upload to GoalKickr
                      {!canUploadFiles && (
                        <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40">
                          Pro
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormSource('youtube')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        formSource === 'youtube'
                          ? 'bg-surface-elevated text-rose-300 shadow-sm'
                          : 'text-ink-primary/65 hover:text-ink-primary'
                      }`}
                    >
                      🔗 YouTube link
                    </button>
                  </div>

                  {!canUploadFiles && (
                    <div className="mb-3 rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 px-3 py-2 text-xs text-amber-200/85 leading-snug">
                      Paste a YouTube link on the current tier. To upload full game files directly to GoalKickr, unlock <button type="button" onClick={() => navigate('/upgrade/video')} className="underline font-bold hover:text-amber-100">Full Game Film</button> ($29.99/mo).
                    </div>
                  )}

                  {formSource === 'upload' ? (
                    <div>
                      {existingVideoUrl && !formFile && (
                        <div className="mb-2 px-3 py-2 bg-brand-primary/15 border border-brand-primary-soft/30 rounded-lg text-xs text-brand-primary-soft">
                          Currently hosted on GoalKickr: <span className="font-mono">{existingVideoFileName || 'video file'}</span>. Choose a new file below to replace it, or leave blank to keep it.
                        </div>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        onChange={e => setFormFile(e.target.files?.[0] || null)}
                        className="w-full text-sm text-ink-primary/65 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-brand-primary file:text-white file:text-sm file:font-medium hover:file:bg-brand-primary"
                      />
                      {formFile && (
                        <p className="text-xs text-ink-primary/50 mt-1">
                          {formFile.name} ({(formFile.size / (1024 * 1024)).toFixed(1)} MB)
                        </p>
                      )}
                      <p className="text-xs text-ink-primary/50 mt-2">
                        Hosted on GoalKickr. Anyone with the share link can watch — no YouTube account needed. Up to 2GB.
                      </p>
                      {saving && uploadProgress > 0 && (
                        <div className="mt-2">
                          <div className="w-full bg-line-default/15 rounded-full h-2">
                            <div className="h-2 rounded-full bg-brand-primary/150 transition-all" style={{ width: `${uploadProgress}%` }} />
                          </div>
                          <p className="text-xs text-ink-primary/50 mt-1">Uploading... {uploadProgress}%</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <input
                        type="url"
                        value={formUrl}
                        onChange={e => setFormUrl(e.target.value)}
                        placeholder="https://youtu.be/... or https://youtube.com/watch?v=..."
                        className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                      />
                      {formUrl && !extractYouTubeId(formUrl) && (
                        <p className="text-xs text-rose-300 mt-1">Doesn't look like a valid YouTube link.</p>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">Result</label>
                  <input
                    type="text"
                    value={formResult}
                    onChange={e => setFormResult(e.target.value)}
                    placeholder="e.g. W 3-1, L 2-4, T 1-1"
                    className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-primary/85 mb-1">Notes</label>
                  <textarea
                    value={formNotes}
                    onChange={e => setFormNotes(e.target.value)}
                    rows={3}
                    placeholder="Highlights, timestamps, etc."
                    className="w-full px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/45 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-brand-primary"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end space-x-2 mt-6 pt-4 border-t border-line-default/5">
                <button
                  type="button"
                  onClick={() => { setShowForm(false); resetForm(); }}
                  className="px-4 py-2 text-sm font-medium text-ink-primary/85 hover:bg-line-default/[0.08] rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-white bg-brand-primary hover:bg-brand-primary rounded-lg disabled:opacity-50"
                >
                  {saving
                    ? (formSource === 'upload' && formFile ? `Uploading ${uploadProgress}%...` : 'Saving...')
                    : editingId ? 'Save Changes' : 'Add Game'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <VideoQuotaModal
        open={!!quotaBlocked}
        quota={quotaBlocked}
        onClose={() => setQuotaBlocked(null)}
        teamId={selectedTeamId || undefined}
      />
    </div>
  );
};

export default FullGames;
