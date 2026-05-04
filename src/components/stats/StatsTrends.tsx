import React from 'react';
import { GameStat } from '../../types';

interface StatsTrendsProps {
  stats: GameStat[]; // newest first
  isKeeper?: boolean;
}

function computeStreaks(orderedOldestFirst: GameStat[]): {
  currentGoalStreak: number;
  longestGoalStreak: number;
  currentContribStreak: number;
  longestContribStreak: number;
  currentDryStreak: number;
} {
  let curG = 0;
  let longG = 0;
  let curC = 0;
  let longC = 0;
  let curDry = 0;
  for (const s of orderedOldestFirst) {
    if (s.goals > 0) {
      curG += 1;
      longG = Math.max(longG, curG);
    } else {
      curG = 0;
    }
    const contrib = s.goals + s.assists;
    if (contrib > 0) {
      curC += 1;
      longC = Math.max(longC, curC);
      curDry = 0;
    } else {
      curC = 0;
      curDry += 1;
    }
  }
  return {
    currentGoalStreak: curG,
    longestGoalStreak: longG,
    currentContribStreak: curC,
    longestContribStreak: longC,
    currentDryStreak: curDry,
  };
}

const StatsTrends: React.FC<StatsTrendsProps> = ({ stats, isKeeper = false }) => {
  if (!stats || stats.length === 0) return null;

  // Stats arrive newest-first; sort oldest-first for trend math + chart
  const ordered = [...stats].sort(
    (a, b) =>
      new Date(a.gameDate || a.createdAt).getTime() -
      new Date(b.gameDate || b.createdAt).getTime()
  );

  const recent = stats.slice(0, 5); // newest 5 (newest-first)

  const streaks = computeStreaks(ordered);

  const totalGoals = ordered.reduce((s, x) => s + (x.goals || 0), 0);
  const totalAssists = ordered.reduce((s, x) => s + (x.assists || 0), 0);
  const totalSaves = ordered.reduce((s, x) => s + (x.saves || 0), 0);

  const bestGoals = ordered.reduce((m, x) => Math.max(m, x.goals || 0), 0);
  const bestAssists = ordered.reduce((m, x) => Math.max(m, x.assists || 0), 0);
  const bestSaves = ordered.reduce((m, x) => Math.max(m, x.saves || 0), 0);

  // Sparkline of contributions (goals + assists) per game, oldest -> newest
  const series = ordered.map((s) => (s.goals || 0) + (s.assists || 0));
  const W = 320;
  const H = 80;
  const PAD = 6;
  const max = Math.max(1, ...series);
  const xStep = series.length > 1 ? (W - PAD * 2) / (series.length - 1) : 0;
  const points = series.map((v, i) => {
    const x = PAD + i * xStep;
    const y = H - PAD - (v / max) * (H - PAD * 2);
    return `${x},${y}`;
  });
  const polyline = points.join(' ');
  const areaPath =
    series.length > 1
      ? `M ${PAD},${H - PAD} L ${points.join(' L ')} L ${PAD + (series.length - 1) * xStep},${H - PAD} Z`
      : '';

  const formBadge = (s: GameStat) => {
    const g = s.goals || 0;
    const a = s.assists || 0;
    let bg = 'bg-white/10 text-gray-200';
    let label = '–';
    if (g > 0 && a > 0) {
      bg = 'bg-emerald-500 text-white';
      label = `${g}G ${a}A`;
    } else if (g > 0) {
      bg = 'bg-blue-600 text-white';
      label = `${g}G`;
    } else if (a > 0) {
      bg = 'bg-amber-500 text-white';
      label = `${a}A`;
    }
    return { bg, label };
  };

  return (
    <div className="bg-gray-900/80 rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Trends &amp; streaks</h3>
        <span className="text-xs text-gray-400">
          {ordered.length} game{ordered.length === 1 ? '' : 's'} recorded
        </span>
      </div>

      {/* Recent form */}
      <div className="mb-6">
        <div className="text-sm font-medium text-gray-200 mb-2">Recent form (last 5)</div>
        <div className="flex space-x-2">
          {recent.map((s) => {
            const b = formBadge(s);
            return (
              <div
                key={s.id}
                title={`${s.opponent || 'Game'} • ${s.goals}G ${s.assists}A`}
                className={`px-2 py-1 rounded-md text-xs font-bold ${b.bg}`}
              >
                {b.label}
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, 5 - recent.length) }).map((_, i) => (
            <div
              key={`pad-${i}`}
              className="px-2 py-1 rounded-md text-xs font-bold bg-white/5 text-gray-400"
            >
              –
            </div>
          ))}
        </div>
      </div>

      {/* Sparkline */}
      <div className="mb-6">
        <div className="text-sm font-medium text-gray-200 mb-2">
          Goals + assists per game
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-24"
          preserveAspectRatio="none"
        >
          {areaPath && <path d={areaPath} fill="rgba(37, 99, 235, 0.12)" />}
          <polyline
            points={polyline}
            fill="none"
            stroke="#2563eb"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {series.map((v, i) => {
            const x = PAD + i * xStep;
            const y = H - PAD - (v / max) * (H - PAD * 2);
            return <circle key={i} cx={x} cy={y} r={v > 0 ? 3 : 2} fill={v > 0 ? '#2563eb' : '#9ca3af'} />;
          })}
        </svg>
      </div>

      {/* Streaks grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="text-center bg-blue-50 rounded-lg p-3">
          <div className="text-xs text-gray-300 mb-1">Goal streak</div>
          <div className="text-2xl font-bold text-cyan-200">{streaks.currentGoalStreak}</div>
          <div className="text-[10px] text-gray-400">best {streaks.longestGoalStreak}</div>
        </div>
        <div className="text-center bg-emerald-500/10 rounded-lg p-3">
          <div className="text-xs text-gray-300 mb-1">Contribution streak</div>
          <div className="text-2xl font-bold text-emerald-300">{streaks.currentContribStreak}</div>
          <div className="text-[10px] text-gray-400">best {streaks.longestContribStreak}</div>
        </div>
        <div className="text-center bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-300 mb-1">Dry games</div>
          <div className="text-2xl font-bold text-gray-200">{streaks.currentDryStreak}</div>
          <div className="text-[10px] text-gray-400">since last contrib</div>
        </div>
        <div className="text-center bg-purple-50 rounded-lg p-3">
          <div className="text-xs text-gray-300 mb-1">Avg contribution</div>
          <div className="text-2xl font-bold text-violet-300">
            {(((totalGoals + totalAssists) / ordered.length) || 0).toFixed(2)}
          </div>
          <div className="text-[10px] text-gray-400">per game</div>
        </div>
      </div>

      {/* Personal bests */}
      <div>
        <div className="text-sm font-medium text-gray-200 mb-2">Single-game bests</div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-gray-300">Goals</div>
            <div className="text-lg font-bold text-cyan-200">{bestGoals}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-gray-300">Assists</div>
            <div className="text-lg font-bold text-emerald-300">{bestAssists}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <div className="text-xs text-gray-300">{isKeeper ? 'Saves' : 'Saves'}</div>
            <div className="text-lg font-bold text-violet-300">{bestSaves}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StatsTrends;
