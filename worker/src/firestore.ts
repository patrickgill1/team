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
}

export async function listDocuments(projectId: string, collection: string, sa: ServiceAccount, pageSize = 300): Promise<FirestoreDoc[]> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const url = `${baseUrl(projectId)}/${encodeURIComponent(collection)}?pageSize=${pageSize}`;
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
  };
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

export async function createDocument(projectId: string, collection: string, fields: Record<string, any>, sa: ServiceAccount, docId?: string): Promise<string> {
  const token = await getAccessToken(sa, FIRESTORE_SCOPE);
  const idParam = docId ? `?documentId=${encodeURIComponent(docId)}` : '';
  const url = `${baseUrl(projectId)}/${encodeURIComponent(collection)}${idParam}`;
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encodeValue(v)])) };
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firestore create ${collection} ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
