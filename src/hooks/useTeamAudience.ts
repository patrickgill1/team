// Small hook + copy-token helper for adult vs youth teams. Every
// surface that renders team-scoped copy or gates a youth-only
// feature should consume this rather than reading team.audienceType
// directly — it keeps the fallback (undefined → 'youth') in one
// place and centralizes the label swaps so we don't sprinkle
// ternaries throughout the app.
//
// Usage:
//   const { audience, copy, isAdult } = useTeamAudience(team);
//   if (!isAdult) return <ParentInviteCard />;
//   return <p>{copy.rsvpGoing}</p>;
//
// Guiding rule for copy tokens:
//   Only tokens that DIFFER between adult and youth deserve to be in
//   here. If both audiences would say the same word (e.g. "Save"),
//   just hard-code it.

import { useMemo } from 'react';
import { Team } from '../types';

export type TeamAudience = 'youth' | 'adult';

export interface TeamAudienceCopy {
  /** Label for the roster tab / player list. Youth defaults to
   *  "Roster"; adults might say "Squad" per the vocab-swagger memory. */
  rosterTitle: string;
  /** How the app refers to a member of the team. */
  playerNoun: string;
  playerNounPlural: string;
  /** Verb + subject for RSVP replies. Youth = "Kian going", adult = "Going". */
  rsvpGoingSelfOnly: boolean;
  /** Labels for the RSVP tri-state buttons. */
  rsvpGoing: string;
  rsvpMaybe: string;
  rsvpNo: string;
  /** Practice vs training terminology. Adult clubs almost universally
   *  call it "Training", youth clubs "Practice". */
  practiceNoun: string;
  /** The label under the coach's dashboard link that leads to team
   *  chat. Adults: "Team chat". Youth: "Team chat" too — no diff. */
  chatTitle: string;
  /** When we ask a coach who to invite. Youth: "Parents". Adult:
   *  "Players". */
  inviteAudience: string;
  /** Prefix on the "Kick off" button copy on GameDay. */
  matchNoun: string;
}

export function copyForAudience(audience: TeamAudience): TeamAudienceCopy {
  if (audience === 'adult') {
    return {
      rosterTitle: 'Squad',
      playerNoun: 'player',
      playerNounPlural: 'players',
      rsvpGoingSelfOnly: true,
      rsvpGoing: 'Going',
      rsvpMaybe: 'Maybe',
      rsvpNo: 'Out',
      practiceNoun: 'Training',
      chatTitle: 'Team chat',
      inviteAudience: 'Players',
      matchNoun: 'Match',
    };
  }
  return {
    rosterTitle: 'Roster',
    playerNoun: 'player',
    playerNounPlural: 'players',
    rsvpGoingSelfOnly: false,
    rsvpGoing: 'Going',
    rsvpMaybe: 'Maybe',
    rsvpNo: 'Not going',
    practiceNoun: 'Practice',
    chatTitle: 'Team chat',
    inviteAudience: 'Parents',
    matchNoun: 'Game',
  };
}

export interface UseTeamAudienceResult {
  audience: TeamAudience;
  isAdult: boolean;
  isYouth: boolean;
  copy: TeamAudienceCopy;
}

// Accept anything with an audienceType — a partial team object, a
// selected-team context, whatever. Legacy teams / missing team → youth.
export function useTeamAudience(
  team: Pick<Team, 'audienceType'> | null | undefined,
): UseTeamAudienceResult {
  return useMemo(() => {
    const audience: TeamAudience = team?.audienceType === 'adult' ? 'adult' : 'youth';
    return {
      audience,
      isAdult: audience === 'adult',
      isYouth: audience === 'youth',
      copy: copyForAudience(audience),
    };
  }, [team?.audienceType]);
}

// Non-hook variant for utilities / server code (e.g., email drips
// that need to swap a word before send). Same fallback rules.
export function audienceOf(team: Pick<Team, 'audienceType'> | null | undefined): TeamAudience {
  return team?.audienceType === 'adult' ? 'adult' : 'youth';
}
