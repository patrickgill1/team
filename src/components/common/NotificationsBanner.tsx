// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { getPushPermissionState, registerPushNotifications } from '../../utils/nativeShell';
import { enablePushForUser, getNotifPermission } from '../../utils/push';
import { useDismissible } from '../../hooks/useDismissible';

type State =
  | 'loading'
  | 'hidden'        // user already has tokens, or has snoozed, or unsupported
  | 'prompt'        // we can show the OS prompt
  | 'denied'        // they tapped no — need to deep-link to settings
  | 'busy';

// Legacy key retained for read-only fallback so users mid-snooze
// under the old 14-day cooldown don't get the banner re-surfaced
// early after the migration.
const LEGACY_SNOOZE_KEY = 'firefc.notifBannerSnoozedAt';
const LEGACY_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

const NotificationsBanner: React.FC = () => {
  const { userData } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [showSettingsHelp, setShowSettingsHelp] = useState(false);
  const { dismissed, dismiss: dismissBanner } = useDismissible('notificationsBanner', {
    snoozeDays: 14,
    legacyKey: LEGACY_SNOOZE_KEY,
    legacyCooldownMs: LEGACY_SNOOZE_MS,
  });

  useEffect(() => {
    if (!userData?.uid) { setState('hidden'); return; }
    // If they already have at least one token saved, don't pester them.
    const tokens: string[] = Array.isArray((userData as any).fcmTokens) ? (userData as any).fcmTokens : [];
    if (tokens.length > 0) { setState('hidden'); return; }

    // Respect dismiss (new hook + legacy fallback).
    if (dismissed) { setState('hidden'); return; }

    let cancelled = false;
    (async () => {
      const isNative = Capacitor.isNativePlatform();
      if (isNative) {
        const perm = await getPushPermissionState();
        if (cancelled) return;
        if (perm === 'granted') {
          // Granted but no token — re-register so the listener writes one.
          try {
            await registerPushNotifications(async (token: string) => {
              await updateDoc(doc(db, 'users', userData.uid), { fcmTokens: arrayUnion(token) });
            });
            setState('hidden');
          } catch {
            setState('prompt');
          }
          return;
        }
        if (perm === 'denied') { setState('denied'); return; }
        setState('prompt');
      } else {
        const perm = getNotifPermission();
        if (perm === 'unsupported') { setState('hidden'); return; }
        if (perm === 'denied') { setState('denied'); return; }
        setState('prompt');
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, (userData as any)?.fcmTokens?.length, dismissed]);

  const enable = async () => {
    if (!userData?.uid) return;
    setState('busy');
    try {
      if (Capacitor.isNativePlatform()) {
        await registerPushNotifications(async (token: string) => {
          await updateDoc(doc(db, 'users', userData.uid), { fcmTokens: arrayUnion(token) });
        });
        // Re-check — if still denied, surface the settings help.
        const perm = await getPushPermissionState();
        if (perm === 'granted') { setState('hidden'); return; }
        if (perm === 'denied') { setState('denied'); return; }
        // Stuck in prompt: user dismissed the system dialog without choosing.
        setState('prompt');
      } else {
        const res = await enablePushForUser(userData.uid);
        if (res?.ok) { setState('hidden'); return; }
        if (res?.error === 'denied') { setState('denied'); return; }
        setState('prompt');
      }
    } catch (err) {
      console.warn('[notif-banner] enable failed', err);
      setState('prompt');
    }
  };

  const snooze = () => {
    dismissBanner();
    setState('hidden');
  };

  if (state === 'loading' || state === 'hidden') return null;

  const platform = Capacitor.getPlatform();

  return (
    <div className="relative bg-brand-primary-soft border border-brand-primary-soft rounded-xl p-3 shadow-sm">
      <button
        type="button"
        onClick={snooze}
        aria-label="Not now"
        title="Not now"
        className="absolute top-2 right-2 w-8 h-8 rounded-full text-slate-500 hover:text-slate-900 hover:bg-brand-primary/10 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
      <div className="flex items-start gap-3 pr-8">
        <div className="w-9 h-9 rounded-full bg-brand-primary/10 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-brand-primary" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-900">Turn on notifications</div>
          <p className="text-xs text-slate-600 mt-0.5">
            {state === 'denied'
              ? `Notifications are off in your ${platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'browser'} settings. Open settings to turn them back on for GoalKickr.`
              : 'Get pushed when teammates message you, RSVPs change, or game day kicks off.'}
          </p>

          {showSettingsHelp && state === 'denied' && (
            <div className="mt-2 bg-white border border-slate-200 rounded-lg p-2.5 text-[11px] text-slate-700 leading-relaxed">
              {platform === 'ios' ? (
                <>
                  <b>iOS:</b> Settings → Notifications → GoalKickr → toggle <b>Allow Notifications</b> on.
                </>
              ) : platform === 'android' ? (
                <>
                  <b>Android:</b> Settings → Apps → GoalKickr → Notifications → toggle <b>Allow notifications</b> on.
                </>
              ) : (
                <>
                  <b>Browser:</b> click the padlock icon in the address bar → set <b>Notifications</b> to <i>Allow</i>, then refresh.
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 mt-2.5">
            {state === 'denied' ? (
              <button
                onClick={() => setShowSettingsHelp(s => !s)}
                className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-brand-primary text-white hover:bg-brand-primary"
              >
                {showSettingsHelp ? 'Hide steps' : 'Open settings'}
              </button>
            ) : (
              <button
                onClick={enable}
                disabled={state === 'busy'}
                className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50"
              >
                {state === 'busy' ? 'Enabling…' : 'Enable'}
              </button>
            )}
            <button
              onClick={snooze}
              className="text-[11px] font-bold uppercase tracking-wider px-2 py-1.5 text-slate-500 hover:text-slate-800"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotificationsBanner;
