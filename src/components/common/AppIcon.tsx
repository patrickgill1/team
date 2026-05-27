import React from 'react';
import {
  Home,
  Users,
  Image as ImageIcon,
  MessageCircle,
  Menu,
  Calendar,
  BarChart3,
  Newspaper,
  Film,
  Sparkles,
  CheckCircle2,
  Handshake,
  Phone,
  TrendingUp,
  Activity,
  ClipboardList,
  ClipboardCheck,
  Settings,
  Landmark,
  Bell,
  Shield,
  Info,
  HelpCircle,
  LifeBuoy,
  Palette,
  ChevronRight,
  Pencil,
  Plus,
  LogOut,
  Trash2,
  User,
  Trophy,
  Volleyball,
  TrafficCone,
  Flag,
  MapPin,
  Clock,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Centralized icon component. All app icons go through here so they
 * share one stroke weight and one visual language (Lucide's outline
 * style). Call sites use string names so we can swap an underlying
 * icon library later without touching every component.
 *
 * If you need an icon that isn't mapped yet, add the Lucide export
 * to the import list above and to ICON_MAP — that's the only place
 * the underlying library is wired in.
 */
export type AppIconName =
  | 'home'
  | 'players'
  | 'media'
  | 'chat'
  | 'menu'
  | 'calendar'
  | 'stats'
  | 'news'
  | 'film'
  | 'highlight'
  | 'check'
  | 'handshake'
  | 'phone'
  | 'chart'
  | 'whistle'
  | 'clipboard'
  | 'survey'
  | 'gear'
  | 'club'
  | 'bell'
  | 'shield'
  | 'info'
  | 'help'
  | 'lifebuoy'
  | 'palette'
  | 'arrow-right'
  | 'edit'
  | 'plus'
  | 'logout'
  | 'trash'
  | 'user'
  | 'trophy'
  | 'soccer'
  | 'cone'
  | 'running'
  | 'flag'
  | 'map-pin'
  | 'clock'
  | 'wrench';

interface Props {
  name: AppIconName;
  className?: string;
  strokeWidth?: number;
}

const ICON_MAP: Record<AppIconName, LucideIcon> = {
  home: Home,
  players: Users,
  media: ImageIcon,
  chat: MessageCircle,
  menu: Menu,
  calendar: Calendar,
  stats: BarChart3,
  news: Newspaper,
  film: Film,
  highlight: Sparkles,
  check: CheckCircle2,
  handshake: Handshake,
  phone: Phone,
  chart: TrendingUp,
  // No whistle in this Lucide version — Activity (heart-pulse line)
  // reads as "live action / Game Day" which is what the only caller
  // actually means by 'whistle'.
  whistle: Activity,
  clipboard: ClipboardList,
  survey: ClipboardCheck,
  gear: Settings,
  club: Landmark,
  bell: Bell,
  shield: Shield,
  info: Info,
  help: HelpCircle,
  lifebuoy: LifeBuoy,
  palette: Palette,
  'arrow-right': ChevronRight,
  edit: Pencil,
  plus: Plus,
  logout: LogOut,
  trash: Trash2,
  user: User,
  trophy: Trophy,
  // Lucide doesn't ship a soccer ball but Volleyball is a round
  // paneled ball — reads as "a sports ball" at any size and doesn't
  // collide visually with `trophy` (used for Vote).
  soccer: Volleyball,
  cone: TrafficCone,
  // Footprints felt off for kids' soccer practice. TrafficCone is
  // the universal "practice/drills" cue.
  running: TrafficCone,
  flag: Flag,
  'map-pin': MapPin,
  clock: Clock,
  // Distinct from Settings (gear) — used for team-admin / setup
  // surfaces so the two don't look identical in nav lists.
  wrench: Wrench,
};

// Hand-picked icons that override the Lucide default. Each entry is
// the inner SVG content (paths/circles/etc.) drawn on a 24x24
// viewBox. Strokes inherit currentColor and stroke-width from the
// wrapping <svg>, so they match the rest of the app's line weight.
//
// Sources:
//   - Tabler Icons (MIT) — https://tabler.io/icons
//   - Phosphor Icons (MIT) — https://phosphoricons.com
const CUSTOM_PATHS: Partial<Record<AppIconName, React.ReactNode>> = {
  // Tabler "brand-google-home" — Fire FC's chosen Home glyph.
  home: (
    <>
      <path d="M19.072 21h-14.144a1.928 1.928 0 0 1 -1.928 -1.928v-6.857c0 -.512 .203 -1 .566 -1.365l7.07 -7.063a1.928 1.928 0 0 1 2.727 0l7.071 7.063c.363 .362 .566 .853 .566 1.365v6.857a1.928 1.928 0 0 1 -1.928 1.928" />
      <path d="M7 13v4h10v-4l-5 -5" />
      <path d="M14.8 5.2l-11.8 11.8" />
      <path d="M7 17v4" />
      <path d="M17 17v4" />
    </>
  ),
  // Tabler "messages" — overlapping speech bubbles.
  chat: (
    <>
      <path d="M21 14l-3 -3h-7a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1h9a1 1 0 0 1 1 1v10" />
      <path d="M14 15v2a1 1 0 0 1 -1 1h-7l-3 3v-10a1 1 0 0 1 1 -1h2" />
    </>
  ),
  // Tabler "photo-alt" — framed photo with mountains, sun, and a
  // caption hint at the bottom. Used for the Media bottom tab.
  media: (
    <>
      <path d="M6 18h5" />
      <path d="M14 18h4" />
      <path d="M15 7h.01" />
      <path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12" />
      <path d="M3 15l5 -5c.928 -.893 2.072 -.893 3 0l5 5" />
      <path d="M14 13l1 -1c.928 -.893 2.072 -.893 3 0l3 3" />
      <path d="M3 15h18" />
    </>
  ),
  // Tabler "play-football" — person about to kick a soccer ball.
  // Used for the practice date-stripe icon (was Footprints).
  running: (
    <>
      <path d="M3 17l5 1l.75 -1.5" />
      <path d="M14 21v-4l-4 -3l1 -6" />
      <path d="M6 12v-3l5 -1l3 3l3 1" />
      <path d="M18.007 19.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0" />
      <path d="M10.007 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    </>
  ),
  // Phosphor "SoccerBall" — circle with the classic pentagon-and-
  // spokes pattern. Scaled from Phosphor's 256x256 grid down to
  // 24x24. Used for the game date-stripe icon.
  soccer: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.25 L15.75 10.97 L14.32 15.38 L9.68 15.38 L8.25 10.97 Z" />
      <path d="M12 5.25 L12 8.25" />
      <path d="M19.5 10.88 L15.75 10.97" />
      <path d="M4.5 10.88 L8.25 10.97" />
      <path d="M15.94 19.31 L14.32 15.38" />
      <path d="M8.06 19.31 L9.68 15.38" />
    </>
  ),
  // Phosphor "CalendarBlank" — clean date pad with two day pegs.
  // Used for the Events bottom tab + anywhere we say `calendar`.
  calendar: (
    <>
      <rect x="3" y="6" width="18" height="15" rx="2" />
      <path d="M3 11 L21 11" />
      <path d="M8 3 L8 7" />
      <path d="M16 3 L16 7" />
    </>
  ),
  // Tabler "soccer-field" — pitch with center circle, goals, and
  // halfway line. Used for the Full Games nav entry.
  film: (
    <>
      <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M3 9h3v6h-3l0 -6" />
      <path d="M18 9h3v6h-3l0 -6" />
      <path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" />
      <path d="M12 5l0 14" />
    </>
  ),
  // Tabler "shirt-sport" — sports jersey with a number on the chest.
  // Used for the Game Day live-tracker nav entry.
  whistle: (
    <>
      <path d="M15 4l6 2v5h-3v8a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-8h-3v-5l6 -2a3 3 0 0 0 6 0" />
      <path d="M10.5 11h2.5l-1.5 5" />
    </>
  ),
  // Tabler "flame" — fits Fire FC for the Club nav entry.
  club: (
    <path d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.294 -2.333 5.588c0 3.704 3.134 6.706 7 6.706c3.866 0 7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235" />
  ),
};

const AppIcon: React.FC<Props> = ({ name, className = 'w-5 h-5', strokeWidth = 1.75 }) => {
  const custom = CUSTOM_PATHS[name];
  if (custom) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {custom}
      </svg>
    );
  }
  const Icon = ICON_MAP[name];
  // Width/height are set by the className (Tailwind w-/h- utilities)
  // — Lucide's intrinsic 24px default would conflict otherwise.
  return <Icon className={className} strokeWidth={strokeWidth} />;
};

export default AppIcon;
