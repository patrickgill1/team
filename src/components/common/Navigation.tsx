import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Subscribe to body class changes so React can re-render when TeamChat
// toggles `chat-conversation` (we want to fully unmount the bottom nav
// rather than rely on CSS specificity to hide it).
function useBodyClass(cls: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const obs = new MutationObserver(cb);
      obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      return () => obs.disconnect();
    },
    () => document.body.classList.contains(cls),
    () => false
  );
}
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { isCoach, isClubAdmin } from '../../utils/helpers';
// Legacy InviteSystem import removed — invites now live on /people.
import AppIcon from './AppIcon';

const Navigation: React.FC = () => {
  const { userData, logout, deleteAccount } = useAuth();
  const { teams, selectedTeamId, selectedTeam, setSelectedTeamId } = useTeam();
  const location = useLocation();
  // isInviteOpen state removed with the legacy modal.
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteAccount = async () => {
    if (deleteConfirmText.trim().toLowerCase() !== 'delete') {
      setDeleteError('Type DELETE to confirm.');
      return;
    }
    setDeletingAccount(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      // user object cleared in context; ProtectedRoute will boot us to /auth.
    } catch (err: any) {
      setDeleteError(err?.message || 'Could not delete account. Please try again.');
    } finally {
      setDeletingAccount(false);
    }
  };

  const isUserCoach = userData ? isCoach(userData.role) : false;
  const isUserClubAdmin = isClubAdmin(userData);
  // When inside a chat conversation, TeamChat sets body.chat-conversation.
  // We unmount the bottom tab bar entirely so the composer can dock at the
  // viewport edge without the tab bar rising with the keyboard.
  const inChatConversation = useBodyClass('chat-conversation');

  // Fetch every player linked to this user (parents of multi-kid
  // families have, well, multiple). We surface all of them in the More
  // sheet + Settings so a parent never has to "switch contexts" just
  // to see their second kid.
  const [linkedPlayers, setLinkedPlayers] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!userData?.uid) { setLinkedPlayers([]); return; }
    (async () => {
      try {
        const q = query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
          where('isActive', '==', true)
        );
        const snap = await getDocs(q);
        const rows = snap.docs.map(d => ({ id: d.id, name: (d.data() as any).name || 'Player' }));
        setLinkedPlayers(rows);
      } catch (err) {
        console.error('Error fetching linked players:', err);
      }
    })();
  }, [userData?.uid]);
  const linkedPlayer = linkedPlayers[0] || null; // back-compat for old refs

  // Close more menu on route change
  useEffect(() => {
    setIsMoreOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  // Bottom tab items for mobile. Active state is conveyed by color +
  // a slightly heavier stroke — no fill-swap (which caused the Media
  // icon to render as a solid blob because Lucide image paths have
  // interior shapes that disappear when filled).
  const bottomTabs: Array<{ name: string; path: string; icon: import('./AppIcon').AppIconName }> = [
    { name: 'Home', path: '/dashboard', icon: 'home' },
    // "Events" is the most-tapped surface (parents check "what's next"
    // multiple times a day). Bumped Players to the More sheet.
    { name: 'Events', path: '/calendar', icon: 'calendar' },
    { name: 'Media', path: '/player-media', icon: 'media' },
    { name: 'Chat', path: '/chat', icon: 'chat' },
    { name: 'More', path: '#more', icon: 'menu' },
  ];

  // All app items for the sidebar and "More" sheet. `icon` is an
  // AppIcon name — kept consistent (single stroke weight, outline)
  // across nav and Settings to match the cleaner Ollie-style look.
  const allNavItems: Array<{ name: string; path: string; icon: any; group: 'main' | 'apps' | 'account' }> = [
    { name: 'Dashboard', path: '/dashboard', icon: 'home', group: 'main' },
    { name: 'Players', path: '/players', icon: 'players', group: 'main' },
    // People directory is staff-only — parents don't see it surfaced
    // in the nav (and the page itself enforces the same guard).
    ...(isUserCoach || isUserClubAdmin
      ? [{ name: 'People', path: '/people', icon: 'phone' as const, group: 'main' as const }]
      : []),
    { name: 'Media', path: '/player-media', icon: 'media', group: 'main' },
    { name: 'Vote', path: '/player-of-match', icon: 'trophy', group: 'main' },
    // Multi-kid: each linked player gets their own shortcut. Use full
    // name (not split) so two kids with the same first name still
    // disambiguate (rare but happens — siblings nicknames overlap).
    ...linkedPlayers.map(p => ({
      name: p.name.split(' ')[0],
      path: `/player/${p.id}`,
      icon: 'soccer' as const,
      group: 'main' as const,
    })),
    { name: 'Chat', path: '/chat', icon: 'chat', group: 'apps' },
    { name: 'Wall', path: '/wall', icon: 'news', group: 'apps' },
    { name: 'Calendar', path: '/calendar', icon: 'calendar', group: 'apps' },
    { name: 'Stats', path: '/stats', icon: 'stats', group: 'apps' },
    { name: 'News', path: '/news', icon: 'news', group: 'apps' },
    { name: 'Full Games', path: '/full-games', icon: 'film', group: 'apps' },
    { name: 'Highlights', path: '/highlights', icon: 'highlight', group: 'apps' },
    { name: 'Attendance', path: '/attendance', icon: 'check', group: 'apps' },
    { name: 'Volunteers', path: '/volunteers', icon: 'handshake', group: 'apps' },
    { name: 'Directory', path: '/directory', icon: 'phone', group: 'apps' },
    { name: 'Development', path: '/development', icon: 'chart', group: 'apps' },
    ...(isUserCoach ? [{ name: 'Game Day', path: `/game-day/quick_${Date.now()}`, icon: 'whistle' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Practice Plan', path: '/practice-plan', icon: 'clipboard' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Surveys', path: '/surveys', icon: 'survey' as const, group: 'apps' as const }] : []),
    // Regular coaches (not club admins) keep "Teams" as their direct
    // entry point to edit/create their own teams. Club admins reach the
    // same page from inside /club, so we hide this entry for them to
    // avoid two ways into the same flow.
    ...(isUserCoach && !isUserClubAdmin ? [{ name: 'Teams', path: '/teams', icon: 'wrench' as const, group: 'apps' as const }] : []),
    // Club admin's single entry point for everything cross-team.
    ...(isUserClubAdmin ? [{ name: 'Club', path: '/club', icon: 'club' as const, group: 'apps' as const }] : []),
    { name: 'Club Support', path: '/helpdesk', icon: 'survey', group: 'account' },
    { name: 'Settings', path: '/settings', icon: 'gear', group: 'account' },
  ];

  const mainItems = allNavItems.filter(i => i.group === 'main');
  const appItems = allNavItems.filter(i => i.group === 'apps');

  // The mobile "More" sheet groups everything NOT already in the bottom
  // tab bar into logical sections so a parent looking for "Stats" or a
  // coach looking for "Practice Plan" can find them by category, not
  // by scanning a wall of 16 tiles.
  const bottomTabPaths = new Set(['/dashboard', '/calendar', '/player-media', '/chat', '#more']);
  const inSheet = (path: string) => !bottomTabPaths.has(path);
  const findItem = (name: string) => allNavItems.find(i => i.name === name);

  const moreSections: { label: string; items: typeof allNavItems }[] = [
    {
      label: 'Schedule',
      items: ['Calendar', 'Attendance']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Players & stats',
      items: [
        // Each linked kid gets their own entry — multi-kid families
        // see both, not just the first one Firestore returned.
        ...linkedPlayers.map(p => p.name.split(' ')[0]),
        'Players', 'Vote', 'Stats', 'Development',
      ].map((n) => findItem(n as string)).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Media',
      items: ['Full Games', 'Highlights']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Communications',
      items: ['News', 'Surveys', 'Volunteers', 'Directory']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Coach tools',
      items: ['Game Day', 'Practice Plan']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Admin',
      items: ['Teams', 'Club']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
  ].filter(s => s.items.length > 0);

  const isActive = (path: string) => location.pathname === path;

  return (
    <>
      {/* ===== DESKTOP SIDEBAR ===== */}
      <aside className={`hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 z-40 transition-all duration-300 ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'} bg-fire-950`}>
        {/* Logo + Collapse Toggle */}
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <Link to="/dashboard" className="flex items-center space-x-3">
            <img src="/images/logo.png" alt="Fire FC" className="h-10 w-10 object-contain" />
            {!sidebarCollapsed && (
              <span className="text-white font-bold text-lg tracking-wide">Fire FC</span>
            )}
          </Link>
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="text-fire-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
          >
            <svg className={`w-5 h-5 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Team Selector */}
        {!sidebarCollapsed && (
          <div className="px-4 pb-4">
            {teams.length > 1 ? (
              <select
                value={selectedTeamId}
                onChange={e => setSelectedTeamId(e.target.value)}
                className="w-full text-sm bg-white/10 text-fire-200 border border-white/10 rounded-lg px-3 py-2 focus:ring-2 focus:ring-cyan-400 focus:border-transparent"
              >
                {teams.map(t => (
                  <option key={t.id} value={t.id} className="bg-fire-950 text-white">{t.name}</option>
                ))}
              </select>
            ) : selectedTeam ? (
              <div className="text-sm text-fire-400 px-1">{selectedTeam.name}</div>
            ) : null}
          </div>
        )}

        {/* Scrollable Nav */}
        <nav className="flex-1 overflow-y-auto px-3 space-y-1">
          {/* Main section */}
          {!sidebarCollapsed && (
            <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fire-500">
              Main
            </div>
          )}
          {mainItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              title={sidebarCollapsed ? item.name : undefined}
              className={`flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                isActive(item.path)
                  ? 'bg-cyan-500/20 text-cyan-300 shadow-lg shadow-cyan-500/10'
                  : 'text-fire-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <AppIcon name={item.icon as any} className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />
              {!sidebarCollapsed && <span>{item.name}</span>}
            </Link>
          ))}

          {/* Apps section */}
          {!sidebarCollapsed && (
            <div className="px-2 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fire-500">
              Apps
            </div>
          )}
          {sidebarCollapsed && <div className="border-t border-white/10 my-3" />}
          {appItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              title={sidebarCollapsed ? item.name : undefined}
              className={`flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                isActive(item.path)
                  ? 'bg-cyan-500/20 text-cyan-300 shadow-lg shadow-cyan-500/10'
                  : 'text-fire-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <AppIcon name={item.icon as any} className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />
              {!sidebarCollapsed && <span>{item.name}</span>}
            </Link>
          ))}
        </nav>

        {/* Invite + User at bottom */}
        <div className="p-3 border-t border-white/10 space-y-2">
          {isUserCoach && (
            <Link
              to="/people"
              className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-2 px-3 py-2.5 rounded-xl text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-fire-950 transition-colors`}
              title="Add a player or invite someone"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              {!sidebarCollapsed && <span>Add / Invite</span>}
            </Link>
          )}
          <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-3 px-3 py-2`}>
            <Link
              to="/settings"
              aria-label="Settings"
              className="h-9 w-9 rounded-full overflow-hidden bg-gradient-to-br from-cyan-400 to-fire-400 flex items-center justify-center text-fire-950 font-bold text-sm flex-shrink-0"
            >
              {userData?.photoURL ? (
                <img src={userData.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                userData?.name?.charAt(0).toUpperCase()
              )}
            </Link>
            {!sidebarCollapsed && (
              <div className="flex-1 min-w-0">
                <Link to="/settings" className="text-sm font-medium text-white truncate block hover:text-cyan-300 transition-colors">
                  {userData?.name}
                </Link>
                <div className="flex items-center gap-3 mt-0.5">
                  <Link to="/settings" className="text-xs text-fire-400 hover:text-white transition-colors">
                    Settings
                  </Link>
                  <span className="text-fire-700">·</span>
                  <button onClick={handleLogout} className="text-xs text-fire-400 hover:text-red-400 transition-colors">
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ===== MOBILE TOP BAR ===== */}
      {/* No safe-top here on purpose: the native shell (Capacitor
          StatusBar.setOverlaysWebView({overlay:false}) on iOS +
          MainActivity inset padding on Android) already positions
          the WebView BELOW the system bar, so env(safe-area-inset-top)
          inside the WebView is 0 on iOS / unreliable on Android.
          Doubling it here produced a tall empty navy strip above
          the logo on Samsung tablets. */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 bg-fire-950">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/dashboard" className="flex items-center space-x-2">
            <img src="/images/logo.png" alt="Fire FC" className="h-8 w-8 object-contain" />
            <span className="text-white font-bold text-base">{selectedTeam?.name || 'Fire FC'}</span>
          </Link>
          <div className="flex items-center space-x-2">
            {teams.length > 1 && (
              <select
                value={selectedTeamId}
                onChange={e => setSelectedTeamId(e.target.value)}
                className="text-xs bg-white/10 text-fire-200 border border-white/10 rounded-lg px-2 py-1.5 max-w-[120px]"
              >
                {teams.map(t => (
                  <option key={t.id} value={t.id} className="bg-fire-950">{t.name}</option>
                ))}
              </select>
            )}
            <Link
              to="/settings"
              aria-label="Settings"
              className="h-8 w-8 rounded-full overflow-hidden flex items-center justify-center text-fire-950 font-bold text-xs bg-gradient-to-br from-cyan-400 to-fire-400 ring-1 ring-white/20"
            >
              {userData?.photoURL ? (
                <img src={userData.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                userData?.name?.charAt(0).toUpperCase()
              )}
            </Link>
          </div>
        </div>
      </header>

      {/* ===== MOBILE BOTTOM TAB BAR ===== */}
      {!inChatConversation && (
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-50 bg-white border-t border-gray-200 safe-bottom">
        <div className="flex justify-around items-center h-12 max-w-lg mx-auto">
          {bottomTabs.map(tab => {
            const active = tab.path === '#more' ? isMoreOpen : isActive(tab.path);
            if (tab.path === '#more') {
              return (
                <button
                  key={tab.name}
                  onClick={() => setIsMoreOpen(!isMoreOpen)}
                  className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${
                    active ? 'text-cyan-600' : 'text-gray-400'
                  }`}
                >
                  <AppIcon name={tab.icon} className="w-6 h-6" strokeWidth={active ? 2.25 : 1.75} />
                  <span className="text-[10px] mt-0.5 font-medium">{tab.name}</span>
                </button>
              );
            }
            return (
              <Link
                key={tab.name}
                to={tab.path}
                className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${
                  active ? 'text-cyan-600' : 'text-gray-400'
                }`}
              >
                <AppIcon name={tab.icon} className="w-6 h-6" strokeWidth={active ? 2.25 : 1.75} />
                <span className="text-[10px] mt-0.5 font-medium">{tab.name}</span>
              </Link>
            );
          })}
        </div>
      </nav>
      )}

      {/* ===== MOBILE "MORE" SHEET ===== */}
      {isMoreOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-fire-950/60 backdrop-blur-sm"
            onClick={() => setIsMoreOpen(false)}
          />
          {/* Sheet */}
          <div className="absolute bottom-0 inset-x-0 bg-white rounded-t-3xl max-h-[85vh] overflow-y-auto animate-slide-up safe-bottom">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-gray-300" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center space-x-3">
                <img src="/images/logo.png" alt="Fire FC" className="h-8 w-8 object-contain" />
                <div>
                  <div className="font-bold text-fire-950">{selectedTeam?.name || 'Fire FC'}</div>
                  <div className="text-xs text-gray-500">{userData?.name}</div>
                </div>
              </div>
              <button
                onClick={() => setIsMoreOpen(false)}
                className="p-2 rounded-full hover:bg-gray-100 text-gray-400"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Team Selector */}
            {teams.length > 1 && (
              <div className="px-6 pb-3">
                <select
                  value={selectedTeamId}
                  onChange={e => setSelectedTeamId(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-gray-50 text-gray-700 focus:ring-2 focus:ring-cyan-500"
                >
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Sectioned list — consistent outline icons in a tinted
                square, single-column rows like Ollie's Tools page.
                Sections are filtered to only render when they actually
                have items for this user's role. */}
            <div className="px-4 py-2 space-y-5">
              {moreSections.map((section) => (
                <div key={section.label}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2 px-2">
                    {section.label}
                  </div>
                  <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden divide-y divide-gray-100">
                    {section.items.map((item) => {
                      const active = isActive(item.path);
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          onClick={() => setIsMoreOpen(false)}
                          className={`flex items-center justify-between px-4 py-3 transition ${active ? 'bg-cyan-50' : 'hover:bg-gray-50'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-cyan-100 text-cyan-700' : 'bg-cyan-50 text-cyan-700'}`}>
                              <AppIcon name={item.icon as any} className="w-5 h-5" />
                            </span>
                            <span className={`text-[15px] font-semibold truncate ${active ? 'text-cyan-800' : 'text-gray-900'}`}>{item.name}</span>
                          </span>
                          <AppIcon name="arrow-right" className="w-4 h-4 text-gray-300 shrink-0" />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Account section */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2 px-2">
                  Account
                </div>
                <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden divide-y divide-gray-100">
                  <Link
                    to="/helpdesk"
                    onClick={() => setIsMoreOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-cyan-50 text-cyan-700 flex items-center justify-center shrink-0">
                        <AppIcon name="survey" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-gray-900">Club Support</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-gray-300" />
                  </Link>
                  <Link
                    to="/settings"
                    onClick={() => setIsMoreOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-cyan-50 text-cyan-700 flex items-center justify-center shrink-0">
                        <AppIcon name="gear" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-gray-900">Settings</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-gray-300" />
                  </Link>
                  {/* "Invite Parents" used to live here as a separate
                      legacy modal. It's been replaced by the unified
                      flow on /people (+ chooser → Add player / Invite
                      someone) so we don't surface a second entry point
                      with worse UX. */}
                  <button
                    onClick={() => { handleLogout(); setIsMoreOpen(false); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition text-left"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">
                        <AppIcon name="logout" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-gray-900">Sign Out</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-gray-300" />
                  </button>
                  <button
                    onClick={() => { setShowDeleteAccount(true); setDeleteConfirmText(''); setDeleteError(null); setIsMoreOpen(false); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-rose-50 transition text-left"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                        <AppIcon name="trash" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-rose-700">Delete account</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-rose-200" />
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom spacer for safe area */}
            <div className="h-20" />
          </div>
        </div>
      )}

      {/* InviteSystem modal removed — the unified flow now lives on
          /people (+ chooser → Add player / Invite someone). The
          desktop sidebar "Add / Invite" button + the mobile More-sheet
          "People" link both route there. */}

      {/* Delete Account confirmation modal — required by App Store guideline 5.1.1(v) */}
      {showDeleteAccount && (
        <div
          className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
          onClick={() => !deletingAccount && setShowDeleteAccount(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="bg-red-50 border-b border-red-100 px-5 py-4">
              <h2 className="text-lg font-bold text-red-900 flex items-center gap-2">
                <span>⚠️</span> Delete your account?
              </h2>
            </div>
            <div className="p-5 space-y-3 text-sm text-gray-700">
              <p>
                This will permanently delete your <strong>Fire FC account</strong>:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-gray-600">
                <li>Your profile, name, email, and phone number are removed.</li>
                <li>You'll be signed out and unable to access this team.</li>
                <li>You can sign up again with the same email later.</li>
              </ul>
              <p className="text-xs text-gray-500">
                Team-shared content you uploaded (photos, messages, RSVPs) stays
                visible to the team — that's content the team owns. Contact your
                coach if you want it removed too.
              </p>

              <div className="pt-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 mb-1.5">
                  Type DELETE to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder="DELETE"
                  autoCapitalize="characters"
                  className="w-full px-3 py-2 rounded-lg border-2 border-gray-200 text-sm focus:outline-none focus:border-red-400 disabled:opacity-50"
                  disabled={deletingAccount}
                />
                {deleteError && (
                  <p className="text-red-600 text-xs mt-2">{deleteError}</p>
                )}
              </div>
            </div>
            <div className="bg-gray-50 px-5 py-3 flex justify-end gap-2 border-t border-gray-100">
              <button
                onClick={() => setShowDeleteAccount(false)}
                disabled={deletingAccount}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deletingAccount || deleteConfirmText.trim().toLowerCase() !== 'delete'}
                className="px-4 py-2 rounded-lg text-sm font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deletingAccount ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Navigation;