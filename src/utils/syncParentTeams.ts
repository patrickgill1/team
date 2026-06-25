// @ts-nocheck
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Push a player's teamIds onto every parent's user-doc teamIds[]
 * via arrayUnion. Keeps the firestore.rules onTeam(teamId) check
 * in sync after a coach adds a player to a new team — without
 * this, parents of multi-team players get locked out of teams
 * their kid joined post-signup.
 *
 * Best-effort: each parent update is independent and failures are
 * logged, never thrown. The caller's primary write (player doc)
 * is the source of truth; parent teamIds is convenience replication.
 *
 * Pairs with scripts/backfill-parent-team-ids.ts (one-time mop-up
 * for legacy drift). This is the going-forward leak preventer.
 */
export async function syncParentTeams(opts: {
  parentIds: string[] | undefined | null;
  teamIds: string[] | undefined | null;
}): Promise<void> {
  const parents = (opts.parentIds || []).filter(Boolean);
  const teams = (opts.teamIds || []).filter(Boolean);
  if (parents.length === 0 || teams.length === 0) return;
  await Promise.all(
    parents.map((uid) =>
      updateDoc(doc(db, 'users', uid), { teamIds: arrayUnion(...teams) }).catch((err) => {
        console.warn('[sync-parent-teams] update failed for', uid, err);
      }),
    ),
  );
}
