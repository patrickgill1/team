// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDoc, collection, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../utils/firebase';
import Header from '../components/common/Header';
import InvitePersonModal from '../components/people/InvitePersonModal';
import AddPlayerModal from '../components/people/AddPlayerModal';
import ActiveInvitesPanel from '../components/people/ActiveInvitesPanel';
import DataGate from '../components/common/DataGate';
import { EmptyState, Sheet, Button } from '../components/ui';
import { RELATIONSHIP_LABELS } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isStaffOfTeam } from '../utils/helpers';

// Club-level "People" directory. One searchable, filterable list of
// every person tied to the current club — players, parents, coaches,
// admins, team managers. Replaces the fragmented "find a parent in
// the parent directory, find a player in the roster, find a coach in
// team management" tour with one surface.

type Role = 'player' | 'parent' | 'coach' | 'team_manager' | 'admin';

interface Person {
  type: 'player' | 'user';
  id: string;
  uid?: string;
  name: string;
  email?: string;
  photoURL?: string;
  role: Role;
  teamIds: string[];
  childNames?: string[];  // for parents
  isActive: boolean;
  /** Family relationship for users with role==='parent'. Drives the
   *  label ('Grandparent' / 'Aunt / Uncle' / etc) shown next to the
   *  name. Missing/undefined falls back to 'Parent'. Coaches +
   *  managers leave this unset. */
  relationship?: 'parent' | 'grandparent' | 'aunt_uncle' | 'guardian' | 'sibling' | 'other';
}

const ROLE_LABEL: Record<Role, string> = {
  player: 'Player',
  parent: 'Parent',
  coach: 'Coach',
  team_manager: 'Manager',
  admin: 'Admin',
};

// Ship 1: honest label for a person's role. If they're role='parent'
// but never declared a specific relationship, fall back to the
// neutral 'Family' rather than lying about 'Parent'. If they
// explicitly declared relationship='parent', keep 'Parent'. Extracted
// so the row chip and the edit-teams Sheet kicker can't drift out of
// sync again (the kicker used to just render ROLE_LABEL[role] and
// showed 'Parent' for every parent user regardless of relationship).
function personRoleLabel(person: { role: Role; relationship?: string }): string {
  if (person.role !== 'parent') return ROLE_LABEL[person.role];
  const rel = person.relationship;
  // 2026-07-16 Circle Ship 1: relationship='parent' is treated as
  // AMBIGUOUS because every legacy user was stamped that way by the
  // old worker default (writeGuards.ts handleClaimInvite), so
  // rendering 'Parent' would keep lying about siblings/grandparents/
  // guardians who accepted a Circle invite. Real self-declared
  // relationships (sibling / grandparent / aunt_uncle / guardian /
  // other) still show their true label. When Ship 2 adds the self-ID
  // prompt in Settings, users who actually pick 'Parent' will need a
  // separate signal (e.g. relationshipDeclaredAt) to reintroduce the
  // 'Parent' chip without resurfacing the legacy lie.
  if (rel && rel !== 'parent' && RELATIONSHIP_LABELS[rel]) return RELATIONSHIP_LABELS[rel];
  return 'Family';
}
// Role chips use SOLID colored pills, not opacity-tinted ones.
// The previous translucent treatment (bg-{color}-500/15-25 +
// text-{color}-100-300) kept failing — Patrick had to flag it
// twice. Translucent tints at chip-sized fonts (9-10px) collapse
// against any moderately-textured background; solid fills guarantee
// the contrast level a status pill needs to do its job.
//
// Color choice:
//   coach = amber (bright fill, dark text — the readable warm-color
//                  pattern from POTM gold)
//   admin = crimson (brand primary, matches +POST and other primary
//                    CTAs — admins are 'the action')
//   manager = sky (cool fill, white text — distinct from coach/admin
//                  without grabbing for violet again)
//   parent = emerald (calm fill, white text)
//   player = bone outline (neutral; most rows are players, so leave
//                          them quiet so coaches/admins stand out)
const ROLE_CHIP: Record<Role, string> = {
  player: 'bg-surface-input text-ink-primary/80 border-line-default/15',
  parent: 'bg-emerald-600 text-white border-emerald-700',
  coach: 'bg-amber-400 text-charcoal-950 border-amber-500',
  team_manager: 'bg-sky-600 text-white border-sky-700',
  admin: 'bg-brand-primary text-white border-brand-primary',
};

const People: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { selectedTeamId, teams: contextTeams } = useTeam() as any;
  const { getDocuments, getPlayersByTeam, getUsersByTeam } = useFirestore();

  const [people, setPeople] = useState<Person[]>([]);
  const [selfAddBusy, setSelfAddBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [teams, setTeams] = useState<Array<{ id: string; name: string; clubId?: string }>>([]);
  // Active management modal — pinned to a single person at a time.
  const [managing, setManaging] = useState<Person | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addPlayerOpen, setAddPlayerOpen] = useState(false);
  // Tiny chooser sheet that opens when you tap +.
  const [chooserOpen, setChooserOpen] = useState(false);
  // Active invites panel — view/revoke pending invites.
  const [invitesPanelOpen, setInvitesPanelOpen] = useState(false);
  // Lightweight cache of every player in the club for the invite
  // modal's player picker (parent invites are anchored to a player).
  const [allClubPlayers, setAllClubPlayers] = useState<any[]>([]);
  // Bulk selection mode. When on, rows show checkboxes; bulk-add action
  // bar appears at the bottom.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  // Multi-team scoped: this page iterates over the union of the
  // user's teams, so "staff on ANY of my teams" is the correct
  // canViewDirectory gate. Widens the previous global isCoach() check
  // to also include team_managers per staff role model.
  const isUserStaff = userData
    ? (Array.isArray(contextTeams) && contextTeams.some((t: any) => isStaffOfTeam(userData, t)))
    : false;
  const isClubAdmin = !!(userData as any)?.isClubAdmin;
  const canViewDirectory = isUserStaff || isClubAdmin;
  // Backwards-compat alias for downstream conditions that still read
  // `isUserCoach` (e.g. copy that speaks specifically to coaches).
  // Same team-scoped semantics.
  const isUserCoach = isUserStaff;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 2026-08-26 rescope: People used to union (user's clubId) with
        // (every team in user.teamIds), which leaked members across
        // unrelated teams — a coach on a Men's League team, a U16 in
        // Club A, and a U11 in Club B saw ALL three rosters mixed
        // together when opening People on any one of them. Now the
        // page is scoped to the CURRENT selected team's club only:
        //   - If the current team has a clubId, show every team in
        //     that club (correct club-directory behavior).
        //   - If no clubId (personal/solo team), show ONLY the current
        //     team's roster.
        // Assistants on Team X still only see Team X's people; they
        // don't inherit any coach identity on the coach's other teams.
        const allTeams = await getDocuments('teams', []);
        if (cancelled) return;
        const currentTeam = (allTeams as any[]).find((t) => t.id === selectedTeamId);
        const clubId = currentTeam?.clubId
          || (userData as any)?.clubId
          || (selectedTeamId ? await getClubIdForTeam(selectedTeamId) : null);

        const effectiveTeams = (allTeams as any[])
          .filter((t) => t.isActive !== false)
          .filter((t) => {
            if (clubId && (t as any).clubId === clubId) return true;
            // No club match — restrict to the current team only.
            // Do NOT union in other teams the user happens to be on;
            // that was the cross-team leak.
            return selectedTeamId ? t.id === selectedTeamId : false;
          });
        const teamIdSet = new Set(effectiveTeams.map(t => t.id));
        setTeams(effectiveTeams.map(t => ({ id: t.id, name: t.name, clubId: (t as any).clubId })));

        const out: Person[] = [];

        // Capture every active club player for the invite modal's
        // player picker (parent invites are player-anchored).
        const clubPlayers: any[] = [];

        // Players + users: fan out per team in our scope. Both LIST
        // rules now require a scoped where clause; unfiltered
        // `getDocuments('players', [])` / `getDocuments('users', [])`
        // 403s once multi-tenant data grows. Dedupe both by id —
        // shared docs (players roster'd to multiple teams, coaches
        // on multiple teams) return once from each fetch.
        const [playerSets, userSets] = await Promise.all([
          Promise.all(effectiveTeams.map(t => getPlayersByTeam(t.id).catch(() => []))),
          Promise.all(effectiveTeams.map(t => getUsersByTeam(t.id).catch(() => []))),
        ]);
        if (cancelled) return;
        const seenPlayerId = new Set<string>();
        const allPlayers: any[] = [];
        for (const set of playerSets) {
          for (const p of set as any[]) {
            if (seenPlayerId.has(p.id)) continue;
            seenPlayerId.add(p.id);
            allPlayers.push(p);
          }
        }
        const seenUserId = new Set<string>();
        const allUsers: any[] = [];
        for (const set of userSets) {
          for (const u of set as any[]) {
            const key = u.uid || u.id;
            if (!key || seenUserId.has(key)) continue;
            seenUserId.add(key);
            allUsers.push(u);
          }
        }

        // Players in any of our teams
        for (const p of allPlayers as any[]) {
          const pTeamIds: string[] = Array.isArray(p.teamIds) ? p.teamIds : (p.teamId ? [p.teamId] : []);
          const intersect = pTeamIds.filter(t => teamIdSet.has(t));
          if (intersect.length === 0) continue;
          out.push({
            type: 'player',
            id: p.id,
            name: p.name,
            photoURL: p.profilePhotoUrl,
            role: 'player',
            teamIds: intersect,
            isActive: p.isActive !== false,
          });
          if (p.isActive !== false) {
            clubPlayers.push({ id: p.id, name: p.name, jerseyNumber: p.jerseyNumber, teamIds: intersect, teamId: p.teamId });
          }
        }
        setAllClubPlayers(clubPlayers);

        // Users (parents/coaches/admins) on any of our teams
        for (const u of allUsers as any[]) {
          const uTeamIds: string[] = Array.isArray(u.teamIds) ? u.teamIds : (u.teamId ? [u.teamId] : []);
          const intersect = uTeamIds.filter(t => teamIdSet.has(t));
          if (intersect.length === 0) continue;
          const role: Role =
            u.isClubAdmin ? 'admin'
            : u.role === 'team_manager' ? 'team_manager'
            : u.role === 'coach' ? 'coach'
            : 'parent';
          out.push({
            type: 'user',
            id: u.id || u.uid,
            uid: u.uid,
            name: u.name || (u.email || 'Unknown'),
            email: u.email,
            photoURL: u.photoURL || u.profilePhotoUrl,
            role,
            teamIds: intersect,
            isActive: u.isActive !== false,
            relationship: u.relationship,
          });
        }

        // For parents, look up their kids' names via player.parentIds /
        // parentEmails. Cheap client-side join over the players we
        // already loaded.
        const parentLookup = new Map<string, string[]>();
        for (const p of allPlayers as any[]) {
          const emails: string[] = (p.parentEmails || []).map((e: string) => e.toLowerCase().trim());
          const parentIds: string[] = Array.isArray(p.parentIds) ? p.parentIds : (p.parentId ? [p.parentId] : []);
          for (const uid of parentIds) {
            const arr = parentLookup.get(uid) || [];
            arr.push(p.name);
            parentLookup.set(uid, arr);
          }
          for (const email of emails) {
            const arr = parentLookup.get(`email:${email}`) || [];
            arr.push(p.name);
            parentLookup.set(`email:${email}`, arr);
          }
        }
        for (const person of out) {
          if (person.role === 'parent' && person.uid) {
            person.childNames = parentLookup.get(person.uid)
              || (person.email ? parentLookup.get(`email:${person.email.toLowerCase()}`) : undefined);
          }
        }

        // Stable sort: active first, then alpha.
        out.sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        setPeople(out);
      } catch (err) {
        console.error('People load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Primitive selectors (2026-07-28 audit): the previous dep list
    // included the whole `userData` object, so every AuthContext live
    // snapshot (pin toggle, mute, FCM token union, XP grant, heal-
    // membership write) minted a fresh object reference and re-ran
    // the whole 2×N-team parallel players+users fetch. Only the
    // primitive shape of userData matters here. Mirrors the pattern
    // TeamContext.tsx:263-269 uses to insulate against the same noisy
    // stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    userData?.uid,
    (userData as any)?.isClubAdmin,
    (userData as any)?.clubId,
    ((userData as any)?.clubIds || []).slice().sort().join('|'),
    (userData?.teamIds || []).slice().sort().join('|'),
    userData?.teamId,
    selectedTeamId,
    getDocuments,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(p => {
      if (roleFilter !== 'all' && p.role !== roleFilter) return false;
      if (teamFilter !== 'all' && !p.teamIds.includes(teamFilter)) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.email || ''} ${(p.childNames || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [people, query, roleFilter, teamFilter]);

  const counts = useMemo(() => {
    const c: Record<'all' | Role, number> = { all: people.length, player: 0, parent: 0, coach: 0, team_manager: 0, admin: 0 };
    for (const p of people) c[p.role]++;
    return c;
  }, [people]);

  const teamNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of teams) m[t.id] = t.name;
    return m;
  }, [teams]);

  if (!canViewDirectory) {
    return (
      <div className="min-h-screen bg-surface-base">
        <Header title="People" />
        <div className="max-w-md mx-auto px-4 py-12 text-center">
          <p className="text-ink-primary/85 font-semibold mb-1">This area is for coaches.</p>
          <p className="text-ink-primary/50 text-sm">
            The People directory holds contact info for everyone in the club, so it's
            limited to coaches, team managers, and club admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title="People"
        subtitle={people.length ? `${people.length} in your club` : undefined}
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setInvitesPanelOpen(true)}
              aria-label="Active invites"
              title="Active invites"
              className="w-9 h-9 rounded-full bg-line-default/10 border border-line-default/20 text-ink-primary/70 flex items-center justify-center hover:bg-line-default/20 hover:text-ink-primary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
            </button>
            <button
              onClick={() => setChooserOpen(true)}
              aria-label="Add someone"
              className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-primary to-surface-tint text-white flex items-center justify-center shadow-lg shadow-brand-primary/30 hover:from-brand-primary-soft hover:to-brand-primary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        }
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {/* Coach-as-player retro CTA. Adult teams only, coach only,
            only when the coach isn't already on the roster as a
            player (checked via parentIds — the same self-link flag
            /players/create with linkSelfAsParent uses). */}
        {(() => {
          if (!isUserCoach || !userData?.uid || !selectedTeamId) return null;
          const teamObj = Array.isArray(contextTeams) ? contextTeams.find((t: any) => t.id === selectedTeamId) : null;
          const teamAudience = (teamObj as any)?.audienceType;
          if (teamAudience !== 'adult') return null;
          const iAmOnRoster = people.some(p =>
            p.type === 'player'
            && Array.isArray((p as any).parentIds)
            && (p as any).parentIds.includes(userData.uid)
          );
          if (iAmOnRoster) return null;
          return (
            <div className="bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 rounded-2xl px-4 py-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-brand-primary/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="8" r="4" /><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-black text-ink-primary leading-tight">You're not on the roster yet</p>
                <p className="text-xs text-ink-primary/60 leading-snug mt-0.5">
                  Play on this team? Adds you to RSVPs, tagged clips, and Split Teams.
                </p>
              </div>
              <button
                type="button"
                disabled={selfAddBusy}
                onClick={async () => {
                  if (selfAddBusy) return;
                  setSelfAddBusy(true);
                  try {
                    const { workerFetch } = await import('../utils/workerFetch');
                    const coachName = (userData.name || '').trim() || (userData.email || '').split('@')[0] || 'Coach';
                    const coachEmail = (userData.email || '').trim().toLowerCase();
                    const res = await workerFetch('/players/create', {
                      method: 'POST',
                      body: JSON.stringify({
                        teamId: selectedTeamId,
                        name: coachName,
                        parentEmails: coachEmail ? [coachEmail] : undefined,
                        linkSelfAsParent: true,
                        isAdultPlayer: true,
                      }),
                    });
                    const data: any = await res.json().catch(() => ({}));
                    if (!res.ok || !data?.ok) {
                      console.error('coach self-add failed', data);
                    } else {
                      // Refresh the people list from Firestore so the
                      // banner disappears + the new row appears.
                      window.location.reload();
                    }
                  } catch (err) {
                    console.error('coach self-add threw', err);
                  } finally {
                    setSelfAddBusy(false);
                  }
                }}
                className="flex-shrink-0 px-4 py-2 rounded-full bg-brand-primary text-white text-xs font-black tracking-wider uppercase shadow-lg hover:bg-brand-primary/90 disabled:opacity-50 transition"
              >
                {selfAddBusy ? 'Adding…' : 'Add me'}
              </button>
            </div>
          );
        })()}

        {/* Search + team filter */}
        <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm p-3 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-ink-primary/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or kid's name…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
            />
          </div>
          {teams.length > 1 && (
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="px-3 py-2 text-sm border border-line-default/10 rounded-lg bg-surface-base text-ink-primary"
            >
              <option value="all">All teams</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>

        {/* Coach-only header: Select toggle for bulk actions */}
        {isUserCoach && people.length > 0 && (
          <div className="flex items-center justify-between -mb-1">
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/40">
              {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            </span>
            <button
              onClick={() => { setSelectMode(v => !v); setSelectedIds(new Set()); }}
              className={`text-[11px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded-md border ${
                selectMode
                  ? 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/30'
                  : 'bg-surface-elevated text-ink-primary/50 border-line-default/10 hover:text-ink-primary/90'
              }`}
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          </div>
        )}

        {/* Role pills */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {([
            { k: 'all' as const, label: 'All' },
            { k: 'player' as const, label: 'Players' },
            { k: 'parent' as const, label: 'Parents' },
            { k: 'coach' as const, label: 'Coaches' },
            ...(counts.team_manager ? [{ k: 'team_manager' as const, label: 'Managers' }] : []),
            ...(counts.admin ? [{ k: 'admin' as const, label: 'Admins' }] : []),
          ]).map(({ k, label }) => (
            <button
              key={k}
              onClick={() => setRoleFilter(k as any)}
              className={`px-3 py-1 rounded-md text-[11px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                roleFilter === k
                  ? 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/30'
                  : 'bg-surface-elevated text-ink-primary/50 border-line-default/10 hover:text-ink-primary/90'
              }`}
            >
              {label} <span className={roleFilter === k ? 'text-brand-primary' : 'text-ink-primary/40'}>{counts[k as any]}</span>
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <DataGate when="loading" />
        ) : filtered.length === 0 ? (
          <EmptyState title="No one matches" />
        ) : (
          <ul className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm divide-y divide-line-default/5 overflow-hidden">
            {filtered.map(p => {
              const key = `${p.type}-${p.id}`;
              const initial = (p.name || '?').charAt(0).toUpperCase();
              // Admins + coaches land on the CRM admin view; everyone else
              // gets the parent-facing player profile.
              const playerDest = isUserCoach || (userData as any)?.isClubAdmin
                ? `/club/person/${p.id}`
                : `/player/${p.id}`;
              const linkTo = !selectMode && p.type === 'player' ? playerDest : undefined;
              const isSelected = selectedIds.has(key);
              const toggleSelect = () => {
                const next = new Set(selectedIds);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                setSelectedIds(next);
              };
              const RowInner = (
                <li
                  className={`px-3 py-2.5 flex items-center gap-2.5 transition-colors ${isSelected ? 'bg-brand-primary/15' : 'hover:bg-line-default/[0.05]'}`}
                  onClick={selectMode ? (e) => { e.preventDefault(); toggleSelect(); } : undefined}
                >
                  {selectMode && (
                    <span className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'bg-brand-primary border-brand-primary text-white' : 'border-line-default/15'
                    }`}>
                      {isSelected && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
                    </span>
                  )}
                  {p.photoURL ? (
                    <img src={p.photoURL} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <span className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">{initial}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-ink-primary truncate">{p.name}</span>
                      <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded border ${ROLE_CHIP[p.role]}`}>
                        {personRoleLabel(p)}
                      </span>
                      {!p.isActive && (
                        <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-surface-base text-ink-primary/40 border-line-default/10">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-primary/50 truncate mt-0.5">
                      {p.role === 'parent' && p.childNames && p.childNames.length
                        ? `Kid${p.childNames.length === 1 ? '' : 's'}: ${p.childNames.join(', ')}`
                        : p.email || (p.teamIds.length ? p.teamIds.map(t => teamNameById[t] || '').filter(Boolean).join(' · ') : '')}
                    </div>
                  </div>
                  {!selectMode && p.teamIds.length > 0 && (
                    <div className="hidden sm:flex flex-wrap gap-1 justify-end max-w-[200px]">
                      {p.teamIds.slice(0, 2).map(tid => (
                        <span key={tid} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-base text-ink-primary/65 border border-line-default/10">
                          {teamNameById[tid] || tid.slice(0, 6)}
                        </span>
                      ))}
                      {p.teamIds.length > 2 && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-base text-ink-primary/65 border border-line-default/10">
                          +{p.teamIds.length - 2}
                        </span>
                      )}
                    </div>
                  )}
                  {!selectMode && isUserCoach && (
                    p.type === 'player' ? (
                      // Players: jump straight to the full PersonAdmin profile.
                      // The old team-assignment-only modal is redundant since
                      // PersonAdmin → Teams tab does that + more.
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/club/person/${p.id}`); }}
                        className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-brand-primary text-white hover:bg-brand-primary/150 flex-shrink-0"
                      >
                        Profile
                      </button>
                    ) : (
                      // Non-players (parents / coaches): keep the lightweight
                      // user-team assignment modal — there's no PersonAdmin
                      // equivalent for users yet.
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setManaging(p); }}
                        className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded border bg-surface-elevated text-ink-primary/50 border-line-default/10 hover:text-ink-primary/90 flex-shrink-0"
                      >
                        Manage
                      </button>
                    )
                  )}
                </li>
              );
              return linkTo ? (
                <Link to={linkTo} key={key}>{RowInner}</Link>
              ) : (
                <div key={key}>{RowInner}</div>
              );
            })}
          </ul>
        )}

        {!isUserCoach && people.length > 0 && (
          <p className="text-[11px] text-ink-primary/40 text-center py-2">
            Viewing your club's people. Coaches can add or remove members.
          </p>
        )}
      </div>

      {/* Bulk action bar — appears when in select mode + has selection.
          Sits ABOVE the mobile bottom nav (z-50 + h-12) so its controls
          aren't covered. On desktop the nav is a side rail so bottom-0
          is fine. safe-bottom keeps it clear of the home indicator. */}
      {selectMode && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-12 lg:bottom-0 z-50 bg-surface-base border-t border-brand-primary/20 px-4 py-3 flex items-center gap-3">
          <span className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/75 flex-shrink-0">
            {selectedIds.size} selected
          </span>
          <select
            value={bulkTarget}
            onChange={(e) => setBulkTarget(e.target.value)}
            className="flex-1 bg-surface-elevated border border-line-default/15 text-ink-primary text-sm rounded-lg px-2 py-1.5"
          >
            <option value="">Add to squad…</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            disabled={!bulkTarget || bulkBusy}
            onClick={async () => {
              if (!bulkTarget) return;
              setBulkBusy(true);
              try {
                const targets = filtered.filter(p => selectedIds.has(`${p.type}-${p.id}`));
                await bulkAddToTeam(targets, bulkTarget, teams.find(t => t.id === bulkTarget));
                // Refresh memberships on the affected people in local state.
                setPeople(prev => prev.map(p => {
                  if (!selectedIds.has(`${p.type}-${p.id}`)) return p;
                  if (p.teamIds.includes(bulkTarget)) return p;
                  return { ...p, teamIds: [...p.teamIds, bulkTarget] };
                }));
                setSelectedIds(new Set());
                setBulkTarget('');
                setSelectMode(false);
              } catch (err) {
                console.error('bulk add failed', err);
                alert('Failed to add to team — try again.');
              } finally {
                setBulkBusy(false);
              }
            }}
            className="bg-brand-primary hover:bg-brand-primary/150 text-white text-xs font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {bulkBusy ? '…' : 'Add'}
          </button>
          <button
            onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setBulkTarget(''); }}
            className="text-ink-primary/45 hover:text-ink-primary text-xs font-extrabold tracking-widest uppercase"
          >
            Cancel
          </button>
        </div>
      )}

      {/* + chooser sheet — pick what kind of thing you're adding */}
      {chooserOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={() => setChooserOpen(false)}>
          <div onClick={e => e.stopPropagation()} className="bg-surface-elevated rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="px-4 py-3 border-b border-line-default/5">
              <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/65">Add</div>
            </div>
            <button
              onClick={() => {
                setChooserOpen(false);
                setAddPlayerOpen(true);
              }}
              className="w-full text-left px-4 py-3 hover:bg-line-default/[0.05] border-b border-line-default/5 flex items-center gap-3"
            >
              <span className="w-8 h-8 rounded-lg bg-brand-primary/15 text-brand-primary flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </span>
              <div className="flex-1">
                <div className="text-sm font-bold text-ink-primary">Add to Squad</div>
                <div className="text-[11px] text-ink-primary/50">New player on the squad, with an optional invite to their family.</div>
              </div>
            </button>
            <button
              onClick={() => { setChooserOpen(false); setInviteOpen(true); }}
              className="w-full text-left px-4 py-3 hover:bg-line-default/[0.05] border-b border-line-default/5 flex items-center gap-3"
            >
              <span className="w-8 h-8 rounded-lg bg-violet-500/15 text-violet-600 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
              </span>
              <div className="flex-1">
                <div className="text-sm font-bold text-ink-primary">Bring Someone In</div>
                <div className="text-[11px] text-ink-primary/50">A family for an existing player, or another coach / manager.</div>
              </div>
            </button>
            <button
              onClick={() => setChooserOpen(false)}
              className="w-full text-center px-4 py-2.5 text-xs font-bold tracking-wide text-ink-primary/50 hover:bg-line-default/[0.05]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Active invites list — view, copy, revoke. */}
      {invitesPanelOpen && (
        <ActiveInvitesPanel
          isAdmin={isClubAdmin}
          currentUid={userData?.uid || ''}
          myTeamIds={(userData as any)?.teamIds || (userData?.teamId ? [userData.teamId] : [])}
          teamNameById={Object.fromEntries(teams.map(t => [t.id, t.name]))}
          playerNameById={Object.fromEntries(allClubPlayers.map((p: any) => [p.id, p.name]))}
          onClose={() => setInvitesPanelOpen(false)}
        />
      )}

      {/* Invite modal — parent (player-anchored) or staff (team+role) */}
      {inviteOpen && (
        <InvitePersonModal
          clubTeams={teams}
          clubPlayers={allClubPlayers}
          currentUid={userData?.uid || ''}
          onClose={() => setInviteOpen(false)}
        />
      )}

      {/* Add player + (optional) parent invite */}
      {addPlayerOpen && (
        <AddPlayerModal
          clubTeams={teams}
          defaultTeamId={selectedTeamId || undefined}
          currentUid={userData?.uid || ''}
          onClose={() => setAddPlayerOpen(false)}
          onCreated={(player) => {
            // Optimistically add to people list so it shows up immediately.
            setPeople(prev => [...prev, {
              type: 'player',
              id: player.id,
              name: player.name,
              role: 'player',
              teamIds: selectedTeamId ? [selectedTeamId] : [],
              isActive: true,
            } as Person]);
          }}
        />
      )}

      {/* Manage modal — single person team assignments */}
      {managing && (
        <ManagePersonModal
          person={managing}
          teams={teams}
          onClose={() => setManaging(null)}
          onUpdated={(updatedTeamIds) => {
            setPeople(prev => prev.map(p =>
              `${p.type}-${p.id}` === `${managing.type}-${managing.id}`
                ? { ...p, teamIds: updatedTeamIds }
                : p
            ));
            setManaging(null);
          }}
        />
      )}

    </div>
  );
};

// ---------- Manage Person modal ----------
const ManagePersonModal: React.FC<{
  person: Person;
  teams: Array<{ id: string; name: string; clubId?: string }>;
  onClose: () => void;
  onUpdated: (newTeamIds: string[]) => void;
}> = ({ person, teams, onClose, onUpdated }) => {
  const [draft, setDraft] = useState<Set<string>>(new Set(person.teamIds));
  const [busy, setBusy] = useState(false);

  const toggle = (teamId: string) => {
    const next = new Set(draft);
    if (next.has(teamId)) next.delete(teamId);
    else next.add(teamId);
    setDraft(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const newTeamIds = Array.from(draft);
      const oldTeamIds = person.teamIds;
      const added = newTeamIds.filter(t => !oldTeamIds.includes(t));
      const removed = oldTeamIds.filter(t => !newTeamIds.includes(t));

      if (person.type === 'player') {
        // Player-side teamIds set — worker verifies caller coaches
        // every team on either side of the diff and fans out to
        // team.playerIds + each parent's user.teamIds.
        const { workerFetch } = await import('../utils/workerFetch');
        const r = await workerFetch('/players/set-teams', {
          method: 'POST',
          body: JSON.stringify({ playerId: person.id, teamIds: newTeamIds }),
        });
        const d: any = await r.json().catch(() => ({}));
        if (!r.ok || !d?.ok) throw new Error(d?.error || `set-teams-${r.status}`);
        // Add membership rows for newly-assigned teams
        for (const teamId of added) {
          const team = teams.find(t => t.id === teamId);
          const clubId = team?.clubId || 'club_unknown';
          const memId = `mem_${person.id}_${teamId}_${'season_active'}`;
          await addDoc(collection(db, 'player_memberships'), {
            id: memId,
            clubId,
            teamId,
            seasonId: 'season_active',
            playerId: person.id,
            isActive: true,
            joinedAt: serverTimestamp(),
          });
        }
        // Mark removed memberships as inactive (don't delete — preserves stats history)
        if (removed.length) {
          const snap = await getDocs(query(collection(db, 'player_memberships'),
            where('playerId', '==', person.id),
            where('teamId', 'in', removed.slice(0, 10)),
          ));
          const batch = writeBatch(db);
          snap.docs.forEach(d => batch.update(d.ref, { isActive: false, leftAt: serverTimestamp() }));
          await batch.commit();
        }
      } else {
        // Staff-side teamIds set — worker fans out to team.coachIds
        // for coach/team_manager users.
        if (person.uid) {
          const { workerFetch } = await import('../utils/workerFetch');
          const r = await workerFetch('/users/set-teams', {
            method: 'POST',
            body: JSON.stringify({ targetUid: person.uid, teamIds: newTeamIds }),
          });
          const d: any = await r.json().catch(() => ({}));
          if (!r.ok || !d?.ok) throw new Error(d?.error || `set-teams-${r.status}`);
        }
        for (const teamId of added) {
          const team = teams.find(t => t.id === teamId);
          const clubId = team?.clubId || 'club_unknown';
          await addDoc(collection(db, 'staff_memberships'), {
            clubId, teamId, seasonId: 'season_active',
            uid: person.uid,
            role: person.role === 'coach' ? 'assistant_coach' : person.role,
            isActive: true,
            joinedAt: serverTimestamp(),
          });
        }
        if (removed.length && person.uid) {
          const snap = await getDocs(query(collection(db, 'staff_memberships'),
            where('uid', '==', person.uid),
            where('teamId', 'in', removed.slice(0, 10)),
          ));
          const batch = writeBatch(db);
          snap.docs.forEach(d => batch.update(d.ref, { isActive: false, leftAt: serverTimestamp() }));
          await batch.commit();
        }
      }
      onUpdated(newTeamIds);
    } catch (err) {
      console.error('save failed', err);
      alert('Failed to save — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={true}
      onClose={onClose}
      size="sm"
      kicker={personRoleLabel(person)}
      title={person.name}
      subtitle={person.email || undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save</Button>
        </>
      }
    >
      <div>
        <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-2">Teams</div>
        <div className="space-y-1">
          {teams.map(t => {
            const on = draft.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg ring-1 text-sm transition ${
                  on ? 'bg-brand-primary/15 ring-brand-primary/40 text-brand-primary-soft' : 'bg-surface-base ring-line-default/10 text-ink-primary hover:bg-line-default/5'
                }`}
              >
                <span className="font-semibold">{t.name}</span>
                <span className={`w-4 h-4 rounded border flex items-center justify-center ${on ? 'bg-brand-primary border-brand-primary text-brand-primary-fg' : 'border-line-default/20'}`}>
                  {on && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
};

// ---------- Bulk add ----------
async function bulkAddToTeam(
  targets: Person[],
  teamId: string,
  team?: { id: string; name: string; clubId?: string },
) {
  const clubId = team?.clubId || 'club_unknown';
  const { workerFetch } = await import('../utils/workerFetch');
  for (const t of targets) {
    if (t.teamIds.includes(teamId)) continue;
    const nextTeamIds = [...t.teamIds, teamId];
    if (t.type === 'player') {
      const r = await workerFetch('/players/set-teams', {
        method: 'POST',
        body: JSON.stringify({ playerId: t.id, teamIds: nextTeamIds }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d?.ok) throw new Error(d?.error || `bulk-player-${r.status}`);
      await addDoc(collection(db, 'player_memberships'), {
        clubId, teamId, seasonId: 'season_active',
        playerId: t.id, isActive: true,
        joinedAt: serverTimestamp(),
      });
    } else if (t.uid) {
      const r = await workerFetch('/users/set-teams', {
        method: 'POST',
        body: JSON.stringify({ targetUid: t.uid, teamIds: nextTeamIds }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d?.ok) throw new Error(d?.error || `bulk-staff-${r.status}`);
      await addDoc(collection(db, 'staff_memberships'), {
        clubId, teamId, seasonId: 'season_active',
        uid: t.uid,
        role: t.role === 'coach' ? 'assistant_coach' : t.role,
        isActive: true,
        joinedAt: serverTimestamp(),
      });
    }
  }
}

// Small helper — resolves the clubId of a team from its team doc.
async function getClubIdForTeam(teamId: string): Promise<string | null> {
  try {
    const snap = await getDocs(query(collection(db, 'teams'), where('__name__', '==', teamId)));
    const doc = snap.docs[0];
    return doc ? ((doc.data() as any).clubId || null) : null;
  } catch {
    return null;
  }
}

export default People;
