import React from 'react';
import GameRecapCard from '../../components/wall/GameRecapCard';
import PotmWinnerCard from '../../components/wall/PotmWinnerCard';
import { ShowcaseKicker } from './PotmShowcase';

// Screenshot-ready page: a mini Team Wall showing a mixed feed —
// game recap, POTM crown, tagged clip preview, coach news. Reads as
// "this is what your Wall looks like Monday morning after Saturday's
// game." Use this for the landing's 'For parents' teaser.
//
// URL: /showcase/wall (public, no auth). Snap, save to
// public/hero/mockups/mockup-wall.png.

const WallShowcase: React.FC = () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

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
    gameDate: yesterday,
  };

  const potm = {
    playerId: 'demo-hunter',
    playerName: 'Hunter Gill',
    playerPhotoUrl: null,
    voteCount: 12,
    gameTitle: 'Fire FC vs Rovers',
    isCoWin: false,
    gameDate: yesterday,
  };

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Wall header — mirrors the real /wall page chrome so the
          screenshot reads as a real page, not a floating card. */}
      <section className="bg-surface-base px-4 sm:px-6 py-3 border-b border-line-default/5">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-2">
          <div className="w-8 h-8 rounded-full bg-line-default/10" aria-hidden />
          <h1 className="text-base sm:text-lg font-black text-ink-primary flex items-center gap-1.5">
            <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M3 10h5m10-6v6"/></svg>
            <span className="tracking-tight">Team Wall</span>
          </h1>
          <button className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-extrabold uppercase tracking-widest shadow-sm">
            + Post
          </button>
        </div>
      </section>

      {/* Filter pills */}
      <div className="sticky top-0 z-20 bg-surface-base/95 backdrop-blur-md border-b border-line-default/10">
        <div className="max-w-2xl mx-auto px-3 py-2 flex flex-wrap items-center justify-center gap-1.5">
          {['Feed', 'Media', 'Recaps', 'Awards', 'News'].map((c, i) => (
            <span
              key={c}
              className={`px-3.5 py-1.5 rounded-full text-[12px] font-extrabold uppercase tracking-widest ${
                i === 0 ? 'bg-surface-raised text-ink-primary' : 'bg-line-default/[0.06] text-ink-primary/65 ring-1 ring-line-default/10'
              }`}
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="max-w-2xl mx-auto px-3 py-4 space-y-3">
        <ShowcaseKicker>Team Wall · Feed</ShowcaseKicker>

        {/* Recap card */}
        <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
          <PostHeader senderName="Coach Patrick" timestamp={yesterday} tone="brand" tag="Recap" />
          <div className="px-3 pb-3">
            <GameRecapCard recap={recap} timestamp={yesterday} />
          </div>
          <QuickReacts likes={4} fire={2} />
        </div>

        {/* POTM winner card */}
        <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
          <PostHeader senderName="Coach Patrick" timestamp={yesterday} tone="amber" tag="Awards" />
          <div className="px-3 pb-3">
            <PotmWinnerCard potm={potm} timestamp={yesterday} />
          </div>
          <QuickReacts likes={9} fire={5} clap={3} />
        </div>

        {/* Coach news post */}
        <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10">
          <PostHeader senderName="Coach Patrick" timestamp={twoDaysAgo} tone="cyan" tag="News" />
          <article className="px-4 pb-3 text-ink-primary/90 text-[15.5px] leading-relaxed">
            <h3 className="font-black text-ink-primary mb-1">Big Saturday, team.</h3>
            <p>
              Kits are red at home. Arrive by 10:15 for a proper warm-up. Bring water and a snack for after. Let's play the ball on the floor and enjoy it.
            </p>
          </article>
          <QuickReacts likes={7} clap={4} />
        </div>
      </div>
    </div>
  );
};

const PostHeader: React.FC<{ senderName: string; timestamp: Date; tone: 'brand' | 'amber' | 'cyan'; tag: string }> = ({ senderName, timestamp, tone, tag }) => {
  const tones = {
    brand: 'text-brand-primary-soft bg-brand-primary/15 ring-brand-primary-soft/30',
    amber: 'text-amber-300 bg-amber-500/15 ring-amber-400/30',
    cyan: 'text-brand-primary-soft bg-brand-primary/15 ring-brand-primary-soft/30',
  }[tone];
  return (
    <div className="px-4 py-3 flex items-center gap-2">
      <div className="w-8 h-8 rounded-full bg-line-default/10 flex items-center justify-center flex-shrink-0">
        <span className="text-[11px] font-black text-ink-primary/70">{senderName.split(' ').map(s => s[0]).join('').slice(0, 2)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-ink-primary truncate">{senderName}</p>
        <p className="text-[10px] text-ink-primary/45">{timestamp.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
      </div>
      <span className={`text-[10px] font-black tracking-widest uppercase px-2 py-0.5 rounded ring-1 ${tones}`}>
        {tag}
      </span>
    </div>
  );
};

const QuickReacts: React.FC<{ likes?: number; fire?: number; clap?: number }> = ({ likes = 0, fire = 0, clap = 0 }) => (
  <div className="px-4 pt-3 pb-3 flex items-center gap-1.5 text-[12px] text-ink-primary/50 border-t border-line-default/5">
    {likes > 0 && <ReactChip emoji="❤️" count={likes} />}
    {fire > 0 && <ReactChip emoji="🔥" count={fire} />}
    {clap > 0 && <ReactChip emoji="👏" count={clap} />}
  </div>
);

const ReactChip: React.FC<{ emoji: string; count: number }> = ({ emoji, count }) => (
  <span className="inline-flex items-center gap-1 rounded-full bg-line-default/[0.04] ring-1 ring-line-default/10 text-ink-primary/85 px-2 py-0.5">
    <span className="text-sm leading-none">{emoji}</span>
    <span className="font-semibold tabular-nums">{count}</span>
  </span>
);

export default WallShowcase;
