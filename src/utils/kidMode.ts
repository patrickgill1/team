// Kid profile mode — no Firebase Auth user is created. The parent's
// uid stays the actor at the auth layer. This module owns:
//   - PIN hashing/verify (SHA-256 client-side; the "safety" is sibling-
//     privacy, not adversarial — bypass just reveals the kid's own view
//     which parent uid already reads at the rules layer)
//   - Per-device dedicated-kid flag (localStorage). Set on a kid's own
//     device by parent tap; cold boot lands in that kid's view.

const DEDICATED_KEY = 'gk.kidMode.dedicatedPlayerId';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function hashPin(playerId: string, pin: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${playerId}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buf));
}

export async function verifyPin(playerId: string, pin: string, storedHash?: string): Promise<boolean> {
  if (!storedHash) return false;
  const candidate = await hashPin(playerId, pin);
  return candidate === storedHash;
}

/** Kid-mode PIN policy. 4 digits, digits-only. Simple by design —
 *  every-day toggling. Not a password. */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

// Per-device dedicated-kid persistence. Set on a kid's own phone from
// the parent's tile "Make this [FirstName]'s device". Cold boot reads
// this and enters kid mode automatically.
export function getDedicatedKidPlayerId(): string | null {
  try {
    return localStorage.getItem(DEDICATED_KEY);
  } catch {
    return null;
  }
}

export function setDedicatedKidPlayerId(playerId: string): void {
  try {
    localStorage.setItem(DEDICATED_KEY, playerId);
  } catch { /* ignore */ }
}

export function clearDedicatedKidPlayerId(): void {
  try {
    localStorage.removeItem(DEDICATED_KEY);
  } catch { /* ignore */ }
}
