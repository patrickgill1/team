import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import WidgetBridge from './widgetBridge';

export type WatchGameStatus = 'scheduled' | 'live' | 'halftime' | 'final';
export type WatchGameActionType =
  | 'ourGoal'
  | 'oppGoal'
  | 'ourGoalMinus'
  | 'oppGoalMinus'
  | 'undoLast'
  | 'subMade'
  | 'startClock'
  | 'pauseClock'
  | 'recordStat'   // Watch stat picker → phone attributes to a player
  | 'endPeriod'    // Overflow: advance period (1st → 2nd → OT)
  | 'toggleBell';  // Overflow: silence / re-enable shift bell

// Stat kinds accepted by the recordStat action. Match the
// TimelineEntry.kind values so the phone side can dispatch
// directly into addTimelineEntry.
export type WatchStatKind = 'goal' | 'assist' | 'save' | 'yellow' | 'red';

export interface WatchGamePlayerSummary {
  id: string;
  name: string;
  jerseyNumber?: number | null;
}

export interface WatchGameSession {
  eventId: string;
  teamId?: string | null;
  homeName: string;
  opponentName: string;
  ourScore: number;
  oppScore: number;
  status: WatchGameStatus;
  period?: 1 | 2 | 'OT' | null;
  clockOffsetSeconds: number;
  clockStartedAtMs?: number | null;
  shiftSeconds?: number | null;
  lastBellAtSec?: number | null;
  bellEnabled?: boolean;
  suggestedNextPlayer?: WatchGamePlayerSummary | null;
  // Bench roster, ordered least-minutes-first so the Watch picker
  // surfaces players who need time at the top of the list. Keeps the
  // scroll to a minimum for the coach's most likely pick.
  bench?: WatchGamePlayerSummary[];
  // Full roster (on-field + bench), used by the stat picker so a
  // coach can attribute a goal/assist/save to any active player
  // regardless of whether they use the sub tracker. Ordered by
  // jersey number ascending so it's predictable for coaches who've
  // memorized their kids' numbers.
  roster?: WatchGamePlayerSummary[];
  updatedAt: number;
}

export interface WatchGameAction {
  id?: string;
  eventId?: string;
  action: WatchGameActionType;
  // Present on 'subMade' actions (bench player coming IN) and
  // 'recordStat' actions (player being credited). Phone side reads
  // this to attribute the action.
  playerId?: string;
  // Only on 'recordStat' — which kind of stat to record. Maps to
  // TimelineEntry.kind on the phone side.
  stat?: WatchStatKind;
  receivedAt?: number;
}

type NativeWatchBridge = typeof WidgetBridge & {
  setGameSession(options: { session: WatchGameSession }): Promise<void>;
  clearGameSession(): Promise<void>;
  drainWatchGameActions(): Promise<{ actions: WatchGameAction[] }>;
  addListener(eventName: 'watchGameAction', listenerFunc: (action: WatchGameAction) => void): Promise<PluginListenerHandle>;
};

const nativeBridge = WidgetBridge as NativeWatchBridge;

function isWatchBridgeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

export interface WatchPublishResult {
  // Native platform is iOS and the plugin method exists. False on
  // Android, in the browser, or when the bundle predates the plugin.
  bridgeReady: boolean;
  // WCSession available (paired Watch companion installed).
  available?: boolean;
  // Watch is running and receiving now. When false the payload was
  // still queued via updateApplicationContext and will apply on the
  // Watch's next foreground.
  reachable?: boolean;
  // Present on failure so callers can surface the error.
  error?: string;
}

export async function publishWatchGameSession(session: WatchGameSession): Promise<WatchPublishResult> {
  if (!isWatchBridgeAvailable()) return { bridgeReady: false };
  if (typeof nativeBridge.setGameSession !== 'function') return { bridgeReady: false };
  try {
    const raw: any = await nativeBridge.setGameSession({ session });
    return {
      bridgeReady: true,
      available: typeof raw?.available === 'boolean' ? raw.available : undefined,
      reachable: typeof raw?.reachable === 'boolean' ? raw.reachable : undefined,
    };
  } catch (err: any) {
    return { bridgeReady: true, error: err?.message || String(err) };
  }
}

export async function clearWatchGameSession(): Promise<void> {
  if (!isWatchBridgeAvailable()) return;
  if (typeof nativeBridge.clearGameSession !== 'function') return;
  await nativeBridge.clearGameSession().catch(() => undefined);
}

export async function drainWatchGameActions(): Promise<WatchGameAction[]> {
  if (!isWatchBridgeAvailable()) return [];
  if (typeof nativeBridge.drainWatchGameActions !== 'function') return [];
  const result = await nativeBridge.drainWatchGameActions().catch(() => ({ actions: [] }));
  return Array.isArray(result.actions) ? result.actions : [];
}

export async function addWatchGameActionListener(listener: (action: WatchGameAction) => void): Promise<PluginListenerHandle | null> {
  if (!isWatchBridgeAvailable()) return null;
  return nativeBridge.addListener('watchGameAction', listener).catch(() => null);
}
