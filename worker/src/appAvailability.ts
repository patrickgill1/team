// Worker-side mirror of src/utils/appAvailability.ts. Worker/src
// can't import from src/, so this exists to keep the flag surface
// identical on both sides. When Patrick flips PLAY_STORE_LIVE,
// he MUST flip both files at once — a mismatch means the app UI
// and the subscription welcome email disagree about whether
// Android install works.

export const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';
export const ANDROID_BETA_OPTIN_URL = 'https://play.google.com/apps/testing/com.firefc.team';

/** iOS App Store is fully public. */
export const APP_STORE_LIVE = true;

/** Public production listing. Still closed until Patrick clears
 *  the 20-testers/14-days gate + applies for production access. */
export const PLAY_STORE_LIVE = false;

/** Beta opt-in URL flow live? Turned OFF 2026-07-13 after testing
 *  proved the Group-join step is a dead end for cold parents
 *  (they see "App not available"). Now handled via coach-submitted
 *  beta_requests + manual paste-in from admin portal. Keep in
 *  lockstep with src/utils/appAvailability.ts. */
export const ANDROID_BETA_OPEN = false;
