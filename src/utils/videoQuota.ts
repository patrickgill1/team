// Video storage quota — Phase 1 (metering + free-tier enforcement).
//
// Tier limits live HERE so every upload-site uses the same numbers
// and a future price change is a one-line edit. Phase 2 will wire
// Stripe to flip team.videoTier between 'free' / 'addon' / 'pro'.
//
// Today every team is effectively on 'free' until the Stripe SKUs
// ship and the worker webhook starts setting the field.

import { doc, getDoc, increment, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { Team } from '../types';

export const TIER_LIMITS = {
  free: {
    label: 'Free',
    maxClips: 20,
    maxClipSeconds: 60,
    maxMinutesStored: Infinity, // not separately enforced — clip count + 60s cap is plenty
  },
  addon: {
    label: 'Highlights+',
    priceLabel: '$10/mo',
    maxClips: Infinity,
    maxClipSeconds: 60,
    maxMinutesStored: Infinity,
  },
  pro: {
    label: 'Full Game Film',
    priceLabel: '$29.99/mo',
    maxClips: Infinity,
    maxClipSeconds: Infinity,
    maxMinutesStored: 100 * 60, // 100 hours
  },
} as const;

export type VideoTier = keyof typeof TIER_LIMITS;

export function getTierFor(team: Pick<Team, 'videoTier'> | null | undefined): VideoTier {
  const t = team?.videoTier;
  if (t === 'addon' || t === 'pro') return t;
  return 'free';
}

/** Full-game file uploads are only unlocked on the `pro` tier — the
 *  economics don't work at free or $10/mo when a 90-min game is
 *  hundreds of MB to a few GB of Cloudflare Stream storage per team.
 *  Free + addon teams get the YouTube-link path only.
 *
 *  Existing full games uploaded before this gate landed keep playing
 *  fine (nothing here nukes the R2 doc); the gate only fires on new
 *  uploads / replacements. */
export function canUploadFullGameFile(team: Pick<Team, 'videoTier'> | null | undefined): boolean {
  return getTierFor(team) === 'pro';
}

export interface QuotaCheck {
  allowed: boolean;
  reason?: 'count' | 'duration' | 'storage';
  tier: VideoTier;
  // Human-facing strings the upgrade modal can render directly.
  currentLabel?: string;
  limitLabel?: string;
  ctaLabel?: string;
}

/**
 * Pre-upload check. Reads the team doc to get the current tier +
 * counters, then validates the proposed clip against the tier's
 * caps. Pass durationSeconds when known client-side (probed via
 * HTMLVideoElement); skip the duration arg to only check count /
 * storage.
 */
export async function checkUploadQuota(
  teamId: string,
  opts: { durationSeconds?: number } = {},
): Promise<QuotaCheck> {
  let team: Team | null = null;
  try {
    const snap = await getDoc(doc(db, 'teams', teamId));
    if (snap.exists()) team = { id: snap.id, ...(snap.data() as any) } as Team;
  } catch {
    // Fail open on read errors — better to let the upload through
    // than to block legitimate use because of a transient blip.
    return { allowed: true, tier: 'free' };
  }
  const tier = getTierFor(team);
  const limits = TIER_LIMITS[tier];

  // 1) Clip-count cap
  const clipCount = team?.videoClipCount || 0;
  if (clipCount >= limits.maxClips) {
    return {
      allowed: false,
      reason: 'count',
      tier,
      currentLabel: `${clipCount} of ${limits.maxClips} clips`,
      limitLabel: `${limits.maxClips} clip max`,
      ctaLabel: tier === 'free' ? 'Upgrade to Highlights+ for unlimited clips' : 'Storage full',
    };
  }

  // 2) Per-clip duration cap (only when we know the duration)
  if (typeof opts.durationSeconds === 'number' && Number.isFinite(opts.durationSeconds)) {
    if (opts.durationSeconds > limits.maxClipSeconds) {
      return {
        allowed: false,
        reason: 'duration',
        tier,
        currentLabel: `${Math.round(opts.durationSeconds)}s`,
        limitLabel: `${limits.maxClipSeconds}s max per clip`,
        ctaLabel: tier === 'pro' ? 'Storage full' : 'Upgrade to Full Game Film for longer clips',
      };
    }
  }

  // 3) Total minutes stored cap (Tier 2 only — others are Infinity)
  const minutes = team?.videoMinutesStored || 0;
  const proposedMinutes = (opts.durationSeconds || 60) / 60;
  if (minutes + proposedMinutes > limits.maxMinutesStored) {
    return {
      allowed: false,
      reason: 'storage',
      tier,
      currentLabel: `${(minutes / 60).toFixed(1)} of ${(limits.maxMinutesStored / 60).toFixed(0)} hours`,
      limitLabel: `${(limits.maxMinutesStored / 60).toFixed(0)} hour storage cap`,
      ctaLabel: 'Delete an old clip to free up space',
    };
  }

  return { allowed: true, tier };
}

/**
 * Probe a video file's duration client-side. Used before the upload
 * starts so we can reject over-cap clips without burning bandwidth.
 * Returns null on probe failure — caller should treat as unknown
 * and either skip the duration check or fail closed depending on
 * context.
 */
export function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        const seconds = Number.isFinite(video.duration) ? video.duration : null;
        URL.revokeObjectURL(url);
        resolve(seconds);
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      video.src = url;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Post-upload counter bump. Run after Stream confirms upload + the
 * UID is in hand. durationSeconds comes from the probe (best) or
 * the Stream metadata webhook (eventual). Failures here are non-
 * fatal — the clip still works, the counter is just inaccurate.
 */
export async function incrementTeamVideoUsage(teamId: string, durationSeconds: number | null): Promise<void> {
  try {
    await updateDoc(doc(db, 'teams', teamId), {
      videoClipCount: increment(1),
      videoMinutesStored: increment((typeof durationSeconds === 'number' && durationSeconds > 0 ? durationSeconds : 0) / 60),
    });
  } catch (err) {
    console.warn('[videoQuota] increment failed', err);
  }
}

/**
 * Post-delete counter decrement. Mirror of incrementTeamVideoUsage:
 * atomic increment(-n) so simultaneous deletes don't clobber each
 * other. A theoretical negative counter is harmless (converges as
 * new videos land).
 */
export async function decrementTeamVideoUsage(teamId: string, durationSeconds: number | null): Promise<void> {
  try {
    const minutes = typeof durationSeconds === 'number' && durationSeconds > 0 ? durationSeconds / 60 : 0;
    await updateDoc(doc(db, 'teams', teamId), {
      videoClipCount: increment(-1),
      videoMinutesStored: increment(-minutes),
    });
  } catch (err) {
    console.warn('[videoQuota] decrement failed', err);
  }
}
