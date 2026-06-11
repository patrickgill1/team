# Fire FC 2.1.0

iOS build **19** · Android versionCode **24**

## App Store — "What's New"

The Wall is its own thing now. Long announcements with bold, headings, lists, links, photos, and comments don't leak into chat. New drafts, inline images, and auto-posts for POTM wins, dev plans, and juggle records. Profile got a dark refresh; Practice Effort tracks streak days with Sundays free.

## Play Store — full description

**The Wall, redone.** Coach announcements live on their own surface now — bold, headings, bullets, numbered lists, blockquotes, dividers, inline photos. Long posts stay polished and don't get garbled in chat. Edit-as-you-go drafts autosave so a half-written post survives a tab close.

**Comments and likes.** Parents can react and reply right under the post.

**Milestone auto-posts.** The wall surfaces the good stuff automatically — Player of the Match wins, completed development plans, new juggle PRs. Game schedules get a tighter two-line layout.

**Profile cleanup.** The player profile's Overview tab is now one continuous dark surface — the awkward mix of light cards and rainbow gradients is gone. The edit pencil in the top corner actually works.

**Practice Effort = days in a row.** Shows the current streak instead of total hours. Sundays don't count toward the streak and don't break it, so a religious day of rest is respected.

**HEIC photo uploads fixed.** Photos straight from the iPhone camera roll now upload to the wall correctly.

## Marketing one-liner

The wall, but actually a wall. Long formatted posts, no chat leak, photos that work.

## Internal notes (for me)

- New collections: `wall_posts` and `wall_comments`. Composite indexes deployed (firestore.indexes.json). Rules deployed (firestore.rules) for both — read by any auth, write gated to author/admin with a likes-only escape for reactions on posts.
- 2.0.0 users won't see new wall posts after this lands — the new wall reads from `wall_posts`, the old one reads pinned `chat_messages`. No force-update prompt is wired; relies on App Store / Play auto-update.
- R2 bucket CORS now lives at infra/r2-cors.json. Includes goalkickr.com origins for the upcoming rebrand.
- AWS SDK >=3.730 default checksum behavior disabled in api/r2-presign.mjs (signed-URL would break browser PUT preflight otherwise).
- Wall draft autosave is in localStorage. Per-surface (browser separate from iOS separate from Android), no cross-device sync. Patrick was told to keep a Notes backup of the big 2.1 launch post until 2.1 is live on his phone.
