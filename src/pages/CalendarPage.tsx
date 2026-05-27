import React from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '../components/common/Header';
import CalendarComponent from '../components/calendar/Calendar';

const CalendarPage: React.FC = () => {
  // ?view=list — used by the Home page's "Next event" hero so taps open
  // straight into the list view instead of dropping the user into the
  // month grid where they have to find the event again.
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') === 'list' ? 'list' : 'month';
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