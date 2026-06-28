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
