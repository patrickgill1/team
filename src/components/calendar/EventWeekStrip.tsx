import React from 'react';
import { CalendarEvent } from '../../types';

// Inline 7-day strip that sits below the pill filters. Visually breaks
// up the navy canvas + lets you scan "what's this week" at a glance.
// Today is highlighted cyan; days with events get a darker fill and a
// colored dot per event type (game red, practice cyan, event purple).
// Tapping a day scrolls the list to that day's first event.

const DOWS_SHORT = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

interface Props {
  events: CalendarEvent[];
  onDayClick?: (date: Date) => void;
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const EventWeekStrip: React.FC<Props> = ({ events, onDayClick }) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build the next 7 days (today + 6).
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }

  // Index events by ymd → list of event types.
  const byDay: Record<string, Array<'game'|'practice'|'event'>> = {};
  for (const e of events) {
    const d = new Date(e.date);
    const key = ymd(d);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(e.type as any);
  }

  return (
    <div className="px-3.5 py-3 bg-gradient-to-b from-surface-base to-surface-input border-y border-brand-primary/10">
      <div className="grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const key = ymd(d);
          const types = byDay[key] || [];
          const isToday = i === 0;
          const has = types.length > 0;
          const base = 'text-center py-1.5 rounded-md border transition-colors';
          const cls = isToday
            ? `${base} bg-brand-primary/15 border-brand-primary-soft/50 ring-1 ring-brand-primary-soft/20`
            : has
            ? `${base} bg-surface-base/60 border-slate-700/50`
            : `${base} bg-surface-base/40 border-slate-800/50`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onDayClick?.(d)}
              className={cls}
              aria-label={`${DOWS_SHORT[d.getDay()]} ${d.getDate()}`}
            >
              <div className={`text-[8px] font-extrabold tracking-widest ${isToday ? 'text-brand-primary-soft' : 'text-slate-500'}`}>
                {DOWS_SHORT[d.getDay()]}
              </div>
              <div className={`text-[14px] font-black leading-none mt-0.5 ${isToday || has ? 'text-white' : 'text-slate-400'}`}>
                {d.getDate()}
              </div>
              <div className="flex justify-center gap-[3px] mt-1 h-1">
                {types.slice(0, 3).map((t, j) => (
                  <span
                    key={j}
                    className={`w-1 h-1 rounded-full ${
                      t === 'game' ? 'bg-rose-500'
                      : t === 'practice' ? 'bg-brand-primary-soft'
                      : 'bg-purple-500'
                    }`}
                  />
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default EventWeekStrip;
