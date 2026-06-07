# USSF License API v2 — outreach

Public docs live at https://connect.learning.ussoccer.com/index.html (S3-hosted,
no auth required to read). The API itself is at `connect.ussdlc.com` — JWT auth,
documented endpoints, webhook events, the full deal. **NOT self-serve** — has to
go through a member-organization partnership.

## What we get if approved

Per the docs, the relevant endpoints for Fire FC are:

- **`GET /users/{ussf_id}/user-licenses`** — every cert this person holds, with
  issue date, expiration date, issuer, rank. This is the coaching-license display.
- **`POST /users/{ussf_id}/subscriptions`** — subscribe to a person's record.
  After this, the webhooks below fire whenever USSF updates them.
- **`POST /webhook-user-license-update`** — fires on any license add/update/expire.
  This is the webhook our Cloudflare Worker terminates so credentials stay current
  without polling.
- **`GET /background-checks/ussf/{ussf_id}`** — returns active background check
  records (up to 2 years past expiration). Huge for youth-sports safety surfacing.
- **`GET /risk-management-database`** — check whether a person is on the
  safeguarding / banned list. Should be wired into onboarding so a flagged person
  can't link to a team.

The docs also expose referee experience + grassroots referee certificate
endpoints — not relevant for Fire FC at coaching scale, can skip.

## Where to send the request

**`sdp-support@ussoccer.org`** — per the docs, this is the address for technology
providers requesting API credentials on behalf of a member organization. Fire FC
plays under Utah Youth Soccer Association (UYSA), which is a USSF member
organization — that's our partnership angle.

(NOT `learning@ussoccer.com` — that's general learner support and would just
forward.)

## Email template

Subject:
```
License API v2 — credential request for Fire FC (UYSA member club)
```

Body:
```
Hi USSF SDP team,

I'm Patrick Gill, head coach of Fire FC — a club registered under Utah
Youth Soccer Association (UYSA), a U.S. Soccer member organization. I've
also built and operate the in-house team management app we use to run
the club (chat, scheduling, RSVPs, player development plans, game stats,
parent communication).

I'd like to request API credentials for the License API v2 documented at
connect.learning.ussoccer.com. Specifically, the integration would:

  1. Display each coach's USSF coaching credentials + expiration dates
     on their in-app profile (GET /users/{ussf_id}/user-licenses).
  2. Subscribe to webhook-user-license-update for our coaches so we can
     send a polite reminder ~60 days before any license expires.
  3. Run a safeguarding check against /risk-management-database when a
     new coach joins, so a flagged person can't be linked to a team.
  4. Show background check status on each coach's profile via
     /background-checks/ussf/{ussf_id}.

Read-only on our side. Each coach explicitly opts in before we enroll
their record; data lives only in our Firestore instance and is visible
only to that coach and our club admin. Webhook endpoint would be
hosted at https://firefc16-mailer.firefc.workers.dev/ussf-webhook
behind the shared-secret header pattern your docs describe.

Active credentials on our side:
  - Patrick Gill — USSF Grassroots E License (head coach, app developer)
  - Bryan Jensen — USSF Grassroots D License (assistant coach)

Member-org affiliation: Utah Youth Soccer Association
Club: Fire FC PG (U10 boys, 2026 season)

Could you let me know what's needed to provision credentials, what the
review timeline looks like, and whether there's a partner agreement to
sign? Happy to provide more on the app, our club registration, or the
integration architecture.

Thanks,
Patrick Gill
Head Coach, Fire FC PG — Utah Youth Soccer
patrick.gill@zfpmail.org
(your phone)
```

## After they approve

Worker secrets to add:

```bash
cd worker
npx wrangler secret put USSF_API_BASE        # likely https://connect.ussdlc.com
npx wrangler secret put USSF_API_USERNAME
npx wrangler secret put USSF_API_PASSWORD
npx wrangler secret put USSF_WEBHOOK_SECRET  # they'll provide this
```

Worker endpoints to add (sketch):

- `POST /ussf-webhook` — terminate webhook traffic. Validate the `Authorization`
  header against `USSF_WEBHOOK_SECRET`, look up the affected user by their
  `ussf_id` stored on the user doc, write the latest cert list to
  `users/<uid>.coachCertifications` with `source: 'ussf'`.
- `POST /ussf-link` — coach-initiated linking from Settings → "Connect USSF
  account". Body: `{ ussf_id, email }`. Worker calls `POST /users/<ussf_id>/subscriptions`
  to enroll, stores `ussf_id` on the user doc, and pulls the initial cert list.
- Refresh token rotation — the docs say access tokens are 1h, refresh 24h.
  Worker needs a scheduled task or just-in-time refresh in front of every API
  call.

## Manual entry path (interim, ships today)

Until the webhook is live, coaches self-enter credentials from Settings →
Coaching credentials. Each row stores `source: 'manual'`. When the API sync
turns on, the webhook handler reconciles by name + level and swaps to
`'ussf'`. Manual rows for non-USSF credentials (state SafeSport, first aid)
stay alongside.
