// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { getPushPermissionState, registerPushNotifications } from '../../utils/nativeShell';
import { enablePushForUser, getNotifPermission } from '../../utils/push';

type State =
  | 'loading'
  | 'hidden'        // user already has tokens, or has snoozed, or unsupported
  | 'prompt'        // we can show the OS prompt
  | 'denied'        // they tapped no — need to deep-link to settings
  | 'busy';

const SNOOZE_KEY = 'firefc.notifBannerSnoozedAt';
// Re-surface every 14 days if they snooze.
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

const NotificationsBanner: React.FC = () => {
  const { userData } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [showSettingsHelp, setShowSettingsHelp] = useState(false);

  useEffect(() => {
    if (!userData?.uid) { setState('hidden'); return; }
    // If they already have at least one token saved, don't pester them.
    const tokens: string[] = Array.isArray((userData as any).fcmTokens) ? (userData as any).fcmTokens : [];
    if (tokens.length > 0) { setState('hidden'); return; }

    // Respect snooze.
    try {
      const snoozed = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (snoozed && Date.now() - snoozed < SNOOZE_MS) { setState('hidden'); return; }
    } catch { /* ignore */ }

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
  }, [userData?.uid, (userData as any)?.fcmTokens?.length]);

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
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch { /* ignore */ }
    setState('hidden');
  };

  if (state === 'loading' || state === 'hidden') return null;

  const platform = Capacitor.getPlatform();

  return (
    <div className="bg-gradient-to-r from-cyan-50 to-blue-50 border border-cyan-200 rounded-xl p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-cyan-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
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
                className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-cyan-600 text-white hover:bg-cyan-500"
              >
                {showSettingsHelp ? 'Hide steps' : 'Open settings'}
              </button>
            ) : (
              <button
                onClick={enable}
                disabled={state === 'busy'}
                className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50"
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
