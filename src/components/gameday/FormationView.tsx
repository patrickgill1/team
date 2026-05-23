// @ts-nocheck
import React, { useMemo } from 'react';

interface Props {
  players: any[];
  /** Player IDs currently on the field. */
  onFieldIds: string[];
}

/**
 * Visual soccer-field rendering of the current on-field lineup.
 * Auto-arranges players into rows based on their declared positions:
 *   - Goalkeeper → 1 player in the back row
 *   - Defender   → middle-back row
 *   - Midfielder → middle row
 *   - Forward / Striker → top row
 * Players with no declared position fall into the midfield row.
 *
 * No drag-drop — for the coach's positional planning + a clean
 * visualization to share pre-game / show parents.
 */
const FormationView: React.FC<Props> = ({ players, onFieldIds }) => {
  const onField = useMemo(
    () => onFieldIds
      .map(id => players.find(p => p.id === id))
      .filter(Boolean),
    [players, onFieldIds]
  );

  // Bucket players by primary position.
  const rows = useMemo(() => {
    const buckets: { keeper: any[]; defenders: any[]; mids: any[]; forwards: any[] } = {
      keeper: [], defenders: [], mids: [], forwards: [],
    };
    for (const p of onField) {
      const positions: string[] = Array.isArray(p.positions) && p.positions.length > 0
        ? p.positions
        : (p.position ? [p.position] : []);
      const primary = (positions[0] || '').toLowerCase();
      if (primary.includes('goalkeeper') || primary === 'gk') buckets.keeper.push(p);
      else if (primary.includes('defender') || primary.includes('back')) buckets.defenders.push(p);
      else if (primary.includes('forward') || primary.includes('striker')) buckets.forwards.push(p);
      else buckets.mids.push(p);
    }
    // If no keeper picked, the most-defensive player floats up.
    if (buckets.keeper.length === 0 && buckets.defenders.length > 0) {
      buckets.keeper.push(buckets.defenders.shift());
    }
    return buckets;
  }, [onField]);

  if (onField.length === 0) {
    return (
      <div className="rounded-2xl bg-emerald-900/40 ring-1 ring-emerald-700/30 p-6 text-center">
        <p className="text-sm text-emerald-200">Sub players onto the field to build the formation.</p>
      </div>
    );
  }

  const Chip: React.FC<{ player: any }> = ({ player }) => (
    <div className="flex flex-col items-center gap-1 max-w-[64px]">
      <div className="relative">
        {player.profilePhotoUrl ? (
          <img
            src={player.profilePhotoUrl}
            alt={player.name}
            className="w-11 h-11 rounded-full object-cover ring-2 ring-white shadow-md"
          />
        ) : (
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-cyan-400 to-blue-700 text-white font-black flex items-center justify-center ring-2 ring-white shadow-md">
            {(player.name || '?').charAt(0)}
          </div>
        )}
        {player.jerseyNumber != null && (
          <span className="absolute -bottom-1 -right-1 px-1 rounded bg-fire-900 text-white text-[9px] font-black ring-2 ring-white tabular-nums">
            #{player.jerseyNumber}
          </span>
        )}
      </div>
      <p className="text-[10px] text-white font-semibold text-center truncate w-full leading-tight">
        {(player.name || 'Player').split(' ')[0]}
      </p>
    </div>
  );

  return (
    <div className="relative rounded-3xl overflow-hidden ring-1 ring-emerald-700/40 shadow-2xl">
      {/* Field — striped gradient + center markings rendered with simple
          absolutely-positioned elements. SVG would be cleaner but adds
          complexity; this is enough to read as a soccer field. */}
      <div className="relative bg-gradient-to-b from-emerald-700 via-emerald-600 to-emerald-700">
        {/* Stripe overlay */}
        <div className="absolute inset-0 opacity-15">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`absolute inset-x-0 h-[12.5%] ${i % 2 === 0 ? 'bg-emerald-800' : ''}`}
              style={{ top: `${i * 12.5}%` }}
            />
          ))}
        </div>
        {/* Center circle + line */}
        <div className="absolute inset-x-0 top-1/2 border-t border-white/30" />
        <div
          className="absolute left-1/2 top-1/2 w-20 h-20 rounded-full border border-white/30"
          style={{ transform: 'translate(-50%, -50%)' }}
        />
        {/* Penalty boxes (top + bottom). */}
        <div className="absolute left-1/2 top-0 w-3/5 h-[15%] border-x border-b border-white/30" style={{ transform: 'translateX(-50%)' }} />
        <div className="absolute left-1/2 bottom-0 w-3/5 h-[15%] border-x border-t border-white/30" style={{ transform: 'translateX(-50%)' }} />

        {/* Rows of player chips. Top of the field = forwards (where we
            attack), bottom = our keeper. */}
        <div className="relative grid grid-rows-4 gap-2 py-5 px-3" style={{ minHeight: 380 }}>
          <Row players={rows.forwards} ChipComponent={Chip} label="Forward" />
          <Row players={rows.mids} ChipComponent={Chip} label="Mid" />
          <Row players={rows.defenders} ChipComponent={Chip} label="Back" />
          <Row players={rows.keeper} ChipComponent={Chip} label="GK" />
        </div>
      </div>
      <div className="bg-emerald-900/60 px-4 py-2 flex items-center justify-between text-xs text-emerald-100">
        <span className="font-semibold">{onField.length} on the field</span>
        <span className="text-emerald-300/80">Auto-arranged from positions</span>
      </div>
    </div>
  );
};

const Row: React.FC<{
  players: any[];
  ChipComponent: React.FC<{ player: any }>;
  label: string;
}> = ({ players, ChipComponent, label }) => {
  if (players.length === 0) {
    return (
      <div className="flex items-center justify-center">
        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-200/40">{label}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-6 flex-wrap">
      {players.map((p) => (
        <ChipComponent key={p.id} player={p} />
      ))}
    </div>
  );
};

export default FormationView;
