import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import AppIcon from '../common/AppIcon';

// ClaimChildWidget — Settings-scoped affordance for a parent to
// declare which players on their team(s) are theirs. Replaces the
// per-card "My Child?" button that used to live on every player
// card; that pattern cluttered PlayerCard for 24 non-yours kids
// just so 1 could be claimed.
//
// Flow:
//   1. Fetch every player across the user's teams
//   2. Filter out players already in the user's claimed list
//   3. Show the remainder with a tap-to-claim action
//   4. Worker verifies the caller's email matches the player's
//      parentEmails list (or they're already a parent). On refusal
//      we show a friendly "ask your coach" message instead of a
//      raw 403 blob.
//
// If the user isn't on any teams yet, this widget quietly hides
// (nothing to claim from).

interface Props {
  userUid: string;
  userEmail: string;
  userTeamIds: string[];
  alreadyClaimedIds: string[];
  onClaimed?: () => void;
}

interface PlayerRow {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  parentEmails: string[];
  photoUrl?: string;
}

const normEmail = (s: string) => (s || '').trim().toLowerCase();

const ClaimChildWidget: React.FC<Props> = ({
  userUid, userEmail, userTeamIds, alreadyClaimedIds, onClaimed,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const claimedSet = useMemo(() => new Set(alreadyClaimedIds), [alreadyClaimedIds]);

  useEffect(() => {
    if (!expanded || userTeamIds.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Chunk teamIds into groups of 30 for the `in` clause. Same
        // ceiling as anywhere else that fans out by team id.
        const chunks: string[][] = [];
        for (let i = 0; i < userTeamIds.length; i += 30) {
          chunks.push(userTeamIds.slice(i, i + 30));
        }
        const teamNames: Record<string, string> = {};
        for (const chunk of chunks) {
          const teamSnap = await getDocs(query(
            collection(db, 'teams'),
            where('__name__', 'in', chunk),
          ));
          teamSnap.docs.forEach((d) => { teamNames[d.id] = (d.data() as any).name || 'Team'; });
        }
        const playerRows: PlayerRow[] = [];
        for (const chunk of chunks) {
          // Player docs use `teamIds: string[]` (multi-team support),
          // so array-contains-any is the right operator.
          const snap = await getDocs(query(
            collection(db, 'players'),
            where('teamIds', 'array-contains-any', chunk),
          ));
          snap.docs.forEach((d) => {
            const data: any = d.data();
            if (data.isActive === false) return;
            if (claimedSet.has(d.id)) return;
            const teamId = Array.isArray(data.teamIds) && data.teamIds.length > 0
              ? data.teamIds.find((t: string) => chunk.includes(t)) || data.teamIds[0]
              : (data.teamId || '');
            playerRows.push({
              id: d.id,
              name: data.name || 'Unnamed player',
              teamId,
              teamName: teamNames[teamId] || 'Team',
              parentEmails: Array.isArray(data.parentEmails) ? data.parentEmails.map(normEmail) : [],
              photoUrl: data.profilePhotoUrl || data.photoUrl,
            });
          });
        }
        playerRows.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setRows(playerRows);
      } catch (err) {
        console.error('ClaimChildWidget load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, userTeamIds, claimedSet]);

  const emailNorm = normEmail(userEmail);

  const claim = async (row: PlayerRow) => {
    if (!emailNorm || claiming) return;
    setClaiming(row.id);
    setRowError((prev) => ({ ...prev, [row.id]: '' }));
    try {
      const { workerFetch } = await import('../../utils/workerFetch');
      const res = await workerFetch('/players/toggle-self-parent', {
        method: 'POST',
        body: JSON.stringify({ playerId: row.id, on: true }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        // 403 = email not on parentEmails. Say so plainly.
        const msg = res.status === 403
          ? 'Your email isn’t on this player yet. Ask your coach to add ' + emailNorm + ' to the player, then try again.'
          : (data?.error || `Claim failed (${res.status}).`);
        setRowError((prev) => ({ ...prev, [row.id]: msg }));
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      onClaimed?.();
    } catch (err: any) {
      setRowError((prev) => ({ ...prev, [row.id]: err?.message || 'Claim failed.' }));
    } finally {
      setClaiming(null);
    }
  };

  if (userTeamIds.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-line-default/10">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-left text-sm font-semibold text-ink-primary/75 hover:text-ink-primary transition"
      >
        <span className="inline-flex items-center gap-1.5">
          <AppIcon name="plus" className="w-4 h-4" />
          Not on the roster? Claim a player
        </span>
        <span className="text-ink-primary/45">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {loading && (
            <p className="text-xs text-ink-primary/45 text-center py-4">Loading players…</p>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-xs text-ink-primary/45 text-center py-4">
              No unclaimed players found on your teams.
            </p>
          )}
          {!loading && rows.map((row) => {
            const canSelfClaim = !!emailNorm && row.parentEmails.includes(emailNorm);
            const err = rowError[row.id];
            return (
              <div
                key={row.id}
                className="flex items-center gap-3 p-2 rounded-lg bg-surface-input ring-1 ring-line-default/10"
              >
                {row.photoUrl ? (
                  <img
                    src={row.photoUrl}
                    alt=""
                    className="w-9 h-9 rounded-full object-cover ring-1 ring-line-default/10 flex-shrink-0"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-line-default/10 flex items-center justify-center text-sm font-bold text-ink-primary flex-shrink-0">
                    {row.name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-primary truncate">{row.name}</p>
                  <p className="text-[11px] text-ink-primary/45 truncate">{row.teamName}</p>
                  {err && (
                    <p className="text-[11px] text-rose-400 mt-1 leading-snug">{err}</p>
                  )}
                </div>
                <button
                  onClick={() => claim(row)}
                  disabled={!canSelfClaim || claiming === row.id}
                  className="px-3 py-1.5 rounded-full text-xs font-bold bg-brand-primary-soft/25 ring-1 ring-brand-primary-soft/40 text-ink-primary hover:bg-brand-primary-soft/35 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  title={canSelfClaim ? 'Claim this player' : `Your coach needs to add ${emailNorm || 'your email'} to this player first.`}
                >
                  {claiming === row.id ? '…' : canSelfClaim ? 'Claim' : 'Ask coach'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ClaimChildWidget;
