// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { doc, updateDoc, getDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import WidgetBridge from '../../utils/widgetBridge';

/**
 * Widget setup card. Generates and displays a long-lived widget
 * token that the user pastes into the iOS Player widget's edit
 * screen. Token is stored on users/{uid}.widgetToken and rotatable.
 *
 * No App Group / Capacitor plugin needed — the widget hits the
 * worker endpoint /widget/snapshot with the token as a bearer.
 * Trade-off: user has to copy a 24-char string once, instead of
 * the widget auto-discovering the account.
 */

function randomToken(): string {
  // 24 url-safe chars, ~140 bits. crypto.getRandomValues is
  // available in browsers + Capacitor WebView.
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  // base64url
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const WidgetSetupCard: React.FC = () => {
  const { userData, currentUser } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const uid = userData?.uid || currentUser?.uid;

  // Pushes the token into the native widget bridge so the home-screen
  // widget's configure activity (Android) can auto-pick it up and skip
  // the paste UI. Web/iOS fall back to no-op for now — iOS needs App
  // Group entitlements before its bridge can light up; users on iOS
  // copy/paste manually until that ships.
  const syncToNativeBridge = async (next: string) => {
    try { await WidgetBridge.setToken({ token: next }); }
    catch { /* fire-and-forget */ }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!uid) { setLoading(false); return; }
      try {
        // Trust userData first; fall back to a doc read if it
        // hasn't loaded the field yet (older sessions).
        if (typeof userData?.widgetToken === 'string') {
          if (!cancelled) {
            setToken(userData.widgetToken);
            setLoading(false);
            void syncToNativeBridge(userData.widgetToken);
          }
          return;
        }
        const snap = await getDoc(doc(db, 'users', uid));
        const t = snap.exists() ? (snap.data() as any).widgetToken : null;
        if (!cancelled) {
          setToken(typeof t === 'string' ? t : null);
          setLoading(false);
          if (typeof t === 'string' && t) void syncToNativeBridge(t);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, userData?.widgetToken]);

  const ensureToken = async () => {
    if (!uid || busy) return;
    setBusy(true);
    try {
      const t = randomToken();
      await updateDoc(doc(db, 'users', uid), { widgetToken: t });
      setToken(t);
      setShowInstructions(true);
      void syncToNativeBridge(t);
    } finally { setBusy(false); }
  };

  const rotate = async () => {
    if (!uid || busy) return;
    if (!window.confirm('Replace your current widget code? Your widget will stop working until you paste the new code in.')) return;
    setBusy(true);
    try {
      const t = randomToken();
      await updateDoc(doc(db, 'users', uid), { widgetToken: t });
      setToken(t);
      setCopied(false);
      void syncToNativeBridge(t);
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="bg-surface-elevated rounded-xl border border-line-default/10 p-4 text-ink-primary/50 text-sm">
        Loading widget setup...
      </div>
    );
  }

  return (
    <div className="bg-surface-elevated rounded-xl border border-line-default/10 overflow-hidden">
      <div className="p-4 border-b border-line-default/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-primary-soft flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-brand-primary">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-ink-primary font-bold text-base leading-tight">Home-screen widget</h3>
            <p className="text-ink-primary/55 text-xs leading-snug">Player photo, streak, and next event on your phone's home screen.</p>
          </div>
        </div>
      </div>

      {!token ? (
        <div className="p-4 space-y-3">
          <p className="text-ink-primary/70 text-sm leading-relaxed">
            Generate a one-time setup code, then paste it into the widget when you add it to your home screen.
          </p>
          <button
            type="button"
            onClick={ensureToken}
            disabled={busy}
            className="w-full px-4 py-2.5 rounded-lg bg-brand-primary text-brand-primary-fg font-bold text-sm disabled:opacity-60"
          >
            {busy ? 'Generating...' : 'Generate setup code'}
          </button>
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div>
            <p className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/45 mb-1.5">Your setup code</p>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 bg-surface-base border border-line-default/10 rounded-lg px-3 py-2.5 font-mono text-sm text-ink-primary break-all select-all">
                {token}
              </div>
              <button
                type="button"
                onClick={copy}
                className="px-3 rounded-lg bg-line-default/10 hover:bg-line-default/15 text-ink-primary font-bold text-xs flex-shrink-0"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowInstructions(s => !s)}
            className="text-brand-primary-soft text-xs font-bold tracking-wide hover:underline"
          >
            {showInstructions ? 'Hide setup steps' : 'How to add the widget'}
          </button>

          {showInstructions && (() => {
            // Platform-aware instructions. Detect via Capacitor's
            // platform string when available, else fall back to a
            // UA heuristic so the web preview still shows something
            // sensible. iOS and Android widget add-flows differ
            // enough that one set of instructions can't fit both.
            const cap = (window as any)?.Capacitor;
            const platform = cap?.getPlatform?.()
              || (/Android/i.test(navigator.userAgent || '') ? 'android' : 'ios');
            if (platform === 'android') {
              return (
                <ol className="text-ink-primary/65 text-xs leading-relaxed space-y-1.5 pl-4 list-decimal">
                  <li>On your Android home screen, long-press an empty area.</li>
                  <li>Tap <span className="text-ink-primary font-semibold">Widgets</span>.</li>
                  <li>Scroll to <span className="text-ink-primary font-semibold">GoalKickr</span> and drag the Player widget onto your home screen.</li>
                  <li>When the setup screen pops up, paste the code above into the <span className="text-ink-primary font-semibold">Setup code</span> field.</li>
                  <li>Tap <span className="text-ink-primary font-semibold">Save</span>.</li>
                </ol>
              );
            }
            return (
              <ol className="text-ink-primary/65 text-xs leading-relaxed space-y-1.5 pl-4 list-decimal">
                <li>On your iPhone home screen, long-press an empty area.</li>
                <li>Tap the <span className="text-ink-primary font-semibold">+</span> in the top-left.</li>
                <li>Search for <span className="text-ink-primary font-semibold">GoalKickr</span> and add the Player widget.</li>
                <li>Long-press the new widget, tap <span className="text-ink-primary font-semibold">Edit Widget</span>.</li>
                <li>Paste the code above into the <span className="text-ink-primary font-semibold">Setup code</span> field.</li>
              </ol>
            );
          })()}

          <button
            type="button"
            onClick={rotate}
            disabled={busy}
            className="text-ink-primary/45 hover:text-ink-primary text-xs underline disabled:opacity-50"
          >
            Replace setup code
          </button>
        </div>
      )}
    </div>
  );
};

export default WidgetSetupCard;
