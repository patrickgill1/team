# Fire FC16 Mailer (Cloudflare Worker)

Sends transactional + digest email via **MailChannels** (free from CF Workers).
The React app POSTs to this Worker; users never see the secret.

---

## 1. One-time deploy

```bash
cd worker
npm install
npx wrangler login           # opens browser, sign into your CF account
npx wrangler secret put NOTIFY_SECRET
# (paste a long random string — you'll also put it in Vercel env)
npx wrangler deploy
```

Note the URL it prints, e.g. `https://firefc16-mailer.<your-subdomain>.workers.dev`.

---

## 2. DNS records on `firefc16.com` (Cloudflare DNS)

### a) SPF — merge MailChannels into existing record

Your current TXT on `firefc16.com` is something like:
```
v=spf1 include:spf.efwd.registrar-servers.com ~all
```
**Edit it** to:
```
v=spf1 include:spf.efwd.registrar-servers.com include:relay.mailchannels.net ~all
```

### b) Domain Lockdown (prevents others from spoofing your domain via MailChannels)

Add a TXT record:
- **Name:** `_mailchannels`
- **Value:** `v=mc1 cfid=<your-workers-subdomain>.workers.dev`
  - `<your-workers-subdomain>` is the part before `.workers.dev` in your worker URL.
  - Example: if your worker URL is `firefc16-mailer.patrickgill.workers.dev`, the value is `v=mc1 cfid=patrickgill.workers.dev`.

### c) DKIM (optional but strongly recommended for inbox placement)

Generate keys locally:
```bash
openssl genrsa 2048 | tee priv.pem | openssl rsa -pubout -outform der | openssl base64 -A
```
- The base64 line → add as TXT record:
  - **Name:** `mailchannels._domainkey`
  - **Value:** `v=DKIM1; k=rsa; p=<base64-pubkey>`
- Take the contents of `priv.pem`, base64 it (`base64 -i priv.pem`), and store as a worker secret:
  ```bash
  npx wrangler secret put DKIM_PRIVATE_KEY
  ```
  Then add to the MailChannels payload (see `src/index.ts`, optional follow-up).
- Delete `priv.pem` afterwards.

---

## 3. Vercel env (for the React app)

In Vercel → Project → Settings → Environment Variables, add:
- `REACT_APP_NOTIFY_URL` = `https://firefc16-mailer.<your-subdomain>.workers.dev`
- `REACT_APP_NOTIFY_SECRET` = same value you used in `wrangler secret put NOTIFY_SECRET`

Redeploy the app.

---

## 4. Verify

```bash
curl https://firefc16-mailer.<your-subdomain>.workers.dev/health
# → {"ok":true,"from":"noreply@firefc16.com"}

curl -X POST https://firefc16-mailer.<your-subdomain>.workers.dev/send \
  -H "Authorization: Bearer <NOTIFY_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com","subject":"Fire FC16 test","html":"<b>Hello</b>"}'
```

Watch logs:
```bash
npx wrangler tail
```

---

## 5. AI drill generator (OpenAI GPT)

Powers the "Generate" button in the Drills library — coach types a topic
(e.g. "first touch under pressure, 10 min, U10") and GPT returns a
structured drill (title / setup / instructions / focus / duration / age
band) that the coach reviews + edits before saving.

Endpoint: `POST /generate-drill`
Body: `{ prompt: string, topic?: string, ageBand?: string }`
Returns: structured drill JSON (or `{ ok: false, error }` on failure).
Model: `gpt-4o-mini` with `response_format: json_object` so the output
is guaranteed-parseable.

### Setup

```bash
npx wrangler secret put OPENAI_API_KEY
# paste your sk-… key from https://platform.openai.com/api-keys
```

That's the whole setup. No DNS, no other env vars. Cost is ~$0.005
per generation (gpt-4o-mini, ~800 tokens). Reasonable cap: ~$1/month
for a single coach generating several drills per week.

NOTE: an OpenAI API key (`platform.openai.com`) is separate from a
ChatGPT Plus subscription. You need API credits on file at
platform.openai.com/settings/organization/billing — $5 will last
forever at this usage.

If the key is missing the endpoint returns 503 — the UI surfaces it as
a friendly "Generation failed" toast, no app-wide break.

---

## 6. Stripe Connect (multi-club payments)

Worker endpoints are LIVE in `worker/src/stripe.ts` — they return `503
stripe-not-configured` until the secrets below are set. UI flow is also
live: Connect button on the Payments tab, OAuth return handler, Register
form auto-redirect to Checkout when a price is owed, webhook flips
Registration to `paid`. To turn it on:

### a) Stripe platform account

1. Create a Stripe account at https://dashboard.stripe.com (Patrick — use your existing one if it's not already a Connect platform).
2. Activate Connect: Dashboard → Settings → Connect → Get Started → choose "Platform or marketplace" → "Standard accounts" (we want each club holding their own balance, not Express).
3. Note the platform's:
   - Publishable key (`pk_live_…` and `pk_test_…`)
   - Secret key (`sk_live_…` and `sk_test_…`)
   - Connect OAuth Client ID (`ca_…`)
   - Webhook signing secret (set up the webhook endpoint first — see (c)).

### b) Worker secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY        # sk_live_… or sk_test_…
npx wrangler secret put STRIPE_CONNECT_CLIENT_ID # ca_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_…
# Optional — only if your Firebase project id isn't already in FCM_SERVICE_ACCOUNT
npx wrangler secret put FIREBASE_PROJECT_ID
```

### c) Worker endpoints (already live in `src/stripe.ts`)

- `GET  /stripe/connect/start?clubId=<id>` — returns Stripe's hosted OAuth
  URL. Stripe redirects back to `APP_ORIGIN/club?stripe_connected=1&state=<clubId>&code=<auth_code>`.
- `POST /stripe/connect/finish` — body: `{ code, clubId }`. Exchanges code
  for `stripe_user_id`, fetches the account, writes `stripeAccountId` +
  `stripeChargesEnabled` + `stripePayoutsEnabled` + `stripeOnboardedAt`
  to `clubs/<id>`.
- `POST /stripe/registration-checkout` — body: `{ registrationId }`. Reads
  the Registration + Club docs, creates a Checkout Session on the
  connected account using the snapshotted `amountPaidCents` + surcharge,
  returns the hosted URL. UI redirects the parent there.
- `POST /stripe/webhook` — anonymous endpoint (Stripe signs with
  `STRIPE_WEBHOOK_SECRET`). On `checkout.session.completed`, flips the
  Registration to `paid`, writes `paidAt` + `stripePaymentIntentId`, and
  logs a `registration_paid` activity.

Configure the webhook in Stripe Dashboard → Developers → Webhooks → Add
endpoint pointing at `https://<worker>.workers.dev/stripe/webhook`,
listening for `checkout.session.completed`. Copy the signing secret into
`STRIPE_WEBHOOK_SECRET`.

### NOTE — platform fee (deferred)

`application_fee_amount` on the Checkout Session is the lever for
charging clubs a platform fee. Intentionally NOT wired yet — see the
TODO in `handleRegistrationCheckout`. When enabled, the per-club fee
rate (`platformFeeBps` on the Club doc) must be writable ONLY by the
platform owner, not by club admins.

### d) Vercel env

- `REACT_APP_STRIPE_PUBLISHABLE_KEY` (used only for the redirect — Connect OAuth
  needs the publishable key in the URL).

### e) Firestore rules

Add to `firestore.rules`:
```
match /invoices/{invoiceId} {
  // Parents see only their own. Coaches see their team's. Club admins see all.
  allow read: if request.auth != null
    && (resource.data.parentUid == request.auth.uid
        || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isClubAdmin == true
        // (team coach check would go here)
       );
  // Writes only via worker (server-side). Block client writes.
  allow write: if false;
}
```

The worker uses Firestore Admin SDK creds (service account JSON in
`FCM_SERVICE_ACCOUNT` already) so it bypasses rules — fine.
