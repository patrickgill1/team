// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { getPushPermissionState, registerPushNotifications } from '../../utils/nativeShell';
import { enablePushForUser, getNotifPermission } from '../../utils/push';
import { DEFAULT_PUSH_PREFS, PushPrefKey, PushPreferences } from '../../utils/notify';

const CATEGORIES: Array<{ key: PushPrefKey; label: string; hint: string }> = [
  { key: 'chat', label: 'Chat messages', hint: 'Direct messages and team chat' },
  { key: 'events', label: 'Events', hint: 'Cancellations, comments, new events' },
  { key: 'helpdesk', label: 'Club support', hint: 'Tickets and replies' },
  { key: 'broadcast', label: 'Club announcements', hint: 'Coach/admin broadcasts' },
];

const NotificationPreferences: React.FC = () => {
  const { userData } = useAuth();
  const [permState, setPermState] = useState<string>('loading');
  const [prefs, setPrefs] = useState<PushPreferences>(DEFAULT_PUSH_PREFS);
  const [enabling, setEnabling] = useState(false);
  const [saving, setSaving] = useState<PushPrefKey | null>(null);

  useEffect(() => {
    if (!userData) return;
    setPrefs({ ...DEFAULT_PUSH_PREFS, ...((userData as any).pushPreferences || {}) });
    (async () => {
      if (Capacitor.isNativePlatform()) {
        setPermState(await getPushPermissionState());
      } else {
        setPermState(getNotifPermission());
      }
    })();
  }, [userData?.uid]);

  const enablePush = async () => {
    if (!userData?.uid) return;
    setEnabling(true);
    try {
      if (Capacitor.isNativePlatform()) {
        await registerPushNotifications(async (token: string) => {
          await updateDoc(doc(db, 'users', userData.uid), { fcmTokens: arrayUnion(token) });
        });
        setPermState(await getPushPermissionState());
      } else {
        await enablePushForUser(userData.uid);
        setPermState(getNotifPermission());
      }
    } catch (err) {
      console.warn('enable push failed', err);
    } finally {
      setEnabling(false);
    }
  };

  const togglePref = async (key: PushPrefKey) => {
    if (!userData?.uid) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(key);
    try {
      await updateDoc(doc(db, 'users', userData.uid), { pushPreferences: next });
    } catch (err) {
      console.warn('save pref failed', err);
      // revert on failure
      setPrefs(prefs);
    } finally {
      setSaving(null);
    }
  };

  const granted = permState === 'granted';
  const denied = permState === 'denied';
  const platform = Capacitor.getPlatform();

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Permission state row */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">Push notifications</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {granted ? 'Enabled on this device.' :
             denied  ? `Blocked in ${platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'browser'} settings — open settings to re-enable.` :
                       'Not enabled yet — turn on to get team messages and updates.'}
          </div>
        </div>
        {!granted && (
          <button
            onClick={enablePush}
            disabled={enabling || denied}
            className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-crimson-600 text-white hover:bg-crimson-500 disabled:opacity-50"
          >
            {enabling ? 'Enabling…' : denied ? 'Blocked' : 'Enable'}
          </button>
        )}
      </div>

      {/* Per-category toggles. Even if push isn't enabled yet, let the
          user pre-set their preferences so they take effect immediately
          when they grant permission later. */}
      <div className="divide-y divide-slate-100">
        {CATEGORIES.map(({ key, label, hint }) => (
          <div key={key} className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${granted ? 'text-slate-900' : 'text-slate-400'}`}>{label}</div>
              <div className="text-xs text-slate-500 mt-0.5">{hint}</div>
            </div>
            <button
              role="switch"
              aria-checked={prefs[key]}
              onClick={() => togglePref(key)}
              disabled={saving === key}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                prefs[key] ? 'bg-crimson-600' : 'bg-slate-300'
              } disabled:opacity-50`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                  prefs[key] ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NotificationPreferences;
