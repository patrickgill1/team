# Club Module — phased rollout

The club asked to integrate Fire FC as their primary platform: public
registration, tryout pipeline, offer letters, branded comms, full
admin CRM. This file tracks what's shipped and what's next.

## Status — Module 1 (foundation)

Shipped:

- **Types**: `Registration`, `Activity`, `Product`, `PricingTier`,
  `Coupon`, plus `Season` enhancements (registration window, fee,
  early-bird).
- **Public `/register` page**: no-auth multi-step form. Player + parent
  (1–2 guardians) + age group / gender / position / medical notes /
  "played before" flag. Supports `?return=<playerId>` to pre-fill from
  an existing player doc for returning families.
- **Products + tiered pricing**: charges run off a `Product` doc per
  season, with a `pricingTiers[]` array (Early Bird → Standard → Late
  windows resolved by date) and a `coupons[]` array for promo codes.
  The Register form quotes through `quotePrice()` and snapshots the
  resolved tier/coupon onto the Registration doc so a later product
  edit doesn't change what a family was charged.
- **Stripe surcharge passthrough**: per-product `stripeSurchargeBps`
  adds an itemized processing line at checkout (defaults to 0 — the
  club absorbs fees unless they flip it on).
- **Admin `/club/registrations` page**: filterable list of every
  registration with status pills, summary tiles, and inline status
  actions (Mark paid / Invite to tryout / Withdraw).
- **`activities` collection** + `logActivity()` helper. Every
  registration submit, status change, and coupon redemption writes an
  Activity doc — the spine of the future CRM family timeline.
- **Quick-action tile** in Club admin to jump to Registrations.

## Status — Module 1 (NOT yet shipped, queued)

These are queued for the next commit batch but each needs a decision
or external setup before I can wire them.

### Admin UI for managing Products

Right now Products get created by hand in Firestore. Before this is
parent-facing, admin needs:

1. `/club/products` list page — see active products per season,
   pricing tiers, coupon list, redemption counts.
2. Product editor modal — name, type, tier rows with date pickers,
   coupon rows with code/discount/maxUses/expiry, age-group selector,
   surcharge toggle.
3. Coupon usage report — who redeemed which code on which registration.

### Stripe payment at submission — code shipped, awaiting Patrick's Stripe setup

UI + worker endpoints are LIVE. Currently `503 stripe-not-configured`
until secrets land on the worker. Patrick action:

1. **Set up Stripe Connect platform** (worker README section 6).
2. `npx wrangler secret put STRIPE_SECRET_KEY / STRIPE_CONNECT_CLIENT_ID / STRIPE_WEBHOOK_SECRET`.
3. Click "Connect Stripe" on the Payments tab of /club → finish OAuth.
4. Test a real registration end-to-end.

What's already wired:
- `worker/src/stripe.ts` with `/stripe/connect/start`,
  `/stripe/connect/finish`, `/stripe/registration-checkout`,
  `/stripe/webhook` (signature-verified).
- Register.tsx redirects to Checkout when a price is owed; falls back
  to the success screen if the worker is unconfigured (so the form
  keeps working).
- `/register/success` + `/register/cancel` landing pages for the
  return from Stripe.
- Webhook flips Registration to `paid` + writes `registration_paid`
  activity.

Not yet wired (intentional): `application_fee_amount` (platform fee) —
see `project_platform_fee.md` memory. Coupon `usesCount` bump on
payment success is also TODO; add to the webhook handler.

### Bulk-blast to current players

For returning-player early-bird pushes ("open registration"):

1. Admin clicks "Push registration email" on the Registrations page —
   modal includes an age-group multi-select so we can target a single
   age band (e.g. just U11s for a tryout call).
2. Worker fans out one email per family — pulls every active player's
   `parentEmails`, dedupes by email, fires through the existing
   `/send-batch` path with a tailored returning-player template that
   links to `/register?return=<playerId>&season=<seasonId>`.
3. Each send writes an `email_sent` activity for the CRM timeline.

### Email branding from a custom domain

Today outbound mail comes from `firefc.app` via Resend (MailChannels
in worker). To send from `firefc.com` (or similar):

1. Verify the new domain in Resend dashboard (add 3 DNS records to
   the club's DNS provider).
2. Update `FROM_EMAIL` worker secret.

No code changes — pure DNS + config.

## Module 1.5 — Customizable registration form (next-ish)

The club wants to capture additional, club-specific fields at signup
(prior clubs, school/grade, "looking to play up?", scholarship request,
coach-handoff notes). Today the form is hardcoded.

- `RegistrationFormConfig` doc per club/season — array of
  `{ id, label, type: 'text'|'select'|'yes_no'|'textarea', options?, required }`.
- Renders a "Club questions" section after the player/parent blocks.
- Answers stored on `Registration.customAnswers` as a `Record<id, value>`.
- Admin builder UI to add/reorder/edit the question list.

## Module 2 — Tryouts + Offer Letters

Foundation shipped (`/club/tryouts`). Still to come: offer letters.

Shipped:
- **Coach activity feed strip** on /club/tryouts — last 6 coach moves
  (favorites, ratings, notes, holds, offers, tryout invites) visible
  to everyone. Patrick's "Ollie can't do most of that" transparency
  goal.
- **Favorites + Holds** — heart toggle stored per-coach; hold is a
  shared lock with a 7-day default that blocks other coaches from
  offering until released.
- **Heavy filters** on the tryout pool: status, age, gender, position,
  returning vs new, "favorites only" toggle, free-text search.
- **Notes + ratings** — 1-5 stars per coach (shows pool average) plus
  free-form notes visible to all coaches.

Offers (shipped):
- "Send offer" button on every Tryouts row (blocked if another coach
  is holding the candidate).
- Modal: team picker (defaults to age-matched team), offer position +
  jersey #, fee owed at accept, expiry days, composed message body
  with a sensible default template.
- Email goes out to the primary parent with a unique `/offer/<id>` link.
- Public `/offer/<id>` page — parent-facing, no auth. Renders the
  message + key details. Accept promotes the Registration to a real
  Player on the offering team (with snapshotted position/jersey),
  flips both docs to accepted, logs `offer_accepted` +
  `player_promoted`. Decline captures an optional reason and flips to
  declined.

Still queued:
- Offer letter templates page (`/club/offer-templates`) so coaches
  don't retype the same body for every kid.
- Welcome email to the family after accept (link to install the app,
  RSVP next event, etc.).
- Attachments on offers (PDF roster handbook, gear order form) via
  Stream/R2 upload.

## Module 3 — Admin CRM

Foundation shipped: `/club/family/:email` timeline view aggregating
every registration, offer, player, and activity touching that parent
email into one chronological feed. "Family" link surfaces it from each
Registrations row.

Still queued:
- Bulk actions (mass-charge fees, mass-email a group).
- Season lifecycle UI: open registration / close / start / end as a
  proper state machine with audit log.
- Reports + dashboards (registrations by age, conversion rate from
  registration → offer → roster, fee collection, coupon usage).
- "Family" link on Tryouts rows too (currently only on Registrations).

## Decisions still open

From the original conversation:

- **Tryout assignment** — when admin marks "Invite to tryout," do
  they pick a slot from a list, or does the system auto-assign?
- **Domain for outbound mail** — `firefc.com` (club's, needs DNS) vs
  `firefc.app` (yours, working today). Defaulting to firefc.app
  until told otherwise.
- **Default `stripeSurchargeBps`** — start at 0 (club absorbs) or
  default to 290bps (~Stripe's flat take, passed to parent)?
