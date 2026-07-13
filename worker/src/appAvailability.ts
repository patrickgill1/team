// Worker-side mirror of src/utils/appAvailability.ts. Worker/src
// can't import from src/, so this exists to keep the flag surface
// identical on both sides. When Patrick flips PLAY_STORE_LIVE,
// he MUST flip both files at once — a mismatch means the app UI
// and the subscription welcome email disagree about whether
// Android install works.

export const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';

/** iOS App Store is fully public. */
export const APP_STORE_LIVE = true;

/** Play Store is closed (internal-testing only) as of 2026-07-12.
 *  Flip to true in LOCKSTEP with src/utils/appAvailability.ts when
 *  the public Play listing is installable without allowlisting. */
export const PLAY_STORE_LIVE = false;
