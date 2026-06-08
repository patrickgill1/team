import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, orderBy, query, where, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import { logActivity } from '../utils/activityLog';
import type { Registration } from '../types';
import RegistrationBlastModal from '../components/club/RegistrationBlastModal';
import BulkEmailModal from '../components/club/BulkEmailModal';
import { useClubId } from '../hooks/useClubId';

// Admin view of every registration in the club's pipeline. Filter by
// season, age group, gender, status. Each row opens a panel for editing
// status (mark paid / invite to tryout / accept offer / decline). The
// real CRM-grade detail view comes in Module 2; this is the minimum
// for the admin to see who's registered and move them through stages.

type StatusKey = Registration['status'];

const STATUS_TONES: Record<StatusKey, { bg: string; text: string; ring: string; label: string }> = {
  pending_payment: { bg: 'bg-amber-100', text: 'text-amber-800', ring: 'ring-amber-300', label: 'Pending payment' },
  paid: { bg: 'bg-emerald-100', text: 'text-emerald-800', ring: 'ring-emerald-300', label: 'Paid' },
  tryout_invited: { bg: 'bg-cyan-100', text: 'text-cyan-800', ring: 'ring-cyan-300', label: 'Tryout invited' },
  offer_sent: { bg: 'bg-violet-100', text: 'text-violet-800', ring: 'ring-violet-300', label: 'Offer sent' },
  accepted: { bg: 'bg-emerald-100', text: 'text-emerald-900', ring: 'ring-emerald-400', label: 'Accepted' },
  declined: { bg: 'bg-rose-100', text: 'text-rose-800', ring: 'ring-rose-300', label: 'Declined' },
  withdrawn: { bg: 'bg-slate-100', text: 'text-slate-700', ring: 'ring-slate-300', label: 'Withdrawn' },
};

const Registrations: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const { clubId } = useClubId();

  const [seasons, setSeasons] = useState<any[]>([]);
  const [seasonId, setSeasonId] = useState<string>('all');
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<StatusKey | 'all'>('all');
  const [filterAge, setFilterAge] = useState<string>('all');
  const [filterGender, setFilterGender] = useState<string>('all');
  const [showBlast, setShowBlast] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [showBulkEmail, setShowBulkEmail] = useState(false);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const seasonsSnap = await getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc')));
        if (cancelled) return;
        const ss = seasonsSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setSeasons(ss);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [allowed]);

  const reload = async () => {
    if (!allowed) return;
    try {
      setLoading(true);
      let q;
      if (seasonId === 'all') {
        q = query(collection(db, 'registrations'), orderBy('createdAt', 'desc'));
      } else {
        q = query(collection(db, 'registrations'), where('seasonId', '==', seasonId), orderBy('createdAt', 'desc'));
      }
      const snap = await getDocs(q);
      const list = snap.docs.map(d => {
        const data = d.data() as any;
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
        };
      }) as Registration[];
      setRegistrations(list);
    } catch (err) {
      console.warn('registrations load failed', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, [seasonId, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return registrations.filter(r => {
      if (filterStatus !== 'all' && r.status !== filterStatus) return false;
      if (filterAge !== 'all' && r.player.ageGroup !== filterAge) return false;
      if (filterGender !== 'all' && r.player.gender !== filterGender) return false;
      if (q) {
        const hay = `${r.player.firstName} ${r.player.lastName} ${r.parents.map(p => `${p.firstName} ${p.lastName} ${p.email}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [registrations, search, filterStatus, filterAge, filterGender]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { total: registrations.length, pending_payment: 0, paid: 0, accepted: 0, declined: 0 };
    for (const r of registrations) {
      if (r.status in c) c[r.status]++;
    }
    return c;
  }, [registrations]);

  const ageGroups = useMemo(() => {
    const set = new Set<string>();
    registrations.forEach(r => r.player.ageGroup && set.add(r.player.ageGroup));
    return Array.from(set).sort();
  }, [registrations]);

  // Bulk: apply a status transition to every selected registration that
  // can validly take it. Skips ones already past the target so we don't
  // re-fire activities. Sequential to keep activity ordering sane and
  // avoid hammering Firestore writes — small N in practice.
  const handleBulkStatus = async (next: StatusKey) => {
    if (selected.size === 0) return;
    if (!window.confirm(`Apply "${STATUS_TONES[next].label}" to ${selected.size} registration${selected.size === 1 ? '' : 's'}?`)) return;
    setBulkRunning(true);
    try {
      for (const id of Array.from(selected)) {
        const r = registrations.find(x => x.id === id);
        if (!r || r.status === next) continue;
        try {
          await updateDoc(doc(db, 'registrations', id), {
            status: next,
            updatedAt: serverTimestamp(),
            ...(next === 'paid' ? { paidAt: serverTimestamp() } : {}),
          });
          void logActivity({
            clubId: r.clubId,
            kind: next === 'paid' ? 'registration_paid' : next === 'tryout_invited' ? 'tryout_invited' : 'note_added',
            registrationId: r.id,
            playerId: r.playerId || undefined,
            parentEmail: r.parents[0]?.email,
            seasonId: r.seasonId,
            actorUid: userData?.uid,
            actorName: userData?.name,
            payload: { fromStatus: r.status, toStatus: next, bulk: true },
          });
        } catch (err) {
          console.warn('bulk status update failed for', id, err);
        }
      }
      setSelected(new Set());
      void reload();
    } finally {
      setBulkRunning(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(visible.map(r => r.id)));
  };

  const clearSelection = () => setSelected(new Set());

  const handleStatusChange = async (r: Registration, next: StatusKey) => {
    try {
      await updateDoc(doc(db, 'registrations', r.id), {
        status: next,
        updatedAt: serverTimestamp(),
        ...(next === 'paid' ? { paidAt: serverTimestamp() } : {}),
      });
      void logActivity({
        clubId: r.clubId,
        kind: next === 'paid' ? 'registration_paid' : next === 'tryout_invited' ? 'tryout_invited' : 'note_added',
        registrationId: r.id,
        playerId: r.playerId || undefined,
        parentEmail: r.parents[0]?.email,
        seasonId: r.seasonId,
        actorUid: userData?.uid,
        actorName: userData?.name,
        payload: { fromStatus: r.status, toStatus: next },
      });
      void reload();
    } catch (err) {
      console.error('status update failed', err);
      alert('Failed to update status — try again.');
    }
  };

  if (!allowed) {
    return (
      <div className="min-h-screen bg-fire-50 flex items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <p className="text-sm font-bold text-slate-700">Club admin access only</p>
          <p className="text-xs text-slate-500 mt-1">Registrations are visible to club administrators.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fire-50">
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 py-5 border-b border-cyan-500/10">
        <div className="max-w-6xl mx-auto">
          <Link to="/club" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Club
          </Link>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Registrations</h1>
              <p className="text-sm text-slate-400 mt-0.5">
                Everyone who's signed up for the season — pending, paid, in tryouts, on a team.
              </p>
            </div>
            {clubId && seasons.length > 0 && (
              <button
                type="button"
                onClick={() => setShowBlast(true)}
                className="shrink-0 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white text-xs font-extrabold uppercase tracking-widest"
              >
                Push email
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Total" value={counts.total} tone="slate" />
          <Tile label="Pending payment" value={counts.pending_payment || 0} tone="amber" />
          <Tile label="Paid" value={counts.paid || 0} tone="emerald" />
          <Tile label="Accepted" value={counts.accepted || 0} tone="cyan" />
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl ring-1 ring-slate-200 p-3 flex flex-wrap items-center gap-2">
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="text-sm border border-slate-300 rounded-lg px-3 py-2">
            <option value="all">All seasons</option>
            {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)} className="text-sm border border-slate-300 rounded-lg px-3 py-2">
            <option value="all">All statuses</option>
            {(Object.keys(STATUS_TONES) as StatusKey[]).map(s => <option key={s} value={s}>{STATUS_TONES[s].label}</option>)}
          </select>
          <select value={filterAge} onChange={(e) => setFilterAge(e.target.value)} className="text-sm border border-slate-300 rounded-lg px-3 py-2">
            <option value="all">All ages</option>
            {ageGroups.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={filterGender} onChange={(e) => setFilterGender(e.target.value)} className="text-sm border border-slate-300 rounded-lg px-3 py-2">
            <option value="all">All genders</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </select>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by player or parent…"
            className="flex-1 min-w-[180px] text-sm border border-slate-300 rounded-lg px-3 py-2"
          />
          <button
            type="button"
            onClick={selected.size === visible.length && visible.length > 0 ? clearSelection : selectAllVisible}
            className="ml-auto text-[11px] font-bold text-slate-600 hover:text-cyan-700"
          >
            {selected.size === visible.length && visible.length > 0 ? 'Clear all' : 'Select all'}
          </button>
          <span className="text-xs text-slate-500">{visible.length} of {registrations.length}</span>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-bold text-slate-700">No registrations match.</p>
              <p className="text-xs text-slate-500 mt-1">
                {registrations.length === 0
                  ? 'Once parents start submitting at /register, they show up here.'
                  : 'Try a different filter combination.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {visible.map(r => {
                const tone = STATUS_TONES[r.status] || STATUS_TONES.pending_payment;
                return (
                  <li key={r.id} className="px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                        className="mt-1 w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
                        title="Select for bulk action"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-bold text-slate-900">
                            {r.player.firstName} {r.player.lastName}
                          </span>
                          <span className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                            {r.player.ageGroup}
                          </span>
                          {r.player.playedBefore && (
                            <span className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1.5 py-0.5 rounded">Returning</span>
                          )}
                          <span className={`ml-auto text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded ${tone.bg} ${tone.text} ring-1 ${tone.ring}`}>
                            {tone.label}
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 mb-0.5">
                          {r.player.gender} · DOB {r.player.dateOfBirth}
                          {r.player.preferredPosition ? ` · ${r.player.preferredPosition}` : ''}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {r.parents.map(p => `${p.firstName} ${p.lastName} · ${p.email}`).join(' · ')}
                        </div>
                        {r.player.medicalNotes && (
                          <div className="mt-1 text-[11px] text-amber-700 italic">Med: {r.player.medicalNotes}</div>
                        )}
                        {r.customAnswers && Object.keys(r.customAnswers).length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {Object.entries(r.customAnswers).map(([qid, val]) => {
                              const label = r.customAnswerLabels?.[qid] || qid;
                              const display = typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val);
                              if (!display.trim()) return null;
                              return (
                                <span key={qid} className="text-[10px] px-2 py-0.5 rounded bg-slate-100 ring-1 ring-slate-200 text-slate-700">
                                  <span className="text-slate-500">{label}:</span>{' '}
                                  <span className="font-bold">{display}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                          <span>${((r.amountPaidCents ?? r.registrationFeeCents ?? 0) / 100).toFixed(2)}</span>
                          {r.pricingTierLabel && <span className="text-cyan-700 font-bold">· {r.pricingTierLabel}</span>}
                          {r.couponCode && <span className="text-violet-700 font-bold">· {r.couponCode}</span>}
                          <span>·</span>
                          <span>{(r.createdAt as any)?.toLocaleDateString?.() || ''}</span>
                        </div>
                      </div>
                    </div>
                    {/* Status actions */}
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {r.promotedToPlayerId && (
                        <Link
                          to={`/club/person/${r.promotedToPlayerId}`}
                          className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-cyan-600 text-white hover:bg-cyan-500"
                        >
                          Profile
                        </Link>
                      )}
                      {r.parents?.[0]?.email && (
                        <Link
                          to={`/club/family/${encodeURIComponent(r.parents[0].email.toLowerCase())}`}
                          className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-slate-50 text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                        >
                          Family
                        </Link>
                      )}
                      {r.status === 'pending_payment' && (
                        <button onClick={() => handleStatusChange(r, 'paid')} className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100">
                          Mark paid
                        </button>
                      )}
                      {(r.status === 'paid' || r.status === 'pending_payment') && (
                        <button onClick={() => handleStatusChange(r, 'tryout_invited')} className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 hover:bg-cyan-100">
                          Invite to tryout
                        </button>
                      )}
                      {r.status !== 'withdrawn' && r.status !== 'declined' && r.status !== 'accepted' && (
                        <button onClick={() => handleStatusChange(r, 'withdrawn')} className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100">
                          Withdraw
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900 text-white rounded-2xl shadow-2xl ring-1 ring-cyan-500/20 px-3 py-2 flex items-center gap-2 max-w-[95vw] overflow-x-auto">
          <span className="text-[11px] font-extrabold uppercase tracking-widest text-cyan-300 px-2">{selected.size} selected</span>
          <span className="text-slate-700">|</span>
          <button
            type="button"
            disabled={bulkRunning}
            onClick={() => handleBulkStatus('paid')}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50"
          >
            Mark paid
          </button>
          <button
            type="button"
            disabled={bulkRunning}
            onClick={() => handleBulkStatus('tryout_invited')}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50"
          >
            Invite to tryout
          </button>
          <button
            type="button"
            disabled={bulkRunning}
            onClick={() => handleBulkStatus('withdrawn')}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
          >
            Withdraw
          </button>
          <button
            type="button"
            disabled={bulkRunning}
            onClick={() => setShowBulkEmail(true)}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-violet-500 hover:bg-violet-400 disabled:opacity-50"
          >
            Email
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded text-slate-300 hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {showBulkEmail && clubId && (
        <BulkEmailModal
          clubId={clubId}
          registrations={registrations.filter(r => selected.has(r.id))}
          signature={{
            name: userData?.name || 'Club Admin',
            role: 'Club Admin',
            email: userData?.email,
          }}
          onClose={() => setShowBulkEmail(false)}
          onSent={() => { /* stays open until Done */ }}
        />
      )}

      {showBlast && clubId && (
        <RegistrationBlastModal
          clubId={clubId}
          seasons={seasons}
          defaultSeasonId={seasonId !== 'all' ? seasonId : seasons.find(s => s.registrationOpen)?.id || seasons[0]?.id}
          signature={{
            name: userData?.name || 'Club Admin',
            role: 'Club Admin',
            email: userData?.email,
            avatarUrl: (userData as any)?.photoURL,
          }}
          onClose={() => setShowBlast(false)}
          onSent={() => { /* modal stays open to show result; close on Done */ }}
        />
      )}
    </div>
  );
};

const Tile: React.FC<{ label: string; value: number; tone: 'amber' | 'emerald' | 'cyan' | 'slate' }> = ({ label, value, tone }) => {
  const tones = {
    amber: 'bg-amber-50 ring-amber-200 text-amber-900',
    emerald: 'bg-emerald-50 ring-emerald-200 text-emerald-900',
    cyan: 'bg-cyan-50 ring-cyan-200 text-cyan-900',
    slate: 'bg-white ring-slate-200 text-slate-900',
  } as const;
  return (
    <div className={`rounded-xl ring-1 px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-black tabular-nums leading-none">{value}</div>
      <div className="text-[10px] font-extrabold tracking-widest uppercase mt-1 opacity-80">{label}</div>
    </div>
  );
};

export default Registrations;
