// GametapeComposeModal — the coach-only compose flow. Two tabs:
//   • Upload video — native picker, 90s cap.
//   • Paste link  — YouTube (and Vimeo) URL, always free.
//
// Targeting: single player / small group / whole team. All three
// funnel to the same worker POST — the server treats an empty
// playerIds array as "whole team" so the client stays simple.
//
// Paid-tier enforcement is SERVER-SIDE ONLY. /api/stream-upload-url
// and /gametape/create both re-verify tier from the user doc and
// return 402 with a warm inline message when a non-paid coach picks
// a native upload. There is no client-side gate: an earlier prop
// (`isPaidCoach`) was never wired to a hook in any caller, which
// left the Upload button as a silent no-op. Rely on 402 handling
// in handleFilePicked / handleSubmit instead.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../ui';
import { checkVideoLimit, uploadToStream } from '../../utils/streamUpload';
import { probeVideoDuration } from '../../utils/videoQuota';
import { createClip, type GametapeSource } from '../../utils/gametapeApi';
import type { GametapePlayer } from '../../types';

const MAX_CLIP_SECONDS = 90;

interface Props {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /** Coach roster the picker chooses from. */
  players: GametapePlayer[];
  /** Fires with the newly-created clipId after the worker responds
   *  ok. Parent can show a toast + rely on the Section's onSnapshot
   *  listener to render the row. */
  onCreated?: (result: { clipId?: string; autoArchivedCount: number }) => void;
}

type TargetMode = 'single' | 'group' | 'team';

const COPY = {
  title: 'Drop a clip',
  subtitle:
    "Send tactical film to a player, a small group, or the whole squad. Keep it tight, under 90 seconds hits hardest.",
  targetLabel: "Who's this for?",
  targetHelper:
    'Pick one player, a small group, or the whole team. You can send the same clip to more than one squad member at once.',
  tabUpload: 'Upload video',
  tabLink: 'Paste link',
  uploadHint: 'MP4 or MOV, up to 90 seconds. Trim it in Photos first if it is longer.',
  uploadTooLong:
    'That clip is longer than 90 seconds. Trim it in Photos first, then try again. Short clips get watched.',
  linkPlaceholder: 'https://youtube.com/watch?v=... or vimeo.com/...',
  linkHint: 'Paste a YouTube or Vimeo link. Anything embed-friendly works.',
  linkInvalid: "That does not look like a YouTube or Vimeo link. Try pasting the share URL again.",
  notePlaceholder:
    'Why should they watch this? One or two sentences beats a paragraph.',
  postButton: 'Send clip',
  postingButton: 'Sending…',
  capWarningInline:
    'Heads up: one or more targeted players already has 3 active clips. The oldest will slide to their Library so this does not feel like homework.',
  targetSingle: 'One player',
  targetGroup: 'Small group',
  targetTeam: 'Whole team',
  emptyRoster: 'Add players to the roster first, then post a clip.',
} as const;

// Simple URL sniffer — same rules as the video player.
function detectLinkSource(raw: string): { source: GametapeSource | null; embedUrl: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { source: null, embedUrl: '' };
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return { source: 'youtube', embedUrl: trimmed };
    if (host === 'vimeo.com' || host.endsWith('vimeo.com')) return { source: 'vimeo', embedUrl: trimmed };
    return { source: null, embedUrl: trimmed };
  } catch {
    return { source: null, embedUrl: trimmed };
  }
}

const GametapeComposeModal: React.FC<Props> = ({
  open,
  onClose,
  teamId,
  players,
  onCreated,
}) => {
  const [tab, setTab] = useState<'upload' | 'link'>('upload');
  const [targetMode, setTargetMode] = useState<TargetMode>('single');
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);
  const [note, setNote] = useState('');

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedStreamUid, setUploadedStreamUid] = useState<string | null>(null);
  const [uploadedDuration, setUploadedDuration] = useState<number | null>(null);
  const [uploadedMeta, setUploadedMeta] = useState<{ fileName?: string; contentType?: string; fileSize?: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Link state
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset everything whenever the sheet reopens so we don't leak a
  // stale draft between sessions.
  useEffect(() => {
    if (!open) return;
    setTab('upload');
    setTargetMode('single');
    setSelectedPlayerIds([]);
    setNote('');
    setUploading(false);
    setUploadProgress(0);
    setUploadedStreamUid(null);
    setUploadedDuration(null);
    setUploadedMeta(null);
    setUploadError(null);
    setLinkUrl('');
    setLinkError(null);
    setSubmitting(false);
    setSubmitError(null);
  }, [open]);

  const linkDetection = useMemo(() => detectLinkSource(linkUrl), [linkUrl]);

  const targetsWholeTeam = targetMode === 'team';
  const effectivePlayerIds = targetsWholeTeam ? [] : selectedPlayerIds;

  // Validation — a single derived boolean the submit button reads.
  const canSubmit = useMemo(() => {
    if (submitting || uploading) return false;
    if (targetMode !== 'team' && selectedPlayerIds.length === 0) return false;
    if (targetMode === 'single' && selectedPlayerIds.length > 1) return false;
    if (tab === 'upload') {
      return !!uploadedStreamUid;
    }
    return linkDetection.source !== null;
  }, [submitting, uploading, targetMode, selectedPlayerIds, tab, uploadedStreamUid, linkDetection.source]);

  const togglePlayer = (id: string) => {
    setSelectedPlayerIds(prev => {
      if (targetMode === 'single') {
        return prev.includes(id) ? [] : [id];
      }
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 4 && targetMode === 'group') return prev; // small-group cap
      return [...prev, id];
    });
  };

  const handleTargetModeChange = (mode: TargetMode) => {
    setTargetMode(mode);
    // Reset selection when swapping between single/group so the
    // caps stay honest.
    if (mode === 'single' && selectedPlayerIds.length > 1) {
      setSelectedPlayerIds(selectedPlayerIds.slice(0, 1));
    }
    if (mode === 'team') {
      setSelectedPlayerIds([]);
    }
  };

  const handleFilePicked = async (file: File) => {
    setUploadError(null);
    const decision = checkVideoLimit(file);
    if (!decision.ok) {
      setUploadError(decision.message || 'That clip is too large.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    // Duration probe BEFORE we burn bandwidth on the Stream upload.
    const duration = await probeVideoDuration(file);
    if (typeof duration === 'number' && duration > MAX_CLIP_SECONDS) {
      setUploadError(COPY.uploadTooLong);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (decision.warn && decision.message) {
      const proceed = typeof window !== 'undefined' && window.confirm(decision.message);
      if (!proceed) {
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const res = await uploadToStream(
        file,
        { name: file.name, teamId, feature: 'gametape' },
        (pct) => setUploadProgress(pct),
      );
      setUploadedStreamUid(res.uid);
      setUploadedDuration(typeof duration === 'number' ? Math.round(duration) : null);
      setUploadedMeta({ fileName: file.name, contentType: file.type, fileSize: file.size });
    } catch (err: any) {
      const status = err?.status;
      if (status === 402) {
        setUploadError('Native video upload is on the paid Coach plan. YouTube and Vimeo links are always free.');
      } else {
        setUploadError(err?.message || 'Upload failed. Try again in a moment.');
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearUpload = () => {
    setUploadedStreamUid(null);
    setUploadedDuration(null);
    setUploadedMeta(null);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (tab === 'upload') {
        if (!uploadedStreamUid) throw new Error('missing-upload');
        const res = await createClip({
          teamId,
          source: 'upload',
          note: note.trim(),
          playerIds: effectivePlayerIds,
          streamUid: uploadedStreamUid,
          durationSeconds: uploadedDuration ?? undefined,
          fileName: uploadedMeta?.fileName,
          contentType: uploadedMeta?.contentType,
          fileSize: uploadedMeta?.fileSize,
        });
        onCreated?.({ clipId: res.clipId, autoArchivedCount: res.autoArchived?.length || 0 });
      } else {
        if (linkDetection.source === null) throw new Error('bad-link');
        const res = await createClip({
          teamId,
          source: linkDetection.source,
          note: note.trim(),
          playerIds: effectivePlayerIds,
          embedUrl: linkDetection.embedUrl,
        });
        onCreated?.({ clipId: res.clipId, autoArchivedCount: res.autoArchived?.length || 0 });
      }
      onClose();
    } catch (err: any) {
      const status = (err as any)?.status;
      if (status === 402) {
        setSubmitError('Native video upload is on the paid Coach plan. YouTube and Vimeo links are always free.');
      } else {
        setSubmitError(err?.message || 'Could not send the clip. Try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={submitting ? () => {} : onClose}
      kicker="Gametape"
      title={COPY.title}
      subtitle={COPY.subtitle}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-bold text-ink-secondary hover:text-ink-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-extrabold bg-brand-primary text-brand-primary-fg hover:bg-brand-primary-hov disabled:opacity-50"
          >
            {submitting ? COPY.postingButton : COPY.postButton}
          </button>
        </>
      }
    >
      <div className="space-y-5">

        {/* Target picker */}
        <section>
          <label className="text-xs font-extrabold uppercase tracking-widest text-ink-secondary">
            {COPY.targetLabel}
          </label>
          <p className="mt-1 text-xs text-ink-secondary/80">{COPY.targetHelper}</p>
          <div className="mt-2 grid grid-cols-3 gap-2" role="tablist" aria-label="Target audience">
            {(['single', 'group', 'team'] as TargetMode[]).map(mode => {
              const label = mode === 'single' ? COPY.targetSingle : mode === 'group' ? COPY.targetGroup : COPY.targetTeam;
              const active = targetMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleTargetModeChange(mode)}
                  className={`px-3 py-2 rounded-lg text-xs font-bold ring-1 transition-colors ${
                    active
                      ? 'bg-brand-primary text-brand-primary-fg ring-brand-primary'
                      : 'bg-surface-elevated text-ink-primary ring-line-default/20 hover:bg-line-default/10'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {targetMode !== 'team' ? (
            players.length === 0 ? (
              <div className="mt-3 rounded-lg bg-surface-elevated ring-1 ring-line-default/10 px-3 py-2 text-xs text-ink-secondary">
                {COPY.emptyRoster}
              </div>
            ) : (
              <div className="mt-3 max-h-52 overflow-y-auto pr-1">
                <ul className="space-y-1">
                  {players.map(p => {
                    const checked = selectedPlayerIds.includes(p.id);
                    const capReached = targetMode === 'group' && !checked && selectedPlayerIds.length >= 4;
                    return (
                      <li key={p.id}>
                        <label
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer ${
                            checked ? 'bg-brand-primary-soft' : 'hover:bg-line-default/10'
                          } ${capReached ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <input
                            type={targetMode === 'single' ? 'radio' : 'checkbox'}
                            name="gametape-target"
                            checked={checked}
                            disabled={capReached}
                            onChange={() => togglePlayer(p.id)}
                            className="accent-brand-primary"
                          />
                          <span className="text-sm text-ink-primary">{p.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {targetMode === 'group' ? (
                  <p className="mt-1 text-[11px] text-ink-secondary">Small groups top out at 4 players.</p>
                ) : null}
              </div>
            )
          ) : null}
        </section>

        {/* Source picker tabs */}
        <section>
          <div className="flex gap-2 border-b border-line-default/15">
            <button
              type="button"
              onClick={() => setTab('upload')}
              className={`px-3 pb-2 -mb-px text-xs font-bold uppercase tracking-widest border-b-2 ${
                tab === 'upload'
                  ? 'text-ink-primary border-brand-primary'
                  : 'text-ink-secondary border-transparent hover:text-ink-primary'
              }`}
            >
              {COPY.tabUpload}
            </button>
            <button
              type="button"
              onClick={() => setTab('link')}
              className={`px-3 pb-2 -mb-px text-xs font-bold uppercase tracking-widest border-b-2 ${
                tab === 'link'
                  ? 'text-ink-primary border-brand-primary'
                  : 'text-ink-secondary border-transparent hover:text-ink-primary'
              }`}
            >
              {COPY.tabLink}
            </button>
          </div>

          <div className="mt-3">
            {tab === 'upload' ? (
              uploadedStreamUid ? (
                <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-500/30 px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-extrabold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
                      Uploaded
                    </div>
                    <div className="text-[11px] text-emerald-700/80 dark:text-emerald-300/80 truncate">
                      {uploadedMeta?.fileName || 'Clip ready'}
                      {uploadedDuration ? ` · ${uploadedDuration}s` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={clearUpload}
                    className="text-[11px] font-bold text-rose-600 hover:text-rose-800"
                  >
                    Remove
                  </button>
                </div>
              ) : uploading ? (
                <div className="rounded-xl bg-brand-primary-soft ring-1 ring-brand-primary-soft p-3">
                  <div className="text-xs font-bold text-brand-primary-dim mb-2">
                    Uploading… {uploadProgress}%
                  </div>
                  <div className="h-1.5 rounded-full bg-brand-primary-soft overflow-hidden">
                    <div
                      className="h-full bg-brand-primary transition-[width] duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <label className="block">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFilePicked(file);
                    }}
                    className="block w-full text-xs text-ink-secondary file:mr-2 file:px-3 file:py-1.5 file:rounded file:ring-1 file:ring-line-default/20 file:bg-surface-elevated file:text-ink-primary file:font-bold file:hover:bg-line-default/10 file:cursor-pointer"
                  />
                  <p className="text-[11px] text-ink-secondary mt-1">{COPY.uploadHint}</p>
                </label>
              )
            ) : (
              <div>
                <input
                  type="url"
                  inputMode="url"
                  value={linkUrl}
                  onChange={(e) => { setLinkUrl(e.target.value); setLinkError(null); }}
                  onBlur={() => {
                    if (!linkUrl.trim()) return;
                    if (linkDetection.source === null) setLinkError(COPY.linkInvalid);
                  }}
                  placeholder={COPY.linkPlaceholder}
                  className="w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 text-sm text-ink-primary placeholder:text-ink-secondary/60 focus:outline-none focus:ring-brand-primary"
                />
                <p className="text-[11px] text-ink-secondary mt-1">{COPY.linkHint}</p>
                {linkError ? (
                  <p className="mt-1 text-[11px] text-rose-600">{linkError}</p>
                ) : null}
              </div>
            )}
            {uploadError ? (
              <div className="mt-2 rounded-lg bg-rose-50 dark:bg-rose-950/40 ring-1 ring-rose-500/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {uploadError}
              </div>
            ) : null}
          </div>
        </section>

        {/* Note */}
        <section>
          <label className="text-xs font-extrabold uppercase tracking-widest text-ink-secondary" htmlFor="gametape-note">
            Note
          </label>
          <textarea
            id="gametape-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            placeholder={COPY.notePlaceholder}
            rows={3}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 text-sm text-ink-primary placeholder:text-ink-secondary/60 focus:outline-none focus:ring-brand-primary resize-none"
          />
          <div className="mt-1 text-[11px] text-ink-secondary text-right">
            {note.length}/500
          </div>
        </section>

        {/* Inline cap heads-up — surfaced when we know the selection
             is at risk. Cheap to always show; the copy is warm and
             informational, not alarming. */}
        {targetMode !== 'team' && selectedPlayerIds.length > 0 ? (
          <p className="text-[11px] text-ink-secondary italic">{COPY.capWarningInline}</p>
        ) : null}

        {submitError ? (
          <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 ring-1 ring-rose-500/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {submitError}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
};

export default GametapeComposeModal;
