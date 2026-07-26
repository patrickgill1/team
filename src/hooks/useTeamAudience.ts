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
  /** Long title for the top-vote-getter award. Youth: "Player of the
   *  Match". Adult: "MVP". Used everywhere the ballot / winner card
   *  headline the award, so the label stays consistent across Wall,
   *  Dashboard, and the /player-of-match page. */
  potmTitle: string;
  /** Short/spoken form for CTAs and short subtitles ("Vote for MVP",
   *  "Vote for Player of the Match"). Keeps the badge / chip copy
   *  from wrapping in tight spaces. */
  potmShort: string;
  /** Verb clause the coach sees when opening the ballot. */
  potmVoteVerb: string;
  /** Placeholder inside the "why does this person deserve it?" input
   *  on the ballot. */
  potmReasonPlaceholder: string;
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
      potmTitle: 'MVP',
      potmShort: 'MVP',
      potmVoteVerb: 'Vote for MVP',
      potmReasonPlaceholder: 'Why does this player deserve MVP?',
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
    potmTitle: 'Player of the Match',
    potmShort: 'Player of the Match',
    potmVoteVerb: 'Vote for Player of the Match',
    potmReasonPlaceholder: 'Why does this player deserve to be Player of the Match?',
  };
}

export type TeamRosterMode = 'roster' | 'pickup';

export interface UseTeamAudienceResult {
  audience: TeamAudience;
  isAdult: boolean;
  isYouth: boolean;
  copy: TeamAudienceCopy;
  /** Fixed roster ('roster') vs open drop-in group ('pickup'). Youth
   *  teams are always 'roster'. Adults default 'roster' unless the
   *  coach explicitly opted in to pickup at team-create time. Missing
   *  field on the team doc → 'roster'. */
  rosterMode: TeamRosterMode;
  isPickup: boolean;
}

// Accept anything with an audienceType + rosterMode — a partial team
// object, a selected-team context, whatever. Legacy teams / missing
// team → youth + roster.
export function useTeamAudience(
  team: Pick<Team, 'audienceType' | 'rosterMode'> | null | undefined,
): UseTeamAudienceResult {
  return useMemo(() => {
    const audience: TeamAudience = team?.audienceType === 'adult' ? 'adult' : 'youth';
    const rosterMode: TeamRosterMode = team?.rosterMode === 'pickup' ? 'pickup' : 'roster';
    return {
      audience,
      isAdult: audience === 'adult',
      isYouth: audience === 'youth',
      copy: copyForAudience(audience),
      rosterMode,
      isPickup: rosterMode === 'pickup',
    };
  }, [team?.audienceType, team?.rosterMode]);
}

// Non-hook variant for utilities / server code (e.g., email drips
// that need to swap a word before send). Same fallback rules.
export function audienceOf(team: Pick<Team, 'audienceType'> | null | undefined): TeamAudience {
  return team?.audienceType === 'adult' ? 'adult' : 'youth';
}

// Non-hook variant for the rosterMode read. Same fallback rule
// (missing/unknown → 'roster') so every read site converges on the
// same default.
export function rosterModeOf(team: Pick<Team, 'rosterMode'> | null | undefined): TeamRosterMode {
  return team?.rosterMode === 'pickup' ? 'pickup' : 'roster';
}
