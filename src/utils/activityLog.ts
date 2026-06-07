// Thin helper around the `activities` Firestore collection — the
// foundation of the club CRM timeline. Call from anywhere a meaningful
// system event happens (registration paid, offer sent, etc.). Always
// fire-and-forget; never block a user action waiting on log persistence.
//
// Schema is in src/types/index.ts → Activity. The clubId is mandatory
// so the admin portal can scope queries; everything else is optional
// because each kind of activity references different things.

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import type { Activity } from '../types';

type LogInput = Omit<Activity, 'id' | 'createdAt'> & { createdAt?: Date };

/** Fire-and-forget. Returns a Promise so callers can `await` if they
 *  need to (e.g., in a server-style flow), but the recommended pattern
 *  is `void logActivity({...})`. */
export async function logActivity(input: LogInput): Promise<void> {
  try {
    await addDoc(collection(db, 'activities'), {
      ...input,
      createdAt: input.createdAt || serverTimestamp(),
    });
  } catch (err) {
    // Logging failures are non-fatal by definition. Surface to the
    // console for debugging; never throw out of this function.
    console.warn('[activityLog] write failed', input.kind, err);
  }
}
