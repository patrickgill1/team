import React, { useEffect, useState } from 'react';

/**
 * Top-of-page banner urging mobile-web users to download the native
 * Fire FC app. iOS Safari already shows Apple's native Smart App
 * Banner from the meta tag in index.html — so on iOS this is a
 * fallback for non-Safari browsers and a richer prompt with our
 * branding. On Android we drive the install ourselves (Google's
 * native PWA banner doesn't link to the Play Store).
 *
 * Hidden when:
 *   - Running inside the Capacitor native app (already installed)
 *   - User dismissed it (stored in localStorage)
 *   - Desktop / large viewport (not an "install the app" moment)
 */
const STORAGE_KEY = 'firefc.installBannerDismissedAt';
const DISMISS_REMINDER_MS = 1000 * 60 * 60 * 24 * 14;  // 14 days after an X-out
// The web can't detect whether the native iOS app is installed, so once
// someone taps Install we assume they did and back off much longer
// rather than nagging them on every web visit.
const INSTALLED_SNOOZE_MS = 1000 * 60 * 60 * 24 * 180; // ~6 months after tapping Install

// Fire FC on the App Store (Apple ID 6770324158).
const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';

const isCapacitor = () => {
  if (typeof window === 'undefined') return false;
  // Capacitor exposes window.Capacitor inside the WKWebView / Android
  // shell. On the web bundle this is undefined.
  return !!(window as any).Capacitor?.isNativePlatform?.();
};

type Platform = 'ios' | 'android' | null;
const detectPlatform = (): Platform => {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream) return 'ios';
  // Android detection works fine, but we don't surface a CTA until the
  // Android app actually ships on the Play Store — see the gate in the
  // render path below. Detected here so we can light it up easily once
  // the Play listing is live.
  if (/android/i.test(ua)) return 'android';
  return null;
};

// IOS_STORE_LIVE: on — Fire FC is live on the App Store.
// ANDROID_STORE_LIVE: set to true after the Play Store listing is live.
const IOS_STORE_LIVE = true;
const ANDROID_STORE_LIVE = false;

const InstallAppBanner: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>(null);

  useEffect(() => {
    if (isCapacitor()) return;                       // already in the app
    const detected = detectPlatform();
    if (!detected) return;                           // desktop / unknown
    if (typeof window === 'undefined') return;
    if (window.innerWidth >= 768) return;            // not a phone screen

    // Stored value is the epoch-ms the banner should stay hidden UNTIL.
    // An X-out sets ~14 days; tapping Install sets ~6 months.
    const snoozeUntil = Number(localStorage.getItem(STORAGE_KEY) || 0);
    if (snoozeUntil && Date.now() < snoozeUntil) return;

    // Skip Android until the Play listing exists. Android users on the
    // web today get the full PWA-ish experience; nagging them to "install
    // the app" when there isn't one to install is worse than no banner.
    if (detected === 'android' && !ANDROID_STORE_LIVE) return;
    if (detected === 'ios' && !IOS_STORE_LIVE) return;

    setPlatform(detected);
    setVisible(true);
  }, []);

  const snooze = (ms: number) => {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now() + ms)); } catch { /* ignore */ }
    setVisible(false);
  };
  const dismiss = () => snooze(DISMISS_REMINDER_MS);
  const onInstall = () => snooze(INSTALLED_SNOOZE_MS); // they're likely installing now

  const installUrl = platform === 'ios' ? APP_STORE_URL : PLAY_STORE_URL;
  const storeLabel = platform === 'ios' ? 'App Store' : 'Google Play';

  if (!visible || !platform) return null;

  return (
    <div className="lg:hidden bg-gradient-to-r from-cyan-600 to-navy-700 text-white shadow">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center gap-3">
        <img
          src="/images/logo.png"
          alt="Fire FC"
          className="w-9 h-9 rounded-xl bg-white/10 ring-1 ring-white/20 p-1 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-tight truncate">Get the Fire FC app</p>
          <p className="text-[11px] text-white/80 leading-tight truncate">
            Push notifications, faster, works offline.
          </p>
        </div>
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onInstall}
          className="shrink-0 inline-flex items-center gap-1.5 bg-white text-navy-800 text-xs font-bold px-3 py-1.5 rounded-full hover:bg-white/90 transition"
        >
          <span>Install</span>
        </a>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          title={`Hide for 14 days (open from ${storeLabel} anytime)`}
          className="shrink-0 -mr-1 p-1.5 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default InstallAppBanner;
