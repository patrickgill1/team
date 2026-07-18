#!/usr/bin/env tsx
/**
 * Seed the Lightning FC U10 demo team.
 *
 * Owned by Patrick's real uid so it appears in his own team selector.
 * The team is flagged `isDemo: true` which kills push fan-out AND
 * forces countsToStats=false on games, so nothing here bleeds into
 * real stats or spams anyone.
 *
 * DRY-RUN default. Pass --apply to actually write.
 *
 * Usage:
 *   npx tsx scripts/seed-lightning-fc-demo.ts                       # dry-run
 *   npx tsx scripts/seed-lightning-fc-demo.ts --apply                # write
 *   npx tsx scripts/seed-lightning-fc-demo.ts --apply --patrick-uid=<uid>
 *
 * Patrick uid resolution order:
 *   1. --patrick-uid=<uid> flag
 *   2. PATRICK_UID env var
 *   3. Firebase Auth lookup by email 'patrick.gill@zfpmail.org'
 *      (may fail if he signs in with Apple relay — use flag/env in that case)
 *
 * Re-runs are idempotent: deterministic doc ids everywhere + check-
 * then-create at the top level. Kudos / xp events use deterministic
 * ids so a second run overwrites the same docs instead of duplicating.
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? 'APPLY' : 'DRY  ';

// --- Service account boot -------------------------------------------------
const candidates = ['firebase-service-account.json', 'demo-service-account.json'];
let serviceAccountPath: string | null = null;
for (const c of candidates) {
  const p = path.resolve(__dirname, c);
  if (fs.existsSync(p)) { serviceAccountPath = p; break; }
}
if (!serviceAccountPath) {
  console.error('Missing scripts/firebase-service-account.json (or demo-service-account.json).');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))),
});
const db = admin.firestore();
const auth = admin.auth();

// --- Constants ------------------------------------------------------------
const TEAM_ID = 'lightning_fc_u10_demo';
const TEAM_NAME = 'Lightning FC U10';
const SEASON_LABEL = 'Fall 2026';
const SEASON_ID = 'lightning_fc_u10_demo_2026_fall';
const PATRICK_EMAIL = 'patrick.gill@zfpmail.org';

// Sender uids for kudos (fake Circle members)
const SENDER_MOM_ELENA = 'demo_sender_mom_elena';
const SENDER_DAD_SAM = 'demo_sender_dad_sam';
const SENDER_MOM_SAM = 'demo_sender_mom_sam';
const SENDER_DAD_NOLAN = 'demo_sender_dad_nolan';
const SENDER_MOM_AVA = 'demo_sender_mom_ava';
const SENDER_MOM_KAI = 'demo_sender_mom_kai';
const SENDER_COACH_ASSISTANT = 'demo_sender_asst_coach';

// --- Helpers --------------------------------------------------------------
const daysAgo = (d: number, hour = 10, minute = 0) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, minute, 0, 0);
  return t;
};
const daysFromNow = (d: number, hour = 18, minute = 0) => daysAgo(-d, hour, minute);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function resolvePatrickUid(): Promise<string> {
  const flag = process.argv.find(a => a.startsWith('--patrick-uid='));
  if (flag) return flag.slice('--patrick-uid='.length);
  if (process.env.PATRICK_UID) return process.env.PATRICK_UID!;
  try {
    const u = await auth.getUserByEmail(PATRICK_EMAIL);
    return u.uid;
  } catch (err: any) {
    console.error(`\nCould not resolve Patrick uid.`);
    console.error(`  Tried email lookup for ${PATRICK_EMAIL} — not found`);
    console.error(`  (Apple Sign-In private-relay addresses do not match this email.)`);
    console.error(`\nPass --patrick-uid=<uid> or set PATRICK_UID env var.`);
    console.error(`Find it: Firebase Console → Authentication → Users → your row.`);
    process.exit(1);
  }
}

async function docExists(collection: string, id: string): Promise<boolean> {
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists;
}

async function write(collection: string, id: string, data: any, existed: boolean) {
  const verb = existed ? 'merge   ' : 'create  ';
  console.log(`[${tag}] ${verb} ${collection}/${id}`);
  if (APPLY) {
    await db.collection(collection).doc(id).set(data, { merge: true });
  }
}

// --- Roster ---------------------------------------------------------------
type SeedPlayer = {
  jersey: number;
  first: string;
  last: string;
  position: 'Defender' | 'Midfielder' | 'Striker' | 'Goalkeeper';
};

const ROSTER: SeedPlayer[] = [
  { jersey: 4,  first: 'Elena',    last: 'Torres',   position: 'Defender'   },
  { jersey: 6,  first: 'Mason',    last: 'Chen',     position: 'Defender'   },
  { jersey: 7,  first: 'Jaylen',   last: 'Brooks',   position: 'Midfielder' },
  { jersey: 9,  first: 'Olivia',   last: 'Park',     position: 'Striker'    },
  { jersey: 10, first: 'Sam',      last: 'Rivera',   position: 'Midfielder' },
  { jersey: 11, first: 'Ava',      last: 'Kim',      position: 'Striker'    },
  { jersey: 12, first: 'Kai',      last: 'Reyes',    position: 'Midfielder' },
  { jersey: 14, first: 'Marcus',   last: 'Delaney',  position: 'Defender'   },
  { jersey: 15, first: 'Sophie',   last: 'Tran',     position: 'Midfielder' },
  { jersey: 17, first: 'Diego',    last: 'Morales',  position: 'Striker'    },
  { jersey: 22, first: 'Ella',     last: 'Grant',    position: 'Defender'   },
  { jersey: 23, first: 'Nolan',    last: 'Ford',     position: 'Goalkeeper' },
];

const pid = (jersey: number) => `lightning_demo_player_${String(jersey).padStart(2, '0')}`;
const playerName = (p: SeedPlayer) => `${p.first} ${p.last}`;
const findByFirst = (first: string) => ROSTER.find(p => p.first === first)!;

// --- Seeders --------------------------------------------------------------
async function seedTeam(patrickUid: string) {
  const existed = await docExists('teams', TEAM_ID);
  const now = new Date();
  const data = {
    id: TEAM_ID,
    name: TEAM_NAME,
    ageGroup: 'Under 10',
    season: SEASON_LABEL,
    format: '7v7' as const,
    audienceType: 'youth' as const,
    coachIds: [patrickUid],
    headCoachId: patrickUid,
    assistantCoachIds: [] as string[],
    managerIds: [] as string[],
    playerIds: ROSTER.map(p => pid(p.jersey)),
    parentIds: [] as string[],
    isActive: true,
    isDemo: true,
    notificationsDisabled: true,
    homeKitColor: 'Yellow',
    awayKitColor: 'Black',
    streakConfig: { restDayOfWeek: 0 as const },
    xpConfig: {
      enabled: true,
      enabledAt: now,
      sources: {
        participation: true,
        badges: true,
        practice: true,
        rsvp: true,
        practiceAttendance: true,
        gameAttendance: true,
        effortBonus: true,
        firstGoal: true,
        firstAssist: true,
        firstSave: true,
        firstCleanSheet: false,     // off — visual variety on CoachXpConfig
        firstPotm: true,
        streaks: true,
        perfectAttendance: true,
        whisper: true,
        coachLiveGrant: true,
        kudosConvert: false,        // off — visual variety
      },
    },
    createdBy: patrickUid,
    createdAt: now,
  };
  await write('teams', TEAM_ID, data, existed);
  return existed;
}

async function ensurePatrickUserTeamLink(patrickUid: string) {
  // Add TEAM_ID to Patrick's users/{uid}.teamIds arrayUnion so the team
  // appears in his selector. Don't touch anything else on his user doc.
  console.log(`[${tag}] merge    users/${patrickUid} (teamIds arrayUnion ${TEAM_ID})`);
  if (APPLY) {
    await db.collection('users').doc(patrickUid).set({
      teamIds: admin.firestore.FieldValue.arrayUnion(TEAM_ID),
    }, { merge: true });
  }
}

async function seedPlayers() {
  const now = new Date();
  const createdBase = daysAgo(45);
  for (const p of ROSTER) {
    const id = pid(p.jersey);
    const existed = await docExists('players', id);
    const isSam = p.first === 'Sam';

    const base: any = {
      id,
      name: playerName(p),
      firstName: p.first,
      lastName: p.last,
      jerseyNumber: p.jersey,
      position: p.position,
      positions: [p.position],
      teamId: TEAM_ID,
      teamIds: [TEAM_ID],
      parentIds: [] as string[],
      isActive: true,
      createdAt: createdBase,
      dateOfBirth: '2016-05-15',
      publicShare: { enabled: false },
    };

    if (isSam) {
      base.nickname = 'Sammy';
      base.favoriteTeam = 'Barcelona';
      base.favoriteNumber = 10;
      base.favoritePlayer = 'Pedri';
      base.xp = 450;
      base.xpCareer = 450;
      base.currentStreakDays = 8;
      base.currentStreakUpdatedAt = daysAgo(0, 20);
      base.badges = {
        first_goal:  { earnedAt: daysAgo(21), seasonId: SEASON_ID, context: SEASON_LABEL },
        streak_10:   { earnedAt: daysAgo(4),  seasonId: SEASON_ID, context: '10-day practice streak' },
        first_potm:  { earnedAt: daysAgo(3),  seasonId: SEASON_ID, context: 'vs Southside Storm' },
      };
    }
    await write('players', id, base, existed);
  }
}

async function seedEvents(patrickUid: string) {
  const eventDocs: Array<{ id: string; data: any }> = [];

  // 1. UPCOMING practice tonight, 8pm.
  eventDocs.push({
    id: 'lightning_demo_evt_practice_tonight',
    data: {
      id: 'lightning_demo_evt_practice_tonight',
      title: 'Team practice',
      type: 'practice',
      teamId: TEAM_ID,
      date: daysFromNow(0, 20, 0),
      location: 'Grand Park',
      arriveOffsetMinutes: 15,
      createdBy: patrickUid,
      createdByName: 'Coach Patrick',
      createdAt: daysAgo(4),
      isCancelled: false,
    },
  });

  // 2. UPCOMING game tomorrow evening, 6pm.
  eventDocs.push({
    id: 'lightning_demo_evt_game_tomorrow',
    data: {
      id: 'lightning_demo_evt_game_tomorrow',
      title: 'vs Riverdale FC',
      type: 'game',
      teamId: TEAM_ID,
      opponent: 'Riverdale FC',
      homeAway: 'home',
      date: daysFromNow(1, 18, 0),
      location: 'City Field 3',
      arriveOffsetMinutes: 30,
      createdBy: patrickUid,
      createdByName: 'Coach Patrick',
      createdAt: daysAgo(5),
      isCancelled: false,
      autoCreatePotm: true,
      countsToStats: false,
    },
  });

  // 3. RECENT completed game 3 days ago vs Southside Storm.
  //    playerRsvps showing 10 of 12 attended.
  const playerRsvps: Record<string, any> = {};
  const attendedFirst = ROSTER.slice(0, 10);
  for (const p of attendedFirst) {
    playerRsvps[pid(p.jersey)] = {
      status: 'going' as const,
      playerName: playerName(p),
      byUid: patrickUid,
      byName: 'Coach Patrick',
      respondedAt: daysAgo(4, 9),
    };
  }
  eventDocs.push({
    id: 'lightning_demo_evt_game_recent',
    data: {
      id: 'lightning_demo_evt_game_recent',
      title: 'vs Southside Storm',
      type: 'game',
      teamId: TEAM_ID,
      opponent: 'Southside Storm',
      homeAway: 'away',
      date: daysAgo(3, 17, 0),
      location: 'Southside Fields, Pitch 2',
      arriveOffsetMinutes: 30,
      createdBy: patrickUid,
      createdByName: 'Coach Patrick',
      createdAt: daysAgo(10),
      isCancelled: false,
      finalScoreHome: 3,
      finalScoreAway: 2,
      playerRsvps,
      autoCreatePotm: true,
      countsToStats: false,
    },
  });

  for (const e of eventDocs) {
    const existed = await docExists('events', e.id);
    await write('events', e.id, e.data, existed);
  }
}

async function seedMatchVotings(patrickUid: string) {
  const samId = pid(10);
  const elenaId = pid(4);
  const nolanId = pid(23);
  const oliviaId = pid(9);
  const eligiblePlayerIds = ROSTER.map(p => pid(p.jersey));

  // 1. CLOSED voting on the recent game — Sam wins 3-2 over Elena.
  const closedId = 'lightning_demo_potm_recent';
  const closedExisted = await docExists('match_votings', closedId);
  const gameDate = daysAgo(3, 17, 0);
  await write('match_votings', closedId, {
    id: closedId,
    teamId: TEAM_ID,
    gameId: 'lightning_demo_evt_game_recent',
    calendarEventId: 'lightning_demo_evt_game_recent',
    gameTitle: 'vs Southside Storm',
    gameDate,
    opponent: 'Southside Storm',
    homeAway: 'away',
    location: 'Southside Fields, Pitch 2',
    isActive: false,
    status: 'closed',
    closedAt: daysAgo(2, 18),
    eligiblePlayerIds,
    createdBy: patrickUid,
    createdByName: 'Coach Patrick',
    createdAt: daysAgo(3, 20),
    votes: [
      { voterId: SENDER_DAD_SAM,         voterName: "Sam's dad",   playerId: samId,    playerName: 'Sam Rivera',  reason: 'Sam controlled the midfield all game', timestamp: daysAgo(2, 19) },
      { voterId: SENDER_MOM_SAM,         voterName: "Sam's mom",   playerId: samId,    playerName: 'Sam Rivera',  reason: 'Sam again, he was everywhere',          timestamp: daysAgo(2, 20) },
      { voterId: SENDER_COACH_ASSISTANT, voterName: 'Coach Riley', playerId: samId,    playerName: 'Sam Rivera',  reason: 'Every good sequence went through him',  timestamp: daysAgo(2, 21) },
      { voterId: SENDER_MOM_ELENA,       voterName: "Elena's mom", playerId: elenaId,  playerName: 'Elena Torres',reason: 'Great defensive play from Elena',       timestamp: daysAgo(2, 22) },
      { voterId: SENDER_DAD_NOLAN,       voterName: "Nolan's dad", playerId: nolanId,  playerName: 'Nolan Ford',  reason: 'Amazing save at the end from Nolan!',   timestamp: daysAgo(2, 23) },
      { voterId: SENDER_MOM_AVA,         voterName: "Ava's mom",   playerId: oliviaId, playerName: 'Olivia Park', reason: "Olivia's goal was pure class",          timestamp: daysAgo(3, 8) },
      // Sam finishes with 3, Elena 2, Nolan 1, Olivia 1. Sam wins 3-2 over Elena.
      { voterId: SENDER_MOM_KAI,         voterName: "Kai's mom",   playerId: elenaId,  playerName: 'Elena Torres',reason: 'Elena cleaned up every ball',           timestamp: daysAgo(3, 9) },
    ],
    winner:  { playerId: samId, playerName: 'Sam Rivera', voteCount: 3 },
    winners: [{ playerId: samId, playerName: 'Sam Rivera', voteCount: 3 }],
  }, closedExisted);

  // 2. ACTIVE voting on the upcoming (tomorrow's) game — for dashboard/wall
  //    "vote is open" state. 3 votes already cast; results hidden while open.
  const activeId = 'lightning_demo_potm_active';
  const activeExisted = await docExists('match_votings', activeId);
  await write('match_votings', activeId, {
    id: activeId,
    teamId: TEAM_ID,
    gameId: 'lightning_demo_evt_game_tomorrow',
    calendarEventId: 'lightning_demo_evt_game_tomorrow',
    gameTitle: 'vs Riverdale FC',
    gameDate: daysFromNow(1, 18, 0),
    opponent: 'Riverdale FC',
    homeAway: 'home',
    location: 'City Field 3',
    isActive: true,
    eligiblePlayerIds,
    createdBy: patrickUid,
    createdByName: 'Coach Patrick',
    createdAt: minutesAgo(90),
    votes: [
      { voterId: SENDER_DAD_SAM,   voterName: "Sam's dad",   playerId: samId,    playerName: 'Sam Rivera',  reason: 'Best game he has played',            timestamp: minutesAgo(85) },
      { voterId: SENDER_MOM_ELENA, voterName: "Elena's mom", playerId: elenaId,  playerName: 'Elena Torres',reason: 'Rock solid at the back',             timestamp: minutesAgo(60) },
      { voterId: SENDER_MOM_AVA,   voterName: "Ava's mom",   playerId: oliviaId, playerName: 'Olivia Park', reason: 'Two goals and never stopped running',timestamp: minutesAgo(30) },
    ],
  }, activeExisted);
}

async function seedKudos() {
  const samId = pid(10);
  const elenaId = pid(4);
  const nolanId = pid(23);
  const avaId   = pid(11);
  const kaiId   = pid(12);

  type K = {
    slug: string;
    playerId: string;
    playerName: string;
    senderUid: string;
    senderName: string;
    note: string;
    daysBack: number;
    presetKind?: string;
  };

  const kudos: K[] = [
    { slug: 'sam_1',   playerId: samId,   playerName: 'Sam Rivera',
      senderUid: SENDER_DAD_SAM, senderName: "Sam's dad",
      note: 'Loved how Sammy stayed calm under pressure today. Kept his head up when the game got hectic.',
      daysBack: 12, presetKind: 'kind_moment' },
    { slug: 'sam_2',   playerId: samId,   playerName: 'Sam Rivera',
      senderUid: SENDER_MOM_SAM, senderName: "Sam's mom",
      note: 'He came home talking about the assist to Ava all night. So proud.',
      daysBack: 6, presetKind: 'practiced_hard' },
    { slug: 'sam_3',   playerId: samId,   playerName: 'Sam Rivera',
      senderUid: SENDER_COACH_ASSISTANT, senderName: 'Coach Riley',
      note: 'Best training session of the month — worked the whole hour and still asked for more.',
      daysBack: 2 },
    { slug: 'elena_1', playerId: elenaId, playerName: 'Elena Torres',
      senderUid: SENDER_MOM_ELENA, senderName: "Elena's mom",
      note: "Elena's second half was incredible. Never stopped tracking runners.",
      daysBack: 3, presetKind: 'kind_moment' },
    { slug: 'elena_2', playerId: elenaId, playerName: 'Elena Torres',
      senderUid: SENDER_COACH_ASSISTANT, senderName: 'Coach Riley',
      note: 'Quiet leader on the field. Teammates listen when she talks.',
      daysBack: 8 },
    { slug: 'nolan_1', playerId: nolanId, playerName: 'Nolan Ford',
      senderUid: SENDER_DAD_NOLAN, senderName: "Nolan's dad",
      note: 'That save at the end saved the game. He was so happy on the drive home.',
      daysBack: 2, presetKind: 'practiced_hard' },
    { slug: 'ava_1',   playerId: avaId,   playerName: 'Ava Kim',
      senderUid: SENDER_MOM_AVA, senderName: "Ava's mom",
      note: 'Ava was cheering for everyone on the sideline — even the kids on the other team. Good kid.',
      daysBack: 9, presetKind: 'kind_moment' },
    { slug: 'kai_1',   playerId: kaiId,   playerName: 'Kai Reyes',
      senderUid: SENDER_MOM_KAI, senderName: "Kai's mom",
      note: 'Kai practiced juggling for 45 minutes in the backyard today. New personal best.',
      daysBack: 5, presetKind: 'practiced_hard' },
  ];

  for (const k of kudos) {
    const id = `lightning_demo_kudos_${k.slug}`;
    const existed = await docExists('kudos', id);
    await write('kudos', id, {
      id,
      playerId: k.playerId,
      playerName: k.playerName,
      teamId: TEAM_ID,
      seasonId: SEASON_ID,
      senderUid: k.senderUid,
      senderName: k.senderName,
      presetKind: k.presetKind ?? null,
      note: k.note,
      createdAt: daysAgo(k.daysBack, 19),
    }, existed);
  }
}

async function seedDevelopmentPlan(patrickUid: string) {
  const samId = pid(10);
  const planId = 'lightning_demo_plan_sam';
  const existed = await docExists('development_plans', planId);

  // 5 practice logs across the last 8 days on the primary goal, streak-safe.
  const cursor = new Date();
  cursor.setHours(16, 30, 0, 0);
  cursor.setDate(cursor.getDate() - 1);
  const logDates: Date[] = [];
  let walk = 0;
  while (logDates.length < 5 && walk < 12) {
    if (cursor.getDay() !== 0) logDates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
    walk++;
  }

  const notes = [
    'Worked on quick 1-2s with dad in the backyard',
    '20 minutes of wall passing — both feet',
    'Cone weave + first-touch turn 15 min',
    'Wall passing again, worked on the weak foot',
    'Quick 1-2s with dad after school',
  ];

  const primaryLog = logDates.map((d, i) => ({
    id: `lightning_demo_pl_primary_${i}`,
    date: d,
    note: notes[i],
    minutes: 20 + (i % 3) * 5,
    loggedBy: patrickUid,
    loggedByName: "Sam's dad",
  }));

  await write('development_plans', planId, {
    id: planId,
    playerId: samId,
    playerName: 'Sam Rivera',
    teamId: TEAM_ID,
    seasonId: SEASON_ID,
    title: 'First-touch and quick passing',
    description: 'Three short drills every session. Focus on soft first touch, head up between touches, and clean short passes on both feet.',
    category: 'technical',
    status: 'active',
    createdBy: patrickUid,
    createdByName: 'Coach Patrick',
    createdAt: daysAgo(9),
    updatedAt: minutesAgo(30),
    goals: [
      {
        id: 'lightning_demo_goal_wall',
        order: 1,
        title: 'Passing wall — 100 reps',
        focus: 'Both feet. Inside of the foot, follow through.',
        targetMinutes: 15,
        playerCompleted: false,
        readyForReview: true,
        coachVerified: false,
        practiceLog: primaryLog,
      },
      {
        id: 'lightning_demo_goal_firsttouch',
        order: 2,
        title: 'First-touch turn drill',
        focus: 'Touch away from pressure. Head up before you receive.',
        targetMinutes: 10,
        playerCompleted: false,
        readyForReview: false,
        coachVerified: false,
        practiceLog: [],
      },
      {
        id: 'lightning_demo_goal_quickpass',
        order: 3,
        title: '1-2 with a partner',
        focus: 'Move after you pass. Ask for it back.',
        targetMinutes: 10,
        playerCompleted: false,
        readyForReview: false,
        coachVerified: false,
        practiceLog: [],
      },
    ],
  }, existed);
}

async function seedXpEvents(patrickUid: string) {
  // Sam total = 450 XP:
  //   goal (100) + streak_milestone (200) + potm (75) + 2x coach_live (30 + 20)
  //   + 5x dev_plan_log (5 each) = 100 + 200 + 75 + 30 + 20 + 25 = 450
  const samId = pid(10);
  const events: Array<{
    slug: string;
    playerId: string;
    playerName: string;
    xp: number;
    source: string;
    daysBack: number;
    note?: string;
    sourceRef?: string;
  }> = [
    { slug: 'sam_goal',          playerId: samId, playerName: 'Sam Rivera', xp: 100, source: 'goal',
      daysBack: 21, note: 'First goal of the season vs Ridgemont',
      sourceRef: 'lightning_demo_stat_goal_first' },
    { slug: 'sam_streak10',      playerId: samId, playerName: 'Sam Rivera', xp: 200, source: 'streak_milestone',
      daysBack: 4, note: '10-day practice streak', sourceRef: '10' },
    { slug: 'sam_potm',          playerId: samId, playerName: 'Sam Rivera', xp: 75,  source: 'potm',
      daysBack: 3, note: 'Player of the Match vs Southside Storm',
      sourceRef: 'lightning_demo_potm_recent' },
    { slug: 'sam_live_1',        playerId: samId, playerName: 'Sam Rivera', xp: 30,  source: 'coach_live',
      daysBack: 5, note: 'Great effort tracking back to defend' },
    { slug: 'sam_live_2',        playerId: samId, playerName: 'Sam Rivera', xp: 20,  source: 'coach_live',
      daysBack: 1, note: 'Winner of the finishing drill' },
    { slug: 'sam_dev_1',         playerId: samId, playerName: 'Sam Rivera', xp: 5,   source: 'dev_plan_log',
      daysBack: 1, sourceRef: 'lightning_demo_plan_sam' },
    { slug: 'sam_dev_2',         playerId: samId, playerName: 'Sam Rivera', xp: 5,   source: 'dev_plan_log',
      daysBack: 2, sourceRef: 'lightning_demo_plan_sam' },
    { slug: 'sam_dev_3',         playerId: samId, playerName: 'Sam Rivera', xp: 5,   source: 'dev_plan_log',
      daysBack: 3, sourceRef: 'lightning_demo_plan_sam' },
    { slug: 'sam_dev_4',         playerId: samId, playerName: 'Sam Rivera', xp: 5,   source: 'dev_plan_log',
      daysBack: 5, sourceRef: 'lightning_demo_plan_sam' },
    { slug: 'sam_dev_5',         playerId: samId, playerName: 'Sam Rivera', xp: 5,   source: 'dev_plan_log',
      daysBack: 8, sourceRef: 'lightning_demo_plan_sam' },
  ];

  for (const e of events) {
    const id = `lightning_demo_xp_${e.slug}`;
    const existed = await docExists('player_xp_events', id);
    const data: any = {
      id,
      playerId: e.playerId,
      playerName: e.playerName,
      teamId: TEAM_ID,
      seasonId: SEASON_ID,
      xp: e.xp,
      source: e.source,
      awardedBy: patrickUid,
      awardedByRole: 'coach',
      createdAt: daysAgo(e.daysBack, 20),
    };
    if (e.note) data.note = e.note;
    if (e.sourceRef) data.sourceRef = e.sourceRef;
    await write('player_xp_events', id, data, existed);
  }
}

async function seedSurvey(patrickUid: string) {
  const id = 'lightning_demo_survey_coach_feedback';
  const existed = await docExists('surveys', id);
  await write('surveys', id, {
    id,
    title: 'How Am I Doing? Coach Feedback',
    description: 'Two-minute anonymous check-in. Your honest answers help me get better for the kids.',
    teamId: TEAM_ID,
    questions: [
      { id: 'q1', order: 1, type: 'rating', maxRating: 5, required: true,
        text: 'How would you rate the coaching this season so far?' },
      { id: 'q2', order: 2, type: 'rating', maxRating: 5, required: true,
        text: 'Is your child having fun at practices and games?' },
      { id: 'q3', order: 3, type: 'yes_no', required: true,
        text: 'Do you feel communication (schedule, updates, chat) has been clear?' },
      { id: 'q4', order: 4, type: 'multiple_choice', required: false,
        options: ['Ball skills', 'Game IQ', 'Confidence', 'Fitness', 'Teamwork'],
        allowMultiple: true,
        text: 'Where have you seen the most growth in your child? (pick any)' },
      { id: 'q5', order: 5, type: 'text', required: false,
        text: 'What is one thing I could do better as a coach?' },
      { id: 'q6', order: 6, type: 'text', required: false,
        text: 'Anything else you want me to know?' },
    ],
    isActive: true,
    isAnonymous: true,
    resultsPublic: false,
    createdBy: patrickUid,
    createdByName: 'Coach Patrick',
    responseCount: 0,
    createdAt: daysAgo(2, 10),
  }, existed);
}

// --- Main -----------------------------------------------------------------
(async () => {
  console.log(`\n=== Seed Lightning FC U10 demo team [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===\n`);

  const patrickUid = await resolvePatrickUid();
  console.log(`Patrick uid: ${patrickUid}\n`);

  const teamExisted = await seedTeam(patrickUid);
  console.log(teamExisted
    ? `  team already existed — merged updates`
    : `  team did not exist — created fresh\n`);

  await ensurePatrickUserTeamLink(patrickUid);
  console.log('');

  console.log('Players:');
  await seedPlayers();
  console.log('');

  console.log('Events:');
  await seedEvents(patrickUid);
  console.log('');

  console.log('Match votings:');
  await seedMatchVotings(patrickUid);
  console.log('');

  console.log('Kudos:');
  await seedKudos();
  console.log('');

  console.log('Development plan (Sam Rivera):');
  await seedDevelopmentPlan(patrickUid);
  console.log('');

  console.log('XP events (Sam Rivera, total = 450):');
  await seedXpEvents(patrickUid);
  console.log('');

  console.log('Survey:');
  await seedSurvey(patrickUid);
  console.log('');

  console.log(`\nDone. ${APPLY ? 'Applied all writes.' : 'DRY-RUN complete. Re-run with --apply to write.'}\n`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
