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
import InviteSystem from '../../pages/InviteSystem';

const Navigation: React.FC = () => {
  const { userData, logout, deleteAccount } = useAuth();
  const { teams, selectedTeamId, selectedTeam, setSelectedTeamId } = useTeam();
  const location = useLocation();
  const [isInviteOpen, setIsInviteOpen] = useState(false);
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

  // Fetch linked player for parents
  const [linkedPlayer, setLinkedPlayer] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!userData?.uid) { setLinkedPlayer(null); return; }
    (async () => {
      try {
        const q = query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
          where('isActive', '==', true)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const first = snap.docs[0];
          setLinkedPlayer({ id: first.id, name: first.data().name });
        } else {
          setLinkedPlayer(null);
        }
      } catch (err) {
        console.error('Error fetching linked player:', err);
      }
    })();
  }, [userData?.uid]);

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

  // Bottom tab items for mobile
  const bottomTabs = [
    {
      name: 'Home',
      path: '/dashboard',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5} d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
        </svg>
      ),
    },
    {
      name: 'Players',
      path: '/players',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
      ),
    },
    {
      name: 'Media',
      path: '/player-media',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18 7.5h.008v.008H18V7.5zM6.75 3h10.5a2.25 2.25 0 012.25 2.25v13.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 18.75V5.25A2.25 2.25 0 016.75 3z" />
        </svg>
      ),
    },
    {
      name: 'Chat',
      path: '/chat',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5} d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      ),
    },
    {
      name: 'More',
      path: '#more',
      icon: (_active: boolean) => (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
      ),
    },
  ];

  // All app items for the sidebar and "More" sheet
  const allNavItems = [
    { name: 'Dashboard', path: '/dashboard', emoji: '🏠', group: 'main' },
    { name: 'Players', path: '/players', emoji: '👥', group: 'main' },
    { name: 'Media', path: '/player-media', emoji: '📸', group: 'main' },
    { name: 'Vote', path: '/player-of-match', emoji: '🏆', group: 'main' },
    ...(linkedPlayer ? [{
      name: linkedPlayer.name.split(' ')[0],
      path: `/player/${linkedPlayer.id}`,
      emoji: '⚽',
      group: 'main' as const,
    }] : []),
    { name: 'Chat', path: '/chat', emoji: '💬', group: 'apps' },
    { name: 'Calendar', path: '/calendar', emoji: '📅', group: 'apps' },
    { name: 'Stats', path: '/stats', emoji: '📊', group: 'apps' },
    { name: 'News', path: '/news', emoji: '📰', group: 'apps' },
    { name: 'Full Games', path: '/full-games', emoji: '🎬', group: 'apps' },
    { name: 'Highlights', path: '/highlights', emoji: '✨', group: 'apps' },
    { name: 'Attendance', path: '/attendance', emoji: '✅', group: 'apps' },
    { name: 'Volunteers', path: '/volunteers', emoji: '🤝', group: 'apps' },
    { name: 'Directory', path: '/directory', emoji: '📞', group: 'apps' },
    { name: 'Development', path: '/development', emoji: '📈', group: 'apps' },
    ...(isUserCoach ? [{ name: 'Game Day', path: `/game-day/quick_${Date.now()}`, emoji: '🎯', group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Practice Plan', path: '/practice-plan', emoji: '🗒️', group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Surveys', path: '/surveys', emoji: '📋', group: 'apps' as const }] : []),
    // Regular coaches (not club admins) keep "Teams" as their direct
    // entry point to edit/create their own teams. Club admins reach the
    // same page from inside /club, so we hide this entry for them to
    // avoid two ways into the same flow.
    ...(isUserCoach && !isUserClubAdmin ? [{ name: 'Teams', path: '/teams', emoji: '⚙️', group: 'apps' as const }] : []),
    // Club admin's single entry point for everything cross-team.
    ...(isUserClubAdmin ? [{ name: 'Club', path: '/club', emoji: '🏛️', group: 'apps' as const }] : []),
  ];

  const mainItems = allNavItems.filter(i => i.group === 'main');
  const appItems = allNavItems.filter(i => i.group === 'apps');
  // The mobile "More" sheet shows everything NOT already in the bottom
  // tab bar (so we don't duplicate Chat, Players, Dashboard, Media) but
  // DOES include the 'main'-group items that aren't bottom tabs (Vote,
  // linkedPlayer) so parents can still reach them on mobile.
  const bottomTabPaths = new Set(['/dashboard', '/players', '/player-media', '/chat', '#more']);
  const moreSheetItems = allNavItems.filter(i => !bottomTabPaths.has(i.path));

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
              <span className="text-lg flex-shrink-0">{item.emoji}</span>
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
              <span className="text-lg flex-shrink-0">{item.emoji}</span>
              {!sidebarCollapsed && <span>{item.name}</span>}
            </Link>
          ))}
        </nav>

        {/* Invite + User at bottom */}
        <div className="p-3 border-t border-white/10 space-y-2">
          {isUserCoach && (
            <button
              onClick={() => setIsInviteOpen(true)}
              className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-2 px-3 py-2.5 rounded-xl text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-fire-950 transition-colors`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              {!sidebarCollapsed && <span>Invite</span>}
            </button>
          )}
          <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-3 px-3 py-2`}>
            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-cyan-400 to-fire-400 flex items-center justify-center text-fire-950 font-bold text-sm flex-shrink-0">
              {userData?.name?.charAt(0).toUpperCase()}
            </div>
            {!sidebarCollapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{userData?.name}</div>
                <div className="flex items-center gap-3 mt-0.5">
                  <button onClick={handleLogout} className="text-xs text-fire-400 hover:text-red-400 transition-colors">
                    Sign out
                  </button>
                  <span className="text-fire-700">·</span>
                  <button
                    onClick={() => { setShowDeleteAccount(true); setDeleteConfirmText(''); setDeleteError(null); }}
                    className="text-xs text-fire-500 hover:text-red-400 transition-colors"
                    title="Permanently delete your account and profile"
                  >
                    Delete account
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ===== MOBILE TOP BAR ===== */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 bg-fire-950 safe-top">
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
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-cyan-400 to-fire-400 flex items-center justify-center text-fire-950 font-bold text-xs">
              {userData?.name?.charAt(0).toUpperCase()}
            </div>
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
                  {tab.icon(active)}
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
                {tab.icon(active)}
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

            {/* Apps Grid */}
            <div className="px-6 py-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Apps</div>
              <div className="grid grid-cols-4 gap-3">
                {moreSheetItems.map(item => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex flex-col items-center p-3 rounded-2xl transition-all ${
                      isActive(item.path)
                        ? 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200'
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <span className="text-2xl mb-1">{item.emoji}</span>
                    <span className="text-[11px] font-medium text-center leading-tight">{item.name}</span>
                  </Link>
                ))}
              </div>
            </div>

            {/* Quick links for parent's player */}
            {linkedPlayer && (
              <div className="px-6 py-3">
                <Link
                  to={`/player/${linkedPlayer.id}`}
                  className="flex items-center space-x-3 p-3 rounded-2xl bg-fire-50 border border-fire-200"
                >
                  <span className="text-2xl">⚽</span>
                  <div>
                    <div className="font-medium text-fire-900">{linkedPlayer.name}</div>
                    <div className="text-xs text-fire-600">View player profile</div>
                  </div>
                </Link>
              </div>
            )}

            {/* Actions */}
            <div className="px-6 py-3 space-y-2 border-t border-gray-100">
              {isUserCoach && (
                <button
                  onClick={() => { setIsInviteOpen(true); setIsMoreOpen(false); }}
                  className="w-full flex items-center space-x-3 p-3 rounded-2xl bg-cyan-50 text-cyan-700 hover:bg-cyan-100 transition-colors"
                >
                  <span className="text-xl">➕</span>
                  <span className="font-medium">Invite Parents</span>
                </button>
              )}
              <button
                onClick={() => { handleLogout(); setIsMoreOpen(false); }}
                className="w-full flex items-center space-x-3 p-3 rounded-2xl text-red-500 hover:bg-red-50 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                </svg>
                <span className="font-medium">Sign out</span>
              </button>
              <button
                onClick={() => { setShowDeleteAccount(true); setDeleteConfirmText(''); setDeleteError(null); setIsMoreOpen(false); }}
                className="w-full flex items-center space-x-3 p-3 rounded-2xl text-red-700 hover:bg-red-50 transition-colors"
                title="Permanently delete your account and profile"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span className="font-medium">Delete account</span>
              </button>
            </div>

            {/* Bottom spacer for safe area */}
            <div className="h-20" />
          </div>
        </div>
      )}

      {/* Invite Modal */}
      <InviteSystem
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
      />

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