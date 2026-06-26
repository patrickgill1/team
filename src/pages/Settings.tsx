// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { APP_VERSION, APP_BUILD } from '../utils/version';
import { useFirestore } from '../hooks/useFirestore';
import { usePhotoUpload } from '../hooks/useStorage';
import AppIcon, { AppIconName } from '../components/common/AppIcon';
import { getShareOrigin } from '../utils/origin';
import { enablePushForUser, getNotifPermission } from '../utils/push';
import { isCoach } from '../utils/helpers';
import NotificationPreferences from '../components/common/NotificationPreferences';
import SubscriptionCard from '../components/settings/SubscriptionCard';
import WidgetSetupCard from '../components/settings/WidgetSetupCard';

interface LinkedPlayer {
  id: string;
  name: string;
  jerseyNumber?: number;
  position?: string;
  profilePhotoUrl?: string;
  teamId?: string;
  teamIds?: string[];
  teamNames?: string[];
}

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { userData, currentUser, logout, deleteAccount, refreshUserData } = useAuth();
  const { updateDocument } = useFirestore();
  // OTA bundle version that's actually running. Distinct from
  // APP_VERSION (which is the binary version that matches what's in
  // the App Store / Play Store). So if you've pushed OTA fixes since
  // the binary shipped, this shows the latest live JS bundle.
  const [bundleVersion, setBundleVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        const cur = await CapacitorUpdater.current();
        const v = (cur as any)?.bundle?.version;
        if (!cancelled && typeof v === 'string') setBundleVersion(v);
      } catch { /* not native or plugin missing — leave null */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const { uploadUserPhoto } = usePhotoUpload();

  const [linkedPlayers, setLinkedPlayers] = useState<LinkedPlayer[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [editingProfile, setEditingProfile] = useState(false);
  const [name, setName] = useState(userData?.name || '');
  const [phone, setPhone] = useState(userData?.phoneNumber || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [notifPermission, setNotifPermission] = useState<string>('default');
  const [enablingPush, setEnablingPush] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setName(userData?.name || '');
    setPhone(userData?.phoneNumber || '');
  }, [userData?.name, userData?.phoneNumber]);

  useEffect(() => {
    setNotifPermission(getNotifPermission());
  }, []);

  // Load every player linked to this user across every team — multi-kid
  // families have one kid on Team A and another on Team B, so we
  // intentionally don't scope this to the currently-selected team.
  useEffect(() => {
    if (!userData?.uid) { setLoadingPlayers(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
        ));
        if (cancelled) return;
        const rows: LinkedPlayer[] = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false);

        // Resolve team names so each kid's card can show which team
        // they're on (the disambiguator parents need).
        const teamIdsToLookup = new Set<string>();
        rows.forEach((r: any) => {
          if (Array.isArray(r.teamIds)) r.teamIds.forEach((t: string) => teamIdsToLookup.add(t));
          if (r.teamId) teamIdsToLookup.add(r.teamId);
        });
        const idArr = Array.from(teamIdsToLookup);
        const idToName: Record<string, string> = {};
        for (let i = 0; i < idArr.length; i += 30) {
          const chunk = idArr.slice(i, i + 30);
          if (chunk.length === 0) continue;
          const teamSnap = await getDocs(query(
            collection(db, 'teams'),
            where('__name__', 'in', chunk),
          ));
          teamSnap.docs.forEach((d) => {
            idToName[d.id] = (d.data() as any).name || 'Team';
          });
        }
        const decorated = rows.map((r: any) => {
          const ids = Array.isArray(r.teamIds) && r.teamIds.length > 0
            ? r.teamIds
            : (r.teamId ? [r.teamId] : []);
          return {
            ...r,
            teamNames: ids.map((id: string) => idToName[id]).filter(Boolean),
          };
        });
        if (cancelled) return;
        setLinkedPlayers(decorated);
      } catch (err) {
        console.error('Linked players lookup failed:', err);
      } finally {
        if (!cancelled) setLoadingPlayers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid]);

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userData?.uid) return;
    setUploadingPhoto(true);
    try {
      const url = await uploadUserPhoto(file, userData.uid);
      await updateDocument('users', userData.uid, { photoURL: url });
      await refreshUserData();
    } catch (err: any) {
      alert(err?.message || 'Could not update photo. Try again.');
    } finally {
      setUploadingPhoto(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveProfile = async () => {
    if (!userData?.uid) return;
    setSavingProfile(true);
    try {
      await updateDocument('users', userData.uid, {
        name: name.trim() || userData.name,
        phoneNumber: phone.trim() || null,
      });
      await refreshUserData();
      setEditingProfile(false);
    } catch (err: any) {
      alert(err?.message || 'Could not save profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleEnablePush = async () => {
    if (!userData?.uid) return;
    setEnablingPush(true);
    try {
      await enablePushForUser(userData.uid);
      setNotifPermission(getNotifPermission());
    } finally {
      setEnablingPush(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logout();
      // Belt-and-suspenders: navigate to /auth ourselves. The
      // AuthContext clears state and ProtectedRoute will redirect
      // here too, but explicit navigation prevents a flash of the
      // dashboard if any auth listener stutters.
      navigate('/auth', { replace: true });
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handleDelete = async () => {
    if (deleteText.trim().toLowerCase() !== 'delete') {
      setDeleteError("Type 'delete' to confirm.");
      return;
    }
    setDeletingAccount(true);
    setDeleteError(null);
    try {
      await deleteAccount();
    } catch (err: any) {
      setDeleteError(err?.message || 'Delete failed.');
      setDeletingAccount(false);
    }
  };

  const shareCalendarFeed = async () => {
    if (!userData?.uid) return;
    const origin = getShareOrigin();
    // Subscribe URL is per-team; default to the user's primary team.
    const teamId = userData.teamId || userData.teamIds?.[0];
    if (!teamId) {
      alert('Pick a team first to get its calendar feed.');
      return;
    }
    const url = `${origin}/api/calendar/${teamId}.ics`;
    const webcal = url.replace(/^https?:/, 'webcal:');
    const message = `Subscribe in your phone calendar:\n\n${webcal}\n\nTap the link or paste it into Calendar → "Add Subscription Calendar".`;
    try {
      if (navigator.share) {
        await (navigator as any).share({ title: 'Team calendar feed', text: message, url: webcal });
        return;
      }
    } catch { /* user canceled — fall through to clipboard */ }
    try {
      await navigator.clipboard.writeText(webcal);
      alert(`Subscription URL copied:\n${webcal}\n\nPaste it into your calendar app → Add Subscription Calendar.`);
    } catch {
      window.prompt('Subscription URL — copy this and add to your calendar:', webcal);
    }
  };

  const userInitial = (userData?.name || userData?.email || '?').charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-charcoal-950 pb-12">
      {/* Page title row — sits below the global AppLayout top bar, no
          second dark header. */}
      <div className="max-w-2xl mx-auto px-4 pt-4 pb-2 flex items-center justify-between">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-bone/65 hover:text-bone text-sm font-semibold"
        >
          <AppIcon name="arrow-right" className="w-4 h-4 rotate-180" />
          <span>Back</span>
        </button>
        <h1 className="text-base font-bold text-bone">Settings</h1>
        <div className="w-14" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pt-2 space-y-6">
        {/* ── MY ACCOUNT ─────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-2xl font-bold text-bone">My Account</h2>
            {!editingProfile && (
              <button
                onClick={() => setEditingProfile(true)}
                className="inline-flex items-center gap-1 text-sm font-semibold text-brand-primary-soft hover:text-brand-primary-dim"
              >
                <AppIcon name="edit" className="w-4 h-4" />
                <span>Edit</span>
              </button>
            )}
          </div>

          <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm p-4">
            <div className="flex items-start gap-4">
              {/* Avatar */}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploadingPhoto}
                className="relative shrink-0 group"
                title="Tap to change photo"
              >
                {userData?.photoURL ? (
                  <img
                    src={userData.photoURL}
                    alt={userData.name}
                    className="w-20 h-20 rounded-full object-cover ring-2 ring-white/10"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary flex items-center justify-center text-white text-2xl font-bold ring-2 ring-white/10">
                    {userInitial}
                  </div>
                )}
                <div className="absolute -bottom-0.5 -right-0.5 w-7 h-7 rounded-full bg-charcoal-900 ring-1 ring-white/10 shadow-sm flex items-center justify-center text-bone/85 group-hover:bg-white/[0.05]">
                  <AppIcon name="edit" className="w-3.5 h-3.5" />
                </div>
                {uploadingPhoto && (
                  <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickPhoto}
                />
              </button>

              {/* Info */}
              <div className="flex-1 min-w-0">
                {editingProfile ? (
                  <div className="space-y-2">
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-bone/50 mb-1">Name</label>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full border border-white/15 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-brand-primary"
                        style={{ fontSize: '16px' }}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wide text-bone/50 mb-1">Phone</label>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="(555) 555-5555"
                        className="w-full border border-white/15 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-brand-primary"
                        style={{ fontSize: '16px' }}
                      />
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => {
                          setEditingProfile(false);
                          setName(userData?.name || '');
                          setPhone(userData?.phoneNumber || '');
                        }}
                        disabled={savingProfile}
                        className="px-3 py-1.5 text-sm font-semibold text-bone/85 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveProfile}
                        disabled={savingProfile}
                        className="bg-brand-primary hover:bg-brand-primary text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-50"
                      >
                        {savingProfile ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 className="text-lg font-bold text-bone truncate">{userData?.name || 'Your Name'}</h3>
                    <p className="text-sm text-bone/65 truncate">{userData?.email}</p>
                    {userData?.phoneNumber && (
                      <p className="text-sm text-bone/65">{userData.phoneNumber}</p>
                    )}
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-bone/40 mt-1">
                      {roleLabel(userData?.role, userData?.coachLevel, userData?.isClubAdmin)}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ── MY PLAYERS PROFILES ───────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-2xl font-bold text-bone">My Players</h2>
            {isCoach(userData?.role || '') && (
              <Link
                to="/players?add=1"
                className="inline-flex items-center gap-1 text-sm font-semibold text-brand-primary-soft hover:text-brand-primary-dim"
              >
                <AppIcon name="plus" className="w-4 h-4" />
                <span>Add Player</span>
              </Link>
            )}
          </div>

          <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm p-4">
            {loadingPlayers ? (
              <p className="text-sm text-bone/50 text-center py-4">Loading…</p>
            ) : linkedPlayers.length === 0 ? (
              <p className="text-sm text-bone/50 text-center py-4">
                You're not linked to a player yet. {isCoach(userData?.role || '') ? 'Create a team and add players first.' : 'Ask your coach to send you a link with your child\'s name on it.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {linkedPlayers.map((p) => (
                  <Link
                    key={p.id}
                    to={`/player/${p.id}`}
                    className="flex flex-col items-center text-center rounded-xl ring-1 ring-white/10 hover:ring-brand-primary-soft hover:shadow-sm p-3 transition"
                  >
                    {p.profilePhotoUrl ? (
                      <img
                        src={p.profilePhotoUrl}
                        alt={p.name}
                        className="w-20 h-20 rounded-full object-cover ring-2 ring-white/10"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-charcoal-900 to-charcoal-700 flex items-center justify-center text-white text-xl font-bold ring-2 ring-white/10">
                        {(p.name || '?').charAt(0)}
                      </div>
                    )}
                    <p className="mt-2 text-sm font-bold text-bone truncate w-full">{p.name}</p>
                    {p.teamNames && p.teamNames.length > 0 && (
                      <p className="text-[11px] text-bone/50 truncate w-full">{p.teamNames.join(' · ')}</p>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── SUBSCRIPTION ──────────────────────────────────────── */}
        <section>
          <h2 className="text-2xl font-bold text-bone mb-2 px-1">Subscription</h2>
          <SubscriptionCard />
        </section>

        {/* ── MANAGE ACCOUNT ────────────────────────────────────── */}
        <section>
          <h2 className="text-2xl font-bold text-bone mb-2 px-1">Notifications</h2>
          <NotificationPreferences />
        </section>

        {isCoach(userData?.role || '') && (
          <section>
            <h2 className="text-2xl font-bold text-bone mb-2 px-1">Drill library</h2>
            <DrillLibraryToggle />
          </section>
        )}

        <section>
          <h2 className="text-2xl font-bold text-bone mb-2 px-1">Widget</h2>
          <WidgetSetupCard />
        </section>

        <section>
          <h2 className="text-2xl font-bold text-bone mb-2 px-1">Help</h2>
          <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden divide-y divide-white/5">
            <SettingsRow
              icon="lifebuoy"
              label="My tickets"
              onClick={() => navigate('/tickets')}
              hint="Support requests you've opened or that your club has filed."
            />
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-bone mb-2 px-1">Manage Account</h2>
          <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden divide-y divide-white/5">
            <SettingsRow
              icon="calendar"
              label="Calendar Syncing (Google, Apple, etc)"
              onClick={shareCalendarFeed}
            />
            <SettingsRow
              icon="shield"
              label="Club admins"
              onClick={() => navigate('/club/admins')}
              hint="Grant scoped access to other club staff."
            />
            <SettingsRow
              icon="lifebuoy"
              label="Customer Support"
              onClick={() => navigate('/tickets')}
              hint="Open a ticket so we can track it."
            />
            <SettingsRow
              icon="palette"
              label="Event Colors"
              onClick={() => navigate('/calendar')}
              hint="Set per your calendar app"
            />
            <SettingsRow
              icon="shield"
              label="Privacy Policy"
              onClick={() => navigate('/privacy')}
            />
            <SettingsRow
              icon="info"
              label="About GoalKickr"
              hint={
                bundleVersion && bundleVersion !== APP_VERSION
                  ? `v${APP_VERSION} · build ${APP_BUILD} · live ${bundleVersion}`
                  : `v${APP_VERSION} · build ${APP_BUILD}`
              }
              onClick={() =>
                alert(
                  `GoalKickr v${APP_VERSION} (build ${APP_BUILD})` +
                  (bundleVersion && bundleVersion !== APP_VERSION
                    ? `\nLive update: ${bundleVersion}`
                    : '') +
                  `\n\nBuilt by Patrick Gill for the GoalKickr community.`
                )
              }
            />
          </div>
        </section>

        {/* ── DANGER ────────────────────────────────────────────── */}
        <section>
          <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden divide-y divide-white/5">
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-white/[0.05] transition"
            >
              <span className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-lg bg-white/[0.08] text-bone/65 flex items-center justify-center">
                  <AppIcon name="logout" className="w-5 h-5" />
                </span>
                <span className="text-base font-semibold text-bone">Sign Out</span>
              </span>
              <AppIcon name="arrow-right" className="w-4 h-4 text-bone/35" />
            </button>
            <button
              onClick={() => { setShowDelete(true); setDeleteText(''); setDeleteError(null); }}
              className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-rose-500/15 transition"
            >
              <span className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-lg bg-rose-500/15 text-rose-300 flex items-center justify-center">
                  <AppIcon name="trash" className="w-5 h-5" />
                </span>
                <span className="text-base font-semibold text-rose-300">Delete Account</span>
              </span>
              <AppIcon name="arrow-right" className="w-4 h-4 text-rose-200" />
            </button>
          </div>
        </section>
      </div>

      {/* Delete confirm */}
      {showDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => !deletingAccount && setShowDelete(false)}
        >
          <div
            className="bg-charcoal-900 rounded-2xl shadow-2xl w-full max-w-sm p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-bone">Delete your account?</h3>
            <p className="text-sm text-bone/65 mt-2">
              This permanently removes your profile and access. Player records you've created stay on the team.
              Type <b>delete</b> to confirm.
            </p>
            <input
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="delete"
              className="mt-3 w-full border border-white/15 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-rose-500"
              style={{ fontSize: '16px' }}
              disabled={deletingAccount}
            />
            {deleteError && <p className="text-sm text-rose-300 mt-2">{deleteError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowDelete(false)}
                disabled={deletingAccount}
                className="px-4 py-2 text-sm font-semibold text-bone/85 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deletingAccount || deleteText.trim().toLowerCase() !== 'delete'}
                className="bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300 text-white text-sm font-semibold px-4 py-2 rounded-lg"
              >
                {deletingAccount ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SettingsRow: React.FC<{
  icon: AppIconName;
  label: string;
  hint?: string;
  onClick: () => void;
  busy?: boolean;
}> = ({ icon, label, hint, onClick, busy }) => (
  <button
    onClick={onClick}
    disabled={busy}
    className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-white/[0.05] transition disabled:opacity-60 text-left"
  >
    <span className="flex items-center gap-3 min-w-0">
      <span className="w-9 h-9 rounded-lg bg-brand-primary/15 text-brand-primary-soft flex items-center justify-center shrink-0">
        <AppIcon name={icon} className="w-5 h-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-base font-semibold text-bone truncate">{label}</span>
        {hint && <span className="block text-xs text-bone/50 truncate">{hint}</span>}
      </span>
    </span>
    <AppIcon name="arrow-right" className="w-4 h-4 text-bone/35 shrink-0" />
  </button>
);

function roleLabel(role?: string, coachLevel?: string, isClubAdmin?: boolean): string {
  if (isClubAdmin) return 'Club Admin';
  if (role === 'coach') return coachLevel === 'head_coach' ? 'Head Coach' : coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Coach';
  if (role === 'team_manager') return 'Team Manager';
  if (role === 'parent') return 'Parent';
  if (role === 'player') return 'Player';
  return role || '';
}

const DrillLibraryToggle: React.FC = () => {
  const { userData } = useAuth();
  const { updateDocument } = useFirestore();
  const [browse, setBrowse] = useState((userData as any)?.browseDrillLibrary !== false);
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    if (!userData || busy) return;
    const next = !browse;
    setBusy(true);
    try {
      await updateDocument('users', userData.uid, { browseDrillLibrary: next });
      setBrowse(next);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('drill library pref save failed', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-charcoal-900 rounded-xl border border-white/10 px-4 py-4 flex items-start gap-3">
      <div className="flex-1">
        <p className="text-bone font-bold text-sm">Browse the shared library</p>
        <p className="text-bone/55 text-xs mt-0.5 leading-snug">
          Show the cross-club catalog tab in your drills page. Other coaches' shared drills appear there with ratings.
        </p>
      </div>
      <button
        type="button"
        onClick={flip}
        disabled={busy}
        className={`shrink-0 text-[11px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full transition ${
          browse ? 'bg-brand-primary text-white' : 'bg-white/[0.06] text-bone/65 ring-1 ring-white/15 hover:bg-white/[0.1]'
        }`}
      >
        {busy ? '…' : browse ? 'On' : 'Off'}
      </button>
    </div>
  );
};

export default Settings;
