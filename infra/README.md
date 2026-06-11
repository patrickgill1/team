# Infra one-shots

Server-side config you have to apply yourself (Claude can't reach Cloudflare with your creds).

## R2 bucket CORS

Required for browser PUTs from `https://firefc.app` to upload to the `fire` bucket.

JSON shape: wrangler 4.x expects `{ "rules": [ { "allowed": { "origins": [...], "methods": [...], "headers": [...] }, ... } ] }` — the Cloudflare API format, NOT the AWS S3 `AllowedOrigins`/`AllowedMethods` capitalized form.

### Option 1 — wrangler CLI

The bucket lives in a specific Cloudflare account. Make sure wrangler is logged into THAT account (run `npx wrangler whoami` to check). Then:

```bash
npx wrangler r2 bucket cors set fire --file infra/r2-cors.json -y
npx wrangler r2 bucket cors list fire
```

### Option 2 — Cloudflare dashboard

If wrangler isn't logged into the right account, easier to skip the auth dance:

Dashboard → switch to the account owning `fire` → R2 → **fire** → Settings → CORS Policy → paste the contents of [r2-cors.json](r2-cors.json) → Save.

You only need to do this once per bucket. Add new origins (e.g. when the goalkickr.com rebrand goes live) by editing [r2-cors.json](r2-cors.json) and re-running the `put` command.
