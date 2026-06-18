import React, { useState } from 'react';
import Header from '../components/common/Header';
import PlayerList from '../components/player/PlayerList';
import ImportPlayersModal, { ParsedPlayer } from '../components/player/ImportPlayersModal';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';

const Players: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { addDocument } = useFirestore();
  const isUserCoach = userData ? isCoach(userData.role) : false;

  const positions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'Striker'];

  const hasActiveFilters = !!(searchTerm || positionFilter);
  const clearFilters = () => {
    setSearchTerm('');
    setPositionFilter('');
  };

  // Per-row handler the import modal calls. Keeps Firestore writes
  // here so the modal stays UI-only. Each row becomes a player doc on
  // the active team; parent emails are stored lowercase so the parent-
  // auto-link path on signup matches.
  const handleImportRow = async (row: ParsedPlayer) => {
    if (!selectedTeamId) throw new Error('No active team');
    const playerData: any = {
      name: row.name,
      firstName: row.firstName,
      lastName: row.lastName,
      teamId: selectedTeamId,
      teamIds: [selectedTeamId],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userData?.uid || null,
      parentEmails: row.parentEmails,
      parentNames: row.parentNames,
      parentIds: [],
      ...(row.dateOfBirth ? { dateOfBirth: row.dateOfBirth } : {}),
      ...(row.jerseyNumber != null ? { jerseyNumber: row.jerseyNumber } : {}),
      ...(row.position ? { position: row.position, positions: [row.position] } : {}),
      ...(row.parentPhones.length > 0 ? { parentPhones: row.parentPhones } : {}),
    };
    await addDocument('players', playerData);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950">
      <Header title="Players" subtitle="Roster, profiles, and contact info" />
      <ImportPlayersModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        teamId={selectedTeamId || ''}
        onCreatePlayer={handleImportRow}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {/* Search + filter — subtle inline pills on the dark page bg
            instead of a big white card. Patrick: "players page has
            this big huge white box." Import CSV moved to a quiet
            footer link below the roster — coaches rarely use it. */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-white/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search by name or #…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-9 py-2.5 text-sm bg-white/[0.04] ring-1 ring-white/10 text-white placeholder-white/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-crimson-400"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-white/40 hover:text-white"
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
              className="appearance-none bg-white/[0.04] ring-1 ring-white/10 text-white rounded-xl pl-3 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-crimson-400"
            >
              <option value="" className="bg-charcoal-900">All positions</option>
              {positions.map(p => <option key={p} value={p} className="bg-charcoal-900">{p}</option>)}
            </select>
            <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-2.5 text-white/70 hover:text-white bg-white/[0.04] ring-1 ring-white/10 rounded-xl"
            >
              Clear
            </button>
          )}
        </div>

        <PlayerList searchTerm={searchTerm} positionFilter={positionFilter} />

        {/* Import CSV moved to a quiet footer affordance. Coaches do
            this once a season at most — no reason for it to fight the
            roster for attention at the top. */}
        {isUserCoach && (
          <div className="pt-2 pb-1 flex justify-center">
            <button
              onClick={() => setImportOpen(true)}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-2 text-crimson-400/80 hover:text-bone"
            >
              Import roster from CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Players;
