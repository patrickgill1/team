import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { VOCAB } from '../../vocab';
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
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import WallHeaderButton from './WallHeaderButton';
import ProfileMenuSheet from './ProfileMenuSheet';
import ChatHeaderButton from './ChatHeaderButton';
import { useTeam } from '../../contexts/TeamContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { useClubStore } from '../../hooks/useClubStore';
import { isCoach, isClubAdmin } from '../../utils/helpers';
import { useTheme } from '../../contexts/ThemeContext';
// Legacy InviteSystem import removed — invites now live on /people.
import AppIcon from './AppIcon';

const Navigation: React.FC = () => {
  const { userData, logout, deleteAccount } = useAuth();
  const { teams, selectedTeamId, selectedTeam, setSelectedTeamId } = useTeam();
  const { hasStore } = useClubStore((selectedTeam as any)?.clubId || null);
  const { resolved: resolvedTheme } = useTheme();
  const location = useLocation();
  // isInviteOpen state removed with the legacy modal.
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isProfileSheetOpen, setIsProfileSheetOpen] = useState(false);
  const [teamSwitcherOpen, setTeamSwitcherOpen] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebar();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [wordmarkFailed, setWordmarkFailed] = useState(false);

  useEffect(() => {
    setWordmarkFailed(false);
  }, [resolvedTheme]);

  const wordmarkSrc = resolvedTheme === 'light'
    ? '/images/logo-wordmark-light.png'
    : '/images/logo-wordmark.png';

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
  const [linkedPlayers, setLinkedPlayers] = useState<Array<{ id: string; name: string; teamName?: string }>>([]);
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
        // Dedup by document id — defensive. Only one Firestore doc
        // should ever appear per id, but Patrick was seeing duplicate
        // player tiles in the More sheet, so we lock it down here.
        const rawById = new Map<string, { id: string; name: string; teamId: any }>();
        for (const d of snap.docs) {
          if (rawById.has(d.id)) continue;
          rawById.set(d.id, {
            id: d.id,
            name: (d.data() as any).name || 'Player',
            teamId: (d.data() as any).teamId,
          });
        }
        const raws = Array.from(rawById.values());
        // Resolve team names so duplicate-name players (e.g. two
        // "Hunter Gill" docs from a re-registration) can be told
        // apart in the More sheet. Without this, parents see two
        // identical "Hunter" tiles and tap blind.
        const teamIds = Array.from(new Set(raws.map(r => r.teamId).filter(Boolean) as string[]));
        const teamNameById = new Map<string, string>();
        await Promise.all(teamIds.map(async (tid) => {
          try {
            // Direct doc read — was `where('__name__', '==', tid)`
            // which silently returns empty in the Firestore Web SDK,
            // so the team-name suffix never showed up.
            const tSnap = await getDoc(doc(db, 'teams', tid));
            if (tSnap.exists()) teamNameById.set(tid, (tSnap.data() as any).name || '');
          } catch { /* ignore */ }
        }));
        // Detect duplicate names — we'll suffix the team name only
        // when there's an ambiguity, so single-kid families don't
        // get noisy labels.
        const nameCounts = new Map<string, number>();
        for (const r of raws) nameCounts.set(r.name, (nameCounts.get(r.name) || 0) + 1);
        const rows = raws.map(r => ({
          id: r.id,
          name: r.name,
          teamName: (nameCounts.get(r.name) || 0) > 1 ? teamNameById.get(r.teamId || '') : undefined,
        }));
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
    // Wall lives in the header megaphone now (see WallHeaderButton).
    // Always one tap away from any page; bottom-tab slot freed up.
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
    { name: VOCAB.teamHq, path: '/dashboard', icon: 'home', group: 'main' },
    { name: VOCAB.squad, path: '/players', icon: 'players', group: 'main' },
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
      // When two linked players share a first name (the duplicate-
      // Hunter case), suffix the team name so each tile is
      // distinguishable. Single-kid families keep the clean name.
      name: p.teamName ? `${p.name.split(' ')[0]} · ${p.teamName}` : p.name.split(' ')[0],
      path: `/player/${p.id}`,
      icon: 'soccer' as const,
      group: 'main' as const,
    })),
    { name: 'Chat', path: '/chat', icon: 'chat', group: 'apps' },
    { name: 'Mentions', path: '/mentions', icon: 'highlight', group: 'apps' },
    { name: 'Wall', path: '/wall', icon: 'news', group: 'apps' },
    // Team Store only shows when the active club has a storeUrl set.
    // Empty-state-as-nav-entry felt like clutter on clubs that don't
    // run a store. Patrick 2026-06-25.
    ...(hasStore ? [{ name: 'Team Store', path: '/store', icon: 'soccer' as const, group: 'apps' as const }] : []),
    { name: 'Events', path: '/calendar', icon: 'calendar', group: 'apps' },
    { name: 'Stats', path: '/stats', icon: 'stats', group: 'apps' },
    { name: 'Full Games', path: '/full-games', icon: 'film', group: 'apps' },
    { name: 'Highlights', path: '/highlights', icon: 'highlight', group: 'apps' },
    { name: 'Attendance', path: '/attendance', icon: 'check', group: 'apps' },
    { name: 'Volunteers', path: '/volunteers', icon: 'handshake', group: 'apps' },
    { name: 'Directory', path: '/directory', icon: 'phone', group: 'apps' },
    { name: 'Development', path: '/development', icon: 'chart', group: 'apps' },
    ...(isUserCoach ? [{ name: 'Game Day', path: `/game-day/quick_${Date.now()}`, icon: 'whistle' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Practice Plan', path: '/practice-plan', icon: 'clipboard' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Surveys', path: '/surveys', icon: 'survey' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Equipment', path: '/equipment', icon: 'check' as const, group: 'apps' as const }] : []),
    ...(isUserCoach ? [{ name: 'Drills', path: '/drills', icon: 'clipboard' as const, group: 'apps' as const }] : []),
    // Regular coaches (not club admins) keep "Teams" as their direct
    // entry point to edit/create their own teams. Club admins reach the
    // same page from inside /club, so we hide this entry for them to
    // avoid two ways into the same flow.
    ...(isUserCoach && !isUserClubAdmin ? [{ name: 'Teams', path: '/teams', icon: 'wrench' as const, group: 'apps' as const }] : []),
    // Coach cockpit — scaffold landing for coaches, mirror of /club
    // for admins. Patrick 2026-06-21: 'as a coach, I would love
    // options to manage my team from one page.' Visible to anyone
    // with the coach role (including coach+admin multi-role users).
    ...(isUserCoach ? [{ name: 'Coach', path: '/coach', icon: 'wrench' as const, group: 'apps' as const }] : []),
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
  // Lookup tolerates renames: a moreSections entry that uses an old
  // label (e.g. 'Players' after renaming to 'Squad') falls back to
  // matching the path so it doesn't silently drop out of the menu.
  // Patrick caught this when the vocab swagger rename made Players
  // vanish from More.
  const PATH_ALIASES: Record<string, string> = {
    'Players':   '/players',
    'Dashboard': '/dashboard',
    'Calendar':  '/calendar',
    'Vote':      '/player-of-match',
    'Stats':     '/stats',
    'Wall':      '/wall',
  };
  const findItem = (name: string) => {
    const direct = allNavItems.find(i => i.name === name);
    if (direct) return direct;
    const aliasPath = PATH_ALIASES[name];
    if (aliasPath) return allNavItems.find(i => i.path === aliasPath);
    return undefined;
  };

  const moreSections: { label: string; items: typeof allNavItems }[] = [
    {
      label: 'Schedule',
      items: ['Events', 'Attendance']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Players & stats',
      items: [
        // Each linked kid gets their own entry — multi-kid families
        // see both, not just the first one Firestore returned.
        ...linkedPlayers.map(p => p.name.split(' ')[0]),
        VOCAB.squad, 'Vote', 'Stats', 'Development',
      ].map((n) => findItem(n as string)).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Media',
      items: ['Full Games', 'Highlights']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Communications',
      items: ['Wall', 'Surveys', 'Volunteers', 'Directory']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      label: 'Team',
      items: ['Team Store']
        .map(findItem).filter(Boolean).filter((i: any) => inSheet(i.path)) as typeof allNavItems,
    },
    {
      // Renamed 'Coach tools' → 'Coach' so the new cockpit landing
      // entry can sit at the top of the section alongside the granular
      // tools beneath it. Patrick 2026-06-21 reported 'not seeing the
      // coach option' — the mobile More drawer renders moreSections
      // (hand-curated), not appItems, so adding to appItems alone was
      // insufficient. Including 'Coach' here surfaces it in the drawer.
      label: 'Coach',
      items: ['Coach', 'Game Day', 'Practice Plan', 'Drills', 'Equipment']
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
      <aside className={`hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 z-40 transition-all duration-300 ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'} bg-surface-base`}>
        {/* Logo + Collapse Toggle */}
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <Link to="/dashboard" className="flex items-center space-x-3">
            <img src="/images/logo.png" alt="GoalKickr" className="h-10 w-10 object-contain" />
            {!sidebarCollapsed && (
              <span className="text-ink-primary font-bold text-lg tracking-wide">GoalKickr</span>
            )}
          </Link>
          <button
            onClick={toggleSidebar}
            className="text-brand-primary-soft hover:text-ink-primary p-1 rounded-lg hover:bg-line-default/10 transition-colors"
          >
            <svg className={`w-5 h-5 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Team Selector — same active/archived split as mobile */}
        {!sidebarCollapsed && (() => {
          const activeTeams = teams.filter(t => (t as any).isActive !== false);
          const archivedTeams = teams.filter(t => (t as any).isActive === false);
          const currentIsArchived = teams.find(t => t.id === selectedTeamId && (t as any).isActive === false);
          const visibleTeams = (archivedExpanded || currentIsArchived)
            ? [...activeTeams, ...archivedTeams]
            : activeTeams;
          if (visibleTeams.length <= 1 && archivedTeams.length === 0) {
            return selectedTeam ? (
              <div className="px-4 pb-4">
                <div className="text-sm text-brand-primary-soft px-1">{selectedTeam.name}</div>
              </div>
            ) : null;
          }
          return (
            <div className="px-4 pb-4 space-y-1">
              <select
                value={selectedTeamId}
                onChange={e => setSelectedTeamId(e.target.value)}
                className="w-full text-sm bg-line-default/10 text-ink-primary border border-line-default/10 rounded-lg px-3 py-2 focus:ring-2 focus:ring-brand-primary-soft focus:border-transparent"
              >
                {visibleTeams.map(t => (
                  <option key={t.id} value={t.id} className="bg-surface-base text-ink-primary">
                    {(t as any).isActive === false ? `${t.name} (archived)` : t.name}
                  </option>
                ))}
              </select>
              {archivedTeams.length > 0 && !currentIsArchived && (
                <button
                  type="button"
                  onClick={() => setArchivedExpanded(v => !v)}
                  className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 hover:text-ink-primary/80 px-1"
                >
                  {archivedExpanded ? 'Hide archived teams' : `Show ${archivedTeams.length} archived`}
                </button>
              )}
            </div>
          );
        })()}

        {/* Scrollable Nav */}
        <nav className="flex-1 overflow-y-auto px-3 space-y-1">
          {/* Main section */}
          {!sidebarCollapsed && (
            <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-brand-primary">
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
                  ? 'bg-brand-primary/20 text-brand-primary-soft shadow-lg shadow-brand-primary/10'
                  : 'text-brand-primary-soft hover:bg-line-default/5 hover:text-ink-primary'
              }`}
            >
              <AppIcon name={item.icon as any} className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />
              {!sidebarCollapsed && <span>{item.name}</span>}
            </Link>
          ))}

          {/* Apps section */}
          {!sidebarCollapsed && (
            <div className="px-2 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-brand-primary">
              Apps
            </div>
          )}
          {sidebarCollapsed && <div className="border-t border-line-default/10 my-3" />}
          {appItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              title={sidebarCollapsed ? item.name : undefined}
              className={`flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                isActive(item.path)
                  ? 'bg-brand-primary/20 text-brand-primary-soft shadow-lg shadow-brand-primary/10'
                  : 'text-brand-primary-soft hover:bg-line-default/5 hover:text-ink-primary'
              }`}
            >
              <AppIcon name={item.icon as any} className="w-5 h-5 flex-shrink-0" strokeWidth={1.75} />
              {!sidebarCollapsed && <span>{item.name}</span>}
            </Link>
          ))}
        </nav>

        {/* Invite + User at bottom */}
        <div className="p-3 border-t border-line-default/10 space-y-2">
          {isUserCoach && (
            <Link
              to="/people"
              className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center' : ''} space-x-2 px-3 py-2.5 rounded-xl text-sm font-medium bg-brand-primary hover:bg-brand-primary-soft text-charcoal-950 transition-colors`}
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
              className="h-9 w-9 rounded-full overflow-hidden bg-gradient-to-br from-brand-primary-soft to-brand-primary-soft flex items-center justify-center text-charcoal-950 font-bold text-sm flex-shrink-0"
            >
              {userData?.photoURL ? (
                <img src={userData.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                userData?.name?.charAt(0).toUpperCase()
              )}
            </Link>
            {!sidebarCollapsed && (
              <div className="flex-1 min-w-0">
                <Link to="/settings" className="text-sm font-medium text-ink-primary truncate block hover:text-brand-primary-soft transition-colors">
                  {userData?.name}
                </Link>
                <div className="flex items-center gap-3 mt-0.5">
                  <Link to="/settings" className="text-xs text-brand-primary-soft hover:text-ink-primary transition-colors">
                    Settings
                  </Link>
                  <span className="text-charcoal-700">·</span>
                  <button onClick={handleLogout} className="text-xs text-brand-primary-soft hover:text-red-400 transition-colors">
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
      {/* Mobile top header — solid fire-950. We tried frosted-blur
          (bleed-through over the hero photo on dashboard) but on
          other tabs (chat, etc) where there's no photo behind it,
          the blur over the page bg reads as washed-out grey, which
          Patrick called out. Solid navy bleeds into the dark hero
          photos naturally AND looks correct on every other tab. */}
      {/* On the dashboard, the chrome blends into the stadium hero
          photo instead of stamping a solid dark band on top of it.
          Patrick: "after login it looks like the app is incomplete
          because it is so dark on top. bleed the soccer photo up."
          Other pages keep the solid bg so chat / wall / events
          still have a defined chrome edge. */}
      {/* Flat charcoal-800 chrome on every route. The next-event
          photo no longer lives behind the chrome — it's the bg of
          the NextEventPoster card BELOW the chrome — so there's no
          "let the photo bleed through" tension. Chrome reads as
          iOS chrome, end of debate. */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 safe-top bg-surface-input">
        <div className="flex items-center gap-2 px-3 h-14 bg-surface-input">
          {/* Brand — use only checked-in official art. A separate
              light-mode wordmark can be dropped in once the exported
              SVG/PNG contains visible paths/pixels. */}
          <Link to="/dashboard" className="shrink-0 inline-flex items-center" aria-label="GoalKickr home">
            <img
              src={wordmarkFailed ? '/images/logo.png' : wordmarkSrc}
              alt="GoalKickr"
              className={wordmarkFailed ? 'h-8 w-8 object-contain' : 'h-7 w-auto max-w-[150px] object-contain'}
              onError={() => setWordmarkFailed(true)}
            />
          </Link>

          {/* Team switcher — compact text-only chip pinned next to
              the wordmark. Was previously flex-1 which made the chip
              fill the entire center of the nav like an oversized
              pill; the trigger felt bigger than the dropdown it
              opened. Now it's a content-sized chevron-only affordance
              that reads as "(currently on) U10 Boys" without claiming
              the whole header. The vertical divider in front
              separates brand from team context. */}
          {selectedTeam && (
            <>
              <span className="h-5 w-px bg-line-default/15 shrink-0" aria-hidden />
              {teams.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setTeamSwitcherOpen(true)}
                  className="min-w-0 inline-flex items-center gap-1 text-ink-primary/85 hover:text-ink-primary transition"
                  aria-label="Switch team"
                >
                  <span className="font-semibold text-sm truncate max-w-[140px]">{selectedTeam.name}</span>
                  <svg className="w-3 h-3 text-charcoal-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              ) : (
                <span className="min-w-0 font-semibold text-sm text-ink-primary/85 truncate max-w-[140px]">{selectedTeam.name}</span>
              )}
            </>
          )}

          <div className="ml-auto shrink-0 flex items-center gap-2">
            <WallHeaderButton />
            <ChatHeaderButton />
            <button
              type="button"
              onClick={() => setIsProfileSheetOpen(true)}
              aria-label="Profile menu"
              className="h-8 w-8 rounded-full overflow-hidden flex items-center justify-center text-charcoal-950 font-bold text-xs bg-gradient-to-br from-brand-primary-soft to-brand-primary-soft ring-1 ring-line-default/20 hover:ring-line-default/40 transition"
            >
              {userData?.photoURL ? (
                <img src={userData.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                userData?.name?.charAt(0).toUpperCase()
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Team-switcher sheet — drops down from the top of the screen
          so it visually attaches to the chip in the nav that opens
          it. Was originally sliding up from the bottom, which felt
          disconnected from the tap target. */}
      {teamSwitcherOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/55 flex items-start justify-center animate-fade-in"
          onClick={() => setTeamSwitcherOpen(false)}
        >
          <div
            className="bg-surface-elevated w-full rounded-b-2xl shadow-2xl overflow-hidden animate-sheet-down"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between">
              <span className="w-12" aria-hidden />
              <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">Switch team</div>
              <button
                type="button"
                onClick={() => setTeamSwitcherOpen(false)}
                className="text-[11px] font-extrabold tracking-widest uppercase text-charcoal-400 hover:text-ink-primary"
              >
                Close
              </button>
            </div>
            {(() => {
              const activeTeams = teams.filter(t => (t as any).isActive !== false);
              const archivedTeams = teams.filter(t => (t as any).isActive === false);
              const currentIsArchived = teams.find(t => t.id === selectedTeamId && (t as any).isActive === false);
              const showArchived = archivedExpanded || !!currentIsArchived;
              const renderRow = (t: typeof teams[number], archived: boolean) => {
                const isCurrent = t.id === selectedTeamId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTeamId(t.id);
                        setTeamSwitcherOpen(false);
                      }}
                      className={`w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-line-default/5 active:bg-line-default/10 transition-colors ${
                        isCurrent ? 'bg-brand-primary/10' : ''
                      } ${archived && !isCurrent ? 'opacity-55' : ''}`}
                    >
                      <span className={`text-[15px] font-bold truncate flex items-center gap-2 ${isCurrent ? 'text-brand-primary-soft' : 'text-ink-primary'}`}>
                        {t.name}
                        {archived && (
                          <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-line-default/[0.08] text-ink-primary/55 ring-1 ring-line-default/10">Archived</span>
                        )}
                      </span>
                      {isCurrent && (
                        <svg className="w-5 h-5 text-brand-primary-soft shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              };
              return (
                <div className="max-h-[60vh] overflow-y-auto">
                  <ul className="divide-y divide-line-default/5">
                    {activeTeams.map(t => renderRow(t, false))}
                  </ul>
                  {archivedTeams.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setArchivedExpanded(v => !v)}
                        className="w-full flex items-center justify-between px-4 py-3 text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/50 hover:bg-line-default/5"
                      >
                        <span>
                          {archivedTeams.length === 1 ? '1 archived team' : `${archivedTeams.length} archived teams`}
                        </span>
                        <svg
                          className={`w-4 h-4 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" strokeWidth={2.5}
                          strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      {showArchived && (
                        <ul className="divide-y divide-line-default/5">
                          {archivedTeams.map(t => renderRow(t, true))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ===== MOBILE BOTTOM TAB BAR ===== */}
      {!inChatConversation && (
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-50 bg-gradient-to-b from-surface-base to-surface-elevated border-t border-line-default/10"
        // Use HALF the safe-area inset as bottom padding (instead of
        // the full inset) so the tab icons sit close to the home
        // indicator instead of floating above a tall empty strip.
        // The home indicator still has its own clearance — it lives
        // OVER the tab bar on iOS, not inside it.
        style={{ paddingBottom: 'max(0px, calc(env(safe-area-inset-bottom) / 2))' }}
      >
        <div className="flex justify-around items-center h-11 max-w-md mx-auto">
          {bottomTabs.map(tab => {
            const active = tab.path === '#more' ? isMoreOpen : isActive(tab.path);
            if (tab.path === '#more') {
              return (
                <button
                  key={tab.name}
                  onClick={() => {
                    void import('../../utils/nativeShell').then(m => m.tapHaptic('light'));
                    setIsMoreOpen(!isMoreOpen);
                  }}
                  className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${
                    active ? 'text-brand-primary-soft' : 'text-ink-primary/45 hover:text-ink-primary/80'
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
                onClick={() => void import('../../utils/nativeShell').then(m => m.tapHaptic('light'))}
                className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${
                  active ? 'text-brand-primary-soft' : 'text-ink-primary/45 hover:text-ink-primary/80'
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
            className="absolute inset-0 bg-surface-base/60 backdrop-blur-sm"
            onClick={() => setIsMoreOpen(false)}
          />
          {/* Sheet — dark navy now that the app picked the dark lane.
              Matches dashboard + bottom nav so there's no light-sheet
              flash when tapping More. */}
          <div className="absolute bottom-0 inset-x-0 bg-gradient-to-b from-surface-base to-surface-elevated rounded-t-3xl max-h-[85vh] overflow-y-auto animate-slide-up safe-bottom">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-line-default/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center space-x-3">
                <img src="/images/logo.png" alt="GoalKickr" className="h-8 w-8 object-contain" />
                <div>
                  <div className="font-bold text-ink-primary">{selectedTeam?.name || 'GoalKickr'}</div>
                  <div className="text-xs text-ink-primary/60">{userData?.name}</div>
                </div>
              </div>
              <button
                onClick={() => setIsMoreOpen(false)}
                className="p-2 rounded-full hover:bg-line-default/10 text-ink-primary/55 hover:text-ink-primary"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Team Selector — active teams by default. Archived teams
                only appear if one is currently selected OR the user
                taps the archived footer to unhide them. Keeps daily
                switching uncluttered while still reachable. */}
            {(() => {
              const activeTeams = teams.filter(t => (t as any).isActive !== false);
              const archivedTeams = teams.filter(t => (t as any).isActive === false);
              const currentIsArchived = teams.find(t => t.id === selectedTeamId && (t as any).isActive === false);
              const visibleTeams = (archivedExpanded || currentIsArchived)
                ? [...activeTeams, ...archivedTeams]
                : activeTeams;
              if (visibleTeams.length <= 1 && archivedTeams.length === 0) return null;
              return (
                <div className="px-6 pb-3 space-y-1">
                  <select
                    value={selectedTeamId}
                    onChange={e => setSelectedTeamId(e.target.value)}
                    className="w-full text-sm border border-line-default/10 rounded-xl px-3 py-2.5 bg-line-default/5 text-ink-primary focus:ring-2 focus:ring-brand-primary-soft"
                  >
                    {visibleTeams.map(t => (
                      <option key={t.id} value={t.id} className="bg-surface-elevated">
                        {(t as any).isActive === false ? `${t.name} (archived)` : t.name}
                      </option>
                    ))}
                  </select>
                  {archivedTeams.length > 0 && !currentIsArchived && (
                    <button
                      type="button"
                      onClick={() => setArchivedExpanded(v => !v)}
                      className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 hover:text-ink-primary/80 px-1"
                    >
                      {archivedExpanded ? 'Hide archived teams' : `Show ${archivedTeams.length} archived`}
                    </button>
                  )}
                </div>
              );
            })()}

            {/* Sectioned list — consistent outline icons in a tinted
                square, single-column rows like Ollie's Tools page.
                Sections are filtered to only render when they actually
                have items for this user's role. */}
            <div className="px-4 py-2 space-y-5">
              {moreSections.map((section) => (
                <div key={section.label}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/45 mb-2 px-2">
                    {section.label}
                  </div>
                  <div className="bg-line-default/[0.04] rounded-2xl ring-1 ring-line-default/10 overflow-hidden divide-y divide-line-default/5">
                    {section.items.map((item) => {
                      const active = isActive(item.path);
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          onClick={() => setIsMoreOpen(false)}
                          className={`flex items-center justify-between px-4 py-3 transition ${active ? 'bg-brand-primary/15' : 'hover:bg-line-default/5'}`}
                        >
                          <span className="flex items-center gap-3 min-w-0">
                            <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-brand-primary/25 text-ink-primary' : 'bg-brand-primary/10 text-brand-primary-soft'}`}>
                              <AppIcon name={item.icon as any} className="w-5 h-5" />
                            </span>
                            <span className={`text-[15px] font-semibold truncate ${active ? 'text-brand-primary-soft' : 'text-ink-primary'}`}>{item.name}</span>
                          </span>
                          <AppIcon name="arrow-right" className="w-4 h-4 text-ink-primary/30 shrink-0" />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Account section */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/45 mb-2 px-2">
                  Account
                </div>
                <div className="bg-line-default/[0.04] rounded-2xl ring-1 ring-line-default/10 overflow-hidden divide-y divide-line-default/5">
                  <Link
                    to="/helpdesk"
                    onClick={() => setIsMoreOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-line-default/5 transition"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-brand-primary/10 text-brand-primary-soft flex items-center justify-center shrink-0">
                        <AppIcon name="survey" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-ink-primary">Club Support</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-ink-primary/30" />
                  </Link>
                  <Link
                    to="/settings"
                    onClick={() => setIsMoreOpen(false)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-line-default/5 transition"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-brand-primary/10 text-brand-primary-soft flex items-center justify-center shrink-0">
                        <AppIcon name="gear" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-ink-primary">Settings</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-ink-primary/30" />
                  </Link>
                  <button
                    onClick={() => { handleLogout(); setIsMoreOpen(false); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-line-default/5 transition text-left"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-line-default/10 text-ink-primary/70 flex items-center justify-center shrink-0">
                        <AppIcon name="logout" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-ink-primary">Sign Out</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-ink-primary/30" />
                  </button>
                  <button
                    onClick={() => { setShowDeleteAccount(true); setDeleteConfirmText(''); setDeleteError(null); setIsMoreOpen(false); }}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-rose-500/10 transition text-left"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-lg bg-rose-500/15 text-rose-300 flex items-center justify-center shrink-0">
                        <AppIcon name="trash" className="w-5 h-5" />
                      </span>
                      <span className="text-[15px] font-semibold text-rose-200">Delete account</span>
                    </span>
                    <AppIcon name="arrow-right" className="w-4 h-4 text-rose-400/40" />
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
                This will permanently delete your <strong>GoalKickr account</strong>:
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
      {/* Profile + view-mode bottom-sheet — opened from the top-
          right avatar. Renders via portal so it overlays the entire
          app, not just the nav. */}
      <ProfileMenuSheet open={isProfileSheetOpen} onClose={() => setIsProfileSheetOpen(false)} />
    </>
  );
};

export default Navigation;