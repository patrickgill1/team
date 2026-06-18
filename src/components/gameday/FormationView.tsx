// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GameFormat } from '../../types';

interface Props {
  players: any[];
  /** Player IDs currently on the field. */
  onFieldIds: string[];
  /** Optional per-player {x, y} position as % of field (0-100). When
   *  missing, auto-arranged from format + role. */
  positions?: Record<string, { x: number; y: number }>;
  /** Match format — sizes the field + drives default formation. */
  format?: GameFormat;
  /** Called when the user drops a chip — receives the new {x, y} for
   *  that player as percentages of field width/height. */
  onMove?: (playerId: string, x: number, y: number) => void;
}

// Default formations: position % {x, y} per slot index, where index 0
// is the goalkeeper (closest to "home" goal at bottom of field).
const DEFAULTS: Record<GameFormat, { x: number; y: number }[]> = {
  '7v7': [
    { x: 50, y: 88 }, // GK
    { x: 28, y: 70 }, { x: 72, y: 70 }, // 2 backs
    { x: 22, y: 50 }, { x: 50, y: 50 }, { x: 78, y: 50 }, // 3 mids
    { x: 50, y: 25 }, // forward
  ],
  '9v9': [
    { x: 50, y: 90 }, // GK
    { x: 20, y: 73 }, { x: 50, y: 73 }, { x: 80, y: 73 }, // 3 backs
    { x: 25, y: 50 }, { x: 50, y: 50 }, { x: 75, y: 50 }, // 3 mids
    { x: 35, y: 22 }, { x: 65, y: 22 }, // 2 forwards
  ],
  '11v11': [
    { x: 50, y: 92 }, // GK
    { x: 15, y: 75 }, { x: 38, y: 75 }, { x: 62, y: 75 }, { x: 85, y: 75 }, // 4 backs
    { x: 25, y: 52 }, { x: 50, y: 52 }, { x: 75, y: 52 }, // 3 mids
    { x: 22, y: 22 }, { x: 50, y: 22 }, { x: 78, y: 22 }, // 3 forwards
  ],
};

const FIELD_RATIO: Record<GameFormat, string> = {
  '7v7': '5 / 7',   // shorter, narrower
  '9v9': '5 / 7.5',
  '11v11': '2 / 3', // standard
};

/**
 * Interactive soccer-field rendering of the on-field lineup. Players
 * default to a slot from the format-appropriate template, sorted by
 * primary position (GK at the bottom, forwards at the top). Drag any
 * circle to reposition it — change persists via onMove.
 */
const FormationView: React.FC<Props> = ({ players, onFieldIds, positions = {}, format = '7v7', onMove }) => {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Live x/y during a drag (% of field) — flushed to onMove on release.
  const [dragXY, setDragXY] = useState<{ x: number; y: number } | null>(null);

  const onField = useMemo(
    () => onFieldIds.map(id => players.find(p => p.id === id)).filter(Boolean),
    [players, onFieldIds]
  );

  // Order on-field players by role so the auto-slot template assigns
  // GK to the deepest slot, forwards to the top, etc.
  const rolePriority = (p: any): number => {
    const positions: string[] = Array.isArray(p.positions) && p.positions.length > 0
      ? p.positions
      : (p.position ? [p.position] : []);
    const primary = (positions[0] || '').toLowerCase();
    if (primary.includes('goalkeeper') || primary === 'gk') return 0;
    if (primary.includes('defender') || primary.includes('back')) return 1;
    if (primary.includes('midfielder') || primary === 'mid') return 2;
    if (primary.includes('forward') || primary.includes('striker') || primary.includes('winger')) return 3;
    return 2; // unknown → midfield
  };
  const ordered = useMemo(() => [...onField].sort((a, b) => rolePriority(a) - rolePriority(b)), [onField]);

  // Resolve each player's final position: explicit > template slot.
  const finalPositions = useMemo(() => {
    const slots = DEFAULTS[format] || DEFAULTS['7v7'];
    const out: Record<string, { x: number; y: number }> = {};
    ordered.forEach((p, idx) => {
      if (positions[p.id]) {
        out[p.id] = positions[p.id];
      } else {
        out[p.id] = slots[idx] || slots[slots.length - 1] || { x: 50, y: 50 };
      }
    });
    return out;
  }, [ordered, positions, format]);

  // Pointer drag handlers. Track movement as % of the field's bbox so
  // the persisted positions scale across screen sizes.
  useEffect(() => {
    if (!draggingId) return;
    const handleMove = (e: PointerEvent) => {
      const field = fieldRef.current;
      if (!field) return;
      const rect = field.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setDragXY({
        x: Math.max(4, Math.min(96, x)),
        y: Math.max(4, Math.min(96, y)),
      });
    };
    const handleUp = () => {
      if (draggingId && dragXY && onMove) onMove(draggingId, dragXY.x, dragXY.y);
      setDraggingId(null);
      setDragXY(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [draggingId, dragXY, onMove]);

  if (onField.length === 0) {
    return (
      <div className="rounded-2xl bg-emerald-900/40 ring-1 ring-emerald-700/30 p-6 text-center">
        <p className="text-sm text-emerald-200">Sub players onto the field to build the formation.</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl overflow-hidden ring-1 ring-emerald-700/40 shadow-2xl">
      <div
        ref={fieldRef}
        className="relative bg-gradient-to-b from-emerald-700 via-emerald-600 to-emerald-700 select-none"
        style={{ aspectRatio: FIELD_RATIO[format], touchAction: 'none' }}
      >
        {/* Stripe overlay */}
        <div className="absolute inset-0 opacity-15 pointer-events-none">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`absolute inset-x-0 h-[12.5%] ${i % 2 === 0 ? 'bg-emerald-800' : ''}`}
              style={{ top: `${i * 12.5}%` }}
            />
          ))}
        </div>
        {/* Center line + circle */}
        <div className="absolute inset-x-0 top-1/2 border-t border-white/30 pointer-events-none" />
        <div
          className="absolute left-1/2 top-1/2 w-[20%] aspect-square rounded-full border border-white/30 pointer-events-none"
          style={{ transform: 'translate(-50%, -50%)' }}
        />
        {/* Penalty boxes */}
        <div
          className="absolute left-1/2 top-0 w-3/5 h-[14%] border-x border-b border-white/30 pointer-events-none"
          style={{ transform: 'translateX(-50%)' }}
        />
        <div
          className="absolute left-1/2 bottom-0 w-3/5 h-[14%] border-x border-t border-white/30 pointer-events-none"
          style={{ transform: 'translateX(-50%)' }}
        />

        {/* Player chips */}
        {ordered.map((p) => {
          const pos = draggingId === p.id && dragXY ? dragXY : finalPositions[p.id];
          if (!pos) return null;
          const isDragging = draggingId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingId(p.id);
                setDragXY(pos);
                // Capture so we keep receiving move events even if the
                // pointer leaves the button's bounds.
                try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
              }}
              className={`absolute flex flex-col items-center gap-1 transition-transform ${
                isDragging ? 'z-20 scale-110' : 'z-10'
              }`}
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                transform: 'translate(-50%, -50%)',
                cursor: 'grab',
                touchAction: 'none',
              }}
            >
              <div className="relative">
                {p.profilePhotoUrl ? (
                  <img
                    src={p.profilePhotoUrl}
                    alt={p.name}
                    draggable={false}
                    className="w-11 h-11 rounded-full object-cover ring-2 ring-white shadow-md pointer-events-none"
                  />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-gradient-to-br from-cyan-400 to-blue-700 text-white font-black flex items-center justify-center ring-2 ring-white shadow-md pointer-events-none">
                    {(p.name || '?').charAt(0)}
                  </div>
                )}
                {p.jerseyNumber != null && (
                  <span className="absolute -bottom-1 -right-1 px-1 rounded bg-fire-900 text-white text-[9px] font-black ring-2 ring-white tabular-nums pointer-events-none">
                    #{p.jerseyNumber}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-white font-semibold text-center truncate max-w-[64px] leading-tight pointer-events-none bg-black/30 px-1 rounded">
                {(p.name || 'Player').split(' ')[0]}
              </p>
            </button>
          );
        })}
      </div>
      <div className="bg-emerald-900/60 px-4 py-2 flex items-center justify-between text-xs text-emerald-100">
        <span className="font-semibold">{onField.length} on the field · {format}</span>
        <span className="text-emerald-300/80">Drag to reposition</span>
      </div>
    </div>
  );
};

export default FormationView;
