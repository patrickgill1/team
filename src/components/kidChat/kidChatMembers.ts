// Mention picker roster + push-target expansion for kid chat.
//
// Kid chat's mention model is intentionally different from adult chat:
// the picker shows KIDS by first name (Ruston, Hunter) but pushes need
// to route to parent uids (who own auth). This helper produces both
// halves of that contract from a single team-scoped subscription.
//
//   pickerMembers          → seed for utils/extractMentions()
//                            uid = playerId (kids) or coachUid (coaches)
//                            name = kid firstName or coach displayName
//
//   expandToPushTargets(uids)
//                          → after extractMentions returns a resolved
//                            uid list, expand any kid playerId into
//                            that kid's parentIds. Coach uids pass
//                            through unchanged. Deduped.
//
// The `uid` in pickerMembers is deliberately overloaded to distinguish
// kid vs. coach at expansion time: the presence of the uid in the
// playersById map is the signal it's a playerId not a real uid.

import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { MentionableMember } from '../../utils/extractMentions';
import type { Player, Team } from '../../types';

export interface UseKidChatMembers {
  pickerMembers: MentionableMember[];
  expandToPushTargets: (uids: string[]) => string[];
  loading: boolean;
}

interface UserRow {
  uid: string;
  name: string;
}

/**
 * Subscribe to the mentionable roster for one team's kid chat.
 *
 * @param teamId  team the kid chat thread belongs to
 * @param team    the loaded team doc, used for coach uid list. Passed
 *                in rather than re-fetched so we don't hit the users/
 *                collection twice on every kid dashboard open.
 * @param coachDisplayNames  optional map of coachUid → display name
 *                from an already-loaded parent context (Team HQ). If
 *                absent, coaches still show up but with a shortened
 *                uid-tail fallback name. Falls back gracefully.
 */
export function useKidChatMembers(
  teamId: string | null | undefined,
  team: Team | null | undefined,
  coachDisplayNames?: Record<string, string>,
): UseKidChatMembers {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(teamId));

  useEffect(() => {
    if (!teamId) {
      setPlayers([]);
      setLoading(false);
      return;
    }
    const q = query(
      collection(db, 'players'),
      where('teamIds', 'array-contains', teamId),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: Player[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }) as Player)
        .filter(p => (p as any).isActive !== false);
      setPlayers(rows);
      setLoading(false);
    }, () => {
      setLoading(false);
    });
    return () => unsub();
  }, [teamId]);

  const { pickerMembers, playerParentIds } = useMemo(() => {
    const seen = new Set<string>();
    const kids: MentionableMember[] = [];
    const parents = new Map<string, string[]>(); // playerId -> parentIds[]

    for (const p of players) {
      const first = (p.name || '').split(' ')[0]?.trim();
      if (!first) continue;
      // Skip the "team" reserved token — extractMentions matches
      // @everyone/@team/@channel/@all as broadcast intents, and we
      // don't want a real kid nicknamed "Team" to conflict.
      if (first.toLowerCase() === 'team') continue;
      // Deduplicate on first name at the picker level so the roster
      // dropdown doesn't render two "Ruston" entries. First-name
      // collisions on kid rosters are real; the picker deliberately
      // shows one entry and mentions expand to BOTH kids' parent uid
      // sets so both families get pushed. Not perfect, but the
      // alternative (name disambiguation UI) is heavier than v1 needs.
      const key = first.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        kids.push({ uid: p.id, name: first });
      }
      parents.set(p.id, ((p as any).parentIds as string[]) || []);
    }

    const coachRows: MentionableMember[] = [];
    const coachIds: string[] = ((team?.coachIds as string[]) || [])
      .concat(team?.headCoachId ? [team.headCoachId] : [])
      .concat((team?.assistantCoachIds as string[]) || []);
    const uniqueCoaches = Array.from(new Set(coachIds.filter(Boolean)));
    for (const cuid of uniqueCoaches) {
      const display = coachDisplayNames?.[cuid];
      // Fallback: last 4 of uid so the picker isn't empty for coaches
      // whose display name isn't yet loaded. Better than nothing;
      // real name lands as soon as the user doc resolves upstream.
      const label = display && display.trim().length > 0
        ? display.split(' ')[0]
        : `Coach-${cuid.slice(-4)}`;
      coachRows.push({ uid: cuid, name: label });
    }

    return {
      pickerMembers: [...kids, ...coachRows],
      playerParentIds: parents,
    };
  }, [players, team, coachDisplayNames]);

  const expandToPushTargets = useMemo(() => {
    return (uids: string[]): string[] => {
      const out = new Set<string>();
      for (const u of uids) {
        const parents = playerParentIds.get(u);
        if (parents && parents.length > 0) {
          for (const pu of parents) if (pu) out.add(pu);
        } else if (u) {
          // Not a known playerId → treat as a real uid (coach).
          out.add(u);
        }
      }
      return Array.from(out);
    };
  }, [playerParentIds]);

  return { pickerMembers, expandToPushTargets, loading };
}
