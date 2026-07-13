import React, { useEffect, useState } from 'react';
import {
  APP_STORE_URL,
  PLAY_STORE_URL,
  PLAY_STORE_LIVE,
  APP_STORE_LIVE,
  ANDROID_BETA_OPTIN_URL,
  ANDROID_BETA_OPEN,
} from '../../utils/appAvailability';

/**
 * Top-of-page banner urging mobile-web users to install the native
 * GoalKickr app OR (while the Android Play listing is still closed
 * testing) add the web app to their home screen.
 *
 * iOS: prompts the App Store install.
 * Android + PLAY_STORE_LIVE=true: prompts the Play Store install.
 * Android + PLAY_STORE_LIVE=false (2026-07-12 reality): shows a
 *   Home-Screen install nudge with plain-English steps. Avoids the
 *   old beta-recruit CTA that pointed at a Google opt-in group,
 *   which "has never worked without me putting their email into my
 *   tester list" per Patrick.
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
  if (/android/i.test(ua)) return 'android';
  return null;
};

const InstallAppBanner: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>(null);

  useEffect(() => {
    if (isCapacitor()) return;                       // already in the app
    const detected = detectPlatform();
    if (!detected) return;                           // desktop / unknown
    if (typeof window === 'undefined') return;
    // Hide on real desktops (>= 1024px / Tailwind's lg breakpoint).
    // 768 was too aggressive; Android tablets land right at 768 in
    // portrait and never saw the banner.
    if (window.innerWidth >= 1024) return;

    // Stored value is the epoch-ms the banner should stay hidden UNTIL.
    // An X-out sets ~14 days; tapping the primary action sets ~6 months.
    const snoozeUntil = Number(localStorage.getItem(STORAGE_KEY) || 0);
    if (snoozeUntil && Date.now() < snoozeUntil) return;

    if (detected === 'ios' && !APP_STORE_LIVE) return;

    setPlatform(detected);
    setVisible(true);
  }, []);

  const snooze = (ms: number) => {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now() + ms)); } catch { /* ignore */ }
    setVisible(false);
  };
  const dismiss = () => snooze(DISMISS_REMINDER_MS);
  const onPrimary = () => snooze(INSTALLED_SNOOZE_MS);

  if (!visible || !platform) return null;

  // Four copy variants:
  //   1. iOS: standard App Store install.
  //   2. Android + Play Store live: standard Play Store install.
  //   3. Android + Play Store closed + beta OPEN: one-tap install
  //      via the Google-Group-backed opt-in URL. Real install, no
  //      allowlist tax.
  //   4. Android + Play Store closed + beta closed: honest A2HS
  //      nudge with no CTA target (can't promise a one-tap flow
  //      that isn't real).
  const isAndroidBeta = platform === 'android' && !PLAY_STORE_LIVE && ANDROID_BETA_OPEN;
  const isAndroidA2HS = platform === 'android' && !PLAY_STORE_LIVE && !ANDROID_BETA_OPEN;
  const installUrl = platform === 'ios' ? APP_STORE_URL
    : PLAY_STORE_LIVE ? PLAY_STORE_URL
    : isAndroidBeta ? ANDROID_BETA_OPTIN_URL
    : undefined;
  const ctaTitle = isAndroidBeta
    ? 'Install GoalKickr on Android'
    : isAndroidA2HS
      ? 'Use GoalKickr as an app on Android'
      : 'Get the GoalKickr app';
  const ctaSubtitle = isAndroidBeta
    ? 'One-tap install via early access. No wait, no email allowlist.'
    : isAndroidA2HS
      ? 'Tap your browser menu, then Add to Home Screen. Full app, no wait.'
      : 'Push notifications, faster, works offline.';
  const ctaButtonLabel = isAndroidA2HS ? 'Got it' : 'Install';
  const storeLabel = isAndroidBeta ? 'early access'
    : isAndroidA2HS ? 'Home Screen'
    : platform === 'ios' ? 'App Store'
    : 'Google Play';

  return (
    <div className="lg:hidden bg-gradient-to-r from-brand-primary to-surface-raised text-white shadow">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center gap-3">
        <img
          src="/images/logo.png"
          alt="GoalKickr"
          className="w-9 h-9 rounded-xl bg-line-default/10 ring-1 ring-line-default/20 p-1 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-tight truncate">{ctaTitle}</p>
          <p className="text-[11px] text-white/80 leading-tight truncate">{ctaSubtitle}</p>
        </div>
        {installUrl ? (
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onPrimary}
            className="shrink-0 inline-flex items-center gap-1.5 bg-white text-charcoal-800 text-xs font-bold px-3 py-1.5 rounded-full hover:bg-line-default/90 transition"
          >
            <span>{ctaButtonLabel}</span>
          </a>
        ) : (
          <button
            type="button"
            onClick={onPrimary}
            className="shrink-0 inline-flex items-center gap-1.5 bg-white text-charcoal-800 text-xs font-bold px-3 py-1.5 rounded-full hover:bg-line-default/90 transition"
          >
            <span>{ctaButtonLabel}</span>
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          title={`Hide for 14 days (${storeLabel})`}
          className="shrink-0 -mr-1 p-1.5 rounded-full text-white/70 hover:text-white hover:bg-line-default/10 transition"
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
