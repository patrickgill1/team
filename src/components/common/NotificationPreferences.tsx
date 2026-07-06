// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
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
  // Diagnostic state — shows the result of the /send-push roundtrip
  // so a coach can tell whether the worker is reachable, whether their
  // tokens are live, and how many tokens FCM accepted vs rejected.
  const [diag, setDiag] = useState<{
    tokenCount: number;
    sending: boolean;
    response?: { ok: boolean; sent: number; failed: number; invalidCount: number; error?: string };
  }>({ tokenCount: 0, sending: false });

  useEffect(() => {
    if (!userData) return;
    setPrefs({ ...DEFAULT_PUSH_PREFS, ...((userData as any).pushPreferences || {}) });
    (async () => {
      if (Capacitor.isNativePlatform()) {
        setPermState(await getPushPermissionState());
      } else {
        setPermState(getNotifPermission());
      }
      // Snapshot current token count so the diagnostic UI can show it.
      try {
        const snap = await getDoc(doc(db, 'users', userData.uid));
        const arr = Array.isArray(snap.data()?.fcmTokens) ? snap.data().fcmTokens : [];
        setDiag(d => ({ ...d, tokenCount: arr.length }));
      } catch { /* ignore */ }
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
      // Refresh token count after enable
      const snap = await getDoc(doc(db, 'users', userData.uid));
      const arr = Array.isArray(snap.data()?.fcmTokens) ? snap.data().fcmTokens : [];
      setDiag(d => ({ ...d, tokenCount: arr.length }));
    } catch (err) {
      console.warn('enable push failed', err);
    } finally {
      setEnabling(false);
    }
  };

  // Bypass every pushPreferences / muted / fromUid filter and shoot a
  // push straight to my own tokens via the worker. The response tells us:
  //   ok:false              — worker unreachable, or FCM_SERVICE_ACCOUNT missing
  //   sent>0, failed=0      — pipeline is healthy on this device
  //   sent=0, failed=N      — FCM accepted the request but every token is dead
  //                           (APNs key expired, app reinstalled, etc.)
  const sendTest = async () => {
    if (!userData?.uid) return;
    setDiag(d => ({ ...d, sending: true, response: undefined }));
    try {
      const snap = await getDoc(doc(db, 'users', userData.uid));
      const tokens: string[] = Array.isArray(snap.data()?.fcmTokens) ? snap.data().fcmTokens : [];
      setDiag(d => ({ ...d, tokenCount: tokens.length }));
      if (tokens.length === 0) {
        setDiag(d => ({ ...d, sending: false, response: { ok: false, sent: 0, failed: 0, invalidCount: 0, error: 'no-tokens-registered' } }));
        return;
      }
      const { workerFetch, hasWorkerConfig } = await import('../../utils/workerFetch');
      if (!hasWorkerConfig()) {
        setDiag(d => ({ ...d, sending: false, response: { ok: false, sent: 0, failed: 0, invalidCount: 0, error: 'notify-env-missing' } }));
        return;
      }
      const res = await workerFetch('/send-push', {
        method: 'POST',
        body: JSON.stringify({
          tokens,
          title: 'GoalKickr test push',
          body: 'If you can see this, FCM → your device is working.',
          url: '/settings',
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      setDiag(d => ({
        ...d,
        sending: false,
        response: {
          ok: !!data?.ok && res.ok,
          sent: Number(data?.sent || 0),
          failed: Number(data?.failed || 0),
          invalidCount: Array.isArray(data?.invalidTokens) ? data.invalidTokens.length : 0,
          error: data?.error || (res.ok ? undefined : `http-${res.status}`),
        },
      }));
    } catch (err: any) {
      setDiag(d => ({ ...d, sending: false, response: { ok: false, sent: 0, failed: 0, invalidCount: 0, error: String(err?.message || err).slice(0, 120) } }));
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
      setPrefs(prefs);
    } finally {
      setSaving(null);
    }
  };

  const granted = permState === 'granted';
  const denied = permState === 'denied';
  const platform = Capacitor.getPlatform();

  return (
    <div className="bg-surface-elevated rounded-xl ring-1 ring-line-default/10 shadow-sm overflow-hidden">
      {/* Permission state row */}
      <div className="px-4 py-3 border-b border-line-default/5 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink-primary">Push notifications</div>
          <div className="text-xs text-ink-primary/50 mt-0.5">
            {granted ? 'Enabled on this device.' :
             denied  ? `Blocked in ${platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'browser'} settings — open settings to re-enable.` :
                       'Not enabled yet — turn on to get team messages and updates.'}
          </div>
        </div>
        {!granted && (
          <button
            onClick={enablePush}
            disabled={enabling || denied}
            className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {enabling ? 'Enabling…' : denied ? 'Blocked' : 'Enable'}
          </button>
        )}
      </div>

      {/* Diagnostic — visible to everyone so a parent can confirm
          delivery themselves. The Test button bypasses all filters and
          dumps the raw response. */}
      <div className="px-4 py-3 border-b border-line-default/5 bg-surface-base/40">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50">Delivery test</div>
            <div className="text-xs text-ink-primary/70 mt-0.5">
              {diag.tokenCount === 0 ? 'No device tokens registered yet.' : `${diag.tokenCount} device token${diag.tokenCount === 1 ? '' : 's'} on file.`}
            </div>
          </div>
          <button
            onClick={sendTest}
            disabled={diag.sending}
            className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-line-default/10 ring-1 ring-line-default/15 text-ink-primary hover:bg-line-default/15 disabled:opacity-50"
          >
            {diag.sending ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {diag.response && (
          <div className={`mt-2 rounded-lg px-3 py-2 text-[11px] ring-1 ${
            diag.response.ok && diag.response.sent > 0
              ? 'bg-emerald-500/10 ring-emerald-400/30 text-emerald-200'
              : 'bg-rose-500/10 ring-rose-400/30 text-rose-200'
          }`}>
            <div className="font-bold">
              {diag.response.ok && diag.response.sent > 0
                ? `Pushed to ${diag.response.sent}/${diag.response.sent + diag.response.failed} device${(diag.response.sent + diag.response.failed) === 1 ? '' : 's'}.`
                : diag.response.error
                  ? `Failed: ${diag.response.error}`
                  : `0 of ${diag.tokenCount} device(s) accepted by FCM.`}
            </div>
            {(diag.response.invalidCount > 0 || diag.response.failed > 0) && (
              <div className="mt-1 opacity-80">
                FCM rejected {diag.response.invalidCount || diag.response.failed} stale token{(diag.response.invalidCount || diag.response.failed) === 1 ? '' : 's'} — likely an old install. Disable + re-enable above to register a fresh one.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-category toggles */}
      <div className="divide-y divide-line-default/5">
        {CATEGORIES.map(({ key, label, hint }) => (
          <div key={key} className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${granted ? 'text-ink-primary' : 'text-ink-primary/40'}`}>{label}</div>
              <div className="text-xs text-ink-primary/50 mt-0.5">{hint}</div>
            </div>
            <button
              role="switch"
              aria-checked={prefs[key]}
              onClick={() => togglePref(key)}
              disabled={saving === key}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                prefs[key] ? 'bg-brand-primary' : 'bg-line-default/15'
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
