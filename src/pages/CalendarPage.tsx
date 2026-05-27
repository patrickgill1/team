import React from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '../components/common/Header';
import CalendarComponent from '../components/calendar/Calendar';

const CalendarPage: React.FC = () => {
  // ?view=month — defaults to list (the right default on every device,
  // since the month grid is too cramped on phones and parents really
  // just want "what's next"). The opt-in ?view=month is left so a
  // desktop bookmark of the grid still works.
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') === 'month' ? 'month' : 'list';
  const focusEventId = searchParams.get('event') || undefined;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Events"
        subtitle="Practices, games, and team events"
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <CalendarComponent
          viewMode={view}
          showCreateButton={true}
          focusEventId={focusEventId}
        />
      </div>
    </div>
  );
};

export default CalendarPage;