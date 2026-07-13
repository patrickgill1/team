// Single source of truth for "can a fresh Android user install our
// native app from the Play Store today?"
//
// Reality 2026-07-12: the Android app is in Google Play internal
// testing — install is gated by Patrick manually adding each
// tester's email to the allowlist. A parent whose email isn't on
// that list literally cannot install from the public Play listing
// (they see "item not found" or the install button silently no-ops).
//
// Every surface that ships a Google Play link/button/badge reads
// this flag. Flip to true once the Play listing is public and any
// Google account can install. When you flip it, no other file
// needs to change — every gated surface below re-enables its Play
// badge/CTA automatically:
//
//   - src/utils/inviteEmails.ts        (parent invite email html + text)
//   - src/pages/Onboarding.tsx         (staff-invite email in the wizard)
//   - src/components/common/InstallAppBanner.tsx
//   - src/components/common/InviteShareModal.tsx
//   - worker/src/appAvailability.ts    (mirror; keep in lockstep)
//   - worker/src/stripe.ts             (subscription welcome email)

export const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';

/** iOS App Store is fully public — no allowlist gate. */
export const APP_STORE_LIVE = true;

/** Play Store is currently CLOSED (internal-testing only). Flip to
 *  true once the public listing exits internal testing. Every
 *  Android install prompt in the app + emails gates on this. */
export const PLAY_STORE_LIVE = false;

/** Copy fragment for plain-text emails. Renders the Play Store link
 *  when live; otherwise renders an honest one-liner directing
 *  Android parents to the web app. Reused across every plaintext
 *  parent/coach invite so tone stays identical. */
export function androidHintText(): string {
  if (PLAY_STORE_LIVE) return `Google Play: ${PLAY_STORE_URL}`;
  return 'On Android: open the invite link above in your phone browser. '
    + 'The web version is the full app. No install needed while our '
    + 'Android app finishes beta.';
}

/** HTML fragment for the same. Returns null when PLAY_STORE_LIVE
 *  is true so the caller can render its own Google Play badge in
 *  the button row. When false, returns a subdued paragraph the
 *  caller drops below the App Store badge. */
export function androidHintHtml(): string | null {
  if (PLAY_STORE_LIVE) return null;
  return '<p style="margin:12px 0 0 0;font-size:12px;line-height:1.55;color:#8a8275;">'
    + 'On Android? Open the link in your phone browser. '
    + 'The web version is the full app. No install needed.'
    + '</p>';
}
