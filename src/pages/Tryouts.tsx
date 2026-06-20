import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isCoach, isClubAdmin } from '../utils/helpers';
import { logActivity } from '../utils/activityLog';
import type { Activity, Registration, RegistrationCoachState } from '../types';
import SendOfferModal from '../components/club/SendOfferModal';

// Coach-facing view of the tryout candidate pool. Shared across all
// coaches in the club — favorites, holds, ratings, and notes are
// visible to everyone so two coaches don't quietly compete for the
// same kid. Only club admins create offers (Module 2 next batch); this
// page is the pre-offer scouting surface.

const STATUS_OPTIONS: Array<{ value: Registration['status'] | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'paid', label: 'Paid' },
  { value: 'tryout_invited', label: 'Tryout invited' },
  { value: 'offer_sent', label: 'Offer sent' },
  { value: 'pending_payment', label: 'Pending payment' },
];

const Tryouts: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData) || (userData?.role ? isCoach(userData.role) : false);
  const myUid = userData?.uid;
  const myName = userData?.name || 'Coach';

  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterAge, setFilterAge] = useState<string>('all');
  const [filterGender, setFilterGender] = useState<string>('all');
  const [filterPosition, setFilterPosition] = useState<string>('all');
  const [filterReturning, setFilterReturning] = useState<'all' | 'returning' | 'new'>('all');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showNeedsAttention, setShowNeedsAttention] = useState(false);
  const [openNotesFor, setOpenNotesFor] = useState<string | null>(null);
  const [offerFor, setOfferFor] = useState<Registration | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      const [rSnap, aSnap] = await Promise.all([
        getDocs(query(collection(db, 'registrations'), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'activities'), orderBy('createdAt', 'desc'))),
      ]);
      setRegistrations(rSnap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
        };
      }) as Registration[]);
      setActivities(aSnap.docs.slice(0, 50).map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
        };
      }) as Activity[]);
    } catch (err) {
      console.warn('tryouts load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (allowed) void reload(); }, [allowed]);

  // Build the list of unique filter values from the loaded set.
  const ageGroups = useMemo(
    () => Array.from(new Set(registrations.map(r => r.player?.ageGroup).filter(Boolean))).sort(),
    [registrations],
  );
  const positions = useMemo(
    () => Array.from(new Set(registrations.map(r => r.player?.preferredPosition).filter(Boolean))).sort() as string[],
    [registrations],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return registrations.filter(r => {
      if (filterStatus !== 'all' && r.status !== filterStatus) return false;
      if (filterAge !== 'all' && r.player?.ageGroup !== filterAge) return false;
      if (filterGender !== 'all' && r.player?.gender !== filterGender) return false;
      if (filterPosition !== 'all' && r.player?.preferredPosition !== filterPosition) return false;
      if (filterReturning === 'returning' && !r.player?.playedBefore) return false;
      if (filterReturning === 'new' && r.player?.playedBefore) return false;
      if (showFavoritesOnly && !(myUid && r.coachStates?.[myUid]?.favorite)) return false;
      if (showNeedsAttention) {
        // "Needs attention" = candidate hasn't been favorited by ANY
        // coach, isn't held, isn't already offered/accepted/declined/
        // withdrawn, and the candidate has been in the pool long
        // enough that they should have been triaged by now. Helps the
        // admin spot kids who are slipping through the cracks.
        const anyFavorite = Object.values(r.coachStates || {}).some(s => s.favorite);
        const isHeld = !!r.heldByUid;
        const terminal = r.status === 'offer_sent' || r.status === 'accepted'
          || r.status === 'declined' || r.status === 'withdrawn';
        const submittedDays = (Date.now() - toMs(r.createdAt)) / (1000 * 60 * 60 * 24);
        const ageEnough = submittedDays > 3; // a few days unfavorited = worth flagging
        if (anyFavorite || isHeld || terminal || !ageEnough) return false;
      }
      if (q) {
        const hay = [
          r.player?.firstName, r.player?.lastName,
          ...(r.parents || []).map(p => `${p.firstName} ${p.lastName} ${p.email}`),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [registrations, search, filterStatus, filterAge, filterGender, filterPosition, filterReturning, showFavoritesOnly, showNeedsAttention, myUid]);

  // Mutations — each updates the doc and writes an activity. Optimistic
  // local update so the UI feels instant.
  const updateCoachState = async (r: Registration, patch: Partial<RegistrationCoachState>) => {
    if (!myUid) return;
    const next: RegistrationCoachState = {
      uid: myUid,
      coachName: myName,
      ...(r.coachStates?.[myUid] || {}),
      ...patch,
    };
    setRegistrations(prev => prev.map(rr => rr.id === r.id ? {
      ...rr,
      coachStates: { ...(rr.coachStates || {}), [myUid]: next },
    } : rr));
    try {
      await updateDoc(doc(db, 'registrations', r.id), {
        [`coachStates.${myUid}`]: next,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('coach state update failed', err);
    }
  };

  const handleToggleFavorite = async (r: Registration) => {
    if (!myUid) return;
    const was = !!r.coachStates?.[myUid]?.favorite;
    await updateCoachState(r, { favorite: !was, favoritedAt: new Date() });
    void logActivity({
      clubId: r.clubId,
      kind: was ? 'coach_unfavorited' : 'coach_favorited',
      registrationId: r.id,
      seasonId: r.seasonId,
      actorUid: myUid,
      actorName: myName,
      payload: { playerName: `${r.player?.firstName} ${r.player?.lastName}` },
    });
  };

  const handleRate = async (r: Registration, rating: number) => {
    if (!myUid) return;
    await updateCoachState(r, { rating });
    void logActivity({
      clubId: r.clubId,
      kind: 'coach_rated',
      registrationId: r.id,
      seasonId: r.seasonId,
      actorUid: myUid,
      actorName: myName,
      payload: { rating, playerName: `${r.player?.firstName} ${r.player?.lastName}` },
    });
  };

  const handleSaveNote = async (r: Registration, note: string) => {
    if (!myUid) return;
    await updateCoachState(r, { note, noteUpdatedAt: new Date() });
    void logActivity({
      clubId: r.clubId,
      kind: 'coach_noted',
      registrationId: r.id,
      seasonId: r.seasonId,
      actorUid: myUid,
      actorName: myName,
      payload: { note: note.slice(0, 200), playerName: `${r.player?.firstName} ${r.player?.lastName}` },
    });
  };

  const handleToggleHold = async (r: Registration) => {
    if (!myUid) return;
    const heldByMe = r.heldByUid === myUid;
    const heldByOther = !!r.heldByUid && r.heldByUid !== myUid;
    if (heldByOther) {
      alert(`Held by ${r.heldByName || 'another coach'}. They need to release first.`);
      return;
    }
    const next = heldByMe ? null : { heldByUid: myUid, heldByName: myName, heldUntil: addDays(new Date(), 7) };
    setRegistrations(prev => prev.map(rr => rr.id === r.id ? {
      ...rr,
      heldByUid: next?.heldByUid as any,
      heldByName: next?.heldByName as any,
      heldUntil: next?.heldUntil as any,
    } : rr));
    try {
      await updateDoc(doc(db, 'registrations', r.id), {
        heldByUid: next?.heldByUid || null,
        heldByName: next?.heldByName || null,
        heldUntil: next?.heldUntil || null,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('hold update failed', err);
    }
    void logActivity({
      clubId: r.clubId,
      kind: heldByMe ? 'coach_released' : 'coach_held',
      registrationId: r.id,
      seasonId: r.seasonId,
      actorUid: myUid,
      actorName: myName,
      payload: { playerName: `${r.player?.firstName} ${r.player?.lastName}` },
    });
  };

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">
        Coaches + club admins only.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950">
      <section className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 sm:px-6 py-5 border-b border-crimson-500/10">
        <div className="max-w-6xl mx-auto">
          <Link to="/club" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-crimson-400 hover:text-bone mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Club
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Tryout pool</h1>
          <p className="text-sm text-bone/40 mt-0.5">
            Coach view. Favorites, holds, ratings, and notes are visible to all coaches.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Activity feed strip */}
        <ActivityStrip activities={activities} />

        {/* Filters — all controls dark-mode by default. Selects + input
            were inheriting system white/black via no explicit bg/text,
            producing the light-mode pill row Patrick called out. */}
        <div className="bg-charcoal-900 rounded-xl ring-1 ring-white/10 p-3 flex flex-wrap items-center gap-2">
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40">
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filterAge} onChange={(e) => setFilterAge(e.target.value)} className="text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40">
            <option value="all">All ages</option>
            {ageGroups.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={filterGender} onChange={(e) => setFilterGender(e.target.value)} className="text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40">
            <option value="all">All genders</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </select>
          {positions.length > 0 && (
            <select value={filterPosition} onChange={(e) => setFilterPosition(e.target.value)} className="text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40">
              <option value="all">All positions</option>
              {positions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <select value={filterReturning} onChange={(e) => setFilterReturning(e.target.value as any)} className="text-sm bg-charcoal-950 text-bone border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40">
            <option value="all">New + returning</option>
            <option value="returning">Returning only</option>
            <option value="new">New only</option>
          </select>
          <button
            type="button"
            onClick={() => setShowFavoritesOnly(v => !v)}
            className={`text-sm font-bold rounded-lg px-3 py-2 ring-1 ${
              showFavoritesOnly
                ? 'bg-rose-500 text-white ring-rose-400'
                : 'bg-charcoal-950 text-bone/85 ring-white/15 hover:ring-rose-400'
            }`}
            title="Show only candidates you've favorited"
          >
            ♥ Mine
          </button>
          <button
            type="button"
            onClick={() => setShowNeedsAttention(v => !v)}
            className={`text-sm font-bold rounded-lg px-3 py-2 ring-1 ${
              showNeedsAttention
                ? 'bg-amber-500 text-charcoal-950 ring-amber-400'
                : 'bg-charcoal-950 text-bone/85 ring-white/15 hover:ring-amber-400'
            }`}
            title="Candidates 3+ days in the pool with NO favorites, NO hold, and NO offer — gameplanning surface for admins"
          >
            ⚠ Needs attention
          </button>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by player or parent…"
            className="flex-1 min-w-[180px] text-sm bg-charcoal-950 text-bone placeholder-bone/40 border border-white/15 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-crimson-400/40"
          />
          <span className="ml-auto text-xs text-bone/50">{visible.length} of {registrations.length}</span>
        </div>

        {/* Table */}
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-bone/50">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-bold text-bone/85">Nothing matches.</p>
              <p className="text-xs text-bone/50 mt-1">Try clearing filters.</p>
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {visible.map(r => (
                <CandidateRow
                  key={r.id}
                  registration={r}
                  myUid={myUid}
                  isOpen={openNotesFor === r.id}
                  onToggleOpen={() => setOpenNotesFor(openNotesFor === r.id ? null : r.id)}
                  onToggleFavorite={() => handleToggleFavorite(r)}
                  onRate={(n) => handleRate(r, n)}
                  onSaveNote={(n) => handleSaveNote(r, n)}
                  onToggleHold={() => handleToggleHold(r)}
                  onOffer={() => setOfferFor(r)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {offerFor && myUid && (
        <SendOfferModal
          registration={offerFor}
          myUid={myUid}
          myName={myName}
          onClose={() => setOfferFor(null)}
          onSent={() => {
            setOfferFor(null);
            void reload();
          }}
        />
      )}
    </div>
  );
};

// ── Candidate row ──────────────────────────────────────────────

interface RowProps {
  registration: Registration;
  myUid?: string;
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleFavorite: () => void;
  onRate: (n: number) => void;
  onSaveNote: (n: string) => void;
  onToggleHold: () => void;
  onOffer: () => void;
}

const CandidateRow: React.FC<RowProps> = ({ registration: r, myUid, isOpen, onToggleOpen, onToggleFavorite, onRate, onSaveNote, onToggleHold, onOffer }) => {
  const my = myUid ? r.coachStates?.[myUid] : undefined;
  const allCoachStates = Object.values(r.coachStates || {});
  const otherFavorites = allCoachStates.filter(s => s.uid !== myUid && s.favorite);
  const allRatings = allCoachStates.filter(s => typeof s.rating === 'number').map(s => s.rating!) ;
  const avgRating = allRatings.length > 0 ? (allRatings.reduce((a, b) => a + b, 0) / allRatings.length) : 0;
  const heldByMe = r.heldByUid === myUid;
  const heldByOther = !!r.heldByUid && r.heldByUid !== myUid;
  const [noteDraft, setNoteDraft] = useState(my?.note || '');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => { setNoteDraft(my?.note || ''); }, [my?.note]);

  return (
    <li className="px-4 py-3 hover:bg-white/[0.05]">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggleFavorite}
          className={`shrink-0 mt-0.5 w-8 h-8 rounded-full flex items-center justify-center ring-1 transition ${
            my?.favorite
              ? 'bg-rose-500/150 ring-rose-500 text-white'
              : 'bg-charcoal-900 ring-white/10 text-bone/40 hover:ring-rose-400 hover:text-rose-300'
          }`}
          title={my?.favorite ? 'Unfavorite' : 'Favorite'}
        >
          ♥
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-sm font-bold text-bone">
              {r.player.firstName} {r.player.lastName}
            </span>
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50 bg-charcoal-950 px-1.5 py-0.5 rounded">
              {r.player.ageGroup}
            </span>
            {r.player.playedBefore && (
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-300 bg-crimson-500/15 px-1.5 py-0.5 rounded">
                returning
              </span>
            )}
            {heldByMe && (
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-amber-200 bg-amber-500/20 ring-1 ring-amber-400/30 px-1.5 py-0.5 rounded">
                You're holding
              </span>
            )}
            {heldByOther && (
              <span className="text-[10px] font-extrabold tracking-widest uppercase text-amber-900 bg-amber-500/20 ring-1 ring-amber-300 px-1.5 py-0.5 rounded">
                Held by {r.heldByName}
              </span>
            )}
          </div>
          <div className="text-xs text-bone/65">
            {r.player.gender} · {r.player.preferredPosition || '—'} · status: <span className="font-bold">{r.status}</span>
          </div>
          {otherFavorites.length > 0 && (
            <div className="mt-1 text-[11px] text-rose-300">
              Also favorited by {otherFavorites.map(s => s.coachName).join(', ')}
            </div>
          )}
          {avgRating > 0 && (
            <div className="mt-1 text-[11px] text-amber-300">
              Pool rating: {avgRating.toFixed(1)} ★ ({allRatings.length})
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => onRate(n)}
              className={`text-base ${(my?.rating ?? 0) >= n ? 'text-amber-500' : 'text-bone/35 hover:text-amber-400'}`}
              title={`Rate ${n} star${n === 1 ? '' : 's'}`}
            >
              ★
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {r.promotedToPlayerId && (
          <Link
            to={`/club/person/${r.promotedToPlayerId}`}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-crimson-600 text-white hover:bg-crimson-500/150"
          >
            Profile
          </Link>
        )}
        {r.parents?.[0]?.email && (
          <Link
            to={`/club/family/${encodeURIComponent(r.parents[0].email.toLowerCase())}`}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-white/[0.04] text-bone/85 ring-1 ring-white/10 hover:bg-white/[0.08]"
          >
            Family
          </Link>
        )}
        <button
          type="button"
          onClick={onToggleOpen}
          className="text-[11px] font-bold text-crimson-300 hover:text-crimson-100"
        >
          {isOpen ? 'Close notes' : my?.note ? 'Edit note' : '+ Add note'}
        </button>
        <button
          type="button"
          onClick={onToggleHold}
          disabled={heldByOther}
          className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 ${
            heldByMe
              ? 'bg-amber-500/150 text-white ring-amber-500'
              : heldByOther
                ? 'bg-charcoal-950 text-bone/40 ring-white/10 cursor-not-allowed'
                : 'bg-charcoal-900 text-amber-300 ring-amber-300 hover:bg-amber-500/15'
          }`}
        >
          {heldByMe ? 'Release hold' : 'Place hold'}
        </button>
        <button
          type="button"
          onClick={onOffer}
          disabled={heldByOther}
          className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 bg-violet-600 text-white ring-violet-600 hover:bg-violet-500/150 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send offer
        </button>
      </div>

      {isOpen && (
        <div className="mt-2 pl-11">
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={3}
            placeholder="Scouting notes — visible to all coaches"
            className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-crimson-400 text-sm"
          />
          <div className="flex items-center justify-end gap-2 mt-1">
            <button
              type="button"
              disabled={savingNote || noteDraft === (my?.note || '')}
              onClick={async () => {
                setSavingNote(true);
                await onSaveNote(noteDraft);
                setSavingNote(false);
              }}
              className="px-3 py-1.5 rounded-lg bg-crimson-600 hover:bg-crimson-500/150 disabled:opacity-50 text-white text-xs font-bold"
            >
              {savingNote ? 'Saving…' : 'Save note'}
            </button>
          </div>
          {allCoachStates.filter(s => s.note && s.uid !== myUid).length > 0 && (
            <div className="mt-2 space-y-1.5">
              {allCoachStates.filter(s => s.note && s.uid !== myUid).map(s => (
                <div key={s.uid} className="text-[11px] text-bone/85 bg-white/[0.04] ring-1 ring-white/10 rounded p-2">
                  <span className="font-bold">{s.coachName}:</span> {s.note}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
};

// ── Activity strip ─────────────────────────────────────────────

const ActivityStrip: React.FC<{ activities: Activity[] }> = ({ activities }) => {
  const recent = activities
    .filter(a => a.kind.startsWith('coach_') || a.kind === 'offer_sent' || a.kind === 'tryout_invited')
    .slice(0, 6);
  if (recent.length === 0) return null;
  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 px-3 py-2">
      <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">Coach activity</div>
      <ul className="flex flex-wrap gap-1.5">
        {recent.map(a => (
          <li key={a.id} className="text-[11px] text-bone/85 bg-white/[0.04] ring-1 ring-white/10 rounded px-2 py-1">
            <span className="font-bold">{a.actorName || 'Coach'}</span> {verbFor(a.kind)}{' '}
            <span className="text-bone/50">{a.payload?.playerName || ''}</span>
            {a.payload?.rating && <span className="ml-1 text-amber-600">{a.payload.rating}★</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

function verbFor(kind: Activity['kind']): string {
  switch (kind) {
    case 'coach_favorited': return 'favorited';
    case 'coach_unfavorited': return 'unfavorited';
    case 'coach_rated': return 'rated';
    case 'coach_noted': return 'noted on';
    case 'coach_held': return 'placed a hold on';
    case 'coach_released': return 'released';
    case 'offer_sent': return 'sent an offer to';
    case 'tryout_invited': return 'invited to tryout:';
    default: return kind;
  }
}

function toMs(v: any): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'number') return v;
  const n = Date.parse(String(v));
  return isNaN(n) ? 0 : n;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export default Tryouts;
