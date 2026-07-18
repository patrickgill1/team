import type { UserData, Team, Player } from '../types';
import type { AppIconName } from '../components/common/AppIcon';

// ─────────────────────────────────────────────────────────────
// Searchable actions registry — powers the search input at the
// top of the mobile More sheet. Ship 1 covers ~40 entries:
// every top-level page in nav plus deep actions for XP, Surveys,
// Attendance, Club admin, Player profile, and Settings.
//
// Adding a new entry later is a one-line append. Every entry has
// a role gate (visibleTo) so parents never see coach-only actions
// and non-admins never see club-admin actions.
// ─────────────────────────────────────────────────────────────

export interface SearchCtx {
  userData: UserData | null;
  selectedTeam: Team | null;
  isCoachOfTeam: boolean;
  isClubAdmin: boolean;
  isParentMode: boolean;
  isAdultTeam: boolean;
  myPlayer: Player | null;
}

export interface SearchableAction {
  id: string;
  label: string;
  description?: string;
  keywords: string[];
  route: string;
  anchor?: string;
  icon?: AppIconName;
  visibleTo: (ctx: SearchCtx) => boolean;
}

// Convenience gates.
const always = () => true;
const coach = (c: SearchCtx) => c.isCoachOfTeam;
const admin = (c: SearchCtx) => c.isClubAdmin;
const hasPlayer = (c: SearchCtx) => !!c.myPlayer?.id;
// Youth-only surfaces (Development, etc.) drop out for adult teams.
// Mirrors the isAdultTeam suppression in Navigation.tsx so search can't
// leak a youth-only screen onto Patrick's adult pickup wedge.
const youthOnly = (c: SearchCtx) => !c.isAdultTeam;

// Top-level page rows. Mirrors allNavItems in Navigation.tsx so
// the search returns them without the user having to remember
// which section they live under.
const PAGE_ACTIONS: SearchableAction[] = [
  { id: 'page-dashboard', label: 'Team HQ', description: 'Your home base', keywords: ['home', 'dashboard', 'team hq', 'hq'], route: '/dashboard', icon: 'home', visibleTo: always },
  { id: 'page-squad', label: 'Squad', description: 'Roster and player cards', keywords: ['squad', 'players', 'roster', 'kids'], route: '/players', icon: 'players', visibleTo: always },
  { id: 'page-people', label: 'People', description: 'Directory of coaches and parents', keywords: ['people', 'directory', 'contacts', 'staff'], route: '/people', icon: 'phone', visibleTo: (c) => c.isCoachOfTeam || c.isClubAdmin },
  { id: 'page-media', label: 'Media', description: 'Photos, videos, highlights', keywords: ['media', 'photos', 'videos', 'gallery'], route: '/player-media', icon: 'media', visibleTo: always },
  { id: 'page-vote', label: 'Vote', description: 'Player of the match voting', keywords: ['vote', 'potm', 'player of the match', 'award', 'mvp'], route: '/player-of-match', icon: 'trophy', visibleTo: always },
  { id: 'page-chat', label: 'Chat', description: 'Team conversations', keywords: ['chat', 'messages', 'dm', 'thread'], route: '/chat', icon: 'chat', visibleTo: always },
  { id: 'page-mentions', label: 'Mentions', description: 'Where you were tagged', keywords: ['mentions', 'tagged', 'inbox', 'notifications'], route: '/mentions', icon: 'highlight', visibleTo: always },
  { id: 'page-wall', label: 'Team Wall', description: 'Culture, kudos, recaps', keywords: ['wall', 'team wall', 'sideline', 'shouts', 'kudos', 'feed'], route: '/wall', icon: 'news', visibleTo: always },
  { id: 'page-events', label: 'Events', description: 'Practices, games, RSVPs', keywords: ['events', 'calendar', 'schedule', 'practice', 'practices', 'training', 'game', 'games', 'match'], route: '/calendar', icon: 'calendar', visibleTo: always },
  { id: 'page-stats', label: 'Stats', description: 'Season and career numbers', keywords: ['stats', 'statistics', 'records', 'leaders', 'goals', 'assists'], route: '/stats', icon: 'stats', visibleTo: always },
  { id: 'page-full-games', label: 'Full Games', description: 'Every recorded match', keywords: ['full games', 'films', 'game film', 'match film', 'video'], route: '/full-games', icon: 'film', visibleTo: always },
  { id: 'page-highlights', label: 'Highlights', description: 'Clips worth watching again', keywords: ['highlights', 'clips', 'reel'], route: '/highlights', icon: 'highlight', visibleTo: always },
  { id: 'page-attendance', label: 'Attendance', description: 'Track who showed up', keywords: ['attendance', 'check in', 'present', 'roll call'], route: '/attendance', icon: 'check', visibleTo: always },
  { id: 'page-volunteers', label: 'Volunteers', description: 'Parent sign-ups and helpers', keywords: ['volunteers', 'volunteer', 'snack', 'signup'], route: '/volunteers', icon: 'handshake', visibleTo: always },
  { id: 'page-directory', label: 'Directory', description: 'Parent contact directory', keywords: ['directory', 'parents', 'contacts', 'phone book'], route: '/directory', icon: 'phone', visibleTo: always },
  { id: 'page-development', label: 'Development', description: 'Player growth pathway', keywords: ['development', 'pathway', 'growth', 'progress'], route: '/development', icon: 'chart', visibleTo: youthOnly },
  { id: 'page-game-day', label: 'Game Day', description: 'Live match tracker', keywords: ['game day', 'gameday', 'live', 'match tracker', 'subs'], route: '/game-day', icon: 'whistle', visibleTo: coach },
  { id: 'page-practice-plan', label: 'Practice Plan', description: 'Build a practice plan', keywords: ['practice plan', 'plan', 'training plan', 'session'], route: '/practice-plan', icon: 'clipboard', visibleTo: coach },
  { id: 'page-surveys', label: 'Surveys', description: 'Ask the team', keywords: ['surveys', 'survey', 'poll', 'questionnaire', 'form'], route: '/surveys', icon: 'survey', visibleTo: coach },
  { id: 'page-equipment', label: 'Equipment', description: 'Gear the squad needs', keywords: ['equipment', 'gear', 'balls', 'cones'], route: '/equipment', icon: 'check', visibleTo: coach },
  { id: 'page-drills', label: 'Drills', description: 'Drill library', keywords: ['drills', 'drill', 'exercises', 'training ground'], route: '/drills', icon: 'clipboard', visibleTo: coach },
  { id: 'page-teams', label: 'Teams', description: 'Manage your teams', keywords: ['teams', 'team settings', 'edit team'], route: '/teams', icon: 'wrench', visibleTo: coach },
  { id: 'page-coach', label: 'Coach', description: 'Coach cockpit', keywords: ['coach', 'cockpit', 'coach tools'], route: '/coach', icon: 'wrench', visibleTo: coach },
  { id: 'page-club', label: 'Club', description: 'Club admin dashboard', keywords: ['club', 'club admin', 'organization'], route: '/club', icon: 'club', visibleTo: admin },
  { id: 'page-support', label: 'Support', description: 'Help desk and tickets', keywords: ['support', 'help', 'tickets', 'contact'], route: '/tickets', icon: 'help', visibleTo: always },
  { id: 'page-settings', label: 'Settings', description: 'Your account and preferences', keywords: ['settings', 'preferences', 'account'], route: '/settings', icon: 'gear', visibleTo: always },
];

// Player XP deep actions. Each anchors to a scroll-target on
// /coach/xp so a coach can jump straight to the toggle they need.
const XP_ACTIONS: SearchableAction[] = [
  { id: 'xp-master', label: 'Turn on Player XP for this team', description: 'Enable the whole XP system', keywords: ['xp', 'player xp', 'enable xp', 'turn on xp', 'master toggle', 'xp on'], route: '/coach/xp', anchor: 'master', icon: 'trophy', visibleTo: coach },
  { id: 'xp-practice', label: 'Toggle practice log XP', description: 'Points when a player taps I did it', keywords: ['xp', 'practice', 'practice log', 'i did it', 'practice xp'], route: '/coach/xp', anchor: 'source-practice', icon: 'trophy', visibleTo: coach },
  { id: 'xp-rsvp', label: 'Toggle RSVP XP', description: 'Points when a player RSVPs going', keywords: ['xp', 'rsvp', 'rsvp xp'], route: '/coach/xp', anchor: 'source-rsvp', icon: 'trophy', visibleTo: coach },
  { id: 'xp-practice-attendance', label: 'Toggle practice attended XP', description: 'Points when marked present at practice', keywords: ['xp', 'attendance', 'practice attendance', 'practiceattendance'], route: '/coach/xp', anchor: 'source-practiceAttendance', icon: 'trophy', visibleTo: coach },
  { id: 'xp-game-attendance', label: 'Toggle game attended XP', description: 'Points when marked present at a match', keywords: ['xp', 'game attendance', 'gameattendance', 'match attendance'], route: '/coach/xp', anchor: 'source-gameAttendance', icon: 'trophy', visibleTo: coach },
  { id: 'xp-effort-bonus', label: 'Toggle effort bonus XP', description: 'Coach-granted effort bonus', keywords: ['xp', 'effort', 'effort bonus', 'bonus'], route: '/coach/xp', anchor: 'source-effortBonus', icon: 'trophy', visibleTo: coach },
  { id: 'xp-milestones', label: 'Toggle milestone XP', description: 'First goal, first assist, first save', keywords: ['xp', 'milestones', 'first goal', 'first assist', 'first save', 'badge xp'], route: '/coach/xp', anchor: 'section-milestones', icon: 'trophy', visibleTo: coach },
  { id: 'xp-whisper', label: 'Toggle whisper XP', description: 'Private notes turn into XP', keywords: ['xp', 'whisper', 'whispers'], route: '/coach/xp', anchor: 'source-whisper', icon: 'trophy', visibleTo: coach },
  { id: 'xp-live-grant', label: 'Toggle live grant XP', description: 'Coach live-grants during a match', keywords: ['xp', 'live grant', 'coach live grant', 'coachlivegrant'], route: '/coach/xp', anchor: 'source-coachLiveGrant', icon: 'trophy', visibleTo: coach },
  { id: 'xp-kudos', label: 'Toggle kudos to XP', description: 'Kudos convert into XP', keywords: ['xp', 'kudos', 'kudos convert', 'kudosconvert'], route: '/coach/xp', anchor: 'source-kudosConvert', icon: 'trophy', visibleTo: coach },
];

// Surveys deep actions.
const SURVEY_ACTIONS: SearchableAction[] = [
  { id: 'survey-create', label: 'Create a survey', description: 'Ask the team a question', keywords: ['survey', 'create survey', 'new survey', 'poll', 'ask'], route: '/surveys', anchor: 'create', icon: 'survey', visibleTo: coach },
  { id: 'survey-anonymous', label: 'Anonymous survey responses', description: 'Hide who said what', keywords: ['survey', 'anonymous', 'anon', 'private responses'], route: '/surveys', anchor: 'create', icon: 'survey', visibleTo: coach },
  { id: 'survey-notify-me', label: 'Only notify me on responses', description: 'Silence the rest of the staff', keywords: ['survey', 'notify', 'notifications', 'private notify'], route: '/surveys', anchor: 'create', icon: 'survey', visibleTo: coach },
];

// Attendance deep actions.
const ATTENDANCE_ACTIONS: SearchableAction[] = [
  { id: 'attendance-record', label: 'Record attendance', description: 'Mark who is here today', keywords: ['attendance', 'record', 'mark present', 'roll call'], route: '/attendance', icon: 'check', visibleTo: coach },
  { id: 'attendance-effort', label: 'Give an effort bonus', description: 'Reward a kid who brought it', keywords: ['effort', 'effort bonus', 'attendance', 'bonus'], route: '/attendance', icon: 'check', visibleTo: coach },
];

// Club admin deep actions. Only surface to club admins.
const CLUB_ACTIONS: SearchableAction[] = [
  { id: 'club-overview', label: 'Club overview', description: 'Everything across teams', keywords: ['club', 'overview', 'organization'], route: '/club', icon: 'club', visibleTo: admin },
  { id: 'club-branding', label: 'Club branding', description: 'Logo, colors, wordmark', keywords: ['club', 'branding', 'logo', 'colors', 'palette'], route: '/club/branding', icon: 'palette', visibleTo: admin },
  { id: 'club-admins', label: 'Club admins', description: 'Grant access to staff', keywords: ['club', 'admins', 'staff', 'members', 'permissions'], route: '/club/admins', icon: 'shield', visibleTo: admin },
  { id: 'club-teams', label: 'Club teams', description: 'All the teams under this club', keywords: ['club', 'teams', 'roster of teams'], route: '/club', icon: 'club', visibleTo: admin },
  { id: 'club-registrations', label: 'Registrations', description: 'Season sign-ups and offers', keywords: ['registrations', 'registration', 'sign ups', 'signups', 'seasons'], route: '/club/registrations', icon: 'clipboard', visibleTo: admin },
  { id: 'club-tryouts', label: 'Tryouts', description: 'Player evaluation cycles', keywords: ['tryouts', 'evaluations', 'tryout'], route: '/club/tryouts', icon: 'clipboard', visibleTo: admin },
];

// Player profile deep actions. Only surface when the current
// user has a linked player.
const PLAYER_ACTIONS: SearchableAction[] = [
  {
    id: 'player-edit',
    label: 'Edit jersey number',
    description: 'Update your player profile',
    keywords: ['jersey', 'number', 'edit profile', 'player profile'],
    route: '',
    icon: 'user',
    visibleTo: hasPlayer,
  },
  {
    id: 'player-photo',
    label: 'Add a profile photo',
    description: 'Give your player a face',
    keywords: ['photo', 'picture', 'avatar', 'profile photo'],
    route: '',
    icon: 'user',
    visibleTo: hasPlayer,
  },
  {
    id: 'player-circle',
    label: 'Player Circle',
    description: 'Add family to the Circle',
    keywords: ['circle', 'player circle', 'family', 'crew', 'guardians', 'add to circle'],
    route: '/circle',
    icon: 'players',
    visibleTo: hasPlayer,
  },
];

// Settings deep actions.
const SETTINGS_ACTIONS: SearchableAction[] = [
  { id: 'settings-notifications', label: 'Turn on notifications', description: 'Push and email preferences', keywords: ['notifications', 'push', 'alerts', 'email notifications'], route: '/settings', anchor: 'notifications', icon: 'bell', visibleTo: always },
  // Role switch only renders in Settings for accounts currently in
  // Coach mode; parents can't self-service switch back (see Settings.tsx
  // guard on currentGlobalRole === 'coach'). Gate the search entry too
  // so we don't promise a jump the anchor won't answer.
  { id: 'settings-role', label: 'Switch to Family mode', description: 'Change your account role', keywords: ['role', 'switch role', 'family mode', 'coach mode', 'parent', 'switch to family'], route: '/settings', anchor: 'role-switch', icon: 'user', visibleTo: (c) => (c.userData as any)?.role === 'coach' },
  { id: 'settings-appearance', label: 'Appearance', description: 'Light or dark mode', keywords: ['appearance', 'theme', 'light mode', 'dark mode', 'colors'], route: '/settings', anchor: 'appearance', icon: 'palette', visibleTo: always },
  { id: 'settings-email', label: 'Email preferences', description: 'What lands in your inbox', keywords: ['email', 'email preferences', 'digest', 'unsubscribe'], route: '/settings', anchor: 'email', icon: 'gear', visibleTo: always },
  { id: 'settings-subscription', label: 'Subscription', description: 'Your GoalKickr plan', keywords: ['subscription', 'billing', 'plan', 'upgrade', 'payment'], route: '/settings', anchor: 'subscription', icon: 'gear', visibleTo: always },
  { id: 'settings-widget', label: 'Home screen widget', description: 'Set up your player widget', keywords: ['widget', 'home screen', 'ios widget', 'android widget'], route: '/settings', anchor: 'widget', icon: 'gear', visibleTo: always },
  { id: 'settings-delete', label: 'Delete my account', description: 'Permanently remove your profile', keywords: ['delete', 'delete account', 'remove account', 'danger'], route: '/settings', anchor: 'danger', icon: 'trash', visibleTo: always },
];

export const SEARCHABLE_ACTIONS: SearchableAction[] = [
  ...PAGE_ACTIONS,
  ...XP_ACTIONS,
  ...SURVEY_ACTIONS,
  ...ATTENDANCE_ACTIONS,
  ...CLUB_ACTIONS,
  ...PLAYER_ACTIONS,
  ...SETTINGS_ACTIONS,
];

// Resolve a runtime route for actions that depend on the current
// player (e.g. edit jersey number → /player/{myPlayerId}/edit).
// The registry uses empty string as the route when the resolver
// needs to fill it in.
export function resolveRoute(action: SearchableAction, ctx: SearchCtx): string {
  if (action.route) return withAnchor(action);
  // The player edit modal opens off /player/:playerId — no dedicated
  // /edit route exists. PlayerProfile watches for ?edit=1 and flips
  // editOpen on mount, so the search deep-link lands straight in the
  // edit sheet instead of the profile.
  if (action.id === 'player-edit' && ctx.myPlayer?.id) {
    return `/player/${ctx.myPlayer.id}?edit=1`;
  }
  if (action.id === 'player-photo' && ctx.myPlayer?.id) {
    return `/player/${ctx.myPlayer.id}?edit=1`;
  }
  // Fallback — should not happen if the entry is visible.
  return '/settings';
}

function withAnchor(action: SearchableAction): string {
  if (!action.anchor) return action.route;
  const sep = action.route.includes('?') ? '&' : '?';
  return `${action.route}${sep}section=${encodeURIComponent(action.anchor)}`;
}

// Case-insensitive fuzzy match against label + keywords. Ranking:
//   1. exact label match
//   2. label starts with query
//   3. label includes query
//   4. keyword includes query
// Ties break on shorter label (more specific reads more relevant).
export function filterActions(
  actions: SearchableAction[],
  query: string,
  ctx: SearchCtx,
): SearchableAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ action: SearchableAction; score: number }> = [];
  for (const a of actions) {
    if (!a.visibleTo(ctx)) continue;
    const label = a.label.toLowerCase();
    let score = 0;
    if (label === q) score = 100;
    else if (label.startsWith(q)) score = 80;
    else if (label.includes(q)) score = 60;
    else if (a.keywords.some(k => k.toLowerCase().includes(q))) score = 40;
    else continue;
    // Nudge shorter labels up so "Vote" beats "Volunteers" on "vo".
    score -= Math.min(20, Math.floor(a.label.length / 3));
    scored.push({ action: a, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 12).map(s => s.action);
}
