// @ts-nocheck
import {
  addDoc, collection, doc, getDoc, getDocs, increment, query, serverTimestamp,
  updateDoc, where, limit, orderBy,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Drill } from '../types';

/**
 * Shared drill library helpers.
 *
 * Three operations matter:
 *   - toggleShareToLibrary  : flip a drill into / out of the public catalog
 *   - rateDrill             : 1-5 stars, recompute averageRating server-side
 *   - saveDrillFromLibrary  : snapshot copy into your own library
 *
 * Plus a `loadLibraryDrills` for the browse tab. The rules layer is the
 * gate; these helpers just keep the writes consistent (especially the
 * rating math, which the firestore.rules can't enforce numerically).
 */

const AUTO_HIDE_THRESHOLD = 2.0;
const AUTO_HIDE_MIN_VOTES = 5;

/** True iff the drill should be hidden from default browse because
 *  enough coaches have rated it below the threshold. The drill is
 *  still findable via direct link and still returned by collection
 *  queries — this is a client-side filter, not a Firestore one. */
export function isAutoHidden(d: Pick<Drill, 'averageRating' | 'ratingCount'>): boolean {
  const count = d.ratingCount || 0;
  const avg = d.averageRating ?? 5;  // unrated => surface optimistically
  return count >= AUTO_HIDE_MIN_VOTES && avg < AUTO_HIDE_THRESHOLD;
}

/** True iff the drill qualifies for the 'Featured' filter. */
export function isFeatured(d: Pick<Drill, 'averageRating' | 'ratingCount'>): boolean {
  const count = d.ratingCount || 0;
  const avg = d.averageRating ?? 0;
  return count >= 3 && avg >= 4.0;
}

/** Flip a drill in or out of the public catalog. Owner-only at the
 *  rules layer; this just sets the timestamps. Pass `allow=false` to
 *  unshare. */
export async function toggleShareToLibrary(drillId: string, allow: boolean): Promise<void> {
  const patch: Record<string, any> = {
    shareToLibrary: allow,
    sharedAt: allow ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  };
  // Seed social-signal fields ONLY when they haven't been set yet.
  // Firestore's orderBy('averageRating', 'desc') on loadLibraryDrills
  // silently drops docs where the field is missing, so an
  // otherwise-shared drill with no ratings never rendered in Browse
  // Library (Patrick 2026-07-22: "the drills i shared to the library
  // I made are not showing up"). Read-first prevents overwriting real
  // ratings on an unshare/reshare cycle.
  if (allow) {
    try {
      const snap = await getDoc(doc(db, 'drills', drillId));
      const data: any = snap.data() || {};
      if (typeof data.averageRating !== 'number') patch.averageRating = 0;
      if (typeof data.saveCount !== 'number') patch.saveCount = 0;
      if (typeof data.ratingCount !== 'number') patch.ratingCount = 0;
      if (typeof data.ratingSum !== 'number') patch.ratingSum = 0;
    } catch {
      // Best-effort seed on read failure — a fresh drill defaults are safe.
      patch.averageRating = 0;
      patch.saveCount = 0;
      patch.ratingCount = 0;
      patch.ratingSum = 0;
    }
  }
  await updateDoc(doc(db, 'drills', drillId), patch);
}

/** Cast (or change) a star rating. Recomputes ratingSum / ratingCount
 *  / averageRating so the table can sort by averageRating without
 *  reading every voter map. NOT a transaction — if two coaches rate
 *  the same drill at the exact same millisecond, one might lose its
 *  vote in the count. Acceptable for v1; bump to a transaction if
 *  this becomes a real problem. */
export async function rateDrill(drillId: string, voterUid: string, stars: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const ref = doc(db, 'drills', drillId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('drill not found');
  const data: any = snap.data();
  const prevRatings: Record<string, number> = data.ratedBy || {};
  const prevVote = prevRatings[voterUid];

  let sum = data.ratingSum || 0;
  let count = data.ratingCount || 0;

  if (prevVote) {
    // Re-vote: subtract the previous contribution.
    sum -= prevVote;
  } else {
    count += 1;
  }
  sum += stars;
  const avg = count > 0 ? sum / count : 0;

  await updateDoc(ref, {
    ratingCount: count,
    ratingSum: sum,
    averageRating: avg,
    [`ratedBy.${voterUid}`]: stars,
  });
}

/** Copy a library drill into the caller's own collection. The new
 *  doc is owned by the caller (createdBy = caller) with source
 *  'imported' and a snapshot of the body. The source drill's
 *  saveCount bumps. */
export async function saveDrillFromLibrary(opts: {
  sourceDrillId: string;
  sourceClubName?: string;
  newOwnerUid: string;
  newOwnerName: string;
  destination: { clubId?: string; teamId?: string };
}): Promise<string> {
  const sourceRef = doc(db, 'drills', opts.sourceDrillId);
  const sourceSnap = await getDoc(sourceRef);
  if (!sourceSnap.exists()) throw new Error('source drill not found');
  const src: any = sourceSnap.data();

  // Snapshot only the body fields. Skip social signals (saveCount,
  // ratings) so the imported copy starts with a clean slate, and skip
  // shareToLibrary (the saver chooses whether to re-share their copy).
  const newDrill: any = {
    title: src.title,
    topic: src.topic,
    category: src.category,
    description: src.description || null,
    setup: src.setup || null,
    instructions: src.instructions || null,
    focus: src.focus || null,
    durationMinutes: src.durationMinutes || null,
    ageBand: src.ageBand || 'all',
    videoLinks: src.videoLinks || null,
    streamUid: src.streamUid || null,
    streamReady: src.streamReady || null,
    source: 'imported',
    createdBy: opts.newOwnerUid,
    createdByName: opts.newOwnerName,
    createdAt: serverTimestamp(),
    isActive: true,
    importedFromDrillId: opts.sourceDrillId,
    importedFromClubName: opts.sourceClubName || null,
  };
  if (opts.destination.clubId) newDrill.clubId = opts.destination.clubId;
  if (opts.destination.teamId) newDrill.teamId = opts.destination.teamId;

  const newRef = await addDoc(collection(db, 'drills'), newDrill);
  // Best-effort source saveCount bump. Failure here just means the
  // source's "saved by N" counter is off-by-one; not worth blocking.
  try {
    await updateDoc(sourceRef, { saveCount: increment(1) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[drillLibrary] saveCount bump failed', e);
  }
  return newRef.id;
}

export interface LibraryFilter {
  topic?: string;
  ageBand?: string;
  featuredOnly?: boolean;
  /** Hide drills below the auto-hide threshold (default true). */
  hideAutoHidden?: boolean;
  /** Coach reading — used to filter out their own drills from the
   *  library (they already see those in 'My team' / 'My club'). */
  excludeCreatorUid?: string;
  max?: number;
}

/** Pull the public catalog. Server-side returns up to `max` drills
 *  flagged shareToLibrary; client filters apply on top. Sorted by
 *  averageRating desc so the best material lands first. */
export async function loadLibraryDrills(filter: LibraryFilter = {}): Promise<Drill[]> {
  const constraints: any[] = [
    where('shareToLibrary', '==', true),
    orderBy('averageRating', 'desc'),
    limit(filter.max || 200),
  ];
  const snap = await getDocs(query(collection(db, 'drills'), ...constraints));
  let rows: Drill[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  // Client filters (Firestore can't combine multiple where()s here
  // without a composite index per dimension; cheaper to filter the
  // ~200 row window in memory).
  if (filter.excludeCreatorUid) {
    rows = rows.filter((r) => r.createdBy !== filter.excludeCreatorUid);
  }
  if (filter.topic && filter.topic !== 'all') {
    rows = rows.filter((r) => r.topic === filter.topic);
  }
  if (filter.ageBand && filter.ageBand !== 'all') {
    rows = rows.filter((r) => r.ageBand === filter.ageBand || r.ageBand === 'all');
  }
  if (filter.featuredOnly) {
    rows = rows.filter((r) => isFeatured(r));
  }
  if (filter.hideAutoHidden !== false) {
    rows = rows.filter((r) => !isAutoHidden(r));
  }
  return rows;
}
