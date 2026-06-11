# Infra one-shots

Server-side config you have to apply yourself (Claude can't reach Cloudflare with your creds).

## R2 bucket CORS

Required for browser PUTs from `https://firefc.app` to upload to the `fire` bucket.

```bash
# from repo root (wrangler 4.x: command is `set`, file via `--file`)
npx wrangler r2 bucket cors set fire --file infra/r2-cors.json

# verify
npx wrangler r2 bucket cors list fire
```

If wrangler isn't authenticated, run `npx wrangler login` first.

(Older wrangler versions called this `put`. If the CLI changes again, run `npx wrangler r2 bucket cors set --help` to see the current syntax.)

You only need to do this once per bucket. Add new origins (e.g. when the goalkickr.com rebrand goes live) by editing [r2-cors.json](r2-cors.json) and re-running the `put` command.
