# Seasons & Invites Redesign

Design doc for two related refactors. Read top-to-bottom — they share concepts (player profiles as primary identity, teams as time-bounded instances).

Status: **proposal**. Nothing built yet.

---

## Why

Current pain points:

1. **Invites are friction-heavy.** Coach has to know parent emails up front. Some parents sign up without telling the coach (orphan accounts). Inviting other coaches "leaves a lot to be desired" (no real flow). No share-friendly link.
2. **No concept of seasons.** Stats accumulate forever. Players who leave clutter the active roster. New season starts with no fresh slate. End-of-year "what now?" has no answer in the product.
3. **Multi-team players are awkward.** A parent whose kid played Fire FC 2024 and Fire FC 2025 has to flip the team selector to find old clips/stats. Career view doesn't exist.

Goals:

- A parent can join with one tap from a coach's text — no email-collection-up-front, no orphan accounts.
- A coach can invite assistants in 30 seconds.
- "End season" is a single button that archives cleanly without losing data.
- Players + parents see a unified career view; coaches see a focused current-season view.
- Set up the bones for a future "Club Portal" (rolling up multiple teams) without committing to it now.

---

## Mental model shift

Today the **team** is the central object — everything filters by `selectedTeamId`. Players, stats, clips, all scoped per-team-per-time.

Going forward:

- **Player** is the primary identity. One profile per kid, persistent across teams and seasons.
- **Team** is an instance: a roster running during a particular **season**.
- **Season** is a time slice with a name and date range.
- **Club** (future) is a parent of multiple teams. Optional today, ignored at the UI level until we want it.

Most data has all three IDs on it (`playerId`, `teamId`, `seasonId`); reads filter by whichever the screen needs.

---

## Data model changes

### New collection: `seasons`

```ts
{
  id: 'season_2025_fall',           // human-readable
  teamId: 'team_1752188125868',     // owning team (for now; clubId in future)
  name: '2025 Fall',
  startDate: Timestamp,
  endDate: Timestamp,
  isActive: boolean,                // exactly one per team is active
  createdAt: Timestamp,
}
```

Migration: when we ship this, every existing team gets a default `season_legacy` season created automatically that backfills onto all historical data. So nothing breaks.

### `players` doc — additions

```ts
{
  // existing
  id, name, jerseyNumber, position, parentIds, isActive, teamId, teamIds, ...

  // new
  seasonMemberships: [
    { seasonId: 'season_2025_fall', teamId: 'team_xxx', jerseyNumber: 7, position: 'Striker' },
    { seasonId: 'season_2024_fall', teamId: 'team_xxx', jerseyNumber: 9, position: 'Midfielder' },
  ],

  // stats split per-season
  statsBySeasonId: {
    'season_2025_fall': { goals: 7, assists: 3, saves: 0, gamesPlayed: 5, ... },
    'season_2024_fall': { goals: 14, assists: 6, saves: 0, gamesPlayed: 12, ... },
  },

  // optional convenience cache (sum of all seasons), recomputed on write
  statsLifetime: { goals: 21, assists: 9, ... },
}
```

The current `stats` field stays during transition; new code reads from `statsBySeasonId[activeSeasonId]` and falls back to `stats` if the bucket doesn't exist.

### `player_media`, `match_votings`, `development_plans`, `attendance_records`, `events` — addition

Single new field on each:

```ts
{ seasonId: 'season_2025_fall', ... }
```

Backfilled to `season_legacy` for existing rows.

### New collection: `invites`

```ts
{
  id: 'inv_abc123',                    // also the URL slug
  type: 'player' | 'coach',            // shape of the join flow
  teamId: 'team_xxx',
  playerId?: 'player_xxx',             // present when type='player'
  role?: 'assistant_coach' | 'head_coach',  // present when type='coach'
  createdBy: 'uid_xxx',
  createdAt: Timestamp,
  expiresAt: Timestamp,                // default 30 days
  maxUses: number | null,               // null = unlimited
  usedCount: number,
  usedBy: string[],                    // uid array (for coach codes that allow multiple)
  revokedAt?: Timestamp,
}
```

URL: `firefc16.com/join/<id>`. The page reads this doc, dispatches based on `type`.

### `users` doc — small additions

```ts
{
  // existing
  email, name, role, teamId, teamIds, approved, ...

  // new
  approvalStatus: 'auto' | 'pending' | 'approved' | 'rejected',  // replaces the boolean `approved`
  approvedAt?: Timestamp,
  approvedBy?: string,
  invitedBy?: string,                  // uid of coach who shared the invite link
  invitedVia?: string,                 // invite id
}
```

Old `approved: boolean` reads keep working; new code uses `approvalStatus`.

---

## Invite flow redesign

### A. Parent → Player (the common case)

**Coach side:**
1. Coach opens a player card → "Invite Parent" → modal shows a one-tap-to-copy URL: `firefc16.com/join/inv_abc123`.
2. Coach taps "Send via SMS" → opens iMessage with the link prefilled. Or pastes wherever.
3. The player card shows a "Pending invite" badge until the link is consumed; coach can revoke any time.

**Parent side:**
1. Taps the link on their phone. Opens directly in the app if installed (universal link), else web.
2. Page shows: photo of the kid (no PII beyond name + jersey + position), "**Carson Robles · #5 · Defender**, are you their parent?".
3. Tap **Yes** → email + password (or Apple/Google sign-in). Account created.
4. The invite record is consumed → parent uid auto-pushed into `player.parentIds`. **No coach approval required** — the invite link IS the approval.
5. Lands them on the player profile with full access.

**Why this beats today:**
- Coach doesn't need to know parent email up front.
- Random self-signups can't happen — the only path to a player is via a link the coach generated.
- Approval is implicit: holding the link = vetted.

### B. Coach → Coach (assistant invites)

**Head coach side:**
1. Settings → "Invite a coach" → generates `firefc16.com/join/inv_xyz789` with `role: 'assistant_coach'`, can be reused N times (configurable, default 3).
2. Shows the link with "Copy" + "Share via SMS" buttons.

**Assistant coach side:**
1. Taps link → "**Patrick Gill** is inviting you to coach **Fire FC PG**".
2. Sign up → instantly granted assistant_coach role on that team. No approval needed.

### C. Player joins a team they aren't on yet (future, not v1)

For multi-team scenarios — coach pulls a player from another team's roster via a search. Out of scope for v1. The schema supports it via the `seasonMemberships` array.

---

## Season transitions

### "End Season" button (head coach only)

Lives on Settings or Team Management. One click flow:

1. **Modal: "End 2025 Fall season?"**
   - Shows team summary: 12 players, 14 games, 47 goals, 23 clips, 8 POTM votings.
2. **Pick which players carry over to next season** — checkbox list of all current players, default checked. Players unchecked become inactive (their data stays, they just don't show up in next season's roster).
3. **Optional: "Create the next season now"** — name (default "2026 Spring"), start date, end date.
4. **Confirm** — backend does:
   - Sets old season `isActive: false`.
   - For each carry-over player: appends to `seasonMemberships`; resets nothing on the player doc itself (stats are per-season anyway, so the new season's bucket just starts empty).
   - Inactive players: `isActive: false` on the player doc; they keep their full profile/clips/awards.
   - New season created and marked `isActive: true`.
5. Dashboard now shows fresh stat tiles (zeros for new season). Old season is one tap away via the season chip.

### Dashboard behavior across seasons

Default view on every page = current active season. A small chip at the top of stats-heavy pages lets you switch:

```
[ Current · 2025 Fall ▾ ]    ← tap to pick
   2025 Fall (active)
   2024 Fall
   2023 Fall · archived
```

For pages that don't make sense per-season (Calendar, Chat, Parent Directory), the chip is hidden — those are team-wide, not season-bound.

### Player profile (the career view)

This is where the player-centric model really pays off.

```
HERO: Hunter Gill · #5 · Defender
[ Current · 2025 Fall ▾ ]   <-- season chip in hero

STATS TILES (filtered to chip selection)
  7 Goals    3 Assists    2 POTM    18 Clips

CAREER STRIP (always visible, below the chip-filtered tiles)
  Career: 21 goals · 9 assists · 3 POTM · 2 seasons

[ tabs: Overview / Media / Development / Awards ]

— Within each tab, content also respects the season chip —
```

Tap **Career** → tiles + content show lifetime totals.
Tap **2024 Fall** → previous season stats + clips only.
Tap a player who left the team → `isActive: false` doesn't matter; their profile loads fully.

### Multi-team / multi-club scenarios

A player on two teams in the same season has two `seasonMemberships` entries with the same `seasonId` but different `teamId`. Their profile shows:

```
2025 Fall
  Fire FC PG · #5 · Defender
  Crossfire Premier · #11 · Midfielder
```

Stats stay per-team because each clip/goal/POTM has a `teamId`, but the player profile aggregates across them.

### Club portal (future)

Add an optional `clubId` field to `team`. Once teams have clubIds, a Club page is a query: "all teams where clubId == X, all stats this season, top scorers across the club". No schema migration needed at that point — the field is just there waiting.

---

## Migration plan

Order of operations to ship without breaking the live app:

### Phase 1 — Add fields, write to both old + new (no UI change)

- Create `seasons` collection. Write a script: for every existing team, create one `season_legacy` season (start = team creation, end = far future, active = true).
- For every existing `player`, copy `stats` → `statsBySeasonId.season_legacy`. Add `seasonMemberships: [{ seasonId: 'season_legacy', teamId, jerseyNumber, position }]`.
- For every existing `player_media`, `match_votings`, `development_plans`, `attendance_records`, `events`: backfill `seasonId: 'season_legacy'`.
- Update every write site to also write `seasonId` going forward.

This is invisible to users — nothing reads the new fields yet. Safe to deploy.

### Phase 2 — Read from new fields with fallback

- Stats reads: try `statsBySeasonId[activeSeasonId]`, fall back to `stats`.
- Filtering: where the screen wants current-season-only, filter by `seasonId == activeSeasonId`. Old data without `seasonId` falls into `season_legacy` and won't show — that's fine because we backfilled.

Still no UI change. Verify nothing regressed.

### Phase 3 — Build invite flow

- New `invites` collection.
- `firefc16.com/join/<id>` route (already exists for legacy `/join` flow — extend).
- "Invite Parent" button on player card.
- "Invite Coach" button in Team Management.
- Drop the email-collection-up-front from the player edit form (keep it as optional for legacy).

### Phase 4 — Build season UI

- Season chip on Dashboard, Player Profile, Stats.
- Career strip on Player Profile.
- "End Season" modal in Team Management.
- Update Quick Game / clip upload / POTM creation to stamp the active `seasonId`.

### Phase 5 — Cleanup

- Drop `player.stats` denormalized field after a few weeks of dual-writing.
- Mark old `approved: boolean` deprecated; read from `approvalStatus`.
- Delete the legacy `/join?invite=<code>` flow once everyone's migrated.

---

## Estimated effort

Rough — assuming evenings + weekends:

| Phase | Effort |
| --- | --- |
| 1 — schema + backfill script | ~1 day |
| 2 — read with fallback | ~1 day |
| 3 — invite flow | ~2-3 days |
| 4 — season UI + End Season | ~2-3 days |
| 5 — cleanup | ~1 day |
| **Total** | **~1-2 weeks of part-time** |

Smaller than the iOS push migration because most of the work is data-shape, not UI.

---

## Open questions

1. **Should parents who join via a player invite be auto-`approved: true`?** I'd say yes — holding the link is the trust signal.
2. **Do we let assistant coaches generate parent invites?** Probably yes — they manage their assigned players. Head coach can revoke.
3. **What's the default season length?** Most clubs have Fall + Spring sessions. Should "End Season" default to today as the end date, with a "you can edit this later" note?
4. **Should clips be sharable to past parents who've left?** I.e., if a kid was on Fire FC 2023 and the parent's account was archived, can they still log in and view? Lean yes — login still works, they just see their kid's profile (read-only for past seasons).
5. **POTM voting — is it tied to a season?** Probably yes (a vote belongs to a game which belongs to a season). When viewing past-season votings, no one can vote — they're frozen.
6. **What about the existing `approved` admin flow?** With invite links being the approval signal, the approval queue mostly empties out. We can leave the existing UI in place for legacy edge cases.

---

## What this enables next

Once seasons and proper invites are in place:

- **Recruiting reels** — share `firefc16.com/player/<id>?season=2024` as a permalink for college coaches. Showcases lifetime career or single-season highlights.
- **Year-over-year comparisons** on the player profile ("This season vs last season").
- **Club Portal** as a tiny project — just queries spanning multiple teams.
- **Roster import** from previous season → next season ("Pull last year's U12 roster into this year's U13").
- **Returning-player onboarding** — a parent already in the system clicks an invite link for a new season, gets auto-linked without re-signing-up.

---

## Tradeoffs / what we lose

- Slightly more complex data model. New code has to remember to stamp `seasonId` on writes.
- Stats reads need a season context to be meaningful (we'll thread `activeSeasonId` through the React tree via context, similar to `selectedTeamId` today).
- Existing CSV exports / external integrations (none today, but) need to know about `seasonId`.

Net: small ongoing tax for a meaningful product unlock.
