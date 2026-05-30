import React, { useState } from 'react';
import Header from '../components/common/Header';
import NewsList from '../components/news/NewsList';

const News: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');

  const clearSearch = () => {
    setSearchTerm('');
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <Header 
        title="Team News" 
        subtitle="Stay updated with the latest team announcements and updates"
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Search Bar */}
        <div className="card-modern p-6 mb-6">
          <div className="flex items-center space-x-4">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search news articles..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-lg"
              />
              {searchTerm && (
                <button
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  <svg className="h-5 w-5 text-gray-400 hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Search Results Info */}
          {searchTerm && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Searching for: <span className="font-medium">"{searchTerm}"</span>
              </p>
              <button
                onClick={clearSearch}
                className="text-sm text-cyan-600 hover:text-cyan-700 font-medium"
              >
                Clear search
              </button>
            </div>
          )}
        </div>

        {/* News List */}
        <NewsList 
          searchTerm={searchTerm}
          showCreateButton={true}
        />

        {/* Help Text for Empty State */}
        {!searchTerm && (
          <div className="mt-8 text-center">
            <div className="bg-cyan-50 rounded-lg p-6 border border-cyan-100">
              <div className="text-cyan-600 mb-2">
                <svg className="mx-auto h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-cyan-900 mb-2">Stay Connected</h3>
              <p className="text-cyan-700 text-sm">
                This is your team's news hub. Coaches can share updates, announcements, 
                and important information. Parents can stay informed about everything 
                happening with the team.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default News;