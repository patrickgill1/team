import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin, isCoach } from '../utils/helpers';
import { logActivity } from '../utils/activityLog';
import TransferPlayerModal from '../components/club/TransferPlayerModal';
import type { Activity, FormDefinition, FormSignature, Registration } from '../types';

// Club-admin CRM view for a single player. Pulls together team
// assignments, guardians, registration funnel state, payments,
// attendance, forms, and a unified activity timeline. Distinct from
// /player/:id which is the parent/coach roster-facing profile — this
// is the one-stop admin surface for "everything about this kid."
//
// Tab structure:
//   Overview        — high-density at-a-glance (this batch)
//   Teams           — full team assignment manager (next batch)
//   Registration    — current + historical registrations (next batch)
//   Payments        — invoice list + balance + Stripe links (next batch)
//   Notes           — admin/coach notes (next batch)
//   Communications  — emails + push history (next batch)
//   Activity        — full activity log for this player (next batch)

type TabKey = 'overview' | 'teams' | 'registration' | 'payments' | 'notes' | 'communications' | 'activity';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'teams', label: 'Teams' },
  { key: 'registration', label: 'Registration' },
  { key: 'payments', label: 'Payments' },
  { key: 'notes', label: 'Notes' },
  { key: 'communications', label: 'Comms' },
  { key: 'activity', label: 'Activity' },
];

const PersonAdmin: React.FC = () => {
  const { playerId } = useParams<{ playerId: string }>();
  const navigate = useNavigate();
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData) || (userData?.role ? isCoach(userData.role) : false);

  const [tab, setTab] = useState<TabKey>('overview');
  const [player, setPlayer] = useState<any | null>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [guardians, setGuardians] = useState<any[]>([]);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [formDefs, setFormDefs] = useState<FormDefinition[]>([]);
  const [formSigs, setFormSigs] = useState<Map<string, FormSignature>>(new Map());
  const [loading, setLoading] = useState(true);
  const [transferOpen, setTransferOpen] = useState(false);
  const [addNoteOpen, setAddNoteOpen] = useState(false);
  const [signFormId, setSignFormId] = useState<string | null>(null);

  // Load everything keyed off the playerId.
  const reload = async () => {
    if (!playerId) return;
    try {
      setLoading(true);
      const playerSnap = await getDoc(doc(db, 'players', playerId));
      if (!playerSnap.exists()) { setPlayer(null); return; }
      const p = { id: playerSnap.id, ...(playerSnap.data() as any) };
      setPlayer(p);

      // Teams (cross-reference player.teamIds[] or teamId).
      const teamIds = Array.from(new Set([...(p.teamIds || []), p.teamId].filter(Boolean)));
      const teamDocs = await Promise.all(teamIds.map(id => getDoc(doc(db, 'teams', id))));
      setTeams(teamDocs.filter(d => d.exists()).map(d => ({ id: d.id, ...(d.data() as any) })));

      // Guardians (Player.parentIds[] → users).
      const parentIds = Array.from(new Set(
        [...(p.parentIds || []), p.parentId].filter(Boolean)
      ));
      const guardianDocs = await Promise.all(parentIds.map(uid => getDoc(doc(db, 'users', uid))));
      setGuardians(guardianDocs.filter(d => d.exists()).map(d => ({ id: d.id, ...(d.data() as any) })));

      // Registrations — match by parent email since pre-Player there
      // was no playerId. Pull all + filter client-side; small N.
      const parentEmails: string[] = (p.parentEmails || []).map((e: string) => e?.toLowerCase().trim()).filter(Boolean);
      let regs: Registration[] = [];
      if (parentEmails.length > 0) {
        const regSnap = await getDocs(query(collection(db, 'registrations'), orderBy('createdAt', 'desc')));
        regs = regSnap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as Registration))
          .filter(r => (r.parents || []).some(par => parentEmails.includes(par.email?.toLowerCase() || '')));
      }
      // Plus any direct promotedToPlayerId match (covers parents the
      // admin manually attached after promotion).
      const direct = await getDocs(query(collection(db, 'registrations'), where('promotedToPlayerId', '==', playerId)));
      direct.forEach(d => {
        if (!regs.find(r => r.id === d.id)) regs.unshift({ id: d.id, ...(d.data() as any) } as Registration);
      });
      setRegistrations(regs);

      // Events for attendance — pull recent events for this player's
      // teams. Last ~60 days is a reasonable window for "last 10 sessions."
      if (teamIds.length > 0) {
        const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const evChunks: any[] = [];
        // Firestore caps `in` at 30 — chunk just in case.
        for (let i = 0; i < teamIds.length; i += 30) {
          const chunk = teamIds.slice(i, i + 30);
          const evSnap = await getDocs(query(
            collection(db, 'events'),
            where('teamId', 'in', chunk),
            where('date', '>=', cutoff),
            orderBy('date', 'desc'),
          ));
          evSnap.forEach(d => evChunks.push({ id: d.id, ...(d.data() as any) }));
        }
        setEvents(evChunks);
      }

      // Activities — anything keyed by playerId OR matching parent email
      // OR any of our registration ids.
      const acts: Activity[] = [];
      const seen = new Set<string>();
      const pushAct = (d: any) => {
        if (seen.has(d.id)) return;
        seen.add(d.id);
        acts.push({ id: d.id, ...(d.data() as any) } as Activity);
      };
      const byPlayerSnap = await getDocs(query(collection(db, 'activities'), where('playerId', '==', playerId)));
      byPlayerSnap.forEach(pushAct);
      for (const email of parentEmails) {
        const s = await getDocs(query(collection(db, 'activities'), where('parentEmail', '==', email)));
        s.forEach(pushAct);
      }
      for (const r of regs) {
        const s = await getDocs(query(collection(db, 'activities'), where('registrationId', '==', r.id)));
        s.forEach(pushAct);
      }
      acts.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
      setActivities(acts);

      // Forms checklist — load active definitions for the club, plus any
      // signatures already recorded for this player.
      if (p.clubId) {
        try {
          const defSnap = await getDocs(query(
            collection(db, 'form_definitions'),
            where('clubId', '==', p.clubId),
            where('isActive', '==', true),
          ));
          const defs = defSnap.docs
            .map(d => ({ id: d.id, ...(d.data() as any) }) as FormDefinition)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          setFormDefs(defs);

          const sigSnap = await getDocs(query(
            collection(db, 'form_signatures'),
            where('playerId', '==', playerId),
          ));
          const sigMap = new Map<string, FormSignature>();
          sigSnap.forEach(d => {
            const sig = { id: d.id, ...(d.data() as any) } as FormSignature;
            sigMap.set(sig.formDefinitionId, sig);
          });
          setFormSigs(sigMap);
        } catch (err) {
          console.warn('forms load failed', err);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (allowed && playerId) void reload(); }, [allowed, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived state for the overview cards ────────────────────────

  const primaryTeam = useMemo(() => teams.find(t => t.id === player?.teamId) || teams[0], [teams, player]);
  const latestRegistration = registrations[0];

  // Forms applicable to this player — apply optional age-group +
  // season scope. Forms with no scope apply to everyone.
  const applicableForms = useMemo(() => {
    const ageGroup = primaryTeam?.ageGroup;
    const seasonId = latestRegistration?.seasonId;
    return formDefs.filter(f => {
      if ((f.ageGroups || []).length > 0 && ageGroup && !(f.ageGroups || []).includes(ageGroup)) return false;
      if (f.seasonId && seasonId && f.seasonId !== seasonId) return false;
      return true;
    });
  }, [formDefs, primaryTeam, latestRegistration]);

  // Attendance over the last 10 finished events for which there's a
  // recorded RSVP or coach-marked attendance for this player.
  const attendance = useMemo(() => {
    const now = Date.now();
    const past = events
      .filter(e => toDate(e.date).getTime() <= now)
      .sort((a, b) => toDate(b.date).getTime() - toDate(a.date).getTime())
      .slice(0, 10);
    let present = 0, excused = 0, absent = 0, unknown = 0;
    for (const e of past) {
      const rsvp = e.playerRsvps?.[playerId!];
      if (!rsvp) { unknown++; continue; }
      if (rsvp.status === 'going') present++;
      else if (rsvp.status === 'maybe') excused++;
      else absent++;
    }
    return { total: past.length, present, excused, absent, unknown };
  }, [events, playerId]);

  // Payments — synthesize from the latest registration since we don't
  // have a full invoice ledger yet. Balance = quoted total - paid.
  const payments = useMemo(() => {
    if (!latestRegistration) return null;
    const quoted = (latestRegistration.amountPaidCents ?? latestRegistration.registrationFeeCents) || 0;
    const isPaid = latestRegistration.status === 'paid'
      || latestRegistration.status === 'tryout_invited'
      || latestRegistration.status === 'offer_sent'
      || latestRegistration.status === 'accepted';
    const balanceCents = isPaid ? 0 : quoted;
    return {
      balanceCents,
      lastPaidCents: isPaid ? quoted : 0,
      lastPaidAt: latestRegistration.paidAt ? toDate(latestRegistration.paidAt) : null,
      label: latestRegistration.productName || 'Registration',
    };
  }, [latestRegistration]);

  // ── Render ────────────────────────────────────────────────────────

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">Coaches + club admins only.</div>;
  }

  if (loading && !player) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-slate-500 text-sm">Loading…</div>;
  }

  if (!player) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">
        <div className="text-center">
          <p>Player not found.</p>
          <button type="button" onClick={() => navigate(-1)} className="mt-2 text-cyan-600 hover:text-cyan-800 text-xs font-bold">← Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header strip */}
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 pt-4 pb-0 border-b border-cyan-500/10">
        <div className="max-w-5xl mx-auto">
          <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back
          </button>
          {/* Tab bar */}
          <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-0">
            {TABS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`shrink-0 px-3 py-2 text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition ${
                  tab === t.key
                    ? 'text-cyan-300 border-cyan-400'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Player ID card */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-5 flex items-start gap-5">
          <Avatar player={player} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-black text-fire-950 leading-tight">{player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim()}</h1>
              <span className="inline-block px-2 py-0.5 rounded bg-blue-500 text-white text-[10px] font-extrabold tracking-widest uppercase">Player</span>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">
              {primaryTeam?.ageGroup ? `${primaryTeam.ageGroup}` : ''}
              {player.dateOfBirth ? ` (${toDate(player.dateOfBirth).getFullYear()})` : ''}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
              <Stat label="Jersey #" value={player.jerseyNumber != null ? String(player.jerseyNumber) : '—'} />
              <Stat label="Primary team" value={primaryTeam?.name || '—'} />
              <Stat label="Position" value={(player.position || (player.positions?.[0])) || '—'} />
            </div>
          </div>
        </div>

        {/* Tab body */}
        {tab === 'overview' && (
          <OverviewBody
            player={player}
            teams={teams}
            guardians={guardians}
            registration={latestRegistration}
            payments={payments}
            attendance={attendance}
            forms={applicableForms}
            formSigs={formSigs}
            onAssignTeam={() => setTransferOpen(true)}
            onAddGuardian={() => alert('Guardian invite — wires to the existing People invite flow. Coming next batch.')}
            onMessage={() => alert('Direct message thread — coming next batch.')}
            onAddNote={() => setAddNoteOpen(true)}
            onCreateTask={() => alert('Tasks system — coming in batch 3.')}
            onSignForm={(id) => setSignFormId(id)}
            onManageForms={() => navigate('/club/forms')}
          />
        )}

        {tab !== 'overview' && (
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-10 text-center">
            <p className="text-sm font-bold text-slate-700">"{TABS.find(t => t.key === tab)?.label}" coming soon.</p>
            <p className="text-xs text-slate-500 mt-1">
              {tab === 'teams' && 'Full team assignment manager — share / move / archive.'}
              {tab === 'registration' && 'Current + historical registrations with snapshots.'}
              {tab === 'payments' && 'Invoice list + balance + Stripe links.'}
              {tab === 'notes' && 'Admin/coach notes thread.'}
              {tab === 'communications' && 'Email + push history.'}
              {tab === 'activity' && 'Full activity log scoped to this player.'}
            </p>
            <p className="text-xs text-slate-400 mt-3 italic">
              {activities.length > 0 && tab === 'activity' && `${activities.length} activities loaded — full view in next batch.`}
            </p>
          </div>
        )}
      </div>

      {transferOpen && (
        <TransferPlayerModal
          isOpen
          onClose={() => setTransferOpen(false)}
          player={{ id: player.id, name: player.name, teamId: player.teamId, teamIds: player.teamIds }}
          teams={teams.map(t => ({ id: t.id, name: t.name, ageGroup: t.ageGroup }))}
          onTransferred={() => { setTransferOpen(false); void reload(); }}
        />
      )}

      {addNoteOpen && (
        <NoteModal
          player={player}
          onClose={() => setAddNoteOpen(false)}
          onSaved={() => { setAddNoteOpen(false); void reload(); }}
          actorUid={userData?.uid}
          actorName={userData?.name}
        />
      )}

      {signFormId && (
        <SignFormModal
          player={player}
          formDef={applicableForms.find(f => f.id === signFormId)!}
          onClose={() => setSignFormId(null)}
          onSaved={() => { setSignFormId(null); void reload(); }}
          actorUid={userData?.uid}
          actorName={userData?.name}
        />
      )}
    </div>
  );
};

// ── Overview body ──────────────────────────────────────────────

interface OverviewProps {
  player: any;
  teams: any[];
  guardians: any[];
  registration?: Registration;
  payments: { balanceCents: number; lastPaidCents: number; lastPaidAt: Date | null; label: string } | null;
  attendance: { total: number; present: number; excused: number; absent: number; unknown: number };
  forms: FormDefinition[];
  formSigs: Map<string, FormSignature>;
  onAssignTeam: () => void;
  onAddGuardian: () => void;
  onMessage: () => void;
  onAddNote: () => void;
  onCreateTask: () => void;
  onSignForm: (formDefinitionId: string) => void;
  onManageForms: () => void;
}

const OverviewBody: React.FC<OverviewProps> = ({ player, teams, guardians, registration, payments, attendance, forms, formSigs, onAssignTeam, onAddGuardian, onMessage, onAddNote, onCreateTask, onSignForm, onManageForms }) => {
  const primaryTeamId = player.teamId || teams[0]?.id;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Team Assignments */}
        <Card title="Team Assignments" icon={<TeamIcon />} action={<ActionLink onClick={onAssignTeam}>Manage Teams</ActionLink>}>
          {teams.length === 0 ? (
            <Empty text="No teams assigned yet." />
          ) : (
            <ul className="space-y-2">
              {teams.map(t => (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded bg-slate-100 ring-1 ring-slate-200 flex items-center justify-center shrink-0">
                      {t.logoUrl ? <img src={t.logoUrl} alt="" className="w-full h-full object-cover rounded" /> : <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900 truncate">{t.name}</div>
                      <div className="text-[11px] text-slate-500">{t.id === primaryTeamId ? 'Primary team' : 'Additional'}</div>
                    </div>
                  </div>
                  <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${
                    t.id === primaryTeamId
                      ? 'bg-blue-50 text-blue-700 ring-blue-200'
                      : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  }`}>
                    {t.id === primaryTeamId ? 'Primary' : 'Additional'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Guardian Contacts */}
        <Card title="Guardian Contacts" icon={<TeamIcon />} action={<ActionLink onClick={onAddGuardian}>Add Guardian</ActionLink>}>
          {guardians.length === 0 ? (
            <Empty text="No guardians linked. Invite one from People." />
          ) : (
            <ul className="space-y-3">
              {guardians.map(g => (
                <li key={g.id} className="flex items-start gap-2">
                  <div className="w-8 h-8 rounded-full bg-cyan-100 text-cyan-800 font-bold flex items-center justify-center shrink-0 text-xs">
                    {(g.name || '?').split(/\s+/).slice(0, 2).map((x: string) => x[0]?.toUpperCase()).join('')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-slate-900">{g.name}</span>
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 ring-1 ring-slate-200">
                        {(g.role || 'parent').replace('_', ' ')}
                      </span>
                    </div>
                    {g.phoneNumber && <div className="text-[11px] text-slate-600 mt-0.5">{g.phoneNumber}</div>}
                    {g.email && <div className="text-[11px] text-slate-500 truncate">{g.email}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Registration */}
        <Card
          title="Registration"
          icon={<ClipboardIcon />}
          action={registration ? <ActionLink onClick={() => window.location.assign(`/club/family/${encodeURIComponent(registration.parents[0]?.email?.toLowerCase() || '')}`)}>View Registration</ActionLink> : null}
          badge={registration ? <StatusBadge status={registration.status} /> : undefined}
        >
          {!registration ? (
            <Empty text="No registration on file." />
          ) : (
            <dl className="text-sm divide-y divide-slate-100">
              <Field label="Season" value={registration.seasonId || '—'} />
              <Field label="Status" value={statusLabel(registration.status)} />
              <Field label="Product" value={registration.productName || '—'} />
              {registration.customAnswers && Object.keys(registration.customAnswers).length > 0 && (
                <div className="py-2">
                  <dt className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">Custom answers</dt>
                  <dd className="text-[11px] text-slate-700 space-y-0.5">
                    {Object.entries(registration.customAnswers).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-slate-500">{registration.customAnswerLabels?.[k] || k}:</span>{' '}
                        <span className="font-bold">{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</span>
                      </div>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </Card>

        {/* Payments */}
        <Card
          title="Payments"
          icon={<DollarIcon />}
          action={<ActionLink onClick={() => alert('Payments tab — next batch.')}>View Payment History</ActionLink>}
          badge={payments?.balanceCents ? <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-amber-100 text-amber-800 ring-1 ring-amber-300">Pending</span> : payments ? <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300">Paid</span> : undefined}
        >
          {!payments ? (
            <Empty text="No invoice activity yet." />
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] text-slate-500">Balance Due</div>
                  <div className="text-3xl font-black text-slate-900 leading-none mt-1">${(payments.balanceCents / 100).toFixed(2)}</div>
                </div>
                {payments.balanceCents > 0 && (
                  <button
                    type="button"
                    onClick={() => alert('Stripe payment link generation — wires to /stripe/registration-checkout once Connect is live.')}
                    className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
                  >
                    View & Pay
                  </button>
                )}
              </div>
              {payments.lastPaidAt && (
                <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
                  <div>
                    <div className="text-slate-500">Recent Payment</div>
                    <div className="text-slate-700 font-bold">${(payments.lastPaidCents / 100).toFixed(2)} <span className="text-slate-400">· {payments.lastPaidAt.toLocaleDateString()}</span></div>
                  </div>
                  <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Paid</span>
                </div>
              )}
            </>
          )}
        </Card>

        {/* Attendance */}
        <Card title="Attendance" icon={<CalendarIcon />} subtitle={`(Last ${attendance.total || 10} Sessions)`} action={<ActionLink onClick={() => alert('Per-event attendance log — coming next batch.')}>View Attendance</ActionLink>}>
          {attendance.total === 0 ? (
            <Empty text="No recent events to score." />
          ) : (
            <div className="flex items-center gap-4">
              <Donut total={attendance.total} present={attendance.present} excused={attendance.excused} absent={attendance.absent} unknown={attendance.unknown} />
              <ul className="text-[11px] space-y-1 flex-1">
                <li className="flex items-center justify-between"><span className="flex items-center gap-1.5"><Dot color="emerald" /> Present</span><span className="font-bold tabular-nums">{attendance.present}</span></li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-1.5"><Dot color="amber" /> Excused</span><span className="font-bold tabular-nums">{attendance.excused}</span></li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-1.5"><Dot color="rose" /> Absent</span><span className="font-bold tabular-nums">{attendance.absent}</span></li>
                {attendance.unknown > 0 && <li className="flex items-center justify-between text-slate-400"><span className="flex items-center gap-1.5"><Dot color="slate" /> No RSVP</span><span className="tabular-nums">{attendance.unknown}</span></li>}
              </ul>
            </div>
          )}
        </Card>

        {/* Forms Checklist */}
        <Card title="Forms Checklist" icon={<ClipboardIcon />} action={<ActionLink onClick={onManageForms}>Manage Forms</ActionLink>}>
          {forms.length === 0 ? (
            <Empty text="No forms defined for this club yet." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {forms.map(f => {
                const sig = formSigs.get(f.id);
                const signed = !!sig;
                return (
                  <li key={f.id} className="py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-slate-800 truncate">{f.name}</div>
                      {sig && <div className="text-[10px] text-slate-500">Signed by {sig.signedByName} · {toDate(sig.signedAt).toLocaleDateString()}</div>}
                    </div>
                    {signed ? (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-700 flex items-center gap-1 shrink-0">
                        Signed
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSignForm(f.id)}
                        className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${
                          f.required
                            ? 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100'
                            : 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100'
                        }`}
                      >
                        {f.required ? 'Required · Mark signed' : 'Pending · Mark signed'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-cyan-500" fill="currentColor" viewBox="0 0 24 24"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-slate-700">Quick Actions</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <QuickAction icon={<MsgIcon />} label="Message" onClick={onMessage} />
          <QuickAction icon={<NoteIcon />} label="Add Note" onClick={onAddNote} />
          <QuickAction icon={<UserPlusIcon />} label="Assign Team" onClick={onAssignTeam} />
          <QuickAction icon={<TaskIcon />} label="Create Task" onClick={onCreateTask} />
        </div>
      </div>
    </div>
  );
};

// ── Add-note modal ──────────────────────────────────────────────

const NoteModal: React.FC<{ player: any; onClose: () => void; onSaved: () => void; actorUid?: string; actorName?: string }> = ({ player, onClose, onSaved, actorUid, actorName }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await logActivity({
        clubId: player.clubId,
        kind: 'note_added',
        playerId: player.id,
        teamId: player.teamId,
        actorUid,
        actorName,
        payload: { note: text.trim(), playerName: player.name },
      });
      // Bump player's updatedAt so list views resort. Cheap signal.
      try { await updateDoc(doc(db, 'players', player.id), { updatedAt: serverTimestamp() }); } catch {/* ignore */}
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-black text-fire-950">Add note</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>
        <div className="p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="Anything worth remembering about this player — visible to coaches + admins."
            className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
          />
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!text.trim() || saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Sign-form modal ──────────────────────────────────────────────

const SignFormModal: React.FC<{
  player: any;
  formDef: FormDefinition;
  onClose: () => void;
  onSaved: () => void;
  actorUid?: string;
  actorName?: string;
}> = ({ player, formDef, onClose, onSaved, actorUid, actorName }) => {
  const [signedByName, setSignedByName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!signedByName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // Doc id is composed so we can read "this player's signature for
      // this form" in one getDoc without a query.
      const id = `${player.id}_${formDef.id}`;
      const sig: any = {
        clubId: player.clubId || formDef.clubId,
        playerId: player.id,
        formDefinitionId: formDef.id,
        formName: formDef.name,
        signedByName: signedByName.trim(),
        signedBy: 'admin',
        note: note.trim() || undefined,
        signedAt: serverTimestamp(),
      };
      if (actorUid) sig.recordedByUid = actorUid;
      if (actorName) sig.recordedByName = actorName;
      await setDoc(doc(db, 'form_signatures', id), sig);
      await logActivity({
        clubId: player.clubId,
        kind: 'form_signed',
        playerId: player.id,
        actorUid,
        actorName,
        payload: { formName: formDef.name, signedByName: signedByName.trim() },
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-fire-950">Mark as signed</h2>
            <p className="text-[11px] text-slate-500">{formDef.name}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {formDef.body && (
            <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 p-3 text-xs text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {formDef.body}
            </div>
          )}
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Signed by</span>
            <input
              value={signedByName}
              onChange={(e) => setSignedByName(e.target.value)}
              placeholder="Full name of the parent/guardian who signed"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="e.g. Paper copy in office binder, signed in person at tryouts"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
            />
          </label>
          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!signedByName.trim() || saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Record signature'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Small bits ──────────────────────────────────────────────────

const Avatar: React.FC<{ player: any }> = ({ player }) => {
  if (player.profilePhotoUrl) {
    return <img src={player.profilePhotoUrl} alt="" className="w-24 h-24 rounded-full ring-2 ring-slate-100 object-cover shrink-0" />;
  }
  const initials = (player.name || '?').split(/\s+/).slice(0, 2).map((x: string) => x[0]?.toUpperCase()).join('');
  return (
    <div className="w-24 h-24 rounded-full bg-slate-200 ring-2 ring-slate-100 flex items-center justify-center text-slate-500 text-2xl font-black shrink-0">
      {initials}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    <div className="text-base font-black text-slate-900 mt-1 truncate">{value}</div>
  </div>
);

const Card: React.FC<{ title: string; icon?: React.ReactNode; subtitle?: string; badge?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }> = ({ title, icon, subtitle, badge, action, children }) => (
  <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="w-7 h-7 rounded bg-cyan-50 ring-1 ring-cyan-100 flex items-center justify-center text-cyan-600 shrink-0">{icon}</span>}
        <h2 className="font-bold text-slate-800 truncate">{title} {subtitle && <span className="text-[11px] text-slate-500 font-normal">{subtitle}</span>}</h2>
      </div>
      {badge}
    </div>
    <div className="p-4">{children}</div>
    {action && <div className="px-4 py-2 border-t border-slate-100 text-center">{action}</div>}
  </div>
);

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="py-2 flex items-center justify-between gap-2">
    <dt className="text-slate-500">{label}</dt>
    <dd className="text-slate-900 font-bold text-right">{value}</dd>
  </div>
);

const ActionLink: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button type="button" onClick={onClick} className="text-cyan-600 hover:text-cyan-800 text-xs font-bold">{children}</button>
);

const Empty: React.FC<{ text: string }> = ({ text }) => <p className="text-[11px] text-slate-500">{text}</p>;

const QuickAction: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl hover:bg-slate-50 transition"
  >
    <span className="w-10 h-10 rounded-full bg-cyan-50 ring-1 ring-cyan-100 text-cyan-600 flex items-center justify-center">{icon}</span>
    <span className="text-[10px] font-bold text-slate-700">{label}</span>
  </button>
);

const Dot: React.FC<{ color: 'emerald' | 'amber' | 'rose' | 'slate' }> = ({ color }) => (
  <span className={`w-2 h-2 rounded-full ${{ emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', slate: 'bg-slate-300' }[color]}`} />
);

const StatusBadge: React.FC<{ status: Registration['status'] }> = ({ status }) => {
  const map: Record<Registration['status'], string> = {
    pending_payment: 'bg-amber-100 text-amber-800 ring-amber-300',
    paid: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
    tryout_invited: 'bg-cyan-100 text-cyan-800 ring-cyan-300',
    offer_sent: 'bg-violet-100 text-violet-800 ring-violet-300',
    accepted: 'bg-emerald-100 text-emerald-900 ring-emerald-400',
    declined: 'bg-rose-100 text-rose-800 ring-rose-300',
    withdrawn: 'bg-slate-100 text-slate-700 ring-slate-300',
  };
  return <span className={`text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded ring-1 ${map[status]}`}>{statusLabel(status)}</span>;
};

const Donut: React.FC<{ total: number; present: number; excused: number; absent: number; unknown: number }> = ({ total, present, excused, absent }) => {
  const r = 28;
  const c = 2 * Math.PI * r;
  const t = Math.max(1, total);
  const segs = [
    { color: '#10b981', n: present },
    { color: '#f59e0b', n: excused },
    { color: '#f43f5e', n: absent },
  ];
  let offset = 0;
  const pct = Math.round((present / t) * 100);
  return (
    <div className="relative w-20 h-20 shrink-0">
      <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
        <circle cx="40" cy="40" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        {segs.map((s, i) => {
          if (s.n === 0) return null;
          const len = (s.n / t) * c;
          const el = <circle key={i} cx="40" cy="40" r={r} fill="none" stroke={s.color} strokeWidth="10" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-lg font-black text-slate-900 leading-none">{pct}%</div>
        <div className="text-[9px] text-slate-500 tabular-nums">{present}/{total}</div>
      </div>
    </div>
  );
};

function statusLabel(s: Registration['status']): string {
  switch (s) {
    case 'pending_payment': return 'Pending payment';
    case 'paid': return 'Paid';
    case 'tryout_invited': return 'Tryout invited';
    case 'offer_sent': return 'Offer sent';
    case 'accepted': return 'Accepted';
    case 'declined': return 'Declined';
    case 'withdrawn': return 'Withdrawn';
  }
}

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

// ── Icons ──────────────────────────────────────────────────────

const TeamIcon = () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
const ClipboardIcon = () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 2h6a2 2 0 0 1 2 2v0H7v0a2 2 0 0 1 2-2z"/><path d="M19 4h-2v2H7V4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/></svg>;
const DollarIcon = () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
const CalendarIcon = () => <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
const MsgIcon = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
const NoteIcon = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const UserPlusIcon = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>;
const TaskIcon = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;

export default PersonAdmin;
