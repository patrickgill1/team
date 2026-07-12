// Timestamp helpers — Firestore client reads can hand us any of five
// possible shapes for a "createdAt" / "earnedAt" field:
//   - a Firestore Timestamp (Timestamp instance, has .toMillis())
//   - a hydrated JS Date
//   - a plain {seconds, nanoseconds} object (when a serialization
//     boundary flattened the Timestamp — see reference_timestamp_clean.md)
//   - a raw ms number
//   - an ISO date string
//
// Every profile section that renders dated events (recognitions
// archive, season timeline, photo tape, personal records) needs the
// same coercion, so it lives here once instead of drifting across
// four component files. Return 0 for unknown shapes so downstream
// sorts + relative-time stay stable.

export function toMillis(raw: unknown): number {
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  const asAny = raw as any;
  if (typeof asAny?.toMillis === 'function') {
    try { return asAny.toMillis(); } catch { /* fall through */ }
  }
  if (typeof asAny?.toDate === 'function') {
    try { return asAny.toDate().getTime(); } catch { /* fall through */ }
  }
  if (typeof asAny?.seconds === 'number') return asAny.seconds * 1000;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  return 0;
}

// Relative-time formatter — matches the copy used across the XP feed,
// whispers list, and coach recognitions archive so the whole app
// speaks the same way about "when did this happen".
export function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 45 * 1000) return 'just now';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(day / 365);
  return `${yr}y ago`;
}

// Short absolute-date formatter used in Personal Records context
// lines and Season Timeline chip metadata: "Sep 12" style, no year
// unless the event is from a previous calendar year.
export function shortDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}
