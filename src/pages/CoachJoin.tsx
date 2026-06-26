import React from 'react';
import { Link } from 'react-router-dom';

// The legacy coach-invite flow has been retired. New invites all go through
// /join/:inviteId (see InviteJoin.tsx + utils/invites.ts). Old links emailed
// before that change still land here, so we show a clear hint instead of
// the previous broken auto-join loop.
const CoachJoin: React.FC = () => (
  <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center p-4 text-white">
    <div className="bg-charcoal-900/60 backdrop-blur ring-1 ring-white/10 rounded-3xl shadow-2xl w-full max-w-md p-8 text-center">
      <div className="text-5xl mb-3">🔄</div>
      <h1 className="text-xl font-bold mb-2">This invite link is out of date</h1>
      <p className="text-white/70 text-sm mb-6">
        We replaced the old invite system with a faster one. Ask the coach who
        sent you this link to send a new one — the new link will start with
        <span className="font-mono bg-white/10 mx-1 px-1.5 py-0.5 rounded">/join/</span>.
      </p>
      <Link
        to="/auth"
        className="inline-block px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary text-white text-sm font-semibold"
      >
        Go to sign-in
      </Link>
    </div>
  </div>
);

export default CoachJoin;
