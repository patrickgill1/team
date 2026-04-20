import React from 'react';
import Header from '../components/common/Header';
import CalendarComponent from '../components/calendar/Calendar';

const CalendarPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header 
        title="Team Calendar" 
        subtitle="View and manage team practices, games, and events"
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <CalendarComponent 
          viewMode="month"
          showCreateButton={true}
        />

        {/* Help Section */}
        <div className="mt-8 bg-white rounded-lg shadow-md p-6">
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