// @ts-nocheck
import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTeam } from '../contexts/TeamContext';
import BulkAddPlayersForm, { BulkAddResult } from '../components/people/BulkAddPlayersForm';
import Header from '../components/common/Header';
import { VOCAB } from '../vocab';

// /people/add — bulk add players + send branded parent invite emails
// in one shot. The dedicated answer to "I'm a new coach and clicked
// 'Add players' but got the existing directory."
//
// Reuses BulkAddPlayersForm (same component the onboarding wizard's
// roster step uses), so anything we polish there shows up here too.

const AddRoster: React.FC = () => {
  const navigate = useNavigate();
  const { selectedTeamId, selectedTeam } = useTeam();
  const [result, setResult] = useState<BulkAddResult | null>(null);

  if (!selectedTeamId || !selectedTeam) {
    return (
      <div className="min-h-screen bg-charcoal-950 text-bone">
        <Header title={VOCAB.buildSquad} />
        <div className="max-w-md mx-auto mt-10 px-4">
          <div className="rounded-2xl bg-charcoal-900 ring-1 ring-white/10 p-6">
            <p className="text-bone/80">No team selected. Pick a team first, then come back.</p>
            <Link to="/teams" className="mt-4 inline-block text-brand-primary-soft text-sm font-bold">
              ← Go to Teams
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="min-h-screen bg-charcoal-950 text-bone pb-24">
        <Header title="Squad locked in" subtitle={selectedTeam.name} />
        <div className="max-w-xl mx-auto mt-8 px-4 sm:px-6 space-y-5">
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 ring-2 ring-emerald-400/40 mb-4">
              <svg className="w-8 h-8 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <p className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-300 mb-1">All set</p>
            <h1 className="text-bone text-2xl font-black tracking-tight">
              {result.created > 0
                ? `${result.created} ${result.created === 1 ? 'player' : 'players'} added`
                : 'Nothing to add'}
            </h1>
            {result.invitesSent > 0 ? (
              <p className="text-charcoal-300 text-sm mt-2">
                {result.invitesSent} {result.invitesSent === 1 ? 'invite' : 'invites'} sent. Parents get a link to join {selectedTeam.name} in their inbox.
              </p>
            ) : result.created > 0 ? (
              <p className="text-charcoal-300 text-sm mt-2">
                Players added without parent emails. You can invite them later from the Team page.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setResult(null)}
              className="px-5 py-3 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
            >
              Add more
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="px-5 py-3 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20 transition"
            >
              Open dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950 text-bone pb-24">
      <Header title={VOCAB.buildSquad} subtitle={selectedTeam.name} />
      <div className="max-w-xl mx-auto mt-6 px-4 sm:px-6">
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-5 sm:p-6">
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">
            Bulk add
          </p>
          <h1 className="text-bone text-2xl sm:text-3xl font-black tracking-tight">
            Roster + parent invites
          </h1>
          <p className="text-charcoal-300 text-sm mt-2 leading-snug">
            Drop in as many players as you want. Parents with an email get a private link to join in their inbox.
          </p>

          <div className="mt-6">
            <BulkAddPlayersForm
              teamId={selectedTeamId}
              teamName={selectedTeam.name}
              onComplete={setResult}
              onSkip={() => navigate(-1)}
              primaryLabel="Add + invite parents"
              skipLabel="Cancel"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddRoster;
