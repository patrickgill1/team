// Vercel serverless function that serves the SPA index.html with
// invite-specific Open Graph meta tags injected. WhatsApp / iMessage /
// Slack / Facebook scrape the HTML they get from /join/{id} and use
// og:title / og:description / og:image to render a link preview.
//
// Real users hit /join/{id}, get this HTML, and the React bundle in
// it boots as normal (InviteJoin.tsx handles the join flow). Scrapers
// hit the same URL, see the injected meta, and never execute JS.
//
// Wired via vercel.json rewrite:
//   { "source": "/join/:inviteId", "destination": "/api/og-invite?id=:inviteId" }
//
// Requires WORKER_ORIGIN env var (e.g. https://api.goalkickr.com) so
// we can call /public/invite-preview server-side. That worker
// endpoint fetches the invite + team docs via the service account
// and returns { title, description, image } — no client-side auth
// dance needed, and the team name never leaks past what /join
// itself already shows.

import fs from 'node:fs';
import path from 'node:path';

const WORKER_ORIGIN = process.env.WORKER_ORIGIN || 'https://api.goalkickr.com';

// Read the built index.html once per cold start and cache in
// memory. Vercel's serverless runtime keeps warm functions across
// requests, so this fs.readFileSync fires at most once per instance
// and every subsequent request reuses the string.
let cachedIndexHtml = null;
function loadIndexHtml() {
  if (cachedIndexHtml) return cachedIndexHtml;
  const p = path.join(process.cwd(), 'build', 'index.html');
  cachedIndexHtml = fs.readFileSync(p, 'utf8');
  return cachedIndexHtml;
}

// HTML-encode a value so an injected title / description can't
// break out of the meta content="..." attribute (or, worse, inject
// script). Same set the browsers would escape via textContent.
function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replace the entire block between the <!-- OG START --> and
// <!-- OG END --> markers we add to public/index.html so the diff
// is unambiguous and future edits to the static meta don't fight
// this replacement. If the markers aren't present, fall back to a
// naive per-tag swap so the code is still safe against a template
// version mismatch.
function injectOg(html, { title, description, image, canonicalUrl }) {
  const t = escapeAttr(title);
  const d = escapeAttr(description);
  const i = escapeAttr(image);
  const u = escapeAttr(canonicalUrl);

  const block = `<!-- OG-INJECTED -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="GoalKickr" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:url" content="${u}" />
    <meta property="og:image" content="${i}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${i}" />
    <meta name="description" content="${d}" />`;

  // Strip the whole static OG block from index.html and drop in ours.
  // Match from the "Open Graph + Twitter cards" comment through the
  // twitter:image line, plus the plain description tag above it.
  let out = html;
  out = out.replace(
    /<meta name="description"[^>]*\/>/,
    ''
  );
  out = out.replace(
    /<!-- Open Graph[\s\S]*?<meta name="twitter:image"[^>]*\/>/,
    block
  );
  return out;
}

export default async function handler(req, res) {
  const inviteId = String(req.query?.id || '').trim();

  // Defaults — used when the invite lookup fails (bad id, worker
  // down, team missing). The joiner still gets the SPA and sees the
  // real error on the /join page; scrapers just see the neutral
  // fallback copy that ships in index.html.
  let title = 'GoalKickr';
  let description = 'Team management for soccer. RSVPs, chat, stats, and media in one place.';
  let image = 'https://app.goalkickr.com/logo512.png';

  if (inviteId) {
    try {
      const url = `${WORKER_ORIGIN}/public/invite-preview/${encodeURIComponent(inviteId)}`;
      // 3s timeout so a slow worker never hangs the response —
      // preview scrapers give up quickly and the SPA still loads
      // for real users.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const workerRes = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (workerRes.ok) {
        const data = await workerRes.json();
        if (data?.ok) {
          if (data.title) title = String(data.title);
          if (data.description) description = String(data.description);
          if (data.image) image = String(data.image);
        }
      }
    } catch (err) {
      console.warn('[og-invite] preview fetch failed', err?.message || err);
    }
  }

  const canonicalUrl = `https://app.goalkickr.com/join/${encodeURIComponent(inviteId)}`;
  let html;
  try {
    html = injectOg(loadIndexHtml(), { title, description, image, canonicalUrl });
  } catch (err) {
    console.error('[og-invite] template load failed', err?.message || err);
    // If the template read fails we cannot serve the SPA at all;
    // return a 500 so Vercel falls back to whatever error page it
    // shows (better than a blank page).
    res.status(500).send('Server error');
    return;
  }

  // Same cache posture as the SPA index.html — do not cache stale
  // bundles or stale meta. The workerRes payload has its own 60s
  // edge cache upstream so repeated scrapes of the same invite
  // avoid a Firestore round-trip.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}
