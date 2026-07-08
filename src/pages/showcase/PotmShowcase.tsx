import React from 'react';
import PotmWinnerCard from '../../components/wall/PotmWinnerCard';

// Screenshot-ready page: the PotmWinnerCard component rendered with
// hand-curated demo data over a phone-shaped frame so you can
// screenshot the exact tile that appears on real Team Wall posts.
//
// URL: /showcase/potm (public, no auth). Open on your phone, snap,
// save to public/hero/mockups/mockup-potm.png. When Fire FC has a
// real POTM winner, swap for a real screenshot at your leisure.

const PotmShowcase: React.FC = () => {
  const potm = {
    playerId: 'demo-hunter',
    playerName: 'Hunter Gill',
    // Drops a real portrait if you save one at
    // /public/hero/players/hunter.jpg — otherwise the card renders
    // the amber-glow initial fallback. To use a different demo
    // player, either swap the file at that path or edit the URL
    // here.
    playerPhotoUrl: '/hero/players/hunter.jpg',
    voteCount: 12,
    gameTitle: 'Fire FC vs Rovers',
    isCoWin: false,
    gameDate: new Date(),
  };
  const timestamp = new Date();

  return (
    <div className="min-h-screen bg-charcoal-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <ShowcaseKicker>Team Wall · POTM Card</ShowcaseKicker>
        <PotmWinnerCard potm={potm} timestamp={timestamp} />
      </div>
    </div>
  );
};

export const ShowcaseKicker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] font-black tracking-[0.3em] uppercase text-white/40 mb-4 text-center">
    {children}
  </p>
);

export default PotmShowcase;
