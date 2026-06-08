# Fire FC — Changelog

## 2.0.0 (iOS build 18 / Android versionCode 23) — 2026-06-07

89 commits since 1.6.1. The headline shift: Fire FC went from a great
team app to a complete club platform. Five categories of work below.

### 🏟️ Club Module — registration funnel end-to-end

The big new surface area. Families register, pay, get tryout'd, get
offered a roster spot, and become a real Player on a team — all in
the app, all tracked, all measurable.

- **Registration funnel + activity log foundation.** Public `/register`
  page with no-auth multi-step form. Activities collection becomes the
  spine of the future CRM family timeline.
- **Auth gate on `/register`.** Sign in with Google, Apple, or email
  before filling the form. One account covers every kid in your
  family. Welcome hero copy: "You're a few clicks from the Fire FC
  family."
- **Player created at registration submit.** No more snapshot-then-
  promote dance — the Player exists from day one with `teamId: null`
  until rostered.
- **Products + tiered pricing + coupons.** Each Product owns a pricing
  schedule (early bird → standard → late, resolved by date window)
  + its own coupon codes. Snapshotted onto each Registration so later
  product edits don't change historical quotes.
- **Admin Products editor at `/club/products`.** Tier editor with date
  windows, coupon editor (flat $ or %, max uses, expiry), age-group
  scoping, Stripe surcharge passthrough, live quote preview.
- **Customizable registration form questions.** Admin defines extra
  questions per club/season (school, prior club, "looking to play up,"
  etc.) at `/club/registration-form`. Snapshots question labels onto
  the Registration so renames don't break old answers.
- **Bulk-blast registration email** for returning-player early-bird
  pushes. Dedupes by primary parent email so multi-kid families get
  one email.
- **Bulk-email a selected subset of registrations** with checkbox + 
  sticky bottom bar on `/club/registrations`.
- **Bulk actions on registrations** — mark paid, invite to tryout,
  withdraw across selected rows.
- **Tryout pool at `/club/tryouts`** — coach favorites (♥), 1-5★
  ratings, free-form scouting notes (visible to all coaches), 7-day
  Holds that block other coaches from offering. Activity strip at the
  top shows recent coach moves.
- **Heavy filters on the tryout pool** — status, age, gender, position,
  returning vs new, "favorites only," and "Needs attention" surface
  for candidates 3+ days unfavorited with no hold and no offer.
- **Offer letters end-to-end.** SendOffer modal: team picker, position,
  jersey, fee, expiry, message body (with optional reusable templates).
  Email to parent with unique `/offer/<id>` link.
- **Welcome video on offer.** Optional Cloudflare Stream upload in the
  SendOffer modal; renders at the top of the public offer page.
- **Public offer accept/decline page** (`/offer/:id`). No auth needed
  to view. Accept simplified: just adds team to the existing Player's
  `teamIds` (preserving prior team memberships).
- **Offer templates at `/club/offer-templates`** — reusable message
  bodies scoped by team + position. SendOffer modal filters templates
  to matches.
- **Welcome email on accept** with install + RSVP-first-event prompts.

### 👤 Person admin (CRM)

New `/club/person/:playerId` surface — the one-stop admin view of
everything about a kid.

- **Person admin CRM detail view.** Header + tab nav (Overview /
  Teams / Registration / Payments / Notes / Communications / Activity)
  + Overview cards: Team Assignments, Guardian Contacts, Registration,
  Payments, Attendance donut, Forms Checklist. Quick Actions footer:
  Message, Add Note, Assign Team, Create Task.
- **Forms checklist system.** Admin defines waivers/releases/consents
  at `/club/forms` (scoped by season + age groups). Per-player Sign
  modal captures signer name + note. Required-but-unsigned forms
  show red.
- **Tasks system.** Admin todos at `/club/tasks` with Mine/All filter,
  status (open / in_progress / done), priority, due dates, related
  player + team. Create Task quick action from PersonAdmin pre-fills
  the player.
- **Per-tab pages live.** Teams (with primary/additional badges),
  Registration (full history), Payments (invoices + refund history +
  installments), Notes (filtered note_added activities), Comms (every
  email_sent), Activity (full chronological feed color-coded by kind).
- **Quick action wiring.** Message → opens/creates DM thread and
  navigates to chat. Add Guardian → reuses InvitePersonModal with
  player pre-pinned. View & Pay → generates one-time Stripe Checkout
  link with copy/open/email-to-parent.
- **Profile entry points everywhere.** People rows, Registrations rows,
  Tryouts rows, Family Timeline kids — every admin-side surface where
  a player appears now links to PersonAdmin.

### 🏥 Structured medical + family unification

- **Structured medical profile** replaces the free-text `medicalInfo`
  field. Allergies (with severity + EpiPen flag), conditions (with
  EAP for in-episode response), medications, concussion log (with
  return-to-play clearance), primary care, insurance, last physical,
  blood type.
- **Critical alerts banner at the top of every PersonAdmin tab.**
  EpiPen, life-threatening allergy, active concussion without
  clearance trigger red banners; severe allergies w/o EpiPen and
  EAP-bearing conditions trigger amber. Life-threatening info is never
  one tap away.
- **Household unification.** Admin links two parent emails into one
  household; the family timeline rolls up registrations / offers /
  players / activities across all linked emails. Handles create,
  extend, and merge cases cleanly.
- **Family timeline at `/club/family/:email`** aggregates everything
  for one family into a single chronological feed with summary tiles.

### 💳 Payments — Stripe Connect end-to-end

- **Stripe Connect Standard (worker + UI).** Each club owns their
  Stripe account; Fire FC the platform never holds money. Connect
  button on Payments tab kicks off OAuth onboarding.
- **Checkout on registration submit.** When a Product has a fee and
  the club's Connect is live, `/register` redirects to a Checkout
  Session. Webhook flips the Registration to paid and writes the
  `registration_paid` activity.
- **Refunds — full + partial.** Per-invoice Refund button on the
  Payments tab. Uses Stripe's `refund_application_fee: true` so the
  platform-fee slice is also reversed (no cut on refunded money).
  Webhook reconciles `pending` → `succeeded` automatically.
- **Payment plans.** Split any registration fee into 2-12 installments
  with individual due dates. Each installment gets its own Stripe
  Checkout link via worker. Registration flips to paid only when every
  installment is paid or waived.
- **Platform fee (`application_fee_amount`).** Per-club `platformFeeBps`
  field, settable ONLY by the platform owner via `/platform/clubs`
  (gated client-side by isOwner + Firestore rule blocks field write
  to anyone but the owner). Defaults to 0 across all clubs.
- **Disconnect button.** Calls Stripe's `/oauth/deauthorize` + clears
  the Club doc atomically. Idempotent — handles cases where Stripe
  has already revoked.
- **Fee disclosure** on the Connect Stripe button (before-state) +
  read-only platform-fee line in the connected state. No surprise
  fees post-connect.
- **Coupon `usesCount` bump** on Stripe webhook so `maxUses` ceilings
  actually enforce.

### 🤖 Automation — drips, digests, alerts

- **Daily registration drips** (cron 10am MDT): incomplete registration
  reminder (24-72h after signup), unpaid reminder (2-7 days after
  pending payment), offer-expiring reminder (24-60h before expiry).
  Each drip writes `lastDripKind` to dedupe.
- **Weekly admin roundup** (cron Sunday 4pm MDT): per-club email to
  every isClubAdmin with three sections — candidates needing attention,
  unpaid stragglers, offers expiring within 72h. Skips the send
  entirely if there's nothing to flag.
- **Digest timezone fix.** Worker was rendering practice times in UTC,
  so 9am MDT became "3pm." Now hardcoded to `America/Denver`. Saved
  as a memory so I don't trip this again.

### 🛠️ Infra — rules, indexes, hooks, eligibility

- **Firestore rules + indexes audit.** Every Club Module collection
  now has explicit rules (products, registrations, activities, offers,
  forms, tasks, households, etc.). Public flows (`/register`,
  `/offer/:id`) properly granted public access where needed.
- **Composite indexes file synced with live truth.** No more
  `firebase deploy --only firestore` prompting to delete existing
  indexes for chat / news / gallery / etc.
- **Ready-to-play eligibility** combines team assignment + payment
  status + required-form signatures into one traffic-light pill +
  per-gate breakdown card on PersonAdmin Overview.
- **`useClubId` hook** stops silently breaking pages when
  `userData.clubId` isn't set directly. Resolves through userData →
  team → any single club doc. Applied to Products, Forms, Tasks,
  OfferTemplates, RegistrationFormBuilder, Registrations,
  ClubOverview PaymentsTab.
- **React #310 fix on `/register`** — split form into a sub-component
  so hooks always run in the same order regardless of auth state.
- **Worker service-account parser fix.** Stripe endpoints were using
  naive `JSON.parse` on the base64-encoded FCM_SERVICE_ACCOUNT secret;
  surfaced as `firestore-not-configured` 503s even though the secret
  was set. Now uses `parseServiceAccount` from `fcm.ts` like the rest
  of the worker.
- **Stripe OAuth fixes** — route `/oauth/*` to `connect.stripe.com`
  (not `api.stripe.com/v1`), switch to basic auth (deauthorize was
  401'ing on bearer), drop dynamic state from redirect_uri so one
  registered URI works for every club.
- **App version single source of truth** at `src/utils/version.ts` +
  Firestore offline persistence via `persistentLocalCache`.

### ⚙️ Earlier in this release (pre-Club Module work)

These shipped between 1.6.1 and the start of the Club Module batch
but are also part of 2.0.0:

- **Development plans** redesign: drop redundant flows, celebratory
  "I DID IT" button + streaks + comments, Coach View / Parent View
  toggle, Import from library, drill streamUid carried onto goals,
  juggle counter, "Tonight's session" dashboard card.
- **AI drill generator** powered by OpenAI gpt-4o-mini; drills library
  with manual + AI sources; admin can upload TikTok-style reference
  videos to Cloudflare Stream.
- **Email rebrand** with new chrome + coach signature block (name +
  role + team + avatar).
- **Universal Links** via AASA file with real Apple Team ID;
  `firefc.app/event/:id`, `/offer/:id`, etc. open the app when
  installed.
- **Chat polish pass**: long-press 1000ms react-only, swipe gestures,
  message pinning, emoji picker redesign, kill EventDiscussion,
  multi-select DM picker, sectioned chat list (Pinned / DMs / Groups /
  Teams / Club), per-user pinning.
- **Mobile Safari Google sign-in fix** via Vercel rewrites + auth
  domain change (signInWithRedirect now actually completes).
- **iOS keyboard underlay fix** — UIWindow + rootViewController
  background painted white in AppDelegate.swift to stop the dark
  navy bleed-through behind iOS keyboard corners.
- **Equipment**: per-player gear sizes + coach "outstanding" view.
- **Players CSV import** for Sports Connect / Affinity export
  compatibility.
- **GameDay** push live updates to RSVP'd parents.
- **POTM** gold ring + chat push deep-links to exact message.
- **Wall** dedicated page for team announcements + "Post to wall"
  composer toggle + dashboard widget.
- **Team Store** dedicated page with copyable discount code.
- **News module** removed in favor of Wall.
- **Helpdesk** in-app tickets with replies + admin triage.

---

Total: 89 commits, 12 MB Android bundle, 18 new admin/coach surfaces,
14 new worker endpoints, 2 new cron schedules, 1 platform fee model,
4 new memory entries.

See `docs/RELEASE_NOTES_2.0.0.md` for App Store / Play Store-ready
copy in three lengths.
