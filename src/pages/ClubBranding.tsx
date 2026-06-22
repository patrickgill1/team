// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useClubId } from '../hooks/useClubId';
import { isClubAdmin } from '../utils/helpers';
import ClubBrandingCard from '../components/club/ClubBrandingCard';
import Header from '../components/common/Header';

// Standalone club-admin page for logo + brand color. Reachable from
// the Branding chip in /club's admin-tools strip. Loads the club doc
// in real-time so a save in the card immediately reflects on the
// preview surfaces below.

const ClubBranding: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const clubId = useClubId();
  const [club, setClub] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clubId) { setLoading(false); return; }
    const unsub = onSnapshot(
      doc(db, 'clubs', clubId),
      (snap) => {
        setClub(snap.exists() ? { id: snap.id, ...(snap.data() as any) } : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [clubId]);

  if (!isClubAdmin(userData)) {
    return (
      <div className="min-h-screen bg-charcoal-950 text-bone p-6">
        <Header title="Branding" />
        <div className="max-w-md mx-auto mt-10 bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6">
          <p className="text-bone/80">Only club admins can change branding.</p>
          <Link to="/club" className="mt-4 inline-block text-crimson-400 text-sm font-bold">← Back to club</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950 text-bone pb-20">
      <Header title="Branding" subtitle={club?.name || 'Club'} />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/50">Loading…</div>
        ) : !club ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/80">
            No active club found.
          </div>
        ) : (
          <>
            <ClubBrandingCard club={club} />

            {/* Live preview — shows the parent invite landing as it
                would appear to a new family. Only the surfaces that
                read brandColor/logoUrl render the club brand; the
                rest of the app stays on the GoalKickr palette. */}
            <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
              <div className="px-5 py-4 border-b border-white/5">
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55">Preview</p>
                <h2 className="text-bone font-bold">How parents see your invite</h2>
              </div>
              <div className="p-5">
                <div
                  className="rounded-xl ring-1 ring-white/10 bg-charcoal-950 p-5 flex items-center gap-4"
                  style={{ boxShadow: `inset 0 2px 0 ${club.brandColor || '#DC2626'}` }}
                >
                  {club.logoUrl ? (
                    <img
                      src={club.logoUrl}
                      alt={club.name}
                      className="w-14 h-14 rounded-lg object-contain bg-white/5 ring-1 ring-white/10"
                    />
                  ) : (
                    <div
                      className="w-14 h-14 rounded-lg flex items-center justify-center text-white font-black text-lg"
                      style={{ backgroundColor: club.brandColor || '#DC2626' }}
                    >
                      {(club.name || 'C').slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-bone font-bold leading-tight">{club.name || 'Your club'}</p>
                    <p className="text-bone/60 text-xs mt-1">A coach invited your family to join.</p>
                    <button
                      type="button"
                      className="mt-3 inline-flex items-center px-3 py-1.5 rounded-md text-white font-bold text-xs"
                      style={{ backgroundColor: club.brandColor || '#DC2626' }}
                    >
                      Accept invite
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate('/club')}
              className="text-bone/60 text-sm hover:text-bone"
            >
              ← Back to club
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default ClubBranding;
