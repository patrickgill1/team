import React from 'react';
import SkyHeader from '../components/common/SkyHeader';

// Dev-only preview page for the dashboard SkyHeader band. Visit
// /_sky-preview to see every phase stacked. Not linked anywhere in
// the app — delete this route once we've locked in the design.

const PHASES: Array<{ hour: number; label: string }> = [
  { hour: 3, label: '3:00 AM — Late night' },
  { hour: 6, label: '6:00 AM — Pre-dawn' },
  { hour: 9, label: '9:00 AM — Morning' },
  { hour: 12.5, label: '12:30 PM — Midday' },
  { hour: 15.5, label: '3:30 PM — Afternoon' },
  { hour: 18, label: '6:00 PM — Golden hour' },
  { hour: 19.75, label: '7:45 PM — Sunset' },
  { hour: 21, label: '9:00 PM — Dusk' },
  { hour: 23, label: '11:00 PM — Night' },
];

const SkyPreview: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="text-center">
          <h1 className="text-xl font-bold text-slate-900">SkyHeader phases</h1>
          <p className="text-sm text-slate-600 mt-1">
            Preview every time-of-day variant without waiting 24 hours.
          </p>
        </header>
        {PHASES.map((p) => (
          <div key={p.hour} className="rounded-2xl overflow-hidden shadow ring-1 ring-slate-200 bg-white">
            <SkyHeader hourOverride={p.hour} />
            <div className="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wide">
              {p.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SkyPreview;
