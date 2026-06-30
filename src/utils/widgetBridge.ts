import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Native bridge to the home-screen widget's shared storage. When
 * the React app generates / rotates the widget token, calling
 * WidgetBridge.setToken pushes the value into a SharedPreferences
 * slot (Android) that the widget's configure activity reads on
 * widget-add. The user never has to copy or paste the code.
 *
 * iOS writes the same value into the app group's UserDefaults via
 * WidgetBridgePlugin.swift so the WidgetKit extension can read it.
 * The web fallback below is a no-op so the call site can be
 * platform-agnostic without crashing in browser previews.
 */

export interface WidgetBridgePlugin {
  setToken(options: { token: string }): Promise<void>;
  getToken(): Promise<{ token: string }>;
  clearToken(): Promise<void>;
  setGameSession?(options: { session: unknown }): Promise<void>;
  clearGameSession?(): Promise<void>;
  drainWatchGameActions?(): Promise<{ actions: unknown[] }>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge', {
  web: () => ({
    setToken: async () => {},
    getToken: async () => ({ token: '' }),
    clearToken: async () => {},
    setGameSession: async () => {},
    clearGameSession: async () => {},
    drainWatchGameActions: async () => ({ actions: [] }),
  }),
});

export default WidgetBridge;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function syncWidgetTokenToNative(token: string, attempts = 3): Promise<{ ok: boolean; skipped?: boolean; readback?: string; error?: string }> {
  if (!token) return { ok: false, error: 'missing-token' };
  if (!Capacitor.isNativePlatform()) return { ok: true, skipped: true };

  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      await WidgetBridge.setToken({ token });
      const readback = await WidgetBridge.getToken().catch(() => ({ token: '' }));
      if (readback.token === token) return { ok: true, readback: readback.token };
      lastError = readback.token ? 'readback-mismatch' : 'readback-empty';
    } catch (err: any) {
      lastError = String(err?.message || err || 'bridge-error');
    }
    if (i < attempts - 1) await delay(350 * (i + 1));
  }
  return { ok: false, error: lastError || 'bridge-failed' };
}

// 24 url-safe chars, ~140 bits of entropy. Used as the per-user
// long-lived widget token. crypto.getRandomValues is available in
// browsers + Capacitor WebView.
export function randomWidgetToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Bootstrap call fired from AppLayoutShell whenever userData
// updates. Two cases:
//  1. Token already exists on the user doc → push it to the native
//     App Group container so the widget can read it on next refresh.
//  2. Token missing → mint one, write to Firestore, push to bridge.
// Idempotent — safe to call on every render. Uses a module-level
// inflight set keyed by uid to dedupe concurrent generation attempts
// (e.g. two AppLayoutShell mounts during auth flicker).
const inflightGen = new Set<string>();

export async function bootstrapWidgetToken(opts: {
  uid?: string | null;
  existingToken?: string | null;
  writeFirestore: (uid: string, token: string) => Promise<void>;
}): Promise<void> {
  const { uid, existingToken, writeFirestore } = opts;
  if (!uid) return;

  if (existingToken && typeof existingToken === 'string') {
    await syncWidgetTokenToNative(existingToken).catch(() => null);
    return;
  }

  if (inflightGen.has(uid)) return;
  inflightGen.add(uid);
  try {
    const t = randomWidgetToken();
    await writeFirestore(uid, t);
    await syncWidgetTokenToNative(t).catch(() => null);
  } catch {
    /* leave the user without a token; next session will retry */
  } finally {
    inflightGen.delete(uid);
  }
}
