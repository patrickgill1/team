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

/** Google's opt-in landing page for internal/closed testing. Works
 *  ONLY when the tester source in Play Console is a Google Group
 *  with "Anyone can join" enabled. Patrick set that up 2026-07-12
 *  (group: goalkickr@googlegroups.com). Parents tapping this URL
 *  join the group + become testers + get one-tap install — no
 *  manual allowlisting. */
export const ANDROID_BETA_OPTIN_URL = 'https://play.google.com/apps/testing/com.firefc.team';

/** iOS App Store is fully public — no allowlist gate. */
export const APP_STORE_LIVE = true;

/** Play Store PUBLIC listing (production track). Still closed
 *  until Patrick clears the 20-testers-14-days gate + applies for
 *  production access. Flip to true then. */
export const PLAY_STORE_LIVE = false;

/** Android BETA opt-in flow is live? True once the Play Console
 *  tester source is set to the Google Group AND the group is set
 *  to "Anyone can join." Flipping this true lights the beta CTA
 *  everywhere and updates the Android-parent copy to mention the
 *  one-tap install path. Flip to false again if the beta ever
 *  closes (unlikely; usually we'd flip PLAY_STORE_LIVE=true and
 *  supersede this instead). */
export const ANDROID_BETA_OPEN = true;

/** Copy fragment for plain-text emails. Three variants:
 *    - Play Store live → straight Play Store link
 *    - Beta open (Google Group tester source) → beta-install link
 *      as the primary Android option, web fallback secondary
 *    - Neither → web only
 *  Reused across every plaintext parent/coach invite so tone
 *  stays identical. */
export function androidHintText(): string {
  if (PLAY_STORE_LIVE) return `Google Play: ${PLAY_STORE_URL}`;
  if (ANDROID_BETA_OPEN) {
    return `Android (early access, one-tap install): ${ANDROID_BETA_OPTIN_URL}`
      + `\n(Or open the invite link above in Chrome to skip the install and use the web version.)`;
  }
  return 'On Android: open the invite link above in your phone browser. '
    + 'The web version is the full app. No install needed while our '
    + 'Android app finishes beta.';
}

/** HTML fragment for the same. Returns null when PLAY_STORE_LIVE
 *  is true so the caller can render its own Google Play badge in
 *  the button row. Otherwise returns a subdued paragraph the
 *  caller drops below the App Store badge. */
export function androidHintHtml(): string | null {
  if (PLAY_STORE_LIVE) return null;
  if (ANDROID_BETA_OPEN) {
    return '<p style="margin:12px 0 0 0;font-size:12px;line-height:1.55;color:#8a8275;">'
      + 'On Android? '
      + `<a href="${ANDROID_BETA_OPTIN_URL}" style="color:#c8202c;text-decoration:underline;">Install via early access</a> `
      + '(one tap, no allowlist). Or open the link above in Chrome to use the web version instead.'
      + '</p>';
  }
  return '<p style="margin:12px 0 0 0;font-size:12px;line-height:1.55;color:#8a8275;">'
    + 'On Android? Open the link in your phone browser. '
    + 'The web version is the full app. No install needed.'
    + '</p>';
}
