// useDismissible — one shared "hide this card for X days" hook that
// backs every dismissable dashboard tile, banner, and prompt. Replaces
// five bespoke localStorage cooldowns that had drifted apart. Design
// contract lives in wf_9b73e9eb-ded-2 (2026-07-16); notable choices:
//
//   - Storage: single localStorage key `gk.dismissedCards` holding a
//     record of `{ snoozeUntilMs, snoozedAtMs }` per canonical key.
//     No Firestore round-trip. Dismisses do not need cross-device sync.
//   - Snooze: `snoozeDays` (default 7) is CALENDAR days in Mountain
//     Time (Patrick lives in southern Utah) so "hide for a week" always
//     expires at local midnight, not 3:47pm on the following Tuesday.
//   - GameDay cards pass `snoozeUntilEventDate` and get event-scoped
//     hiding: the entry expires `event.date + 3h` and a new eventId
//     mints a fresh entry automatically.
//   - Legacy: existing bespoke keys are read as a fallback so no
//     user mid-cooldown sees a card re-surface. Legacy keys are never
//     written and never deleted (a stale bundle in another WebView
//     could race with the cleanup).
//   - Prune: on every read, entries whose snooze has expired are
//     dropped and the map is rewritten.
//
// The Settings screen has a "Hidden dashboard cards" section that
// reads the same map and offers a per-entry "Show now" button. The
// hook emits a `gk:dismissed-cards-changed` window event on every
// write so Settings can update without prop drilling.

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'gk.dismissedCards';
const CHANGE_EVENT = 'gk:dismissed-cards-changed';
const TIME_ZONE = 'America/Denver';

export interface DismissedEntry {
  /** Epoch ms at which this dismiss expires. */
  snoozeUntilMs: number;
  /** Epoch ms at which the dismiss was recorded. */
  snoozedAtMs: number;
}

export type DismissedMap = Record<string, DismissedEntry>;

export interface UseDismissibleOptions {
  /** Calendar days to hide the card. Default 7. Interpreted as
   *  local-midnight in Mountain Time (see TIME_ZONE). Ignored when
   *  snoozeUntilEventDate is provided. */
  snoozeDays?: number;
  /** GameDay-style per-event snooze: entry expires eventDate + 3h. */
  snoozeUntilEventDate?: Date | null;
  /** Legacy read: either an old localStorage key holding an ISO/ms
   *  timestamp with an implicit cooldown, or a predicate returning
   *  `true` when the card should still be considered dismissed under
   *  legacy semantics. Never written to. */
  legacyKey?: string | (() => boolean);
  /** Legacy cooldown in ms — only used when `legacyKey` is a string.
   *  Callers should always pass this so the fallback window is
   *  explicit. */
  legacyCooldownMs?: number;
  /** Auto-un-dismiss: when this value changes (deep-equal via
   *  JSON.stringify since values are small ids), the entry for `key`
   *  is deleted so the card re-surfaces. Use for e.g. Player Circle
   *  where a new parentId means a fresh event worth showing. */
  autoUnDismissWhen?: unknown;
}

export interface UseDismissibleReturn {
  dismissed: boolean;
  dismiss: () => void;
  /** Removes the entry for this key from the map, re-surfacing the
   *  card immediately. Wired up by Settings' "Show now" button. */
  unhide: () => void;
  /** Epoch ms of current snooze (or null when not dismissed). */
  snoozeUntilMs: number | null;
}

// In-memory fallback when localStorage is unavailable (quota exceeded,
// private browsing, SSR). Loses on reload — acceptable degradation.
let memoryMap: DismissedMap | null = null;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function readRaw(): DismissedMap {
  if (memoryMap) return memoryMap;
  if (!hasWindow()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as DismissedMap;
  } catch {
    return {};
  }
}

function writeRaw(map: DismissedMap): void {
  if (!hasWindow()) {
    memoryMap = map;
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    memoryMap = null;
  } catch (err) {
    // Quota / disabled storage — keep the session going in memory so
    // the current tab still respects dismisses.
    console.warn('[useDismissible] localStorage write failed, using memory fallback', err);
    memoryMap = map;
  }
}

function emitChange(): void {
  if (!hasWindow()) return;
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* noop */ }
}

/** Return the map with expired entries pruned. Writes back if any
 *  entries were removed. Exported for Settings to reuse without
 *  duplicating the prune contract. */
export function readAndPruneDismissedMap(): DismissedMap {
  const map = readRaw();
  const now = Date.now();
  const kept: DismissedMap = {};
  let pruned = false;
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (entry && typeof entry.snoozeUntilMs === 'number' && entry.snoozeUntilMs > now) {
      kept[key] = entry;
    } else {
      pruned = true;
    }
  }
  if (pruned) writeRaw(kept);
  return kept;
}

/** Compute local-midnight-in-Mountain-Time N days from now, then
 *  return that instant in epoch ms. Uses Intl.DateTimeFormat to pull
 *  the target day's Denver calendar date + short-offset so we stay
 *  correct across DST transitions. */
export function startOfDayAfterDaysMs(days: number, from: Date = new Date()): number {
  const shifted = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dayFmt.formatToParts(shifted);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  // Guess midnight-UTC of that Y-M-D so we can look up Denver's
  // offset for that instant. Then subtract the offset to land on
  // Denver-midnight in real UTC ms.
  const guessMidnightUtc = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime();
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'shortOffset',
  });
  const tzPart = offsetFmt.formatToParts(new Date(guessMidnightUtc))
    .find(p => p.type === 'timeZoneName')?.value || 'GMT-7';
  const m2 = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzPart);
  let offsetMin = 0;
  if (m2) {
    const sign = m2[1] === '-' ? -1 : 1;
    offsetMin = sign * (parseInt(m2[2], 10) * 60 + (m2[3] ? parseInt(m2[3], 10) : 0));
  }
  return guessMidnightUtc - offsetMin * 60_000;
}

function computeSnoozeUntilMs(opts: UseDismissibleOptions | undefined): number {
  if (opts?.snoozeUntilEventDate instanceof Date && !Number.isNaN(opts.snoozeUntilEventDate.getTime())) {
    // Grace of 3h past kickoff for late-running matches; the card's
    // own render gate will typically have closed by then anyway.
    return opts.snoozeUntilEventDate.getTime() + 3 * 60 * 60 * 1000;
  }
  const days = typeof opts?.snoozeDays === 'number' ? opts.snoozeDays : 7;
  return startOfDayAfterDaysMs(days);
}

function legacySaysDismissed(opts: UseDismissibleOptions | undefined): boolean {
  const lk = opts?.legacyKey;
  if (!lk) return false;
  if (typeof lk === 'function') {
    try { return !!lk(); } catch { return false; }
  }
  if (!hasWindow()) return false;
  try {
    const raw = window.localStorage.getItem(lk);
    if (!raw) return false;
    const asNum = Number(raw);
    const ms = Number.isFinite(asNum) && asNum > 0 ? asNum : Date.parse(raw);
    if (!ms || Number.isNaN(ms)) return false;
    const cooldown = opts?.legacyCooldownMs;
    if (typeof cooldown !== 'number' || cooldown <= 0) {
      // No cooldown supplied — treat presence as "dismissed" only if
      // within the last 30 days. Defensive default; callers should
      // always pass legacyCooldownMs.
      return Date.now() - ms < 30 * 24 * 60 * 60 * 1000;
    }
    return Date.now() - ms < cooldown;
  } catch {
    return false;
  }
}

export function useDismissible(
  key: string | null | undefined,
  opts?: UseDismissibleOptions,
): UseDismissibleReturn {
  // Force re-reads on writes or on cross-component change events
  // without making every consumer duplicate the subscription.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    if (!hasWindow()) return;
    const handler = () => bump();
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [bump]);

  // Auto-un-dismiss: if the dep changed since last render, drop this
  // key from the map before we compute `dismissed`. Uses a ref so we
  // only act on genuine changes, not initial mount.
  const lastAutoRef = useRef<string | undefined>(undefined);
  const autoSig = opts?.autoUnDismissWhen !== undefined
    ? JSON.stringify(opts.autoUnDismissWhen)
    : undefined;
  useEffect(() => {
    if (autoSig === undefined) return;
    if (lastAutoRef.current === undefined) {
      lastAutoRef.current = autoSig;
      return;
    }
    if (lastAutoRef.current !== autoSig) {
      lastAutoRef.current = autoSig;
      if (key) {
        const map = readAndPruneDismissedMap();
        if (map[key]) {
          const next = { ...map };
          delete next[key];
          writeRaw(next);
          emitChange();
          bump();
        }
      }
    }
  }, [autoSig, key, bump]);

  // Silence "unused" for the version state — its role is to trigger
  // re-render when the map changes.
  void version;

  // Empty key = no-op / never dismissed. Defensive against half-loaded
  // contexts (selectedTeamId not yet resolved, etc.).
  if (!key) {
    return {
      dismissed: false,
      dismiss: () => { /* no-op */ },
      unhide: () => { /* no-op */ },
      snoozeUntilMs: null,
    };
  }

  const map = readAndPruneDismissedMap();
  const entry = map[key];
  const dismissedByMap = !!entry && entry.snoozeUntilMs > Date.now();
  const dismissedByLegacy = !dismissedByMap && legacySaysDismissed(opts);
  const dismissed = dismissedByMap || dismissedByLegacy;

  const dismiss = () => {
    const now = Date.now();
    const snoozeUntilMs = computeSnoozeUntilMs(opts);
    const current = readAndPruneDismissedMap();
    current[key] = { snoozeUntilMs, snoozedAtMs: now };
    writeRaw(current);
    emitChange();
    bump();
  };

  const unhide = () => {
    const current = readAndPruneDismissedMap();
    if (current[key]) {
      const next = { ...current };
      delete next[key];
      writeRaw(next);
      emitChange();
      bump();
    }
  };

  return {
    dismissed,
    dismiss,
    unhide,
    snoozeUntilMs: entry?.snoozeUntilMs ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Registry — Settings uses this to render a friendly name for each
// hidden entry. Key format is `<prefix>:<segment>:<segment>…`; the
// prefix (first colon-slice) is the lookup key.
// ─────────────────────────────────────────────────────────────────────

export interface DismissibleRegistryEntry {
  /** Friendly base name (fallback when we can't personalize). */
  label: string;
  /** Optional label builder given the remaining key segments. */
  labelWithParts?: (parts: string[]) => string;
}

export const DISMISSIBLE_CARD_LABELS: Record<string, DismissibleRegistryEntry> = {
  playerCircle: {
    label: 'Player Circle nudge',
  },
  gettingStarted: {
    label: 'Getting Started checklist',
  },
  coachTonight: {
    label: "Tonight's game prep",
  },
  gameDayPrompt: {
    label: 'Game-day tips',
  },
  subscribeBanner: {
    label: 'Subscription reminder',
  },
  snackAssignment: {
    label: 'Snack assignment reminder',
  },
  notificationsBanner: {
    label: 'Turn on notifications',
  },
};

/** Look up a friendly label for a stored key. Returns the registry
 *  entry's `label` (or `labelWithParts(rest)` when defined), or the
 *  raw key when unknown. */
export function labelForDismissibleKey(key: string): string {
  const idx = key.indexOf(':');
  const prefix = idx >= 0 ? key.slice(0, idx) : key;
  const rest = idx >= 0 ? key.slice(idx + 1).split(':') : [];
  const entry = DISMISSIBLE_CARD_LABELS[prefix];
  if (!entry) return key;
  if (entry.labelWithParts) {
    try { return entry.labelWithParts(rest); } catch { return entry.label; }
  }
  return entry.label;
}

export const DISMISSED_CARDS_CHANGE_EVENT = CHANGE_EVENT;
