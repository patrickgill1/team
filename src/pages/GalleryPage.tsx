import React, { useState, useEffect } from 'react';
import Header from '../components/common/Header';
import GalleryComponent from '../components/gallery/Gallery';

const GalleryPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  // Listen for tag filter events from Gallery component
  useEffect(() => {
    const handleTagFilter = (event: CustomEvent) => {
      setTagFilter(event.detail);
    };

    window.addEventListener('tagFilter', handleTagFilter as EventListener);
    return () => {
      window.removeEventListener('tagFilter', handleTagFilter as EventListener);
    };
  }, []);

  const clearFilters = () => {
    setSearchTerm('');
    setTagFilter('');
  };

  const hasActiveFilters = searchTerm || tagFilter;

  return (
    <div className="min-h-screen">
      <Header 
        title="Team Gallery" 
        subtitle="Share and view team photos and memories"
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Search and Filter Controls */}
        <div className="card-modern p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex flex-col sm:flex-row gap-4 flex-1">
              {/* Search Input */}
              <div className="relative flex-1 md:max-w-md">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search photos by caption or uploader..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                />
                {searchTerm && (
                  <button
                    onClick={() => setSearchTerm('')}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  >
                    <svg className="h-4 w-4 text-gray-400 hover:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Tag Filter Input */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Filter by tag..."
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  className="w-full md:w-48 pl-3 pr-4 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                />
                {tagFilter && (
                  <button
                    onClick={() => setTagFilter('')}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  >
                    <svg className="h-4 w-4 text-gray-400 hover:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Clear Filters Button */}
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-gray-300 hover:text-gray-800 border border-white/15 rounded-lg hover:bg-white/5 transition-colors duration-200 flex items-center space-x-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span>Clear Filters</span>
              </button>
            )}
          </div>

          {/* Active Filters Display */}
          {hasActiveFilters && (
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="text-sm font-medium text-gray-200">Active filters:</span>
              {searchTerm && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-cyan-500/10 text-cyan-300">
                  Search: "{searchTerm}"
                  <button
                    onClick={() => setSearchTerm('')}
                    className="ml-2 text-cyan-300 hover:text-cyan-300"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              {tagFilter && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-emerald-500/20 text-emerald-200">
                  Tag: {tagFilter}
                  <button
                    onClick={() => setTagFilter('')}
                    className="ml-2 text-emerald-300 hover:text-emerald-200"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Gallery Component */}
        <GalleryComponent showUploadButton={true} />

        {/* Photo Upload Tips */}
        <div className="mt-8 card-modern p-6">
          <h3 className="text-lg font-semibold text-white mb-4">📸 Photo Tips</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="text-center p-4 bg-cyan-500/10 rounded-lg">
              <div className="text-2xl mb-2">🏆</div>
              <h4 className="font-medium text-white mb-1">Game Moments</h4>
              <p className="text-sm text-gray-300">Capture goals, celebrations, and team spirit during matches</p>
            </div>
            <div className="text-center p-4 bg-emerald-500/10 rounded-lg">
              <div className="text-2xl mb-2">🏃</div>
              <h4 className="font-medium text-white mb-1">Practice Sessions</h4>
              <p className="text-sm text-gray-300">Document training progress and skill development</p>
            </div>
            <div className="text-center p-4 bg-violet-500/10 rounded-lg">
              <div className="text-2xl mb-2">👨‍👩‍👧‍👦</div>
              <h4 className="font-medium text-white mb-1">Team Bonding</h4>
              <p className="text-sm text-gray-300">Share team events, parties, and fun moments</p>
            </div>
            <div className="text-center p-4 bg-amber-500/10 rounded-lg">
              <div className="text-2xl mb-2">🏅</div>
              <h4 className="font-medium text-white mb-1">Achievements</h4>
              <p className="text-sm text-gray-300">Celebrate wins, awards, and personal milestones</p>
            </div>
          </div>
          <div className="mt-4 text-center">
            <p className="text-sm text-gray-300">
              <strong>Remember:</strong> Keep photos appropriate and focus on positive team moments. 
              Use tags like "practice", "game", "celebration" to help others find photos easily.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GalleryPage;