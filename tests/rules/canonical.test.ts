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

describe('invites (team self-serve adult)', () => {
  test('signed-in coach CREATE team_self_serve_adult → allowed', async () => {
    await seedWorld();
    const db = await asUser(HEAD);
    await assertSucceeds(setDoc(doc(db, 'invites', 'ssv-1'), {
      type: 'team_self_serve_adult',
      teamId: TEAM_A,
      createdBy: HEAD,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      maxUses: null,
      usedCount: 0,
      usedBy: [],
    }));
  });

  test('anonymous GET team_self_serve_adult → allowed (join page pre-signin)', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'invites', 'ssv-2'), {
        type: 'team_self_serve_adult',
        teamId: TEAM_A,
        createdBy: HEAD,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        maxUses: null,
        usedCount: 0,
        usedBy: [],
      });
    });
    const db = await asAnon();
    await assertSucceeds(getDoc(doc(db, 'invites', 'ssv-2')));
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

// ────────────────────────────────────────────────────────────────
// chat_messages — high-blast-radius: any client can impersonate
// another user by writing senderId=other-uid unless the rule
// enforces senderId==auth.uid. The reactions/readBy/poll field-
// scoped updates are the escape hatches for participants who
// didn't send the message — they must NOT open a hole to
// arbitrary content edits.
describe('chat_messages', () => {
  test('CREATE with senderId=self → allowed', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertSucceeds(setDoc(doc(db, 'chat_messages', 'cm1'), {
      threadId: 'thread-1', teamId: TEAM_A,
      senderId: PARENT, content: 'hi', timestamp: new Date(),
    }));
  });

  test('CREATE with senderId=other-uid → denied (impersonation guard)', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertFails(setDoc(doc(db, 'chat_messages', 'cm2'), {
      threadId: 'thread-1', teamId: TEAM_A,
      senderId: HEAD, content: 'impersonating head coach', timestamp: new Date(),
    }));
  });

  test('UPDATE reactions-only by non-sender → allowed (field-scoped escape)', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'chat_messages', 'cm3'), {
        threadId: 'thread-1', teamId: TEAM_A,
        senderId: HEAD, content: 'orig', timestamp: new Date(),
      });
    });
    const db = await asUser(PARENT);
    await assertSucceeds(updateDoc(doc(db, 'chat_messages', 'cm3'), {
      reactions: { '👍': [PARENT] },
    }));
  });

  test('UPDATE content by non-sender → denied', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'chat_messages', 'cm4'), {
        threadId: 'thread-1', teamId: TEAM_A,
        senderId: HEAD, content: 'orig', timestamp: new Date(),
      });
    });
    const db = await asUser(PARENT);
    await assertFails(updateDoc(doc(db, 'chat_messages', 'cm4'), {
      content: 'hijacked',
    }));
  });

  test('DELETE by team coach → allowed (moderation)', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'chat_messages', 'cm5'), {
        threadId: 'thread-1', teamId: TEAM_A,
        senderId: PARENT, content: 'noise', timestamp: new Date(),
      });
    });
    const { deleteDoc } = await import('firebase/firestore');
    const db = await asUser(HEAD);
    await assertSucceeds(deleteDoc(doc(db, 'chat_messages', 'cm5')));
  });

  test('DELETE by another parent (non-coach, non-sender) → denied', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'chat_messages', 'cm6'), {
        threadId: 'thread-1', teamId: TEAM_A,
        senderId: HEAD, content: 'coach msg', timestamp: new Date(),
      });
    });
    const { deleteDoc } = await import('firebase/firestore');
    const db = await asUser(PARENT);
    await assertFails(deleteDoc(doc(db, 'chat_messages', 'cm6')));
  });
});

// ────────────────────────────────────────────────────────────────
// wall_posts — coach composer path vs auto-post path vs parent
// composer (wallConfig-gated). Parent-post default is DENY so a
// team that never opts in cannot suddenly get parent-authored
// wall content.
describe('wall_posts CREATE', () => {
  test('coach composer post → allowed', async () => {
    await seedWorld();
    const db = await asUser(HEAD);
    await assertSucceeds(setDoc(doc(db, 'wall_posts', 'wp1'), {
      teamId: TEAM_A, senderId: HEAD, authorRole: 'coach',
      status: 'live', postedFrom: 'wall', content: 'Great win team',
      timestamp: new Date(),
    }));
  });

  test('parent auto-post from video upload → allowed (whitelist)', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertSucceeds(setDoc(doc(db, 'wall_posts', 'wp2'), {
      teamId: TEAM_A, senderId: PARENT,
      status: 'live', postedFrom: 'video', content: 'Uploaded a clip',
      timestamp: new Date(),
    }));
  });

  test('parent composer post without wallConfig.allowParentPosts → denied', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertFails(setDoc(doc(db, 'wall_posts', 'wp3'), {
      teamId: TEAM_A, senderId: PARENT, authorRole: 'parent',
      authorUid: PARENT, status: 'live', postedFrom: 'wall',
      content: 'Should not post', timestamp: new Date(),
    }));
  });
});

// ────────────────────────────────────────────────────────────────
// players — membership fields (parentIds, teamIds, coachIds,
// clubId, isActive) are worker-only. Coach can update
// non-membership fields on their team's players. Regression here
// = a client can escalate themselves onto a player as a "parent"
// bypassing the invite dedup + audit trail.
describe('players UPDATE', () => {
  test('coach on team updates non-membership field → allowed', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'players', 'p1'), {
        name: 'Test Kid', teamId: TEAM_A, teamIds: [TEAM_A],
        parentIds: [PARENT], isActive: true, createdAt: new Date(),
      });
    });
    const db = await asUser(HEAD);
    await assertSucceeds(updateDoc(doc(db, 'players', 'p1'), {
      jerseyNumber: 7, position: 'Midfielder',
    }));
  });

  test('coach on team attempts to write parentIds → denied (worker-only)', async () => {
    await seedWorld();
    await seed(async (db) => {
      await setDoc(doc(db as any, 'players', 'p2'), {
        name: 'Test Kid', teamId: TEAM_A, teamIds: [TEAM_A],
        parentIds: [PARENT], isActive: true, createdAt: new Date(),
      });
    });
    const { arrayUnion } = await import('firebase/firestore');
    const db = await asUser(HEAD);
    await assertFails(updateDoc(doc(db, 'players', 'p2'), {
      parentIds: arrayUnion(OUTSIDER),
    }));
  });
});

// ────────────────────────────────────────────────────────────────
// users — self-update allowed for editable fields; role and
// teamIds mutations client-side would let anyone self-elevate to
// a coach on any team. Both stay worker-only.
describe('users UPDATE self', () => {
  test('self updates name → allowed', async () => {
    await seedWorld();
    const db = await asUser(PARENT);
    await assertSucceeds(updateDoc(doc(db, 'users', PARENT), {
      name: 'New Display Name',
    }));
  });

  test('self attempts to add TEAM_B to teamIds → denied (self-elevation)', async () => {
    await seedWorld();
    const { arrayUnion } = await import('firebase/firestore');
    const db = await asUser(PARENT);
    await assertFails(updateDoc(doc(db, 'users', PARENT), {
      teamIds: arrayUnion(TEAM_B),
    }));
  });
});
