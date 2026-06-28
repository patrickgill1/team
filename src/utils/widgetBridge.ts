import { registerPlugin } from '@capacitor/core';

/**
 * Native bridge to the home-screen widget's shared storage. When
 * the React app generates / rotates the widget token, calling
 * WidgetBridge.setToken pushes the value into a SharedPreferences
 * slot (Android) that the widget's configure activity reads on
 * widget-add. The user never has to copy or paste the code.
 *
 * iOS implementation isn't wired yet — requires App Group
 * entitlements + a Swift plugin counterpart. Until then iOS users
 * still copy/paste from Settings -> Widget. The web fallback
 * below is a no-op so the call site can be platform-agnostic
 * without crashing in browser previews.
 */

export interface WidgetBridgePlugin {
  setToken(options: { token: string }): Promise<void>;
  getToken(): Promise<{ token: string }>;
  clearToken(): Promise<void>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge', {
  web: () => ({
    setToken: async () => {},
    getToken: async () => ({ token: '' }),
    clearToken: async () => {},
  }),
});

export default WidgetBridge;

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
    try { await WidgetBridge.setToken({ token: existingToken }); }
    catch { /* native bridge may not exist on web; silent ok */ }
    return;
  }

  if (inflightGen.has(uid)) return;
  inflightGen.add(uid);
  try {
    const t = randomWidgetToken();
    await writeFirestore(uid, t);
    try { await WidgetBridge.setToken({ token: t }); } catch { /* ignore */ }
  } catch {
    /* leave the user without a token; next session will retry */
  } finally {
    inflightGen.delete(uid);
  }
}
