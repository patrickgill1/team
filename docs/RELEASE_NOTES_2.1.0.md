# Fire FC 2.1.0 — Wall & polish

iOS build **19** · Android versionCode **24**

## What's new (short — App Store "What's New" field)

The team wall is its own thing now — long announcements with bold, headings, lists, links and photos don't leak into chat anymore. Plus profile polish: a unified dark Overview tab and a Practice Effort streak that skips Sundays.

## What's new (Play Store description — slightly longer)

- **Team Wall, redone.** Coach announcements now live on their own surface with proper formatting (bold, headings, bullet lists, blockquotes, dividers, photos). Long posts stay polished and don't get garbled in chat.
- **Profile cleanup.** The player profile's Overview tab is now one continuous dark surface — the awkward mix of light cards and rainbow gradients is gone.
- **Practice Effort = days in a row.** The Practice Effort card on the profile shows your current streak instead of hours. Sundays don't count toward the streak and don't break it, so a day of rest is fully respected.
- **HEIC photo uploads fixed.** Photos straight from the iPhone camera roll now upload to the wall correctly.

## TestFlight / internal testing notes (for me)

- New Firestore collection: `wall_posts`. Composite index and rules deployed already (firebase deploy --only firestore ran 2026-06-10).
- 2.0.0 users will NOT see new wall posts after this release lands — the new wall reads from `wall_posts`, the old one reads pinned `chat_messages`. Force-update prompt is not wired; rely on App Store / Play auto-update.
- R2 bucket CORS must be live before testing photo uploads (see infra/r2-cors.json).

## Marketing / one-liner

The wall, but actually a wall. Long formatted posts, no chat leak, photos that work.
