import React from 'react';
import { Link } from 'react-router-dom';
import AppIcon, { type AppIconName } from '../common/AppIcon';
import { useTeam } from '../../contexts/TeamContext';
import { useTeamAudience } from '../../hooks/useTeamAudience';

interface Prompt {
  key: string;
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  icon: AppIconName;
  tone: 'brand' | 'amber' | 'emerald' | 'sky';
}

interface Props {
  players: any[];
  events: any[];
  isCoach: boolean;
  /** Suppress prompts while Dashboard's initial player/event load is
   *  in flight — same reason GettingStartedCard skips render: an
   *  events array that's empty because it hasn't loaded yet would
   *  trigger the "schedule your first practice" empty-state prompt
   *  even for a coach with a full calendar. */
  dataLoading?: boolean;
}

const toneClass: Record<Prompt['tone'], string> = {
  brand: 'from-brand-primary/20 to-brand-primary-deep/20 text-brand-primary-soft ring-brand-primary/25',
  amber: 'from-amber-500/20 to-amber-900/15 text-amber-300 ring-amber-400/25',
  emerald: 'from-emerald-500/20 to-emerald-900/15 text-emerald-300 ring-emerald-400/25',
  sky: 'from-sky-500/20 to-sky-900/15 text-sky-300 ring-sky-400/25',
};

function isSoonGame(event: any): boolean {
  const type = String(event?.type || '').toLowerCase();
  if (!['game', 'scrimmage', 'tournament'].includes(type)) return false;
  const date = event?.date instanceof Date ? event.date : new Date(event?.date || 0);
  if (Number.isNaN(date.getTime())) return false;
  const ms = date.getTime() - Date.now();
  return ms > -2 * 60 * 60 * 1000 && ms < 72 * 60 * 60 * 1000;
}

const SmartDiscoveryPrompts: React.FC<Props> = ({ players, events, isCoach, dataLoading }) => {
  const { selectedTeamId, teams } = useTeam() as any;
  const teamObj = Array.isArray(teams) ? teams.find((t: any) => t.id === selectedTeamId) : null;
  const { isAdult } = useTeamAudience(teamObj);
  if (dataLoading) return null;
  const prompts: Prompt[] = [];
  const nextGame = events.find(isSoonGame);
  const rosterNeedsParents = players.some((p: any) =>
    (p.parentEmails?.length || 0) === 0 && (p.parentIds?.length || 0) === 0
  );

  if (isCoach && nextGame) {
    prompts.push({
      key: 'gameday',
      eyebrow: 'Game window',
      title: 'Open Game Day before kickoff',
      detail: 'Score, lineup, rotation bell, and recap in one place.',
      href: `/game-day/${nextGame.id}`,
      icon: 'whistle',
      tone: 'brand',
    });
  }

  if (isCoach && events.length === 0) {
    prompts.push({
      key: 'schedule',
      eyebrow: 'Next setup step',
      title: 'Put the first practice on the calendar',
      detail: 'Parents get one clear place for time, field, and RSVP.',
      href: '/calendar',
      icon: 'calendar',
      tone: 'amber',
    });
  }

  if (isCoach && rosterNeedsParents) {
    prompts.push({
      key: 'parents',
      eyebrow: 'Roster health',
      title: isAdult ? 'Bring every player into the app' : 'Bring every family into the app',
      detail: isAdult
        ? 'Add player emails so RSVPs and messages reach the right people.'
        : 'Add parent emails so RSVPs and messages reach the right people.',
      href: '/people/add',
      icon: 'players',
      tone: 'emerald',
    });
  }

  const visible = prompts.slice(0, 2);
  if (visible.length === 0) return null;

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-fade-in">
      {visible.map((prompt) => (
        <Link
          key={prompt.key}
          to={prompt.href}
          className={`group rounded-2xl bg-gradient-to-br ${toneClass[prompt.tone]} ring-1 p-4 transition hover:-translate-y-0.5 hover:ring-brand-primary/40`}
        >
          <div className="flex items-start gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl bg-line-default/10 ring-1 ring-line-default/10 flex items-center justify-center">
              <AppIcon name={prompt.icon} className="w-[18px] h-[18px]" strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest opacity-80 mb-0.5">
                {prompt.eyebrow}
              </span>
              <span className="block text-sm font-black text-ink-primary leading-tight">
                {prompt.title}
              </span>
              <span className="block text-xs text-ink-primary/60 leading-snug mt-1">
                {prompt.detail}
              </span>
            </span>
            <AppIcon name="arrow-right" className="w-4 h-4 text-ink-primary/35 group-hover:text-ink-primary/75 transition" strokeWidth={2.4} />
          </div>
        </Link>
      ))}
    </section>
  );
};

export default SmartDiscoveryPrompts;
