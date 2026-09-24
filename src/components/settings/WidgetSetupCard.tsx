// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { doc, updateDoc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import WidgetBridge, { syncWidgetTokenToNative } from '../../utils/widgetBridge';
import { isOwner } from '../../utils/helpers';
import { workerFetch } from '../../utils/workerFetch';

/**
 * Widget setup card. Generates and displays a long-lived widget
 * token used by the native home-screen widget. Token is stored on
 * users/{uid}.widgetToken and mirrored to native shared storage.
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
  const [refreshStatus, setRefreshStatus] = useState<string>('');

  const uid = userData?.uid || currentUser?.uid;

  // Pushes the token into the native widget bridge so the home-screen
  // widget can auto-pick it up and skip the paste UI. Web falls back
  // to the no-op implementation in widgetBridge.ts.
  const syncToNativeBridge = async (next: string) => {
    return syncWidgetTokenToNative(next);
  };

  const checkSnapshot = async (next: string) => {
    const res = await fetch(`https://api.goalkickr.com/widget/snapshot?token=${encodeURIComponent(next)}&t=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.error || `http-${res.status}`);
    }
    return body?.snapshot;
  };

  const refreshWidgetNow = async () => {
    if (!token || busy) return;
    setBusy(true);
    setRefreshStatus('Writing token to widget...');
    try {
      const bridge = await syncToNativeBridge(token);
      if (!bridge?.ok) {
        setRefreshStatus(`Bridge failed: ${bridge?.error || 'unknown'}`);
        return;
      }
      setRefreshStatus('Checking live widget snapshot...');
      const snap = await checkSnapshot(token);
      const player = snap?.playerName || 'player';
      setRefreshStatus(`Widget ready: ${player}`);
    } catch (err: any) {
      setRefreshStatus(`Snapshot failed: ${String(err?.message || err)}`);
    } finally {
      setBusy(false);
    }
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
      const bridge = await syncToNativeBridge(t);
      setRefreshStatus(bridge?.ok ? 'Widget token saved to this device.' : `Bridge failed: ${bridge?.error || 'unknown'}`);
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
      const bridge = await syncToNativeBridge(t);
      setRefreshStatus(bridge?.ok ? 'New widget code saved to this device.' : `Bridge failed: ${bridge?.error || 'unknown'}`);
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

      <WidgetPlayerPicker />

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

          <div className="rounded-lg bg-surface-base border border-line-default/10 p-3 space-y-2">
            <button
              type="button"
              onClick={refreshWidgetNow}
              disabled={busy}
              className="w-full px-4 py-2.5 rounded-lg bg-brand-primary text-brand-primary-fg font-bold text-sm disabled:opacity-60"
            >
              {busy ? 'Refreshing...' : 'Refresh widget on this phone'}
            </button>
            <p className="text-[11px] text-ink-primary/55 leading-snug">
              Writes this code into the native widget container, reloads timelines, and checks the live widget API.
            </p>
            {refreshStatus && (
              <p className="font-mono text-[11px] text-ink-primary/75 break-words">
                {refreshStatus}
              </p>
            )}
          </div>

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
      {isOwner(userData) && <WidgetBridgeDiagnostics token={token} />}
    </div>
  );
};

// Owner-only diagnostic panel. Surfaces every link in the chain so we
// can see at a glance which step is failing: Firestore token, JS bridge
// reachability, write+read roundtrip. Hidden from non-owners.
const WidgetBridgeDiagnostics: React.FC<{ token: string | null }> = ({ token }) => {
  const [bridgeReadback, setBridgeReadback] = React.useState<string>('(not yet checked)');
  const [bridgeWriteResult, setBridgeWriteResult] = React.useState<string>('(not yet attempted)');
  const [busy, setBusy] = React.useState(false);

  const runCheck = async () => {
    setBusy(true);
    setBridgeWriteResult('writing...');
    try {
      const probe = `diag_${Date.now().toString(36)}`;
      await WidgetBridge.setToken({ token: probe });
      setBridgeWriteResult(`write ok (probe="${probe}")`);
    } catch (e: any) {
      setBridgeWriteResult(`write FAILED: ${String(e?.message || e)}`);
      setBusy(false);
      return;
    }
    setBridgeReadback('reading...');
    try {
      const r = await WidgetBridge.getToken();
      setBridgeReadback(`read ok (token="${r.token || '(empty)'}")`);
    } catch (e: any) {
      setBridgeReadback(`read FAILED: ${String(e?.message || e)}`);
    }
    // Restore the real token after the probe so we don't break the widget
    if (token) {
      try { await WidgetBridge.setToken({ token }); } catch { /* ignore */ }
    }
    setBusy(false);
  };

  return (
    <div className="mt-4 border-t border-line-default/5 px-4 pt-3 pb-4">
      <p className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300 mb-2">Owner diagnostic</p>
      <div className="space-y-1 font-mono text-[11px] text-ink-primary/70">
        <div>Firestore token: <span className="text-ink-primary">{token ? `${token.slice(0, 8)}... (${token.length} chars)` : '(none)'}</span></div>
        <div>Bridge write: <span className="text-ink-primary">{bridgeWriteResult}</span></div>
        <div>Bridge read-back: <span className="text-ink-primary">{bridgeReadback}</span></div>
      </div>
      <button
        type="button"
        onClick={runCheck}
        disabled={busy}
        className="mt-3 px-3 py-1.5 rounded-md bg-amber-500 text-ink-primary text-xs font-extrabold tracking-widest uppercase disabled:opacity-50"
      >
        {busy ? 'Running…' : 'Run bridge check'}
      </button>
      <p className="mt-2 text-[10px] text-ink-primary/45 leading-relaxed">
        Tap Run, then read the three lines above. If write/read both say "ok"
        the JS side is fine and the issue is in the widget extension or App
        Group. If they fail with an error, the JS-to-native call isn't
        landing — usually means the Capacitor plugin isn't registered.
      </p>
    </div>
  );
};

// Picker for WHICH player the widget shows. Renders whenever the
// user has more than one candidate: their linked children (players
// where parentIds includes uid) plus their adult-self player (if
// selfPlayerId is set). Writes users/{uid}.widgetPlayerId via the
// worker (client-side users writes can't touch this field per rules).
//
// Companion to widget.ts precedence: widgetPlayerId wins over
// selfPlayerId, so an adult who plays themselves (pickup team) can
// still pin the widget to their kid.
const WidgetPlayerPicker: React.FC = () => {
  const { userData } = useAuth();
  const uid = userData?.uid;
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; isSelf: boolean }>>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        // Kids (parentIds includes me).
        const kidsSnap = await getDocs(query(collection(db, 'players'), where('parentIds', 'array-contains', uid)));
        const kids: Array<{ id: string; name: string; isSelf: boolean }> = [];
        kidsSnap.forEach((d) => {
          const data: any = d.data() || {};
          kids.push({ id: d.id, name: data.name || 'Player', isSelf: false });
        });
        // Adult-self player (if any).
        const selfId: string | null = (userData as any)?.selfPlayerId || null;
        if (selfId && !kids.some((k) => k.id === selfId)) {
          try {
            const selfDoc = await getDoc(doc(db, 'players', selfId));
            if (selfDoc.exists()) {
              const data: any = selfDoc.data() || {};
              kids.push({ id: selfId, name: `Me (${data.name || 'self'})`, isSelf: true });
            }
          } catch { /* ignore */ }
        } else if (selfId) {
          // selfId is also a kid record (parent-of-self). Just relabel.
          const idx = kids.findIndex((k) => k.id === selfId);
          if (idx >= 0) kids[idx] = { ...kids[idx], name: `Me (${kids[idx].name})`, isSelf: true };
        }
        if (cancelled) return;
        setCandidates(kids);
        // Current selection: widgetPlayerId if set, else selfPlayerId,
        // else the first kid (matches worker precedence after this ship).
        const current = (userData as any)?.widgetPlayerId || selfId || (kids[0]?.id || '');
        setSelected(current);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, (userData as any)?.widgetPlayerId, (userData as any)?.selfPlayerId]);

  const onPick = async (playerId: string) => {
    if (!playerId || playerId === selected || busy) return;
    setBusy(true);
    setStatus('Saving…');
    const prev = selected;
    setSelected(playerId); // optimistic
    try {
      const res = await workerFetch('/users/set-widget-player', {
        method: 'POST',
        body: JSON.stringify({ playerId }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setSelected(prev);
        setStatus(`Failed: ${j?.error || `HTTP ${res.status}`}`);
        return;
      }
      const picked = candidates.find((c) => c.id === playerId);
      setStatus(`Widget will show ${picked?.name || 'this player'} on next refresh.`);
    } catch (err: any) {
      setSelected(prev);
      setStatus(`Failed: ${String(err?.message || err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;
  if (candidates.length < 2) return null; // nothing to choose between

  return (
    <div className="p-4 border-b border-line-default/5 space-y-2">
      <label htmlFor="widget-player-picker" className="block text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/45">
        Widget shows
      </label>
      <select
        id="widget-player-picker"
        value={selected}
        onChange={(e) => onPick(e.target.value)}
        disabled={busy}
        className="w-full bg-surface-base border border-line-default/15 rounded-lg px-3 py-2.5 text-sm text-ink-primary disabled:opacity-60"
      >
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {status && (
        <p className="text-[11px] text-ink-primary/60 leading-snug">{status}</p>
      )}
    </div>
  );
};

export default WidgetSetupCard;
