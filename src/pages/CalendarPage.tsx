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
        title="Team Calendar"
        subtitle="View and manage team practices, games, and events"
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <CalendarComponent
          viewMode={view}
          showCreateButton={true}
          focusEventId={focusEventId}
        />

        {/* Help Section */}
        <div className="mt-8 card-modern p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Calendar Help</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-3xl mb-2">⚽</div>
              <h4 className="font-medium text-gray-900 mb-1">Games</h4>
              <p className="text-sm text-gray-600">
                Competitive matches against other teams. Check location and time details.
              </p>
            </div>
            <div className="text-center">
              <div className="text-3xl mb-2">🏃</div>
              <h4 className="font-medium text-gray-900 mb-1">Practices</h4>
              <p className="text-sm text-gray-600">
                Regular team training sessions. Don't forget your gear and water bottle!
              </p>
            </div>
            <div className="text-center">
              <div className="text-3xl mb-2">📅</div>
              <h4 className="font-medium text-gray-900 mb-1">Team Events</h4>
              <p className="text-sm text-gray-600">
                Team parties, award ceremonies, and other special occasions.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CalendarPage;