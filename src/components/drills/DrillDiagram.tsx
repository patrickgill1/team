import React from 'react';
import { DrillDiagramSpec } from '../../types';

// Deterministic SVG renderer for the drill scene graph. The AI (or a
// coach) supplies structured data; this file owns every pixel of the
// output so every diagram in the library has the same look.
//
// Coordinate system: input is 0..100 in both x and y (top-left origin).
// The internal viewBox is 400x240 (matches aspect-video). We pad the
// interior by INSET to keep pieces off the border.

const VB_W = 400;
const VB_H = 240;
const INSET = 12;

// Field greens tuned to work on both light and dark surface tokens.
// Not the raw pitch green, softened so text overlays still read.
const FIELD_FILL = '#194f37';
const FIELD_LINE = 'rgba(255,255,255,0.35)';

// Team colors keep the same hue as elsewhere in the app: cyan =
// primary/attack, red = defense, amber = neutral, lime = keeper.
const TEAM_COLORS: Record<string, string> = {
  attack: '#22d3ee',
  defense: '#f43f5e',
  neutral: '#fbbf24',
  keeper: '#84cc16',
};

const CONE_COLORS: Record<string, string> = {
  orange: '#fb923c',
  yellow: '#facc15',
  red: '#ef4444',
  blue: '#3b82f6',
};

const px = (v: number) => Math.round((v / 100) * (VB_W - INSET * 2) + INSET);
const py = (v: number) => Math.round((v / 100) * (VB_H - INSET * 2) + INSET);

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

const Field: React.FC<{ kind: DrillDiagramSpec['field'] }> = ({ kind }) => {
  const boundary = (
    <rect
      x={INSET}
      y={INSET}
      width={VB_W - INSET * 2}
      height={VB_H - INSET * 2}
      fill={FIELD_FILL}
      stroke={FIELD_LINE}
      strokeWidth={1.5}
      rx={6}
    />
  );

  if (kind === 'none') return boundary;

  if (kind === 'grid') {
    // Grid: dashed inner box only. Cones will land at corners.
    return (
      <>
        {boundary}
        <rect
          x={INSET + 24}
          y={INSET + 24}
          width={VB_W - INSET * 2 - 48}
          height={VB_H - INSET * 2 - 48}
          fill="none"
          stroke={FIELD_LINE}
          strokeWidth={1}
          strokeDasharray="4 4"
          rx={3}
        />
      </>
    );
  }

  if (kind === 'circle') {
    // Big dashed ring in the middle for rondos, king-of-the-ring,
    // juggling circles, tick-tack etc. Radius sized to leave a
    // margin so player dots on the perimeter don't touch the box.
    const cx = VB_W / 2;
    const cy = VB_H / 2;
    const r = Math.min(VB_W, VB_H) / 2 - INSET - 14;
    return (
      <>
        {boundary}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={FIELD_LINE}
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
      </>
    );
  }

  if (kind === 'half') {
    // Half pitch: goal top, half line bottom, penalty box top.
    return (
      <>
        {boundary}
        <line
          x1={INSET}
          x2={VB_W - INSET}
          y1={VB_H - INSET}
          y2={VB_H - INSET}
          stroke={FIELD_LINE}
          strokeWidth={1}
        />
        <rect
          x={VB_W / 2 - 60}
          y={INSET}
          width={120}
          height={44}
          fill="none"
          stroke={FIELD_LINE}
          strokeWidth={1}
        />
        <rect
          x={VB_W / 2 - 30}
          y={INSET}
          width={60}
          height={20}
          fill="none"
          stroke={FIELD_LINE}
          strokeWidth={1}
        />
      </>
    );
  }

  // full pitch
  return (
    <>
      {boundary}
      <line
        x1={INSET}
        x2={VB_W - INSET}
        y1={VB_H / 2}
        y2={VB_H / 2}
        stroke={FIELD_LINE}
        strokeWidth={1}
      />
      <circle
        cx={VB_W / 2}
        cy={VB_H / 2}
        r={22}
        fill="none"
        stroke={FIELD_LINE}
        strokeWidth={1}
      />
      <rect
        x={VB_W / 2 - 50}
        y={INSET}
        width={100}
        height={30}
        fill="none"
        stroke={FIELD_LINE}
        strokeWidth={1}
      />
      <rect
        x={VB_W / 2 - 50}
        y={VB_H - INSET - 30}
        width={100}
        height={30}
        fill="none"
        stroke={FIELD_LINE}
        strokeWidth={1}
      />
    </>
  );
};

const Cone: React.FC<{ x: number; y: number; color?: string }> = ({ x, y, color }) => {
  const cx = px(clamp(x));
  const cy = py(clamp(y));
  const size = 6;
  const fill = CONE_COLORS[color || 'orange'] || CONE_COLORS.orange;
  return (
    <polygon
      points={`${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`}
      fill={fill}
      stroke="rgba(0,0,0,0.35)"
      strokeWidth={0.75}
    />
  );
};

const Player: React.FC<{ x: number; y: number; team: string; label?: string }> = ({ x, y, team, label }) => {
  const cx = px(clamp(x));
  const cy = py(clamp(y));
  const fill = TEAM_COLORS[team] || TEAM_COLORS.attack;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={9}
        fill={fill}
        stroke="rgba(0,0,0,0.5)"
        strokeWidth={1}
      />
      {label && (
        <text
          x={cx}
          y={cy + 3}
          textAnchor="middle"
          fontSize={9}
          fontWeight={800}
          fill="#0b1120"
          fontFamily="system-ui,-apple-system,sans-serif"
        >
          {label.slice(0, 2)}
        </text>
      )}
    </g>
  );
};

const Ball: React.FC<{ x: number; y: number }> = ({ x, y }) => {
  const cx = px(clamp(x));
  const cy = py(clamp(y));
  return (
    <circle cx={cx} cy={cy} r={3.5} fill="#fff" stroke="#0b1120" strokeWidth={1.25} />
  );
};

const Goal: React.FC<{ x: number; y: number; orientation: 'n' | 's' | 'e' | 'w' }> = ({ x, y, orientation }) => {
  const cx = px(clamp(x));
  const cy = py(clamp(y));
  // Draw as a small rectangle with the "mouth" open on the given side.
  const w = orientation === 'n' || orientation === 's' ? 22 : 6;
  const h = orientation === 'n' || orientation === 's' ? 6 : 22;
  return (
    <rect
      x={cx - w / 2}
      y={cy - h / 2}
      width={w}
      height={h}
      fill="rgba(255,255,255,0.75)"
      stroke="rgba(0,0,0,0.6)"
      strokeWidth={1}
    />
  );
};

const Movement: React.FC<{
  from: { x: number; y: number };
  to: { x: number; y: number };
  type: 'run' | 'pass' | 'dribble' | 'shot';
  label?: string;
  id: string;
}> = ({ from, to, type, label, id }) => {
  const x1 = px(clamp(from.x));
  const y1 = py(clamp(from.y));
  const x2 = px(clamp(to.x));
  const y2 = py(clamp(to.y));

  const stroke = type === 'shot' ? '#facc15' : type === 'pass' ? '#f8fafc' : '#e2e8f0';
  const dashArray = type === 'pass' ? '4 3' : type === 'dribble' ? '2 2' : undefined;
  const strokeWidth = type === 'shot' ? 2.25 : 1.5;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  return (
    <g>
      <defs>
        <marker
          id={`arrow-${id}`}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={stroke} />
        </marker>
      </defs>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArray}
        strokeLinecap="round"
        markerEnd={`url(#arrow-${id})`}
      />
      {label && (
        <g>
          <rect
            x={midX - 8}
            y={midY - 7}
            width={16}
            height={13}
            rx={3}
            fill="rgba(11,17,32,0.85)"
          />
          <text
            x={midX}
            y={midY + 3}
            textAnchor="middle"
            fontSize={8}
            fontWeight={800}
            fill="#fff"
            fontFamily="system-ui,-apple-system,sans-serif"
          >
            {label.slice(0, 3)}
          </text>
        </g>
      )}
    </g>
  );
};

// Public component.
const DrillDiagram: React.FC<{
  spec: DrillDiagramSpec;
  className?: string;
  /** When true, wraps the SVG in a rounded-2xl card w/ caption strip.
   *  Used by the preview sheet. LibraryCard passes false to keep the
   *  chrome minimal on the tile. */
  standalone?: boolean;
}> = ({ spec, className, standalone = false }) => {
  const svg = (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className={className || 'w-full h-full'}
      role="img"
      aria-label="Drill diagram"
    >
      <Field kind={spec.field} />
      {(spec.goals || []).map((g, i) => (
        <Goal key={`g-${i}`} x={g.x} y={g.y} orientation={g.orientation} />
      ))}
      {(spec.cones || []).map((c, i) => (
        <Cone key={`c-${i}`} x={c.x} y={c.y} color={c.color} />
      ))}
      {(spec.movements || []).map((m, i) => (
        <Movement key={`m-${i}`} id={String(i)} from={m.from} to={m.to} type={m.type} label={m.label} />
      ))}
      {(spec.players || []).map((p, i) => (
        <Player key={`p-${i}`} x={p.x} y={p.y} team={p.team} label={p.label} />
      ))}
      {(spec.balls || []).map((b, i) => (
        <Ball key={`b-${i}`} x={b.x} y={b.y} />
      ))}
    </svg>
  );

  if (!standalone) return svg;

  return (
    <div className="rounded-2xl overflow-hidden ring-1 ring-line-default/10 bg-black/20">
      <div className="aspect-video w-full">{svg}</div>
      {spec.caption && (
        <p className="px-3 py-2 text-[10px] font-bold tracking-wider uppercase text-ink-primary/60 border-t border-line-default/10">
          {spec.caption}
        </p>
      )}
    </div>
  );
};

export default DrillDiagram;
