// HiddenDashboardCardsSection — Settings surface that lets a user
// un-hide any dashboard card they previously dismissed. Reads the
// same `gk.dismissedCards` localStorage map that useDismissible
// writes; subscribes to the `gk:dismissed-cards-changed` event so
// changes reflect live without a page reload.
//
// Per the design contract: empty state hides the entire section
// (density rule). Soft-cap at 20 rows sorted by most-recently
// dismissed; more collapse behind a "N more" expander.

import React, { useEffect, useMemo, useState } from 'react';
import {
  DISMISSED_CARDS_CHANGE_EVENT,
  labelForDismissibleKey,
  readAndPruneDismissedMap,
  type DismissedMap,
} from '../../hooks/useDismissible';

const SOFT_CAP = 20;

function formatSnoozeUntil(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  try {
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch {
    return d.toDateString();
  }
}

function useLiveDismissedMap(): DismissedMap {
  const [map, setMap] = useState<DismissedMap>(() => readAndPruneDismissedMap());
  useEffect(() => {
    const refresh = () => setMap(readAndPruneDismissedMap());
    if (typeof window === 'undefined') return;
    window.addEventListener(DISMISSED_CARDS_CHANGE_EVENT, refresh);
    // Also refresh on mount to catch prunes that ran since our first read.
    refresh();
    return () => window.removeEventListener(DISMISSED_CARDS_CHANGE_EVENT, refresh);
  }, []);
  return map;
}

const HiddenDashboardCardsSection: React.FC = () => {
  const map = useLiveDismissedMap();
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    const entries = Object.entries(map)
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => (b.snoozedAtMs || 0) - (a.snoozedAtMs || 0));
    return entries;
  }, [map]);

  const showNow = (key: string) => {
    try {
      if (typeof window === 'undefined') return;
      const raw = window.localStorage.getItem('gk.dismissedCards');
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && parsed[key]) {
        delete parsed[key];
        window.localStorage.setItem('gk.dismissedCards', JSON.stringify(parsed));
        window.dispatchEvent(new Event(DISMISSED_CARDS_CHANGE_EVENT));
      }
    } catch { /* ignore */ }
  };

  // Density rule: nothing to show, nothing rendered.
  if (rows.length === 0) return null;

  const visible = expanded ? rows : rows.slice(0, SOFT_CAP);
  const overflow = rows.length - visible.length;

  return (
    <section>
      <h2 className="text-2xl font-bold text-ink-primary mb-2 px-1">Hidden dashboard cards</h2>
      <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm overflow-hidden divide-y divide-line-default/5">
        {visible.map((row) => (
          <div key={row.key} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-primary truncate">{labelForDismissibleKey(row.key)}</p>
              <p className="text-xs text-ink-primary/55 mt-0.5">
                Hidden until {formatSnoozeUntil(row.snoozeUntilMs)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => showNow(row.key)}
              className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-md text-brand-primary hover:bg-brand-primary/10 transition"
            >
              Show now
            </button>
          </div>
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-center text-xs font-bold text-ink-primary/60 hover:text-ink-primary py-2.5 hover:bg-line-default/5 transition"
          >
            Show {overflow} more
          </button>
        )}
      </div>
    </section>
  );
};

export default HiddenDashboardCardsSection;
