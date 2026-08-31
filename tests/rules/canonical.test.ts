// Canonical rules tests — one caller × one action × one collection each.
// Starter set covering the classes of bugs that hit this codebase
// repeatedly (gate splits, staff-permission widenings, public share).
//
// Add a test when you ship a new rule OR a new gate. The goal is
// "if this rule regresses, at least one test fails."

import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import {
  assertFails,
  assertSucceeds,
  asAnon,
  asUser,
  clear,
  seed,
  team,
  teardown,
  user,
} from './helpers';

// Reusable actors.
const HEAD = 'head-coach-uid';
const ASSISTANT = 'assistant-uid';
const MANAGER = 'manager-uid';
const PARENT = 'parent-uid';
const OUTSIDER = 'outsider-uid';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const CLUB_A = 'club-a';
const CLUB_B = 'club-b';

beforeEach(async () => { await clear(); });
afterAll(async () => { await teardown(); });

// Seed a canonical two-team, two-club world used by most tests.
async function seedWorld() {
  await seed(async (db) => {
    const t1 = team({
      id: TEAM_A,
      clubId: CLUB_A,
      coachIds: [HEAD, ASSISTANT],
      assistantCoachIds: [ASSISTANT],
      managerIds: [MANAGER],
      headCoachId: HEAD,
    });
    const t2 = team({
      id: TEAM_B,
      clubId: CLUB_B,
      coachIds: ['other-coach'],
      headCoachId: 'other-coach',
    });
    await setDoc(doc(db as any, 'teams', t1.id), t1.data);
    await setDoc(doc(db as any, 'teams', t2.id), t2.data);
    await setDoc(doc(db as any, 'users', HEAD), user({
      uid: HEAD, role: 'coach', teamIds: [TEAM_A], clubIds: [CLUB_A], subscriptionActive: true,
    }).data);
    await setDoc(doc(db as any, 'users', ASSISTANT), user({
      uid: ASSISTANT, role: 'coach', teamIds: [TEAM_A], clubIds: [CLUB_A], subscriptionActive: true,
    }).data);
    await setDoc(doc(db as any, 'users', MANAGER), user({
      uid: MANAGER, role: 'team_manager', teamIds: [TEAM_A], clubIds: [CLUB_A],
    }).data);
    await setDoc(doc(db as any, 'users', PARENT), user({
      uid: PARENT, role: 'parent', teamIds: [TEAM_A],
    }).data);
    await setDoc(doc(db as any, 'users', OUTSIDER), user({
      uid: OUTSIDER, role: 'parent', teamIds: [],
    }).data);
  });
}

describe('events CREATE', () => {
  test('coach on team → allowed', async () => {
    await seedWorld();
    const db = await asUser(HEAD);
    await assertSucceeds(setDoc(doc(db, 'events', 'evt1'), {
      teamId: TEAM_A, title: 'Practice', date: new Date(), type: 'practice',
    }));
  });

  test('assistant coach on team → allowed', async () => {
    await seedWorld();
    const db = await asUser(ASSISTANT);
    await assertSucceeds(setDoc(doc(db, 'events', 'evt2'), {
      teamId: TEAM_A, title: 'Practice', date: new Date(), type: 'practice',
    }));
  });

  test('parent on team → denied (should be coach-only)', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertFails(setDoc(doc(db, 'events', 'evt3'), {
      teamId: TEAM_A, title: 'Practice', date: new Date(), type: 'practice',
    }));
  });

  test('coach on a different team → denied', async () => {
    await seedWorld();
    const db = await asUser(HEAD);
    await assertFails(setDoc(doc(db, 'events', 'evt4'), {
      teamId: TEAM_B, title: 'Practice', date: new Date(), type: 'practice',
    }));
  });
});

describe('development_plans CREATE', () => {
  test('assistant coach on team → allowed', async () => {
    await seedWorld();
    const db = await asUser(ASSISTANT);
    await assertSucceeds(setDoc(doc(db, 'development_plans', 'plan1'), {
      teamId: TEAM_A, playerId: 'p1', title: 'Wall passes',
    }));
  });

  test('team manager on team → allowed (2026-08-26 widen)', async () => {
    await seedWorld();
    const db = await asUser(MANAGER);
    await assertSucceeds(setDoc(doc(db, 'development_plans', 'plan2'), {
      teamId: TEAM_A, playerId: 'p1', title: 'Weak-foot drills',
    }));
  });

  test('parent on team → denied', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertFails(setDoc(doc(db, 'development_plans', 'plan3'), {
      teamId: TEAM_A, playerId: 'p1', title: 'nope',
    }));
  });
});

describe('player_media (media share)', () => {
  test('anonymous GET single doc → allowed (public share)', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'player_media', 'm1'), {
        teamId: TEAM_A, playerId: 'p1', url: 'https://example/x.jpg',
      });
    });
    const db = await asAnon();
    await assertSucceeds(getDoc(doc(db, 'player_media', 'm1')));
  });

  test('trial-lapsed coach CREATE YouTube-source → allowed (embed path free)', async () => {
    await seedWorld();
    // Give this coach no active sub and no club coverage.
    await seed(async (db) => {
      await setDoc(doc(db as any, 'users', HEAD), user({
        uid: HEAD, role: 'coach', teamIds: [TEAM_A], subscriptionActive: false,
      }).data);
    });
    const db = await asUser(HEAD);
    await assertSucceeds(setDoc(doc(db, 'player_media', 'm2'), {
      teamId: TEAM_A, playerId: 'p1', source: 'youtube', url: 'https://youtube/x', type: 'video',
    }));
  });
});
