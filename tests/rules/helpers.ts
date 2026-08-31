// Shared fixtures + assertion helpers for the Firestore rules suite.
//
// The rules test env is created ONCE per test file (via jest globalSetup)
// and each test builds only the docs it needs against a fresh withSecurityRulesDisabled
// admin context, then asserts the same operation with an AUTHENTICATED
// or UNAUTHENTICATED user context.

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  RulesTestContext,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ID = 'gk-rules-test';

let env: RulesTestEnvironment | null = null;

export async function getEnv(): Promise<RulesTestEnvironment> {
  if (env) return env;
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '..', '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  return env;
}

export async function teardown(): Promise<void> {
  if (env) {
    await env.cleanup();
    env = null;
  }
}

export async function clear(): Promise<void> {
  const e = await getEnv();
  await e.clearFirestore();
}

/** Seed docs bypassing the rule layer (for setting up fixtures). */
export async function seed(fn: (db: FirebaseFirestore.Firestore) => Promise<void>): Promise<void> {
  const e = await getEnv();
  await e.withSecurityRulesDisabled(async (ctx) => {
    // The admin firestore returned here doesn't implement every server
    // API but is enough for setDoc.
    // @ts-ignore
    await fn(ctx.firestore() as any);
  });
}

/** Get a Firestore instance authed as a specific uid. */
export async function asUser(uid: string, claims: Record<string, unknown> = {}) {
  const e = await getEnv();
  return e.authenticatedContext(uid, claims).firestore();
}

/** Get a Firestore instance not signed in at all. */
export async function asAnon() {
  const e = await getEnv();
  return e.unauthenticatedContext().firestore();
}

export { assertFails, assertSucceeds };

// ────────────────────────────────────────────────────────────────
// Fixture builders — cover the shapes rules commonly read.

export interface TeamFixture {
  id: string;
  clubId?: string;
  coachIds?: string[];
  managerIds?: string[];
  assistantCoachIds?: string[];
  headCoachId?: string;
  isActive?: boolean;
  staffPermissions?: Record<string, Record<string, boolean>>;
}

export function team(t: TeamFixture) {
  return {
    id: t.id,
    data: {
      name: t.id,
      clubId: t.clubId || '',
      coachIds: t.coachIds || [],
      managerIds: t.managerIds || [],
      assistantCoachIds: t.assistantCoachIds || [],
      headCoachId: t.headCoachId || (t.coachIds || [])[0] || '',
      isActive: t.isActive !== false,
      staffPermissions: t.staffPermissions || {},
      createdAt: new Date(),
    },
  };
}

export interface UserFixture {
  uid: string;
  role?: 'coach' | 'parent' | 'team_manager';
  teamIds?: string[];
  clubIds?: string[];
  subscriptionActive?: boolean;
  coverageSource?: 'club';
  isClubAdmin?: boolean;
}

export function user(u: UserFixture) {
  const data: Record<string, unknown> = {
    role: u.role || 'parent',
    teamIds: u.teamIds || [],
    clubIds: u.clubIds || [],
    subscriptionActive: u.subscriptionActive === true,
    isClubAdmin: u.isClubAdmin === true,
    isActive: true,
  };
  // Firestore rejects undefined field values — only set when present.
  if (u.coverageSource) data.coverageSource = u.coverageSource;
  return { id: u.uid, data };
}
