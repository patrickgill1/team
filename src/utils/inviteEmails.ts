// Branded HTML + text templates for invite emails. Used by:
//   - Onboarding wizard's bulk-roster step
//   - /people/add bulk add page
//   - Anywhere else that generates a parent invite link
//
// Inline styles only — every major email client (Gmail, Outlook, Apple
// Mail, third-party clients) strips <style> blocks and external CSS,
// and several break on flex/grid. Tables + inline styles is the only
// layout that renders consistently across them.
//
// Keep the HTML small. Outlook on Windows chokes on > 102KB messages,
// and most mobile clients clip after ~30KB.

const APP_NAME = 'GoalKickr';
const SITE_URL = 'https://goalkickr.com';
// Country-neutral form (no /us/ segment) — iTunes auto-routes to the
// user's home store. The /us/ form was failing for non-US Apple IDs
// with 'not available in your country'.
const APP_STORE_URL = 'https://apps.apple.com/app/id6770324158';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.firefc.team';
const LOGO_URL = 'https://goalkickr.com/logo-light.svg';
const CRIMSON = '#DC2626';
const CHARCOAL_950 = '#0d0d10';
const CHARCOAL_900 = '#16161c';
const BONE = '#f1e9d8';

export interface ParentInviteOptions {
  /** Parent or family email being invited (To: address). */
  to: string;
  /** Player display name — "Lily Chen". */
  playerName: string;
  /** Team display name — "Fire FC U10". */
  teamName: string;
  /** Coach display name — "Patrick Gill" or "Coach Patrick". */
  coachName: string;
  /** Short greeting form — "Patrick". Used in subject line and salutation. */
  coachFirstName: string;
  /** Direct invite URL — `goalkickr.com/join/<id>`. */
  inviteLink: string;
  /** Optional one-line note from the coach (rendered as a blockquote). */
  note?: string;
  /** Family relationship the coach selected. Drives the copy ("Create
   *  your grandparent account"). Defaults to 'parent' when absent. */
  relationship?: 'parent' | 'grandparent' | 'aunt_uncle' | 'guardian' | 'sibling' | 'other';
}

/** Lowercase noun for inline body copy ("Create your <X> account"). */
function relationshipNoun(r?: ParentInviteOptions['relationship']): string {
  switch (r) {
    case 'grandparent': return 'grandparent';
    case 'aunt_uncle':  return 'family';
    case 'guardian':    return 'guardian';
    case 'sibling':     return 'family';
    case 'other':       return 'family';
    default:            return 'parent';
  }
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildParentInviteEmail(opts: ParentInviteOptions): BuiltEmail {
  const { playerName, teamName, coachName, coachFirstName, inviteLink, note, relationship } = opts;
  const noun = relationshipNoun(relationship);
  const isParent = noun === 'parent';

  const subject = `${coachFirstName} invited you to ${teamName} on ${APP_NAME}`;

  const text = [
    `Hi,`,
    ``,
    `${coachName} added ${playerName} to ${teamName} on ${APP_NAME}, the team-management app the coach is using this season.`,
    ``,
    `Tap the link below to set up your ${noun} account so you can RSVP to events, get team announcements, and follow ${playerName}'s schedule and stats:`,
    ``,
    inviteLink,
    ``,
    `This link is just for ${playerName}'s family and works one time. If someone else needs access, ask the coach for a new link.`,
    ``,
    note ? `Note from ${coachFirstName}: ${note}` : '',
    ``,
    `App Store: ${APP_STORE_URL}`,
    `Google Play: ${PLAY_STORE_URL}`,
    ``,
    `— The ${APP_NAME} team`,
  ].filter(Boolean).join('\n');

  // Single-table HTML. Width capped at 600px (the de-facto email
  // standard so it doesn't stretch on desktop preview panes).
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${CHARCOAL_950};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:${BONE};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CHARCOAL_950};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${CHARCOAL_900};border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);">

            <!-- Brand bar -->
            <tr>
              <td style="background:linear-gradient(135deg,${CRIMSON} 0%,${CHARCOAL_950} 100%);padding:28px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${LOGO_URL}" alt="${APP_NAME}" width="36" height="36" style="display:block;border:0;outline:none;text-decoration:none;" />
                    </td>
                    <td align="right" style="vertical-align:middle;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.04em;">
                      <span style="color:${BONE};">GOAL</span><span style="color:#ffffff;">KICKR</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Kicker -->
            <tr>
              <td style="padding:32px 32px 4px 32px;">
                <p style="margin:0;font-size:11px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:${CRIMSON};">You're invited</p>
              </td>
            </tr>

            <!-- Main headline -->
            <tr>
              <td style="padding:4px 32px 8px 32px;">
                <h1 style="margin:0;font-size:24px;line-height:1.2;font-weight:900;color:${BONE};">
                  ${escapeHtml(coachName)} added <span style="color:#ffffff;">${escapeHtml(playerName)}</span> to <span style="color:#ffffff;">${escapeHtml(teamName)}</span>.
                </h1>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#c2bdb1;">
                  ${APP_NAME} is the team-management app ${escapeHtml(coachFirstName)} is using this season. Create your ${noun} account to RSVP to events, get team announcements, and follow ${escapeHtml(playerName)}'s schedule.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:#8a8275;">
                  ${isParent ? 'Parents' : 'Family accounts'} are always free.
                </p>
              </td>
            </tr>

            ${note ? `
            <tr>
              <td style="padding:8px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:rgba(220,38,38,0.10);border-left:3px solid ${CRIMSON};border-radius:6px;">
                  <tr>
                    <td style="padding:12px 16px;font-size:13px;line-height:1.5;color:${BONE};font-style:italic;">
                      &ldquo;${escapeHtml(note)}&rdquo;<br />
                      <span style="font-style:normal;color:#8a8275;font-size:11px;">— ${escapeHtml(coachFirstName)}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ` : ''}

            <!-- CTA -->
            <tr>
              <td align="center" style="padding:24px 32px 12px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="background:${CRIMSON};border-radius:8px;">
                      <a href="${escapeHtml(inviteLink)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">
                        Join ${escapeHtml(teamName)}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Plain-text fallback link for clients that strip buttons -->
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <p style="margin:0;font-size:12px;color:#8a8275;line-height:1.55;">
                  Or paste this link into your browser:<br />
                  <a href="${escapeHtml(inviteLink)}" target="_blank" style="color:${CRIMSON};word-break:break-all;text-decoration:underline;">${escapeHtml(inviteLink)}</a>
                </p>
              </td>
            </tr>

            <!-- Privacy note -->
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0;font-size:12px;color:#6e6757;line-height:1.55;">
                  This invite is just for ${escapeHtml(playerName)}'s family and works one time. If you need access for another adult, ask ${escapeHtml(coachFirstName)} for a new link.
                </p>
              </td>
            </tr>

            <!-- App store badges -->
            <tr>
              <td align="center" style="padding:0 32px 28px 32px;border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;">
                <p style="margin:0 0 12px 0;font-size:11px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:#8a8275;">
                  Get the app
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 6px;">
                      <a href="${APP_STORE_URL}" target="_blank" style="display:inline-block;padding:10px 18px;background:#000000;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;">
                        Download for iPhone
                      </a>
                    </td>
                    <td style="padding:0 6px;">
                      <a href="${PLAY_STORE_URL}" target="_blank" style="display:inline-block;padding:10px 18px;background:#000000;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;">
                        Download for Android
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:20px 32px;background:${CHARCOAL_950};">
                <p style="margin:0;font-size:11px;color:#6e6757;line-height:1.55;">
                  ${APP_NAME} · <a href="${SITE_URL}" target="_blank" style="color:#8a8275;text-decoration:none;">goalkickr.com</a>
                </p>
                <p style="margin:6px 0 0 0;font-size:11px;color:#4f4a3f;line-height:1.55;">
                  You're receiving this because ${escapeHtml(coachName)} added your email to their team roster.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
