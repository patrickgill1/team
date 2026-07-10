import { getAccessToken, ServiceAccount } from './fcm';

// Firebase Auth custom claims via the Identity Toolkit REST API.
// Used to stamp `clubIds` and `teamIds` on the auth token so
// Firestore LIST rules can statically verify a coach's scope
// without falling back to `if isAuthed()` on userDoc() lookups.
//
// Docs: https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/update
//
// Custom claims payload is capped at 1000 bytes JSON-encoded and the
// customAttributes field must be a STRING (a JSON-stringified object,
// not a nested JSON value) or the API returns INVALID_ARGUMENT.
// Passing empty string "" clears claims — use that for /users/deactivate.

const CLAIMS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_CLAIMS_BYTES = 1000;
const MAX_ARRAY_LEN = 40;

export interface CustomClaims {
  clubIds?: string[];
  teamIds?: string[];
  admin?: boolean;
}

/** Write custom claims to a Firebase Auth user. Idempotent — safe to
 *  call after every membership mutation. Non-fatal on failure (the
 *  caller should log and move on rather than roll back the mutation). */
export async function setCustomClaims(
  sa: ServiceAccount,
  uid: string,
  claims: CustomClaims,
): Promise<{ ok: boolean; error?: string }> {
  if (!uid) return { ok: false, error: 'uid_required' };

  const trimmed: CustomClaims = {};
  if (Array.isArray(claims.clubIds)) {
    trimmed.clubIds = claims.clubIds
      .filter(id => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_ARRAY_LEN);
  }
  if (Array.isArray(claims.teamIds)) {
    trimmed.teamIds = claims.teamIds
      .filter(id => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_ARRAY_LEN);
  }
  if (claims.admin === true) trimmed.admin = true;

  let attrString = JSON.stringify(trimmed);
  if (attrString.length > MAX_CLAIMS_BYTES) {
    // Trim the biggest array progressively until under the cap.
    let capped = { ...trimmed };
    while (attrString.length > MAX_CLAIMS_BYTES) {
      const teamsLen = (capped.teamIds || []).length;
      const clubsLen = (capped.clubIds || []).length;
      if (teamsLen >= clubsLen && teamsLen > 0) {
        capped.teamIds = capped.teamIds!.slice(0, Math.max(0, teamsLen - 1));
      } else if (clubsLen > 0) {
        capped.clubIds = capped.clubIds!.slice(0, Math.max(0, clubsLen - 1));
      } else {
        break;
      }
      attrString = JSON.stringify(capped);
    }
    console.warn('[claims] trimmed claims to fit 1000-byte cap', { uid, finalBytes: attrString.length });
  }

  const accessToken = await getAccessToken(sa, CLAIMS_SCOPE);
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ localId: uid, customAttributes: attrString }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[claims] setCustomClaims failed', uid, res.status, body.slice(0, 300));
    return { ok: false, error: `it_${res.status}` };
  }
  return { ok: true };
}

/** Clear all custom claims for a user — used by /users/deactivate. */
export async function clearCustomClaims(
  sa: ServiceAccount,
  uid: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!uid) return { ok: false, error: 'uid_required' };
  const accessToken = await getAccessToken(sa, CLAIMS_SCOPE);
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ localId: uid, customAttributes: '' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn('[claims] clearCustomClaims failed', uid, res.status, body.slice(0, 300));
    return { ok: false, error: `it_${res.status}` };
  }
  return { ok: true };
}
