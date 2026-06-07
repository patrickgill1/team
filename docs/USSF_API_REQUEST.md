# USSF Learning Center API — outreach

We want webhook access to `connect.ussdlc.com` so coach + ref certifications
shown in Fire FC stay current automatically. The API isn't self-serve — USSF
gates it on a manual review. Below is the email to send.

## Where to send it

USSF doesn't publish a public "developer relations" contact for this API.
The right starting point:

- **USSF Learning Center support:** [learning@ussoccer.com](mailto:learning@ussoccer.com)
- If that bounces, fall back to the general USSF Education contact at
  https://learning.ussoccer.com/coach/courses/help

Mention the API by name (`connect.ussdlc.com`) — that's how their team will
route you to the right people.

## Email template

Subject:
```
API access request — Fire FC team management app (Utah Youth Soccer)
```

Body:
```
Hi USSF Learning Center team,

I'm Patrick Gill, head coach of Fire FC (a Utah Youth Soccer club), and the
developer of an in-house team management app we use to run our team —
schedule, RSVPs, player development plans, game stats, parent communication.

I'd like to request API access at connect.ussdlc.com so the app can
surface USSF coaching + referee credentials directly on each coach's
profile, and so coaches get a heads-up when a license is approaching
expiration.

The integration would be read-only on our side. We'd:

  1. Register a webhook endpoint at our Cloudflare Worker
     (firefc16-mailer.firefc.workers.dev/ussf-webhook).
  2. Subscribe to certification-change events for our club's coaches
     after each coach explicitly opts in (we ask their consent before
     enrolling their record).
  3. Display the current credential list on their in-app profile and
     send a polite push reminder ~60 days before expiration.

We won't share or resell the data — it stays inside the app, visible only
to the coach themself and our club admin.

Active credentials on our side today:
  - Patrick Gill — Grassroots E License
  - Bryan Jensen — Grassroots D License

Could you let me know what's needed to provision API credentials, what your
review process looks like, and whether there's a usage agreement we'd sign?
Happy to provide more on the app, the club, or the integration architecture
if helpful.

Thanks,
Patrick Gill
Head Coach, Fire FC PG (U10) — Utah Youth Soccer
patrick.gill@zfpmail.org
(your phone)
```

## After they respond

Once we have credentials, the worker side needs:

```bash
cd worker
npx wrangler secret put USSF_API_KEY
npx wrangler secret put USSF_WEBHOOK_SECRET
```

…and an endpoint `POST /ussf-webhook` that validates the `Authorization`
header against `USSF_WEBHOOK_SECRET`, looks up the affected user by their
USSF subject id (stored on the user doc when they opted in), and writes
the updated cert list to `users/<uid>.coachCertifications` with
`source: 'ussf'`. Manual-entry rows from Settings stay alongside until
the next sync overrides them.

## Manual entry path (interim, ships today)

Until the webhook is live, coaches can self-enter their credentials from
Settings → Coaching credentials. Each row stores `source: 'manual'`.
When the API sync turns on, the webhook handler reconciles: same name +
level → swap to USSF-sourced, manual ones not matched stay (covers
non-USSF credentials like state SafeSport, first aid, etc.).
