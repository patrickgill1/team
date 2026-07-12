// Debug logging helper — no-ops in production so the console stays
// clean for real users. Red errors read as "the app is broken" to
// non-developers, and dozens of white "debug" lines make the actual
// signal impossible to spot when we DO need to help someone.
//
// Use `debug(...)` in place of `console.log(...)` for verbose flow
// tracing. `debugWarn` / `debugError` mirror the pattern. Keep raw
// console.error for actual crashes we WANT to surface.

const isDev = process.env.NODE_ENV !== 'production';

/** Verbose flow log. Silenced in prod. */
export const debug: (...args: unknown[]) => void = isDev
  ? console.log.bind(console)
  : () => { /* no-op in prod */ };

/** Expected non-fatal warning (auth transitions, transient network).
 *  Silenced in prod so we don't scare users with yellow triangles. */
export const debugWarn: (...args: unknown[]) => void = isDev
  ? console.warn.bind(console)
  : () => { /* no-op in prod */ };
