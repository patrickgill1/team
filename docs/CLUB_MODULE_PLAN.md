# Club Module — phased rollout

The club asked to integrate Fire FC as their primary platform: public
registration, tryout pipeline, offer letters, branded comms, full
admin CRM. This file tracks what's shipped and what's next.

## Status — Module 1 (foundation)

Shipped in this batch:

- **Types**: `Registration`, `Activity`, plus `Season` enhancements
  (registration window, fee, early-bird).
- **Public `/register` page**: no-auth multi-step form. Player + parent
  (1–2 guardians) + age group / gender / position / medical notes /
  "played before" flag. Supports `?return=<playerId>` to pre-fill from
  an existing player doc for returning families.
- **Admin `/club/registrations` page**: filterable list of every
  registration with status pills, summary tiles, and inline status
  actions (Mark paid / Invite to tryout / Withdraw).
- **`activities` collection** + `logActivity()` helper. Every
  registration submit + status change writes an Activity doc — the
  spine of the future CRM family timeline.
- **Quick-action tile** in Club admin to jump to Registrations.

## Status — Module 1 (NOT yet shipped, queued)

These are queued for the next commit batch but each needs a decision
or external setup before I can wire them.

### Stripe payment at submission

Currently registrations save as `status: 'pending_payment'` and admin
marks `paid` manually. To take payment automatically:

1. **Set up Stripe Connect for the club** (worker README section 5).
   Worker needs `STRIPE_SECRET_KEY` + `STRIPE_CONNECT_CLIENT_ID` +
   `STRIPE_WEBHOOK_SECRET`. Patrick: this is your action.
2. Worker endpoint `POST /stripe/registration-checkout` that creates
   a Checkout Session on behalf of the club's connected account.
3. `Register.tsx` redirects to the returned checkout URL after the
   doc is saved (instead of jumping straight to the success screen).
4. Webhook `POST /stripe/webhook` (already drafted in the README)
   listens for `checkout.session.completed`, marks the matching
   Registration `paid`, writes a `registration_paid` activity.

### Bulk-blast to current players

For returning-player early-bird pushes ("open registration"):

1. Admin clicks "Push registration email" on the Registrations page
   (button TODO, half a day).
2. Worker fans out one email per family — pulls every active player's
   `parentEmails`, dedupes, fires through the existing `/send-batch`
   path with a tailored returning-player template that links to
   `/register?return=<playerId>&season=<seasonId>`.
3. Each send writes an `email_sent` activity for the CRM timeline.

### Email branding from a custom domain

Today outbound mail comes from `firefc.app` via Resend (MailChannels
in worker). To send from `firefc.com` (or similar):

1. Verify the new domain in Resend dashboard (add 3 DNS records to
   the club's DNS provider).
2. Update `FROM_EMAIL` worker secret.

No code changes — pure DNS + config.

## Module 2 — Tryouts + Offer Letters (next)

Locked once Module 1 is live and getting real submissions.

- Coach-side "tryout candidates" filtered to their age groups.
- Notes + ratings per candidate (1-5 stars, free-form notes).
- Offer letter editor with reusable templates (per coach / per team
  / per position). Attachments via Stream upload (PDFs etc.).
- Public `/offer/<id>` page — beautifully designed parent-facing
  acceptance flow.
- Accept → registration → real Player on the coach's team + welcome
  email walking them through the app.

## Module 3 — Admin CRM (after Module 2)

- Family-centric timeline view (every parent, their kids, every
  activity, every communication, every payment, every offer, every
  team across years).
- Bulk actions (mass-charge fees, mass-email a group).
- Season lifecycle UI: open registration / close / start / end as a
  proper state machine with audit log.
- Reports + dashboards (registrations by age, conversion rate from
  registration → offer → roster, fee collection).

## Decisions still open

From the original conversation:

- **Fee structure** — sliding scale? Multi-kid discount? Late fee?
  Currently the form pulls a single `registrationFeeCents` from the
  Season doc with optional early-bird discount.
- **Tryout assignment** — when admin marks "Invite to tryout," do
  they pick a slot from a list, or does the system auto-assign?
- **Domain for outbound mail** — `firefc.com` (club's, needs DNS) vs
  `firefc.app` (yours, working today). Defaulting to firefc.app
  until told otherwise.
