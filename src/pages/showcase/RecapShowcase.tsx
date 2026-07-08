import React from 'react';
import GameRecapCard from '../../components/wall/GameRecapCard';
import { ShowcaseKicker } from './PotmShowcase';

// Screenshot-ready page: the GameRecapCard component rendered with
// hand-curated demo data. This is the sports-page hero that auto-
// posts to Team Wall when a GameDay session hits status='final'.
//
// URL: /showcase/recap (public, no auth). Snap, save to
// public/hero/mockups/mockup-recap.png.

const RecapShowcase: React.FC = () => {
  const recap = {
    eventId: 'demo-recap',
    gameId: 'demo-recap',
    ourScore: 3,
    opponentScore: 1,
    ourName: 'Fire FC',
    opponent: 'Rovers',
    homeAway: 'home' as const,
    outcome: 'W' as const,
    scorers: [
      { name: 'Hunter', count: 2 },
      { name: 'Kian', count: 1 },
    ],
    assists: [
      { name: 'Sig', count: 2 },
      { name: 'Kian', count: 1 },
    ],
    homeKitColor: 'Red',
    awayKitColor: 'Blue',
    gameDate: new Date(),
  };
  const timestamp = new Date();

  return (
    <div className="min-h-screen bg-charcoal-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <ShowcaseKicker>Team Wall · Game Recap Card</ShowcaseKicker>
        <GameRecapCard recap={recap} timestamp={timestamp} />
      </div>
    </div>
  );
};

export default RecapShowcase;
