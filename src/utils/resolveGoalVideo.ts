// resolveGoalVideo — pure lookup that returns the CURRENT video for a
// development goal by looking through the team's live drill index
// first, and falling back to whatever snapshot was copied onto the
// goal at import time.
//
// Extracted from PlayerDevelopment.tsx (previously a local arrow
// constant closing over `drillsById` state) so the kid-facing
// InlineDevPlanCard can reuse the same resolution logic. Both call
// sites must agree: if the coach re-uploads to a drill, the plan
// goal shows the new video immediately without re-importing.
//
// Priority:
//   1) Source drill by explicit drillId reference on the goal.
//   2) Source drill by NORMALIZED title match (trim + lowercase +
//      collapse whitespace), but only if EXACTLY one drill matches so
//      an ambiguous title never picks the wrong video.
//   3) The goal's own snapshot streamUid / streamReady — fallback for
//      orphaned goals (drill deleted, or pre-drillId legacy imports
//      with no clean title match).
//
// Pure: no React hooks, no async work, no side effects. Safe to call
// per-render from any component that already holds a drills map.

import type { DevelopmentGoal, Drill } from '../types';

export interface ResolvedGoalVideo {
  streamUid?: string;
  streamReady?: boolean;
  /** Id of the source drill when the video resolved from the live drill
   *  index. Absent when we fell through to the goal's own snapshot —
   *  snapshot fields don't map back to a drill doc to cache against. */
  sourceDrillId?: string;
  /** Cached MP4 download URL from Cloudflare Stream, if the source
   *  drill has one persisted. Optional additive field; older drill docs
   *  won't have it until the first Share tap resolves + writes it back.
   *  Consumers use it to hand a direct-play MP4 to native share sheets
   *  (iMessage, WhatsApp) without a network round trip. */
  streamMp4Url?: string;
}

const normalizeTitle = (s: string): string =>
  (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function resolveGoalVideo(
  goal: DevelopmentGoal,
  drillsById: Record<string, Drill>,
): ResolvedGoalVideo {
  const drillId = (goal as any).drillId as string | undefined;
  let drill: Drill | undefined = drillId ? drillsById[drillId] : undefined;

  if (!drill) {
    const goalKey = normalizeTitle(goal.title);
    if (goalKey) {
      const titleMatches = Object.values(drillsById).filter(
        (d) => normalizeTitle(d.title) === goalKey,
      );
      if (titleMatches.length === 1) drill = titleMatches[0];
    }
  }

  if (drill?.streamUid) {
    return {
      streamUid: drill.streamUid,
      streamReady: drill.streamReady,
      sourceDrillId: drill.id,
      streamMp4Url: (drill as any).streamMp4Url,
    };
  }

  return {
    streamUid: (goal as any).streamUid,
    streamReady: (goal as any).streamReady,
  };
}
