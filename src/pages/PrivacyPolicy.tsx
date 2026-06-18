import React from 'react';
import { Link } from 'react-router-dom';

const EFFECTIVE_DATE = 'May 17, 2026';
const CONTACT_EMAIL = 'support@goalkickr.com';
const APP_NAME = 'GoalKickr';
const APP_DOMAIN = 'goalkickr.com';

const PrivacyPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-white">
      <header className="bg-gradient-to-r from-charcoal-700 via-charcoal-600 to-charcoal-700 text-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
          <Link to="/" className="text-sm text-white/70 hover:text-white inline-flex items-center gap-1">
            ← Back to {APP_NAME}
          </Link>
          <h1 className="text-3xl sm:text-4xl font-bold mt-3 tracking-tight">Privacy Policy</h1>
          <p className="text-white/80 text-sm mt-1">Effective {EFFECTIVE_DATE}</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 text-slate-800 leading-relaxed text-[15px] space-y-6">
        <p>
          This Privacy Policy describes how {APP_NAME} (the "App") collects, uses, and shares
          information when you create an account or use the App as a coach, team manager,
          or parent. We respect your privacy and built the App to handle team information
          (rosters, schedules, photos, messages) only for the purpose of running your team.
        </p>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Information We Collect</h2>
          <p className="mb-2">We collect only what's needed to run your team:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Account info</strong>: name, email address, and optionally phone number, profile photo, and address (parent role only, optional).</li>
            <li><strong>Authentication</strong>: a unique identifier from Firebase Authentication (and from Sign in with Apple or Google if you use those options). Apple sign-in may return a private relay email at your choice.</li>
            <li><strong>Player records</strong>: names, jersey numbers, positions, dates of birth, emergency contacts, medical notes — entered by coaches or team managers about players on the team.</li>
            <li><strong>Photos & videos</strong>: media you upload to the team gallery, highlights, or game-day clips. Videos are hosted on Cloudflare Stream for playback; photos and other media are hosted on Firebase Storage or Cloudflare R2.</li>
            <li><strong>Messages & content</strong>: team chat messages, calendar events you create, RSVPs, survey responses, votes for "Player of the Match", and similar team activity.</li>
            <li><strong>Device tokens</strong>: a push notification token (APNs / FCM) so we can deliver team notifications to your device. You can disable notifications in your device settings at any time.</li>
            <li><strong>Usage data</strong>: minimal technical logs (errors, sign-in events) needed to keep the App working.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">How We Use This Information</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>To create and authenticate your account.</li>
            <li>To show team rosters, schedules, photos, messages, and stats to the people on your team.</li>
            <li>To send team-related push notifications (e.g., game reminders, RSVP nudges, new messages).</li>
            <li>To diagnose and fix technical problems.</li>
          </ul>
          <p className="mt-2">
            We do <strong>not</strong> use your data for advertising, sell it, or share it with
            third parties for marketing. We do not use third-party trackers.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Who Can See Your Information</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Your team</strong>: coaches, team managers, and parents on the same team can see player records, rosters, photos, calendar events, and messages within that team.</li>
            <li><strong>Public share links</strong>: when a coach or parent generates a share link for an event, photo, video, or "Player of the Match" vote, anyone with that link can view (and in some cases respond to) the linked item without signing in. Don't share the link with anyone you don't want viewing the content.</li>
            <li><strong>Service providers</strong>: we rely on the following infrastructure providers, who process data on our behalf under their own privacy policies:
              <ul className="list-disc pl-6 mt-1 space-y-1">
                <li>Google / Firebase (authentication, database, file storage, push notifications)</li>
                <li>Cloudflare (video hosting via Stream, file storage via R2, edge networking)</li>
                <li>Vercel (web hosting)</li>
                <li>Apple (Sign in with Apple, push notification delivery)</li>
              </ul>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Children's Privacy</h2>
          <p>
            {APP_NAME} is intended for use by coaches, team managers, and parents — not by
            children directly. Information about players (who may be under 13) is entered by
            their coach, team manager, or parent for the purpose of running the team. Player
            information is visible only to other coaches, team managers, and parents on the
            same team, or to anyone a team member explicitly shares a public link with.
          </p>
          <p className="mt-2">
            If you are a parent or guardian and would like a player's information removed
            from the App, contact your coach or email us at{' '}
            <a className="text-crimson-700 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Data Retention & Deletion</h2>
          <p>
            We retain account information and team data for as long as your account is active
            and your team is using the App. You can request deletion of your own account
            (and any data tied solely to you) at any time by emailing{' '}
            <a className="text-crimson-700 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>{' '}
            from the email address on your account. We will delete or anonymize your data
            within 30 days, except where retention is required for legal, billing, or
            security purposes.
          </p>
          <p className="mt-2">
            Team content (messages you posted, photos you uploaded) may remain visible to
            your team after your account is deleted unless you also request its removal.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Location</h2>
          <p>
            <strong>The App does not request your device's location.</strong> Coaches
            create events by searching for a venue on a map and dropping a pin — the
            venue's coordinates are saved on the event itself, not the coach's.
          </p>
          <p className="mt-2">
            Event-venue coordinates ARE stored on each event so the app can render a
            map preview and open the right spot in Apple/Google Maps. Those venue
            coordinates are visible to your team. They are not tied to any individual
            user's location.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Security</h2>
          <p>
            Data is transmitted over HTTPS and stored with our service providers (Google
            Firebase, Cloudflare) using their standard at-rest encryption. No system is
            perfectly secure — please use a strong, unique password and contact us promptly
            if you believe your account has been compromised.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Your Choices</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>You can edit or remove information from your profile inside the App.</li>
            <li>You can disable push notifications in your device settings.</li>
            <li>You can revoke share links you created from the relevant section of the App.</li>
            <li>You can request a copy of, or deletion of, your account data by emailing{' '}
              <a className="text-crimson-700 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">International Users</h2>
          <p>
            {APP_NAME} is operated from the United States. By using the App you understand
            that your information will be processed in the United States, which may have
            different data protection rules than your country.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy as the App evolves. If we make a material
            change, we will update the "Effective" date above and, where appropriate, notify
            you in the App or via email.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-charcoal-900 mt-6 mb-2">Contact</h2>
          <p>
            Questions, requests, or concerns? Email{' '}
            <a className="text-crimson-700 underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </section>

        <footer className="pt-6 mt-8 border-t border-slate-200 text-xs text-slate-500">
          {APP_NAME} · {APP_DOMAIN}
        </footer>
      </main>
    </div>
  );
};

export default PrivacyPolicy;
