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

const AppIcon: React.FC<Props> = ({ name, className = 'w-5 h-5', strokeWidth = 1.75 }) => {
  const Icon = ICON_MAP[name];
  // Width/height are set by the className (Tailwind w-/h- utilities)
  // — Lucide's intrinsic 24px default would conflict otherwise.
  return <Icon className={className} strokeWidth={strokeWidth} />;
};

export default AppIcon;
