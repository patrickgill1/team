/**
 * Minimal Firestore REST client for Cloudflare Workers.
 * Auth uses the same FCM_SERVICE_ACCOUNT JSON as fcm.ts, just with the datastore scope.
 */

import { getAccessToken, ServiceAccount } from './fcm';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

function baseUrl(projectId: string) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// Decode a Firestore REST "Value" object back to a JS value.
export function decodeValue(v: any): any {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  return null;
}

export function decodeFields(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k in fields) out[k] = decodeValue(fields[k]);
  return out;
}

function encodeValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields: Record<string, any> = {};
    for (const k in v) fields[k] = encodeValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

export interface FirestoreDoc {
  id: string;
  data: Record<string, any>;
  // ISO string returned by Firestore. Optional so existing readers stay
  // untouched; applyMembership() uses it as the precondition argument
  // for TOCTOU-safe status flips on single-use invites.
  updateTime?: string;
}

// Distinct error thrown when createDocument tries to write a doc at
// a deterministic path that already exists. Used by the retro-XP
// backfill loop as its idempotency signal: a re-run of the confirm
// modal hits the same deterministic doc id, Firestore rejects with
// ALREADY_EXISTS, the loop treats it as "already granted on a prior
// run" and skips the paired transform + badge patch.
export class AlreadyExistsError extends Error {
  constructor(public path: string) {
    super(`document already exists: ${path}`);
    this.name = 'AlreadyExistsError';
  }
}

// Distinct error so shims can catch precondition losses (concurrent
// write raced us) and translate to a clean 409, without swallowing
// real 5xx errors.
export class PreconditionFailedError extends Error {
  constructor(public path: string, public expectedUpdateTime: string) {
    super(`precondition failed on ${path}`);
    this.name = 'PreconditionFailedError';
  }
}

export async function listDocuments(projectId: string, collection: string, sa: ServiceAccount, pageSize = 300): Promise<FirestoreDoc[]> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  // Same segment-wise encoding as createDocument — subcollection
  // paths must keep literal '/' between segments.
  const encodedCollection = collection.split('/').map(encodeURIComponent).join('/');
  const url = `${baseUrl(projectId)}/${encodedCollection}?pageSize=${pageSize}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`firestore list ${collection} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return (j.documents || []).map((d: any) => ({
    id: String(d.name).split('/').pop() || '',
    data: decodeFields(d.fields || {}),
  }));
}

export interface QueryFilter {
  field: string;
  op: 'EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'ARRAY_CONTAINS';
  value: any;
}

// Run a structured query rooted at the database root.
export async function getDocument(projectId: string, path: string, sa: ServiceAccount): Promise<FirestoreDoc | null> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `${baseUrl(projectId)}/${path}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore get ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return {
    id: String(j.name).split('/').pop() || '',
    data: decodeFields(j.fields || {}),
    updateTime: typeof j.updateTime === 'string' ? j.updateTime : undefined,
  };
}

// Atomic subfield write on a map field. Uses a dotted field-mask path
// so concurrent writers touching sibling keys on the same map don't
// clobber each other (unlike a read-merge-write PATCH). Pass value=null
// to atomically clear the entry (Firestore stores nullValue; readers
// that check truthiness of the entry treat it as absent).
export async function patchMapEntry(
  projectId: string,
  path: string,
  mapField: string,
  entryKey: string,
  value: any,
  sa: ServiceAccount,
): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const dotted = `${mapField}.${entryKey}`;
  const mask = `updateMask.fieldPaths=${encodeURIComponent(dotted)}`;
  const url = `${baseUrl(projectId)}/${path}?${mask}`;
  const body = {
    fields: {
      [mapField]: { mapValue: { fields: { [entryKey]: encodeValue(value) } } },
    },
  };
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firestore patchMapEntry ${path} ${dotted} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function patchDocument(projectId: string, path: string, fields: Record<string, any>, sa: ServiceAccount): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const keys = Object.keys(fields);
  const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `${baseUrl(projectId)}/${path}?${mask}`;
  const body = { fields: Object.fromEntries(keys.map(k => [k, encodeValue(fields[k])])) };
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firestore patch ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Atomic increment on one or more numeric fields. Uses the Firestore
// `commit` endpoint with `fieldTransforms` so concurrent webhooks
// don't race a read-merge-write cycle (matters when multiple Stripe
// payments complete in the same second on a busy club).
//
// `deltas` accepts negative numbers — pass -42 to decrement.
export async function incrementFields(projectId: string, path: string, deltas: Record<string, number>, sa: ServiceAccount): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const docName = `projects/${projectId}/databases/(default)/documents/${path}`;
  const body = {
    writes: [{
      transform: {
        document: docName,
        fieldTransforms: Object.entries(deltas).map(([field, delta]) => ({
          fieldPath: field,
          increment: { integerValue: String(Math.trunc(delta)) },
        })),
      },
    }],
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firestore increment ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Atomic array-union / array-remove via Firestore field transforms.
// Safer than a read-modify-write for hot fields like user.teamIds or
// player.parentIds where two invite-claims could otherwise race.
// Accepts multiple transforms per doc so a single call can (e.g.)
// arrayUnion teamIds AND patch role/name.
export interface FieldTransform {
  fieldPath: string;
  kind: 'arrayUnion' | 'arrayRemove' | 'increment';
  value: any;
}
export async function commitDocumentTransforms(
  projectId: string,
  path: string,
  transforms: FieldTransform[],
  patchFields: Record<string, any> | null,
  sa: ServiceAccount,
  precondition?: { updateTime: string },
): Promise<void> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const docName = `projects/${projectId}/databases/(default)/documents/${path}`;
  const writes: any[] = [];
  if (patchFields && Object.keys(patchFields).length > 0) {
    const keys = Object.keys(patchFields);
    const update: any = {
      update: {
        name: docName,
        fields: Object.fromEntries(keys.map(k => [k, encodeValue(patchFields[k])])),
      },
      updateMask: { fieldPaths: keys },
    };
    if (precondition?.updateTime) {
      update.currentDocument = { updateTime: precondition.updateTime };
    }
    writes.push(update);
  }
  if (transforms.length > 0) {
    const xform: any = {
      transform: {
        document: docName,
        fieldTransforms: transforms.map(t => {
          if (t.kind === 'arrayUnion') {
            return {
              fieldPath: t.fieldPath,
              appendMissingElements: { values: (Array.isArray(t.value) ? t.value : [t.value]).map(encodeValue) },
            };
          }
          if (t.kind === 'arrayRemove') {
            return {
              fieldPath: t.fieldPath,
              removeAllFromArray: { values: (Array.isArray(t.value) ? t.value : [t.value]).map(encodeValue) },
            };
          }
          return {
            fieldPath: t.fieldPath,
            increment: { integerValue: String(Math.trunc(Number(t.value))) },
          };
        }),
      },
    };
    // A precondition attached to a transform-only commit needs its own
    // `currentDocument` on the transform write. Firestore requires it
    // exactly once when there's no companion update() write.
    if (precondition?.updateTime && writes.length === 0) {
      xform.currentDocument = { updateTime: precondition.updateTime };
    }
    writes.push(xform);
  }
  if (writes.length === 0) return;
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!r.ok) {
    const body = await r.text();
    // Firestore returns 400 with a FAILED_PRECONDITION status when
    // currentDocument.updateTime doesn't match. Translate to a
    // catchable class so callers can retry/return 409 without matching
    // string messages.
    if (precondition?.updateTime && /FAILED_PRECONDITION|failed_precondition/i.test(body)) {
      throw new PreconditionFailedError(path, precondition.updateTime);
    }
    throw new Error(`firestore commit ${path} ${r.status}: ${body.slice(0, 200)}`);
  }
}

export async function createDocument(projectId: string, collection: string, fields: Record<string, any>, sa: ServiceAccount, docId?: string): Promise<string> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const idParam = docId ? `?documentId=${encodeURIComponent(docId)}` : '';
  // Encode each SEGMENT of the collection path separately — the '/'
  // between segments must stay literal or Firestore rejects the URL
  // with "Collection id ... is invalid because it contains '/'".
  // Applies to any subcollection call (players/{id}/dev_checkins,
  // events/{id}/eventActivity, payment_requests/{id}/invoices).
  const encodedCollection = collection.split('/').map(encodeURIComponent).join('/');
  const url = `${baseUrl(projectId)}/${encodedCollection}${idParam}`;
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encodeValue(v)])) };
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    // Firestore returns 409 with a body that mentions "already exists"
    // when a deterministic documentId collides with an existing doc.
    // Surface as a typed error so the backfill loop can skip cleanly
    // without swallowing real 5xx failures.
    if (r.status === 409 || /already exists|ALREADY_EXISTS/i.test(text)) {
      throw new AlreadyExistsError(`${collection}/${docId || '(auto)'}`);
    }
    throw new Error(`firestore create ${collection} ${r.status}: ${text.slice(0, 200)}`);
  }
  const j: any = await r.json();
  return String(j.name).split('/').pop() || '';
}

export async function runQuery(projectId: string, collection: string, filters: QueryFilter[], sa: ServiceAccount, limit = 100): Promise<FirestoreDoc[]> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

  const where = filters.length === 0 ? undefined : filters.length === 1 ? {
    fieldFilter: { field: { fieldPath: filters[0].field }, op: filters[0].op, value: encodeValue(filters[0].value) }
  } : {
    compositeFilter: {
      op: 'AND',
      filters: filters.map(f => ({
        fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encodeValue(f.value) }
      })),
    },
  };

  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      ...(where ? { where } : {}),
      limit,
    },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firestore runQuery ${collection} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const arr: any[] = await r.json();
  return arr
    .filter((row: any) => row.document)
    .map((row: any) => ({
      id: String(row.document.name).split('/').pop() || '',
      data: decodeFields(row.document.fields || {}),
    }));
}
