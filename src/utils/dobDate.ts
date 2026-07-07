// Shared helpers for date-only fields (birthdays, in particular).
//
// The classic JS bug: `new Date("2015-08-16")` is parsed as UTC
// midnight, then formatted with local getters in a negative-offset
// timezone drops to the previous calendar day. Denver users see
// their kid's birthday shifted back by one.
//
// Convention adopted here:
//   • STORE as UTC NOON of the intended calendar day (12:00 UTC).
//     Noon is >= 12 hours from any day boundary, so display with
//     local getters shows the correct day for any viewer.
//   • FORMAT DISPLAY with { timeZone: 'UTC' } — belt-and-suspenders
//     that also renders LEGACY UTC-midnight data on the correct day.
//   • PARSE an <input type="date"> "YYYY-MM-DD" via parseDobInput.
//   • RENDER a Date back into the input's YYYY-MM-DD via
//     formatDobInput (uses UTC getters, consistent with the store
//     convention).

/** Parse a YYYY-MM-DD string as UTC noon of that calendar day. */
export function parseDobInput(s: string): Date {
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return new Date(NaN);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Render a Date into YYYY-MM-DD using UTC getters — the inverse of
 *  parseDobInput, safe against tz-shift when round-tripping into an
 *  <input type="date">. */
export function formatDobInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Coerce whatever the persistence layer handed back (Firestore
 *  Timestamp, JS Date, string) to a JS Date. Never throws. */
export function coerceDob(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v?.toDate === 'function') {
    const d = v.toDate();
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Display a DOB in a "Aug 16, 2015" style, always in UTC so both
 *  new (UTC-noon) and legacy (UTC-midnight) rows render the correct
 *  day. */
export function formatDobShort(v: any): string {
  const d = coerceDob(v);
  if (!d) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Age from a DOB, comparing calendar days in UTC. Same reason as
 *  formatDobShort: use UTC so legacy and new rows both compute
 *  correctly regardless of the viewer's timezone. */
export function computeDobAge(v: any): number | null {
  const d = coerceDob(v);
  if (!d) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
