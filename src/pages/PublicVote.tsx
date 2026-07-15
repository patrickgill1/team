import React from 'react';
import { Link } from 'react-router-dom';

// PublicVote — deprecated 2026-07-14. Patrick killed the public
// /vote/:votingId share affordance: families are 100% in the app
// now, and the public route was a legacy Ollie-era hangover that
// invited voting from outside the team's own community. Voting is
// app-only. This landing replaces the interactive ballot with a
// "moved into the app" nudge so legacy links (still in old texts
// and emails) don't 404 or leak the voting to strangers — they
// see a clear "open the app to vote" instead.
//
// Route is retained in App.tsx (/vote/:votingId → PublicVote) so
// old links resolve to this page rather than a hard 404. Zero
// data-access from this component; the voting id is intentionally
// not looked up (no leaking gameTitle / eligible roster).

const PublicVote: React.FC = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-400 text-slate-950">
          <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
          </svg>
        </div>
        <h1 className="text-2xl sm:text-3xl font-black text-ink-primary leading-tight">
          Voting is in the app now.
        </h1>
        <p className="mt-3 text-[15px] text-ink-primary/70 leading-snug">
          Open GoalKickr on your phone and head to the Team Wall to cast your vote.
          You'll see the ballot right there.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-stretch justify-center gap-3">
          <a
            href="https://apps.apple.com/app/id6770324158"
            className="inline-flex items-center justify-center px-5 py-3 rounded-full bg-ink-primary text-surface-base font-bold text-sm hover:opacity-90 transition"
          >
            Get GoalKickr on iPhone
          </a>
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center px-5 py-3 rounded-full bg-surface-elevated ring-1 ring-line-default/15 text-ink-primary font-bold text-sm hover:bg-surface-input transition"
          >
            I have the app
          </Link>
        </div>
        <p className="mt-8 text-[11px] text-ink-primary/40">
          If you're on Android, open <span className="font-mono">app.goalkickr.com</span> in your browser.
        </p>
      </div>
    </div>
  );
};

export default PublicVote;
