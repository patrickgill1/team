import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CalendarComponent from '../components/calendar/Calendar';

const CalendarPage: React.FC = () => {
  // ?view=month — defaults to list (the right default on every device,
  // since the month grid is too cramped on phones and parents really
  // just want "what's next"). The opt-in ?view=month is left so a
  // desktop bookmark of the grid still works.
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') === 'month' ? 'month' : 'list';
  const focusEventId = searchParams.get('event') || undefined;

  // No outer Header here — the Events list owns its own navy header
  // bar so the whole page reads as one continuous surface (no
  // "window inside a window" effect on the list view). Month-grid
  // visitors will still see a normal page; the inner component
  // controls its own chrome.
  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base">
      <CalendarComponent
        viewMode={view}
        showCreateButton={true}
        focusEventId={focusEventId}
      />
    </div>
  );
};

export default CalendarPage;
