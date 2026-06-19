// Seed a rich demo team for App Store screenshots.
//
// Usage:
//   1. Firebase Console → Project Settings → Service Accounts →
//      "Generate new private key". Save the JSON as:
//        scripts/demo-service-account.json
//      (.gitignored — never committed.)
//   2. npx tsx scripts/seedDemoTeam.ts
//   3. Sign into the app on the iOS Simulator as:
//        Email:    demo@firefc.app
//        Password: DemoScreenshots2026!
//   4. The "Fire FC U11 Elite" team appears in your team selector.
//      Take screenshots. Sign back into your real account when done.
//
// Re-run idempotently — every write is a `set({ ... }, { merge: true })`
// so subsequent runs refresh content without duplicating.
//
// To clean up later, delete the team via the app's team-management
// flow OR `node scripts/seedDemoTeam.ts --delete` (TODO if you want
// it; for now just delete the demo coach user in Firebase Console).

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccountPath = path.resolve(__dirname, 'demo-service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing scripts/demo-service-account.json');
  console.error('Firebase Console → Project Settings → Service Accounts → "Generate new private key"');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))),
});

const db = admin.firestore();
const auth = admin.auth();

const DEMO_EMAIL = 'demo@firefc.app';
const DEMO_PASSWORD = 'DemoScreenshots2026!';
const DEMO_TEAM_ID = 'demo_team_v3';
const DEMO_TEAM_NAME = 'Fire FC U11 Elite';

// Days back helper for realistic timestamps.
const daysAgo = (d: number, hour = 10) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  return t;
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function ensureDemoCoach(): Promise<string> {
  try {
    const user = await auth.getUserByEmail(DEMO_EMAIL);
    return user.uid;
  } catch {
    const user = await auth.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Coach Jordan Reyes',
    });
    return user.uid;
  }
}

async function seedTeamAndUser(coachUid: string) {
  await db.collection('teams').doc(DEMO_TEAM_ID).set({
    id: DEMO_TEAM_ID,
    name: DEMO_TEAM_NAME,
    ageGroup: 'Under 11',
    season: 'Fall 2026',
    coachId: coachUid,
    isActive: true,
    createdAt: new Date(),
  }, { merge: true });

  await db.collection('users').doc(coachUid).set({
    uid: coachUid,
    id: coachUid,
    email: DEMO_EMAIL,
    name: 'Coach Jordan Reyes',
    role: 'coach',
    teamId: DEMO_TEAM_ID,
    teamIds: [DEMO_TEAM_ID],
    isClubAdmin: true,
    approved: true,
    isActive: true,
    createdAt: new Date(),
    privacy: { showPhone: true, showEmail: true, showAddress: false },
    coachLevel: 'F',
    // Pin the team chat so the screenshot shows a pinned thread.
    pinnedThreadIds: [`thread_${DEMO_TEAM_ID}_main`],
  }, { merge: true });

  // A handful of fake parent user docs so the chat list + roster
  // show real names instead of "Unknown".
  const parents = [
    { uid: 'demo_p_sarah', name: 'Sarah Patel', email: 'sarah.demo@example.com' },
    { uid: 'demo_p_marcus', name: 'Marcus Brooks', email: 'marcus.demo@example.com' },
    { uid: 'demo_p_lisa', name: 'Lisa Reynolds', email: 'lisa.demo@example.com' },
    { uid: 'demo_p_amy', name: 'Amy Hayes', email: 'amy.demo@example.com' },
    { uid: 'demo_p_priya', name: 'Priya Wong', email: 'priya.demo@example.com' },
    { uid: 'demo_p_kev', name: 'Kevin Mendez', email: 'kevin.demo@example.com' },
    { uid: 'demo_p_dana', name: 'Dana Garcia', email: 'dana.demo@example.com' },
  ];
  for (const p of parents) {
    await db.collection('users').doc(p.uid).set({
      uid: p.uid,
      id: p.uid,
      email: p.email,
      name: p.name,
      role: 'parent',
      teamId: DEMO_TEAM_ID,
      teamIds: [DEMO_TEAM_ID],
      approved: true,
      isActive: true,
      createdAt: new Date(),
      privacy: { showPhone: false, showEmail: true, showAddress: false },
    }, { merge: true });
  }
}

async function seedPlayers(coachUid: string) {
  // 12 demo players. Beckett is "Coach Jordan's kid" so the dashboard
  // MyPlayerCard hero renders for him (gold POTM treatment + streak).
  const roster = [
    { id: 'demo_p_cooper', name: 'Cooper Reed', firstName: 'Cooper', lastName: 'Reed', jerseyNumber: 1, position: 'Goalkeeper', parentIds: [] as string[], stats: { goals: 0, assists: 0, gamesPlayed: 6, saves: 14 } },
    { id: 'demo_p_jaxon', name: 'Jaxon Park', firstName: 'Jaxon', lastName: 'Park', jerseyNumber: 2, position: 'Defender', parentIds: [], stats: { goals: 1, assists: 2, gamesPlayed: 6 } },
    { id: 'demo_p_liam', name: 'Liam Garcia', firstName: 'Liam', lastName: 'Garcia', jerseyNumber: 3, position: 'Defender', parentIds: ['demo_p_dana'], stats: { goals: 0, assists: 1, gamesPlayed: 6 } },
    { id: 'demo_p_ezra', name: 'Ezra Walker', firstName: 'Ezra', lastName: 'Walker', jerseyNumber: 4, position: 'Defender', parentIds: [], stats: { goals: 0, assists: 0, gamesPlayed: 5 } },
    { id: 'demo_p_mason', name: 'Mason Patel', firstName: 'Mason', lastName: 'Patel', jerseyNumber: 5, position: 'Midfielder', parentIds: ['demo_p_sarah'], stats: { goals: 3, assists: 5, gamesPlayed: 6 } },
    { id: 'demo_p_theo', name: 'Theo Brooks', firstName: 'Theo', lastName: 'Brooks', jerseyNumber: 6, position: 'Midfielder', parentIds: ['demo_p_marcus'], stats: { goals: 2, assists: 4, gamesPlayed: 6 } },
    { id: 'demo_p_asher', name: 'Asher Kim', firstName: 'Asher', lastName: 'Kim', jerseyNumber: 7, position: 'Midfielder', parentIds: [], stats: { goals: 4, assists: 3, gamesPlayed: 6 } },
    { id: 'demo_p_felix', name: 'Felix Mendez', firstName: 'Felix', lastName: 'Mendez', jerseyNumber: 8, position: 'Forward', parentIds: ['demo_p_kev'], stats: { goals: 5, assists: 2, gamesPlayed: 6 } },
    { id: 'demo_p_knox', name: 'Knox Reynolds', firstName: 'Knox', lastName: 'Reynolds', jerseyNumber: 9, position: 'Forward', parentIds: ['demo_p_lisa'], stats: { goals: 7, assists: 3, gamesPlayed: 6 } },
    // BECKETT — Coach Jordan's kid + current POTM winner + on a streak.
    { id: 'demo_p_beckett', name: 'Beckett Hayes', firstName: 'Beckett', lastName: 'Hayes', jerseyNumber: 10, position: 'Forward', parentIds: [coachUid, 'demo_p_amy'], stats: { goals: 9, assists: 4, gamesPlayed: 6 }, currentStreakDays: 7 },
    { id: 'demo_p_atticus', name: 'Atticus Wong', firstName: 'Atticus', lastName: 'Wong', jerseyNumber: 11, position: 'Forward', parentIds: ['demo_p_priya'], stats: { goals: 6, assists: 5, gamesPlayed: 6 } },
    { id: 'demo_p_sawyer', name: 'Sawyer Owens', firstName: 'Sawyer', lastName: 'Owens', jerseyNumber: 12, position: 'Defender', parentIds: [], stats: { goals: 1, assists: 0, gamesPlayed: 5 } },
  ];
  for (const p of roster) {
    await db.collection('players').doc(p.id).set({
      ...p,
      teamId: DEMO_TEAM_ID,
      teamIds: [DEMO_TEAM_ID],
      isActive: true,
      createdAt: daysAgo(180),
      dateOfBirth: '2015-04-12',
    }, { merge: true });
  }
}

async function seedCalendarEvents() {
  const events = [
    {
      id: `demo_evt_game1`,
      title: 'vs Thunder FC',
      type: 'game',
      teamId: DEMO_TEAM_ID,
      opponent: 'Thunder FC',
      homeAway: 'home',
      date: daysAgo(-3, 9),
      location: 'Riverside Sports Complex',
      fieldNumber: '3',
      arriveOffsetMinutes: 30,
      isCancelled: false,
      goingCount: 9,
      pendingRsvpCount: 3,
    },
    {
      id: `demo_evt_practice1`,
      title: 'Tuesday Practice',
      type: 'practice',
      teamId: DEMO_TEAM_ID,
      date: daysAgo(-2, 17),
      location: 'Lions Park Field 2',
      arriveOffsetMinutes: 15,
      isCancelled: false,
    },
    {
      id: `demo_evt_game2`,
      title: 'vs Storm United',
      type: 'game',
      teamId: DEMO_TEAM_ID,
      opponent: 'Storm United',
      homeAway: 'away',
      date: daysAgo(-7, 11),
      location: 'Maplewood Stadium',
      fieldNumber: 'A',
      arriveOffsetMinutes: 45,
      isCancelled: false,
    },
    // Past completed game referenced by the POTM voting + result post.
    {
      id: `demo_evt_pastgame`,
      title: 'vs Eagles SC',
      type: 'game',
      teamId: DEMO_TEAM_ID,
      opponent: 'Eagles SC',
      homeAway: 'home',
      date: daysAgo(3, 10),
      location: 'Riverside Sports Complex',
      fieldNumber: '1',
      isCancelled: false,
      finalScoreHome: 4,
      finalScoreAway: 2,
    },
  ];
  for (const e of events) {
    await db.collection('events').doc(e.id).set(e, { merge: true });
  }
}

async function seedWallPosts(coachUid: string) {
  const posts = [
    {
      id: 'demo_wp_pinned',
      content: `# Fall 2026 kicks off Saturday\n\nWelcome back, families. Quick rundown for the weekend:\n\n- **Game**: vs Thunder FC at Riverside Field 3\n- **Time**: Saturday 9:00 AM\n- **Arrive**: 8:30 AM for warmups\n- **Wear**: Home (white) kit\n\nLet me know if anyone needs a ride. Looking forward to it.`,
      category: 'announcement',
      wallPinnedTop: Date.now(),
      timestamp: daysAgo(2, 19),
      reactions: [
        { emoji: '🔥', userId: 'demo_p_sarah', userName: 'Sarah Patel' },
        { emoji: '🔥', userId: 'demo_p_marcus', userName: 'Marcus Brooks' },
        { emoji: '👍', userId: 'demo_p_lisa', userName: 'Lisa Reynolds' },
        { emoji: '👍', userId: 'demo_p_amy', userName: 'Amy Hayes' },
        { emoji: '👍', userId: 'demo_p_priya', userName: 'Priya Wong' },
        { emoji: '❤️', userId: 'demo_p_dana', userName: 'Dana Garcia' },
      ],
    },
    {
      id: 'demo_wp_result',
      content: `## Fire FC 4 — Eagles SC 2\n\nHuge team effort yesterday. Defense held strong, midfield kept the ball moving, and the front line **finished their chances**.\n\n**Goals:** Beckett (2), Atticus, Felix\n**Assists:** Theo, Mason, Asher\n**Player of the Match:** Beckett Hayes\n\nProud of every single one of these kids. Recovery day Sunday, see you Tuesday.`,
      category: 'result',
      timestamp: daysAgo(3, 16),
      reactions: [
        { emoji: '🏆', userId: 'demo_p_amy', userName: 'Amy Hayes' },
        { emoji: '🏆', userId: 'demo_p_sarah', userName: 'Sarah Patel' },
        { emoji: '🔥', userId: 'demo_p_marcus', userName: 'Marcus Brooks' },
        { emoji: '🔥', userId: 'demo_p_priya', userName: 'Priya Wong' },
        { emoji: '❤️', userId: 'demo_p_lisa', userName: 'Lisa Reynolds' },
      ],
    },
    {
      id: 'demo_wp_spotlight',
      content: `## Player Spotlight — Atticus Wong\n\nThis kid has been showing up to every practice early and staying late. **5 goals and 5 assists** this season already, but it's the leadership on the field that's setting him apart. Captain material.\n\nKeep it up, Atticus.`,
      category: 'spotlight',
      timestamp: daysAgo(5, 14),
      reactions: [
        { emoji: '⚽', userId: 'demo_p_priya', userName: 'Priya Wong' },
        { emoji: '⚽', userId: 'demo_p_sarah', userName: 'Sarah Patel' },
        { emoji: '🔥', userId: 'demo_p_amy', userName: 'Amy Hayes' },
      ],
    },
    {
      id: 'demo_wp_poll',
      content: `## Practice schedule for next week\n\nGoing to pick the day that works for the most families. Let me know which one fits your week best.`,
      category: 'practice',
      timestamp: daysAgo(1, 20),
      poll: {
        question: 'What practice day works best for next week?',
        multi: false,
        options: [
          { id: 'opt_mon', text: 'Monday 5:00 PM', voters: ['demo_p_sarah', 'demo_p_amy'] },
          { id: 'opt_wed', text: 'Wednesday 5:00 PM', voters: ['demo_p_marcus', 'demo_p_lisa', 'demo_p_priya', 'demo_p_dana'] },
          { id: 'opt_thu', text: 'Thursday 5:30 PM', voters: ['demo_p_kev'] },
        ],
      },
      reactions: [
        { emoji: '👍', userId: 'demo_p_lisa', userName: 'Lisa Reynolds' },
      ],
    },
    {
      id: 'demo_wp_streak',
      content: `## On fire\n\n**Beckett Hayes** just hit a **7-day** practice streak.`,
      category: 'announcement',
      postedFrom: 'devplan',
      timestamp: minutesAgo(35),
      reactions: [
        { emoji: '🔥', userId: 'demo_p_sarah', userName: 'Sarah Patel' },
        { emoji: '🔥', userId: 'demo_p_marcus', userName: 'Marcus Brooks' },
        { emoji: '💪', userId: 'demo_p_amy', userName: 'Amy Hayes' },
        { emoji: '⚽', userId: 'demo_p_priya', userName: 'Priya Wong' },
      ],
    },
    {
      id: 'demo_wp_uniforms',
      content: `## Uniform reminder\n\nWe're **home (white)** this Saturday vs Thunder, and **away (black)** the following weekend at Maplewood. Number on the back, please double-check before you leave the house — there's always one kid who shows up in the wrong color.`,
      category: 'announcement',
      timestamp: daysAgo(4, 11),
      reactions: [
        { emoji: '👍', userId: 'demo_p_dana', userName: 'Dana Garcia' },
        { emoji: '😂', userId: 'demo_p_marcus', userName: 'Marcus Brooks' },
      ],
    },
  ];

  for (const p of posts) {
    await db.collection('wall_posts').doc(p.id).set({
      ...p,
      teamId: DEMO_TEAM_ID,
      senderId: coachUid,
      senderName: 'Coach Jordan',
      senderRole: 'coach',
      attachments: null,
      isPublic: false,
    }, { merge: true });
  }

  // Comments on a couple of posts so the engagement bar shows
  // "N comments" + preview.
  const comments = [
    { postId: 'demo_wp_pinned', senderId: 'demo_p_sarah', senderName: 'Sarah Patel', content: 'Mason will be there, can we carpool?', at: daysAgo(2, 20) },
    { postId: 'demo_wp_pinned', senderId: 'demo_p_marcus', senderName: 'Marcus Brooks', content: 'Bringing oranges and pretzels for snack 👍', at: daysAgo(2, 21) },
    { postId: 'demo_wp_result', senderId: 'demo_p_amy', senderName: 'Amy Hayes', content: 'So proud of these boys!', at: daysAgo(3, 18) },
    { postId: 'demo_wp_result', senderId: 'demo_p_priya', senderName: 'Priya Wong', content: 'Atticus came home glowing 😊', at: daysAgo(3, 19) },
    { postId: 'demo_wp_streak', senderId: 'demo_p_priya', senderName: 'Priya Wong', content: 'Beckett, you\'re inspiring my Atticus to keep up!', at: minutesAgo(15) },
  ];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    await db.collection('wall_comments').doc(`demo_wc_${i}`).set({
      id: `demo_wc_${i}`,
      postId: c.postId,
      teamId: DEMO_TEAM_ID,
      senderId: c.senderId,
      senderName: c.senderName,
      content: c.content,
      timestamp: c.at,
    }, { merge: true });
  }
}

async function seedChat(coachUid: string) {
  const allParticipantUids = [
    coachUid,
    'demo_p_sarah', 'demo_p_marcus', 'demo_p_lisa', 'demo_p_amy',
    'demo_p_priya', 'demo_p_kev', 'demo_p_dana',
  ];

  // Team chat
  const teamThreadId = `thread_${DEMO_TEAM_ID}_main`;
  await db.collection('chat_threads').doc(teamThreadId).set({
    id: teamThreadId,
    teamId: DEMO_TEAM_ID,
    title: `${DEMO_TEAM_NAME} Chat`,
    scope: 'team',
    participants: allParticipantUids,
    isDM: false,
    isGroup: false,
    isPrivate: false,
    createdAt: daysAgo(60),
    lastActivity: minutesAgo(8),
    lastMessage: {
      content: 'Snack rotation locked in — thanks Marcus!',
      senderName: 'Coach Jordan',
      timestamp: minutesAgo(8),
    },
  }, { merge: true });

  // Coaches-only thread
  const coachesThreadId = `thread_${DEMO_TEAM_ID}_coaches`;
  await db.collection('chat_threads').doc(coachesThreadId).set({
    id: coachesThreadId,
    teamId: DEMO_TEAM_ID,
    title: 'Coaches, Managers and Staff',
    scope: 'coaches',
    participants: [coachUid],
    isDM: false,
    isGroup: false,
    isPrivate: true,
    createdAt: daysAgo(60),
    lastActivity: daysAgo(1, 14),
    lastMessage: { content: 'Lineup sheet for Saturday is in the drive.', senderName: 'Coach Jordan', timestamp: daysAgo(1, 14) },
  }, { merge: true });

  // DM with Amy (Beckett's mom)
  const dmAmyId = `thread_${DEMO_TEAM_ID}_dm_amy`;
  await db.collection('chat_threads').doc(dmAmyId).set({
    id: dmAmyId,
    teamId: DEMO_TEAM_ID,
    title: 'DM: Amy Hayes',
    participants: [coachUid, 'demo_p_amy'],
    isDM: true,
    isGroup: false,
    isPrivate: false,
    createdAt: daysAgo(30),
    lastActivity: minutesAgo(45),
    lastMessage: { content: 'Of course — Beckett earned it. He\'s been incredible.', senderName: 'Coach Jordan', timestamp: minutesAgo(45) },
    dmParticipantNames: { [coachUid]: 'Coach Jordan', 'demo_p_amy': 'Amy Hayes' },
  }, { merge: true });

  // Team chat messages — a believable thread spanning ~2 days.
  const teamMsgs = [
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'Quick reminder — game day Saturday 9 AM at Riverside Field 3. Please arrive 8:30 for warmups.', at: daysAgo(2, 19) },
    { senderId: 'demo_p_sarah', senderName: 'Sarah Patel', content: 'Will do! Mason will be there. Anyone need a carpool from the west side?', at: daysAgo(2, 20) },
    { senderId: 'demo_p_marcus', senderName: 'Marcus Brooks', content: 'We can swing through and grab one — west side carpool here.', at: daysAgo(2, 20.2) },
    { senderId: 'demo_p_lisa', senderName: 'Lisa Reynolds', content: 'Knox would love a ride if there\'s room!', at: daysAgo(2, 20.4) },
    { senderId: 'demo_p_marcus', senderName: 'Marcus Brooks', content: 'Got it — we\'ll grab Knox at 8:15.', at: daysAgo(2, 20.5) },
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'Snack rotation for Saturday — I think Marcus is up?', at: daysAgo(1, 18) },
    { senderId: 'demo_p_marcus', senderName: 'Marcus Brooks', content: 'Yep, bringing orange slices and pretzels.', at: daysAgo(1, 18.1) },
    { senderId: 'demo_p_amy', senderName: 'Amy Hayes', content: 'Beckett\'s asking what time he should be there to warm up extra. He\'s been hyped all week.', at: daysAgo(1, 19) },
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'Tell him 8:15 and we\'ll do extra finishing reps. Love that.', at: daysAgo(1, 19.1) },
    { senderId: 'demo_p_priya', senderName: 'Priya Wong', content: 'Atticus might be 5 min late — orthodontist runs over sometimes. Will text when leaving.', at: minutesAgo(180) },
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'No problem, just get him here safe.', at: minutesAgo(170) },
    { senderId: 'demo_p_dana', senderName: 'Dana Garcia', content: 'Liam forgot his shinguards at school 🙃 picking them up after pickup. Should make it.', at: minutesAgo(60) },
    { senderId: 'demo_p_kev', senderName: 'Kevin Mendez', content: 'Felix is in. Game face on already.', at: minutesAgo(30) },
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'Snack rotation locked in — thanks Marcus!', at: minutesAgo(8) },
  ];

  for (let i = 0; i < teamMsgs.length; i++) {
    const m = teamMsgs[i];
    const id = `demo_cm_team_${i}`;
    await db.collection('chat_messages').doc(id).set({
      id,
      threadId: teamThreadId,
      teamId: DEMO_TEAM_ID,
      senderId: m.senderId,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.at,
      createdAt: m.at,
      updatedAt: m.at,
      readBy: { [coachUid]: m.at.getTime() },
      reactions: i === 4 ? [{ emoji: '🙏', userId: 'demo_p_lisa', userName: 'Lisa Reynolds' }] :
                 i === 7 ? [{ emoji: '🔥', userId: coachUid, userName: 'Coach Jordan' }] :
                 i === 8 ? [{ emoji: '❤️', userId: 'demo_p_amy', userName: 'Amy Hayes' }] : [],
    }, { merge: true });
  }

  // DM with Amy — short and warm.
  const dmMsgs = [
    { senderId: 'demo_p_amy', senderName: 'Amy Hayes', content: 'Just wanted to say thank you for picking Beckett for POTM. He hasn\'t stopped smiling.', at: minutesAgo(60) },
    { senderId: coachUid, senderName: 'Coach Jordan', content: 'Of course — Beckett earned it. He\'s been incredible.', at: minutesAgo(45) },
  ];
  for (let i = 0; i < dmMsgs.length; i++) {
    const m = dmMsgs[i];
    const id = `demo_cm_dm_${i}`;
    await db.collection('chat_messages').doc(id).set({
      id,
      threadId: dmAmyId,
      teamId: DEMO_TEAM_ID,
      senderId: m.senderId,
      senderName: m.senderName,
      content: m.content,
      timestamp: m.at,
      createdAt: m.at,
      updatedAt: m.at,
      readBy: { [coachUid]: m.at.getTime(), 'demo_p_amy': m.at.getTime() },
    }, { merge: true });
  }
}

async function seedMatchVoting(coachUid: string) {
  // Closed voting referencing the past completed game — Beckett wins.
  // The MyPlayerCard on the dashboard will go GOLD because we check
  // for any voting closed in the last 7 days where my player is the
  // winner.
  const votingId = 'demo_potm_v1';
  await db.collection('match_votings').doc(votingId).set({
    id: votingId,
    teamId: DEMO_TEAM_ID,
    calendarEventId: 'demo_evt_pastgame',
    gameTitle: 'vs Eagles SC',
    gameDate: daysAgo(3, 10),
    closedAt: daysAgo(2, 18),
    status: 'closed',
    eligiblePlayerIds: [
      'demo_p_cooper', 'demo_p_jaxon', 'demo_p_liam', 'demo_p_ezra',
      'demo_p_mason', 'demo_p_theo', 'demo_p_asher', 'demo_p_felix',
      'demo_p_knox', 'demo_p_beckett', 'demo_p_atticus', 'demo_p_sawyer',
    ],
    votes: [
      { voterId: 'demo_p_sarah', playerId: 'demo_p_beckett' },
      { voterId: 'demo_p_marcus', playerId: 'demo_p_beckett' },
      { voterId: 'demo_p_lisa', playerId: 'demo_p_beckett' },
      { voterId: 'demo_p_priya', playerId: 'demo_p_beckett' },
      { voterId: 'demo_p_dana', playerId: 'demo_p_atticus' },
      { voterId: 'demo_p_kev', playerId: 'demo_p_felix' },
      { voterId: coachUid, playerId: 'demo_p_beckett' },
    ],
    winner: { playerId: 'demo_p_beckett', playerName: 'Beckett Hayes', voteCount: 5 },
    winners: [{ playerId: 'demo_p_beckett', playerName: 'Beckett Hayes', voteCount: 5 }],
  }, { merge: true });
}

async function seedDevelopmentPlan(coachUid: string) {
  // Active plan on Beckett with 7 logged practice days (one per day
  // walking back from yesterday, skipping Sunday per the streak
  // helper). currentStreakDays = 7 is also denormalized on the player
  // doc so the chip renders immediately without recompute.
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setHours(15, 30, 0, 0);
  // Walk back, skipping Sundays, until we have 7 days.
  // Skip today's date to mirror "logged yesterday and prior" state —
  // the parent can still tap "Did it today" to bump to 8 in the demo.
  cursor.setDate(cursor.getDate() - 1);
  while (dates.length < 7) {
    if (cursor.getDay() !== 0) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }

  const planId = 'demo_plan_beckett';
  await db.collection('development_plans').doc(planId).set({
    id: planId,
    playerId: 'demo_p_beckett',
    teamId: DEMO_TEAM_ID,
    title: 'Ball mastery + passing wall',
    description: 'Three short drills per session focused on first touch, control under pressure, and clean passing.',
    status: 'active',
    createdAt: daysAgo(14),
    updatedAt: minutesAgo(60),
    goals: [
      {
        id: 'demo_g_warmup',
        order: 1,
        title: 'Cone warm-up circuit',
        focus: 'Doing it the right way matters more than speed.',
        targetMinutes: 8,
        coachVerified: true,
        practiceLog: dates.map((d, i) => ({
          id: `demo_pl_warmup_${i}`,
          date: d,
          note: 'Did it today',
          minutes: 8,
          loggedBy: coachUid,
          loggedByName: 'Coach Jordan',
        })),
      },
      {
        id: 'demo_g_dribble',
        order: 2,
        title: 'Dribbling circuits',
        focus: 'Touch every other step. Head up between cones.',
        targetMinutes: 12,
        coachVerified: false,
        playerCompleted: false,
        readyForReview: true,
        practiceLog: dates.slice(0, 5).map((d, i) => ({
          id: `demo_pl_dribble_${i}`,
          date: d,
          note: 'Did it today',
          minutes: 12,
          loggedBy: 'demo_p_amy',
          loggedByName: 'Amy Hayes',
        })),
      },
      {
        id: 'demo_g_passwall',
        order: 3,
        title: 'Passing wall — 100 reps',
        focus: 'Both feet. Inside-of-foot, follow through.',
        targetMinutes: 10,
        coachVerified: false,
        practiceLog: dates.slice(0, 2).map((d, i) => ({
          id: `demo_pl_pass_${i}`,
          date: d,
          note: 'Did it today',
          minutes: 10,
          loggedBy: 'demo_p_amy',
          loggedByName: 'Amy Hayes',
        })),
      },
    ],
  }, { merge: true });
}

async function seedMedia() {
  // A few placeholder clip docs so the Media tab + Featured Highlight
  // tile aren't empty. Thumbs use Unsplash sports collection — fine
  // for non-commercial demo / screenshot use.
  const clips = [
    { id: 'demo_clip_1', playerId: 'demo_p_beckett', playerName: 'Beckett Hayes', caption: 'First goal vs Eagles', duration: 18, opponent: 'Eagles SC' },
    { id: 'demo_clip_2', playerId: 'demo_p_atticus', playerName: 'Atticus Wong', caption: 'Captain\'s breakaway assist', duration: 22, opponent: 'Eagles SC' },
    { id: 'demo_clip_3', playerId: 'demo_p_felix', playerName: 'Felix Mendez', caption: 'Cool finish — far post', duration: 12, opponent: 'Storm United' },
  ];
  for (const c of clips) {
    await db.collection('player_media').doc(c.id).set({
      ...c,
      teamId: DEMO_TEAM_ID,
      type: 'video',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
      // Soccer ball on grass — replaces the previous Unsplash ID
      // that turned out to be a basketball photo. Patrick on the
      // demo screenshots: 'thumbnail is a basketball, can you switch
      // it for a soccer thumbnail?'
      thumbnailUrl: `https://images.unsplash.com/photo-1551958219-acbc608c6377?w=640&q=60`,
      createdAt: daysAgo(3),
      reactions: { '🔥': 5, '⚽': 3 },
      viewCount: 24,
    }, { merge: true });
  }
}

(async () => {
  console.log('Seeding demo team', DEMO_TEAM_ID);
  const coachUid = await ensureDemoCoach();
  console.log(' coach uid:', coachUid);
  await seedTeamAndUser(coachUid);
  console.log(' team + users');
  await seedPlayers(coachUid);
  console.log(' 12 players (Beckett linked to coach for hero card)');
  await seedCalendarEvents();
  console.log(' calendar events');
  await seedWallPosts(coachUid);
  console.log(' 6 wall posts + comments + poll');
  await seedChat(coachUid);
  console.log(' chat threads (team, coaches, DM) + messages');
  await seedMatchVoting(coachUid);
  console.log(' POTM voting (Beckett wins — hero goes gold this week)');
  await seedDevelopmentPlan(coachUid);
  console.log(' development plan with 7-day streak on Beckett');
  await seedMedia();
  console.log(' demo media clips');
  console.log('\nDone.\n');
  console.log('Sign in on the Simulator with:');
  console.log('  Email:    ' + DEMO_EMAIL);
  console.log('  Password: ' + DEMO_PASSWORD);
  console.log('Then switch to "' + DEMO_TEAM_NAME + '" in the team selector.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
