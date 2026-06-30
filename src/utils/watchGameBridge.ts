import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import WidgetBridge from './widgetBridge';

export type WatchGameStatus = 'scheduled' | 'live' | 'halftime' | 'final';
export type WatchGameActionType = 'ourGoal' | 'oppGoal' | 'undoLast' | 'subMade' | 'startClock' | 'pauseClock';

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
  updatedAt: number;
}

export interface WatchGameAction {
  id?: string;
  eventId?: string;
  action: WatchGameActionType;
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

export async function publishWatchGameSession(session: WatchGameSession): Promise<void> {
  if (!isWatchBridgeAvailable()) return;
  if (typeof nativeBridge.setGameSession !== 'function') return;
  await nativeBridge.setGameSession({ session }).catch(() => undefined);
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
