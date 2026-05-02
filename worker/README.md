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
