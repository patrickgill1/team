import React, { useState } from 'react';
import Header from '../components/common/Header';
import PlayerList from '../components/player/PlayerList';

const Players: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [positionFilter, setPositionFilter] = useState('');

  const positions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'Striker'];

  const hasActiveFilters = !!(searchTerm || positionFilter);
  const clearFilters = () => {
    setSearchTerm('');
    setPositionFilter('');
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <Header title="Players" subtitle="Roster, profiles, and contact info" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {/* Search + filter row — single tactical card matching Events */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search by name or #…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-9 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-700"
                  aria-label="Clear search"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
            <div className="relative">
              <select
                value={positionFilter}
                onChange={(e) => setPositionFilter(e.target.value)}
                className="appearance-none bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              >
                <option value="">All positions</option>
                {positions.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-2 text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <PlayerList searchTerm={searchTerm} positionFilter={positionFilter} />
      </div>
    </div>
  );
};

export default Players;
