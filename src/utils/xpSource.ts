import { Team } from '../types';

export type XpSource = 'participation' | 'badges';

/**
 * Is a given XP-source path enabled for this team?
 *
 * Rules:
 *  - Master `team.xpConfig.enabled` false (or missing) => everything off.
 *  - `team.xpConfig.sources?.[source] === false` => off.
 *  - Missing sources map (or missing key) => on. Backwards compatible.
 *
 * Coach-manual paths (whisper +50, coach live grant, kudos->XP convert)
 * do NOT flow through this helper. Those stay on whenever master is on.
 */
export function isXpSourceEnabled(
  team: Team | null | undefined,
  source: XpSource,
): boolean {
  if (!team?.xpConfig?.enabled) return false;
  const flag = team.xpConfig.sources?.[source];
  if (flag === false) return false;
  return true;
}
