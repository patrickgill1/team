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
import { useClubScopes } from '../hooks/useClubScopes';
import { useTeam } from '../contexts/TeamContext';
import { isClubAdmin, isCoach } from '../utils/helpers';
import { logActivity } from '../utils/activityLog';
import { computeEligibility, eligibilityTone, type EligibilityResult } from '../utils/eligibility';
import TransferPlayerModal from '../components/club/TransferPlayerModal';
import FunnelStepper from '../components/player/FunnelStepper';
import CreateTaskModal from '../components/club/CreateTaskModal';
import InvitePersonModal from '../components/people/InvitePersonModal';
import RefundModal from '../components/club/RefundModal';
import SplitInvoiceModal from '../components/club/SplitInvoiceModal';
import MedicalEditModal from '../components/club/MedicalEditModal';
import { deriveMedicalAlerts, type MedicalAlert } from '../utils/medical';
import { useFirestore } from '../hooks/useFirestore';
import { sendEmail } from '../utils/notify';
import type { Activity, FormDefinition, FormSignature, Installment, Registration } from '../types';

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
  // Resolve club scope for gating the Payments tab + refund modal.
  // Reads the user's first clubId (player's clubId is more accurate
  // but Payments is club-wide anyway).
  const userClubId = (userData as any)?.clubIds?.[0] || (userData as any)?.clubId || null;
  const { has: hasClubScopeCheck } = useClubScopes(userClubId);
  const canSeeFinancials = hasClubScopeCheck('financials');
  // TeamContext gives us the full list of teams the current user has
  // access to via the team picker (club-admin: every team in the
  // database; regular user: their teamIds[]). We union those into the
  // Move modal's team list because the clubId-based Firestore query
  // below misses teams that don't have a clubId set OR that belong to
  // a sibling club the user can still see. Patrick: 'still can't
  // assign this player to the other team in addition to primary team.'
  const { teams: contextTeams } = useTeam();
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
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [inviteGuardianOpen, setInviteGuardianOpen] = useState(false);
  const [paymentLink, setPaymentLink] = useState<{ url: string; registrationId: string } | null>(null);
  const [paymentLinkLoading, setPaymentLinkLoading] = useState(false);
  const [refundFor, setRefundFor] = useState<Registration | null>(null);
  const [splitFor, setSplitFor] = useState<Registration | null>(null);
  const [medicalOpen, setMedicalOpen] = useState(false);
  const { getOrCreateDMThread } = useFirestore() as any;

  // Load everything keyed off the playerId.
  const reload = async () => {
    if (!playerId) return;
    try {
      setLoading(true);
      const playerSnap = await getDoc(doc(db, 'players', playerId));
      if (!playerSnap.exists()) { setPlayer(null); return; }
      const p = { id: playerSnap.id, ...(playerSnap.data() as any) };
      setPlayer(p);

      // Teams — load ALL teams in the player's club (not just the
      // teams they're currently on). The Transfer/Share modal needs
      // the wider list so a coach can move/share into a sibling team
      // the player isn't yet a member of. If clubId isn't set anywhere,
      // fall back to all teams the user can read.
      const teamIds = Array.from(new Set([...(p.teamIds || []), p.teamId].filter(Boolean)));
      const teamIdsOnPlayer = teamIds;
      let teamList: Array<{ id: string; name?: string; ageGroup?: string; clubId?: string; isActive?: boolean }> = [];
      try {
        // Step 1: get the player's known teams so we can derive clubId
        // (and so they're guaranteed to appear in the list even without
        // a clubId on the player or team docs).
        const knownTeamDocs = await Promise.all(teamIdsOnPlayer.map(id => getDoc(doc(db, 'teams', id))));
        const knownTeams = knownTeamDocs
          .filter(d => d.exists())
          .map(d => ({ id: d.id, ...(d.data() as any) }));
        teamList.push(...knownTeams);
        const clubId = (p as any).clubId
          || knownTeams.find((t: any) => t.clubId)?.clubId
          || (userData as any)?.clubId;
        if (clubId) {
          const { collection, getDocs, query, where } = await import('firebase/firestore');
          const snap = await getDocs(query(
            collection(db, 'teams'),
            where('clubId', '==', clubId),
          ));
          snap.forEach((d) => {
            if (!teamList.some(t => t.id === d.id)) {
              teamList.push({ id: d.id, ...(d.data() as any) });
            }
          });
        }
        // Drop archived teams from the picker.
        teamList = teamList.filter((t: any) => t.isActive !== false);
        teamList.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
      } catch (err) {
        console.warn('PersonAdmin: club-wide team load failed, using player teams only', err);
        // Fallback: at least show the teams the player is on so the
        // existing "Currently on" chips render.
        if (teamList.length === 0) {
          const knownTeamDocs = await Promise.all(teamIdsOnPlayer.map(id => getDoc(doc(db, 'teams', id))));
          teamList = knownTeamDocs.filter(d => d.exists()).map(d => ({ id: d.id, ...(d.data() as any) }));
        }
      }
      setTeams(teamList);

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

  // Critical / warning / info alerts derived from the medical profile.
  // The critical + warning rows render in a banner above the player
  // header so coaches see them at the top of every view.
  const medicalAlerts = useMemo<MedicalAlert[]>(() => deriveMedicalAlerts(player?.medical), [player]);

  // One boolean a coach can scan before tomorrow's practice. Combines
  // team assignment + payment state + required-form signatures.
  const eligibility = useMemo<EligibilityResult>(() => computeEligibility({
    player: { teamId: player?.teamId, teamIds: player?.teamIds },
    registrations,
    forms: applicableForms,
    formSigs,
  }), [player, registrations, applicableForms, formSigs]);

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
    return <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">Coaches + club admins only.</div>;
  }

  if (loading && !player) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-bone/50 text-sm">Loading…</div>;
  }

  if (!player) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">
        <div className="text-center">
          <p>Player not found.</p>
          <button type="button" onClick={() => navigate(-1)} className="mt-2 text-brand-primary hover:text-brand-primary-soft text-xs font-bold">← Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950">
      {/* Header strip */}
      <section className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 sm:px-6 pt-4 pb-0 border-b border-brand-primary/10">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between gap-2 mb-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 ring-1 ring-white/15 text-bone text-xs font-bold hover:bg-white/15 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
            <button
              type="button"
              onClick={() => navigate('/club')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft text-xs font-bold hover:bg-brand-primary/25 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Club
            </button>
          </div>
          {/* Tab bar */}
          <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-0">
            {TABS.filter(t => t.key !== 'payments' || canSeeFinancials).map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`shrink-0 px-3 py-2 text-[11px] font-extrabold tracking-widest uppercase border-b-2 transition ${
                  tab === t.key
                    ? 'text-brand-primary-soft border-brand-primary-soft'
                    : 'text-bone/40 border-transparent hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Critical medical alerts — render first so coaches see them
          on every tab, not just Overview. */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-4">
        <MedicalAlertsBanner alerts={medicalAlerts} />
      </div>

      {/* Player ID card */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-5 flex items-start gap-5">
          <Avatar player={player} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-black text-bone leading-tight">{player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim()}</h1>
              <span className="inline-block px-2 py-0.5 rounded bg-brand-primary text-white text-[10px] font-extrabold tracking-widest uppercase">Player</span>
              <EligibilityPill result={eligibility} />
            </div>
            <p className="text-sm text-bone/50 mt-0.5">
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
            onAddGuardian={() => setInviteGuardianOpen(true)}
            onMessage={async () => {
              const primary = guardians.find(g => g.uid);
              if (!primary?.uid) { alert('No guardian with a GoalKickr account to DM yet. Use Add Guardian first.'); return; }
              if (!userData?.uid) return;
              try {
                const threadId = await getOrCreateDMThread({
                  teamId: player.teamId || teams[0]?.id || '',
                  me: { uid: userData.uid, name: userData.name || 'Admin' },
                  other: { uid: primary.uid, name: primary.name || 'Guardian' },
                });
                navigate(`/chat?thread=${threadId}`);
              } catch (err) {
                console.warn('DM open failed', err);
                alert("Couldn't open the DM thread — try from the chat page directly.");
              }
            }}
            onAddNote={() => setAddNoteOpen(true)}
            onCreateTask={() => setCreateTaskOpen(true)}
            onSignForm={(id) => setSignFormId(id)}
            onManageForms={() => navigate('/club/forms')}
            onGeneratePaymentLink={async () => {
              if (!latestRegistration || (payments?.balanceCents ?? 0) <= 0) return;
              setPaymentLinkLoading(true);
              try {
                const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
                const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
                if (!NOTIFY_URL || !NOTIFY_SECRET) { alert('Worker not configured.'); return; }
                const r = await fetch(`${NOTIFY_URL}/stripe/registration-checkout`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
                  body: JSON.stringify({ registrationId: latestRegistration.id }),
                });
                const data: any = await r.json().catch(() => ({}));
                if (!r.ok) {
                  alert(data?.error === 'club-not-stripe-ready'
                    ? 'Club Stripe Connect setup not complete yet. See worker/README.md §6.'
                    : data?.error || 'Could not generate link.');
                  return;
                }
                setPaymentLink({ url: data.url, registrationId: latestRegistration.id });
              } finally {
                setPaymentLinkLoading(false);
              }
            }}
            paymentLinkLoading={paymentLinkLoading}
            eligibility={eligibility}
            onOpenMedical={() => setMedicalOpen(true)}
            medicalAlerts={medicalAlerts}
            actorUid={userData?.uid}
          />
        )}

        {tab === 'teams' && <TeamsTab player={player} teams={teams} onAssignTeam={() => setTransferOpen(true)} />}
        {tab === 'registration' && <RegistrationTab registrations={registrations} />}
        {tab === 'payments' && canSeeFinancials && (
          <PaymentsTab
            registrations={registrations}
            actorUid={userData?.uid}
            actorName={userData?.name}
            onRefund={(r) => setRefundFor(r)}
            onSplit={(r) => setSplitFor(r)}
            onReload={reload}
          />
        )}
        {tab === 'payments' && !canSeeFinancials && (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-center text-sm text-bone/60">
            You don't have access to financials. Ask the club owner for the 'financials' scope.
          </div>
        )}
        {tab === 'notes' && (
          <NotesTab
            activities={activities}
            onAddNote={() => setAddNoteOpen(true)}
          />
        )}
        {tab === 'communications' && <CommunicationsTab activities={activities} />}
        {tab === 'activity' && <ActivityTab activities={activities} />}
      </div>

      {transferOpen && (
        <TransferPlayerModal
          isOpen
          onClose={() => setTransferOpen(false)}
          player={{ id: player.id, name: player.name, teamId: player.teamId, teamIds: player.teamIds }}
          teams={(() => {
            // Union the player-club-scoped teams (PersonAdmin's own
            // load, gated by clubId match) with the teams the current
            // user already has access to (TeamContext, which surfaces
            // them via the team picker). The clubId query misses
            // legacy teams that have no clubId set OR sibling clubs;
            // TeamContext covers both gaps.
            const byId = new Map<string, any>();
            for (const t of teams) if (t?.id) byId.set(t.id, t);
            for (const t of contextTeams || []) {
              if (t?.id && t.isActive !== false && !byId.has(t.id)) byId.set(t.id, t);
            }
            return Array.from(byId.values())
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
              .map(t => ({ id: t.id, name: t.name, ageGroup: t.ageGroup }));
          })()}
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

      {createTaskOpen && player.clubId && userData?.uid && (
        <CreateTaskModal
          clubId={player.clubId}
          actorUid={userData.uid}
          actorName={userData.name || 'Admin'}
          relatedPlayer={{ id: player.id, name: player.name }}
          relatedTeamId={player.teamId}
          onClose={() => setCreateTaskOpen(false)}
          onCreated={() => { setCreateTaskOpen(false); void reload(); }}
        />
      )}

      {inviteGuardianOpen && userData?.uid && (
        <InvitePersonModal
          clubTeams={teams as any}
          clubPlayers={[player as any]}
          currentUid={userData.uid}
          defaultPlayerId={player.id}
          defaultKind="parent"
          onClose={() => { setInviteGuardianOpen(false); void reload(); }}
        />
      )}

      {refundFor && userData?.uid && (
        <RefundModal
          registration={refundFor}
          actorUid={userData.uid}
          actorName={userData.name || 'Admin'}
          onClose={() => setRefundFor(null)}
          onRefunded={() => { setRefundFor(null); void reload(); }}
        />
      )}

      {splitFor && userData?.uid && (
        <SplitInvoiceModal
          registration={splitFor}
          actorUid={userData.uid}
          actorName={userData.name || 'Admin'}
          onClose={() => setSplitFor(null)}
          onSaved={() => { setSplitFor(null); void reload(); }}
        />
      )}

      {medicalOpen && userData?.uid && (
        <MedicalEditModal
          player={player}
          actorUid={userData.uid}
          actorName={userData.name || 'Admin'}
          onClose={() => setMedicalOpen(false)}
          onSaved={() => { setMedicalOpen(false); void reload(); }}
        />
      )}

      {paymentLink && (
        <PaymentLinkModal
          link={paymentLink.url}
          registrationId={paymentLink.registrationId}
          parentEmail={guardians[0]?.email || latestRegistration?.parents?.[0]?.email}
          playerName={player.name}
          actorUid={userData?.uid}
          actorName={userData?.name}
          clubId={player.clubId}
          onClose={() => setPaymentLink(null)}
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
  onGeneratePaymentLink: () => void;
  paymentLinkLoading: boolean;
  eligibility: EligibilityResult;
  onOpenMedical: () => void;
  medicalAlerts: MedicalAlert[];
  actorUid?: string;
}

const OverviewBody: React.FC<OverviewProps> = ({ player, teams, guardians, registration, payments, attendance, forms, formSigs, onAssignTeam, onAddGuardian, onMessage, onAddNote, onCreateTask, onSignForm, onManageForms, onGeneratePaymentLink, paymentLinkLoading, eligibility, onOpenMedical, medicalAlerts, actorUid }) => {
  const primaryTeamId = player.teamId || teams[0]?.id;
  return (
    <div className="space-y-4">
      {/* Recruitment funnel — the at-a-glance "where is this kid in
          the pipeline." Sits ABOVE eligibility because most kids in
          PersonAdmin are mid-funnel; ready-to-play is the back half. */}
      <FunnelStepper
        playerId={player.id}
        progress={player.funnelProgress}
        canEdit
        actorUid={actorUid}
      />

      {/* Eligibility — the one thing a coach scans before the next practice. */}
      <EligibilityCard result={eligibility} />

      {/* Medical — full-width because critical alerts deserve room. */}
      <MedicalSummaryCard player={player} alerts={medicalAlerts} onEdit={onOpenMedical} />

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
                    <div className="w-7 h-7 rounded bg-charcoal-950 ring-1 ring-white/10 flex items-center justify-center shrink-0">
                      {t.logoUrl ? <img src={t.logoUrl} alt="" className="w-full h-full object-cover rounded" /> : <svg className="w-4 h-4 text-bone/40" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-bone truncate">{t.name}</div>
                      <div className="text-[11px] text-bone/50">{t.id === primaryTeamId ? 'Primary team' : 'Additional'}</div>
                    </div>
                  </div>
                  <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${
                    t.id === primaryTeamId
                      ? 'bg-brand-primary/15 text-bone/85 ring-brand-primary-soft'
                      : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
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
                  <div className="w-8 h-8 rounded-full bg-brand-primary/20 text-brand-primary-soft font-bold flex items-center justify-center shrink-0 text-xs">
                    {(g.name || '?').split(/\s+/).slice(0, 2).map((x: string) => x[0]?.toUpperCase()).join('')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-bone">{g.name}</span>
                      <span className="text-[10px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-charcoal-950 text-bone/65 ring-1 ring-white/10">
                        {(g.role || 'parent').replace('_', ' ')}
                      </span>
                    </div>
                    {g.phoneNumber && <div className="text-[11px] text-bone/65 mt-0.5">{g.phoneNumber}</div>}
                    {g.email && <div className="text-[11px] text-bone/50 truncate">{g.email}</div>}
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
            <dl className="text-sm divide-y divide-white/5">
              <Field label="Season" value={registration.seasonId || '—'} />
              <Field label="Status" value={statusLabel(registration.status)} />
              <Field label="Product" value={registration.productName || '—'} />
              {registration.customAnswers && Object.keys(registration.customAnswers).length > 0 && (
                <div className="py-2">
                  <dt className="text-[11px] font-bold uppercase tracking-widest text-bone/50 mb-1">Custom answers</dt>
                  <dd className="text-[11px] text-bone/85 space-y-0.5">
                    {Object.entries(registration.customAnswers).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-bone/50">{registration.customAnswerLabels?.[k] || k}:</span>{' '}
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
          badge={payments?.balanceCents ? <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-amber-500/20 text-amber-200 ring-1 ring-amber-300">Pending</span> : payments ? <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-300">Paid</span> : undefined}
        >
          {!payments ? (
            <Empty text="No invoice activity yet." />
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] text-bone/50">Balance Due</div>
                  <div className="text-3xl font-black text-bone leading-none mt-1">${(payments.balanceCents / 100).toFixed(2)}</div>
                </div>
                {payments.balanceCents > 0 && (
                  <button
                    type="button"
                    disabled={paymentLinkLoading}
                    onClick={onGeneratePaymentLink}
                    className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-xs font-bold"
                  >
                    {paymentLinkLoading ? 'Working…' : 'View & Pay'}
                  </button>
                )}
              </div>
              {payments.lastPaidAt && (
                <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-[11px]">
                  <div>
                    <div className="text-bone/50">Recent Payment</div>
                    <div className="text-bone/85 font-bold">${(payments.lastPaidCents / 100).toFixed(2)} <span className="text-bone/40">· {payments.lastPaidAt.toLocaleDateString()}</span></div>
                  </div>
                  <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30">Paid</span>
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
                {attendance.unknown > 0 && <li className="flex items-center justify-between text-bone/40"><span className="flex items-center gap-1.5"><Dot color="slate" /> No RSVP</span><span className="tabular-nums">{attendance.unknown}</span></li>}
              </ul>
            </div>
          )}
        </Card>

        {/* Forms Checklist */}
        <Card title="Forms Checklist" icon={<ClipboardIcon />} action={<ActionLink onClick={onManageForms}>Manage Forms</ActionLink>}>
          {forms.length === 0 ? (
            <Empty text="No forms defined for this club yet." />
          ) : (
            <ul className="divide-y divide-white/5">
              {forms.map(f => {
                const sig = formSigs.get(f.id);
                const signed = !!sig;
                return (
                  <li key={f.id} className="py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-bone/90 truncate">{f.name}</div>
                      {sig && <div className="text-[10px] text-bone/50">Signed by {sig.signedByName} · {toDate(sig.signedAt).toLocaleDateString()}</div>}
                    </div>
                    {signed ? (
                      <span className="text-[10px] font-extrabold tracking-widest uppercase text-emerald-300 flex items-center gap-1 shrink-0">
                        Signed
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSignForm(f.id)}
                        className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${
                          f.required
                            ? 'bg-rose-500/15 text-rose-300 ring-rose-200 hover:bg-rose-500/20'
                            : 'bg-amber-500/15 text-amber-300 ring-amber-400/30 hover:bg-amber-500/20'
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
      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-4">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-brand-primary" fill="currentColor" viewBox="0 0 24 24"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/85">Quick Actions</span>
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

// ── Medical bits ─────────────────────────────────────────────

const MedicalAlertsBanner: React.FC<{ alerts: MedicalAlert[] }> = ({ alerts }) => {
  // Show critical + warning only at the top of every tab. Info-level
  // (active meds, expired physical) lives on the Overview card.
  const surfaced = alerts.filter(a => a.level === 'critical' || a.level === 'warning');
  if (surfaced.length === 0) return null;
  return (
    <div className="mb-3 space-y-1.5">
      {surfaced.map((a, i) => {
        const isCrit = a.level === 'critical';
        return (
          <div
            key={i}
            className={`rounded-xl ring-1 p-3 flex items-start gap-3 ${
              isCrit ? 'bg-rose-500/15 ring-rose-300' : 'bg-amber-500/15 ring-amber-300'
            }`}
          >
            <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isCrit ? 'bg-rose-500' : 'bg-amber-500'}`}>
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-bold ${isCrit ? 'text-rose-900' : 'text-amber-900'}`}>{a.title}</div>
              {a.detail && <div className={`text-[11px] mt-0.5 ${isCrit ? 'text-rose-800' : 'text-amber-200'}`}>{a.detail}</div>}
            </div>
            <span className={`text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded ring-1 shrink-0 ${isCrit ? 'bg-charcoal-900 text-rose-300 ring-rose-300' : 'bg-charcoal-900 text-amber-200 ring-amber-300'}`}>
              {isCrit ? 'Critical' : 'Warning'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const MedicalSummaryCard: React.FC<{ player: any; alerts: MedicalAlert[]; onEdit: () => void }> = ({ player, alerts, onEdit }) => {
  const m = player?.medical;
  const allergyCount = m?.allergies?.length || 0;
  const conditionCount = m?.conditions?.length || 0;
  const medCount = m?.medications?.length || 0;
  const concussionCount = m?.concussions?.length || 0;
  const hasEpiPen = (m?.allergies || []).some((a: any) => a.hasEpiPen);
  const activeConcussion = (m?.concussions || []).find((c: any) => !c.clearedToReturnAt);
  const lastPhysical = m?.lastPhysicalAt;
  const isEmpty = !m && !player?.medicalInfo;

  const critCount = alerts.filter(a => a.level === 'critical').length;
  const warnCount = alerts.filter(a => a.level === 'warning').length;

  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded bg-rose-500/15 ring-1 ring-rose-100 flex items-center justify-center text-rose-300 shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>
          </span>
          <h2 className="font-bold text-bone/90">Medical</h2>
          {hasEpiPen && (
            <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-rose-500 text-white">
              EpiPen
            </span>
          )}
          {activeConcussion && (
            <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded bg-rose-500 text-white">
              Concussion · not cleared
            </span>
          )}
        </div>
        <button type="button" onClick={onEdit} className="text-xs font-bold text-brand-primary-soft hover:text-brand-primary-dim">
          {isEmpty ? '+ Add medical' : 'Edit'}
        </button>
      </div>
      <div className="p-4">
        {isEmpty ? (
          <p className="text-[11px] text-bone/50">
            No medical profile on file. Add at minimum an allergies row ("No known allergies" works) + a primary-care contact.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <Tile label="Allergies" value={String(allergyCount)} />
              <Tile label="Conditions" value={String(conditionCount)} />
              <Tile label="Meds" value={String(medCount)} />
              <Tile label="Concussions" value={String(concussionCount)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-bone/65">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-bone/40">Last physical</div>
                <div className="font-bold text-bone/90">{lastPhysical ? toDate(lastPhysical).toLocaleDateString() : '—'}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-bone/40">Primary care</div>
                <div className="font-bold text-bone/90 truncate">{m?.primaryCare?.name || '—'}{m?.primaryCare?.phone ? ` · ${m.primaryCare.phone}` : ''}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-bone/40">Insurance</div>
                <div className="font-bold text-bone/90 truncate">{m?.insurance?.carrier || '—'}</div>
              </div>
            </div>
            {(critCount > 0 || warnCount > 0) && (
              <div className="mt-3 text-[11px] text-bone/50">
                {critCount > 0 && <span className="text-rose-300 font-bold">{critCount} critical alert{critCount === 1 ? '' : 's'}</span>}
                {critCount > 0 && warnCount > 0 && ' · '}
                {warnCount > 0 && <span className="text-amber-300 font-bold">{warnCount} warning{warnCount === 1 ? '' : 's'}</span>}
              </div>
            )}
            {player?.medicalInfo && !m && (
              <div className="mt-3 rounded-lg bg-amber-500/15 ring-1 ring-amber-300 px-3 py-2 text-[11px] text-amber-900">
                Legacy medical notes on file. Open Edit to fold them into structured fields.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ── Eligibility bits ──────────────────────────────────────────

const EligibilityPill: React.FC<{ result: EligibilityResult }> = ({ result }) => {
  const tone = eligibilityTone(result.status);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded ring-1 ${tone.bg} ${tone.text} ${tone.ring}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
      <span className="text-[10px] font-extrabold tracking-widest uppercase">{tone.label}</span>
    </span>
  );
};

const EligibilityCard: React.FC<{ result: EligibilityResult }> = ({ result }) => {
  const tone = eligibilityTone(result.status);
  return (
    <div className={`rounded-2xl ring-1 p-4 ${tone.bg} ${tone.ring}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${tone.dot}`} />
          <h2 className={`font-black ${tone.text}`}>{tone.label}</h2>
        </div>
        <span className={`text-[10px] font-extrabold tracking-widest uppercase ${tone.text} opacity-70`}>
          {result.passedCount} / {result.totalCount} ready
        </span>
      </div>
      <ul className="space-y-1.5">
        {result.gates.map((g, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${g.ok ? 'bg-emerald-500 text-white' : 'bg-charcoal-900 ring-1 ring-white/15 text-transparent'}`}>
              {g.ok && <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>}
            </span>
            <div className="flex-1 min-w-0">
              <div className={g.ok ? 'text-bone/85' : 'text-bone font-bold'}>{g.label}</div>
              {g.hint && !g.ok && <div className="text-[11px] text-bone/50 mt-0.5">{g.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ── Tab bodies ─────────────────────────────────────────────────

const TeamsTab: React.FC<{ player: any; teams: any[]; onAssignTeam: () => void }> = ({ player, teams, onAssignTeam }) => {
  const primaryId = player.teamId || teams[0]?.id;
  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <h2 className="font-bold text-bone/90">Team assignments</h2>
        <button type="button" onClick={onAssignTeam} className="text-xs font-bold text-brand-primary-soft hover:text-brand-primary-dim">+ Assign / transfer</button>
      </div>
      {teams.length === 0 ? (
        <div className="p-6 text-center text-sm text-bone/50">Not on any team yet.</div>
      ) : (
        <ul className="divide-y divide-white/5">
          {teams.map(t => (
            <li key={t.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded bg-charcoal-950 ring-1 ring-white/10 flex items-center justify-center shrink-0 overflow-hidden">
                  {t.logoUrl ? <img src={t.logoUrl} alt="" className="w-full h-full object-cover" /> : <svg className="w-5 h-5 text-bone/40" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-bone truncate">{t.name}</div>
                  <div className="text-[11px] text-bone/50">
                    {t.ageGroup ? `${t.ageGroup} · ` : ''}{t.season || ''} {t.league ? `· ${t.league}` : ''}
                  </div>
                </div>
              </div>
              <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${
                t.id === primaryId ? 'bg-brand-primary/15 text-bone/85 ring-brand-primary-soft' : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
              }`}>
                {t.id === primaryId ? 'Primary' : 'Additional'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const RegistrationTab: React.FC<{ registrations: Registration[] }> = ({ registrations }) => {
  if (registrations.length === 0) {
    return <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">No registrations on file.</div>;
  }
  return (
    <div className="space-y-3">
      {registrations.map(r => (
        <div key={r.id} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-2">
            <div>
              <div className="font-bold text-bone">{r.productName || 'Registration'}</div>
              <div className="text-[11px] text-bone/50">Submitted {toDate(r.createdAt).toLocaleDateString()}</div>
            </div>
            <StatusBadge status={r.status} />
          </div>
          <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Mini label="Season" value={r.seasonId || '—'} />
            <Mini label="Tier" value={r.pricingTierLabel || '—'} />
            <Mini label="Fee" value={`$${((r.amountPaidCents ?? r.registrationFeeCents ?? 0) / 100).toFixed(2)}`} />
            <Mini label="Coupon" value={r.couponCode || '—'} />
          </div>
          {r.customAnswers && Object.keys(r.customAnswers).length > 0 && (
            <div className="px-4 pb-4">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mb-1">Custom answers</div>
              <ul className="text-[11px] text-bone/85 space-y-0.5">
                {Object.entries(r.customAnswers).map(([k, v]) => (
                  <li key={k}>
                    <span className="text-bone/50">{r.customAnswerLabels?.[k] || k}:</span>{' '}
                    <span className="font-bold">{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.parents?.[0]?.email && (
            <div className="px-4 py-2 border-t border-white/5 text-center">
              <Link to={`/club/family/${encodeURIComponent(r.parents[0].email.toLowerCase())}`} className="text-xs font-bold text-brand-primary-soft hover:text-brand-primary-dim">
                Full family timeline →
              </Link>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const PaymentsTab: React.FC<{
  registrations: Registration[];
  actorUid?: string;
  actorName?: string;
  onRefund: (r: Registration) => void;
  onSplit: (r: Registration) => void;
  onReload: () => Promise<void>;
}> = ({ registrations, actorUid, actorName, onRefund, onSplit, onReload }) => {
  const rows = registrations.map(r => {
    const isPaid = r.status === 'paid' || r.status === 'tryout_invited' || r.status === 'offer_sent' || r.status === 'accepted';
    const refundsCents = (r.refunds || [])
      .filter(rr => rr.status !== 'failed' && rr.status !== 'canceled')
      .reduce((sum, rr) => sum + (rr.amountCents || 0), 0);
    return {
      id: r.id,
      raw: r,
      label: r.productName || 'Registration',
      amountCents: r.amountPaidCents ?? r.registrationFeeCents ?? 0,
      surchargeCents: r.stripeSurchargeCents || 0,
      refundsCents,
      paid: isPaid,
      paidAt: r.paidAt ? toDate(r.paidAt) : null,
      stripePaymentIntentId: r.stripePaymentIntentId,
      couponCode: r.couponCode,
      createdAt: toDate(r.createdAt),
    };
  });
  const totalPaid = rows.filter(r => r.paid).reduce((sum, r) => sum + r.amountCents, 0);
  const totalRefunded = rows.reduce((sum, r) => sum + r.refundsCents, 0);
  const totalOwed = rows.filter(r => !r.paid).reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Total paid" value={`$${(totalPaid / 100).toFixed(2)}`} />
        <Tile label="Refunded" value={`$${(totalRefunded / 100).toFixed(2)}`} />
        <Tile label="Balance" value={`$${(totalOwed / 100).toFixed(2)}`} />
      </div>
      {rows.length === 0 ? (
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">No payment history.</div>
      ) : (
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <h2 className="font-bold text-bone/90">Invoices</h2>
          </div>
          <ul className="divide-y divide-white/5">
            {rows.map(r => {
              const netCents = r.amountCents - r.refundsCents;
              const fullyRefunded = r.refundsCents > 0 && netCents <= 0;
              const canRefund = r.paid && !!r.stripePaymentIntentId && !fullyRefunded;
              return (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-bone">{r.label}</div>
                      <div className="text-[11px] text-bone/50">
                        {r.createdAt.toLocaleDateString()}
                        {r.couponCode && <span className="text-violet-600 font-bold"> · {r.couponCode}</span>}
                        {r.stripePaymentIntentId && <span className="text-bone/40"> · {r.stripePaymentIntentId.slice(0, 12)}…</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-black text-bone tabular-nums">${(r.amountCents / 100).toFixed(2)}</div>
                      <span className={`text-[10px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded ring-1 ${
                        fullyRefunded ? 'bg-rose-500/15 text-rose-300 ring-rose-200'
                          : r.refundsCents > 0 ? 'bg-amber-500/15 text-amber-300 ring-amber-400/30'
                          : r.paid ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
                          : 'bg-amber-500/15 text-amber-300 ring-amber-400/30'
                      }`}>
                        {fullyRefunded ? 'Refunded' : r.refundsCents > 0 ? 'Partial refund' : r.paid ? 'Paid' : 'Pending'}
                      </span>
                    </div>
                  </div>
                  {r.refundsCents > 0 && (
                    <div className="mt-2 pl-3 border-l-2 border-rose-400/30 text-[11px] space-y-1">
                      {(r.raw.refunds || []).map(rr => (
                        <div key={rr.id} className="flex items-center justify-between text-bone/65">
                          <span>
                            {rr.refundedByName || 'System'} · {toDate(rr.refundedAt).toLocaleDateString()}
                            {rr.reason && <span className="text-bone/40"> · {rr.reason}</span>}
                          </span>
                          <span className="font-bold tabular-nums text-rose-300">-${((rr.amountCents || 0) / 100).toFixed(2)} <span className="text-bone/40">({rr.status})</span></span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(r.raw.installments && r.raw.installments.length > 0) && (
                    <InstallmentList
                      registration={r.raw}
                      actorUid={actorUid}
                      actorName={actorName}
                      onReload={onReload}
                    />
                  )}
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    {!r.paid && !r.raw.installments?.length && (
                      <button
                        type="button"
                        onClick={() => onSplit(r.raw)}
                        className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-charcoal-900 text-brand-primary-soft ring-1 ring-brand-primary-soft hover:bg-brand-primary/15"
                      >
                        Split into installments
                      </button>
                    )}
                    {r.raw.installments && r.raw.installments.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onSplit(r.raw)}
                        className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-charcoal-900 text-brand-primary-soft ring-1 ring-brand-primary-soft hover:bg-brand-primary/15"
                      >
                        Edit plan
                      </button>
                    )}
                    {canRefund && (
                      <button
                        type="button"
                        onClick={() => onRefund(r.raw)}
                        className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-1 rounded bg-charcoal-900 text-rose-300 ring-1 ring-rose-200 hover:bg-rose-500/15"
                      >
                        {r.refundsCents > 0 ? 'Refund more' : 'Refund'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

// Per-registration installment list. Each row shows its own status +
// inline actions: Send link (generates a Stripe Checkout URL for just
// that installment), Mark paid (manual override), Waive (no charge).
const InstallmentList: React.FC<{
  registration: Registration;
  actorUid?: string;
  actorName?: string;
  onReload: () => Promise<void>;
}> = ({ registration, actorUid, actorName, onReload }) => {
  const installments = registration.installments || [];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const sendLink = async (inst: Installment) => {
    setBusyId(inst.id);
    try {
      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
      const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
      if (!NOTIFY_URL || !NOTIFY_SECRET) { alert('Worker not configured.'); return; }
      const r = await fetch(`${NOTIFY_URL}/stripe/registration-checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
        body: JSON.stringify({ registrationId: registration.id, installmentId: inst.id }),
      });
      const data: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(data?.error === 'club-not-stripe-ready'
          ? 'Club Stripe Connect not set up yet.'
          : data?.error || 'Could not generate link.');
        return;
      }
      setLinkFor({ id: inst.id, url: data.url });
    } finally {
      setBusyId(null);
    }
  };

  const markPaid = async (inst: Installment) => {
    if (!window.confirm(`Mark "${inst.label}" as paid manually? Use this only for cash/check — Stripe payments mark themselves automatically.`)) return;
    setBusyId(inst.id);
    try {
      const next = installments.map(i => i.id === inst.id
        ? { ...i, status: 'paid' as const, paidAt: new Date() }
        : i);
      const allDone = next.every(i => i.status === 'paid' || i.status === 'waived');
      const patch: Record<string, any> = { installments: next, updatedAt: serverTimestamp() };
      if (allDone) { patch.status = 'paid'; patch.paidAt = serverTimestamp(); }
      await updateDoc(doc(db, 'registrations', registration.id), patch);
      await logActivity({
        clubId: registration.clubId,
        kind: 'installment_paid',
        registrationId: registration.id,
        seasonId: registration.seasonId,
        actorUid,
        actorName,
        payload: { installmentId: inst.id, label: inst.label, amountCents: inst.amountCents, manual: true },
      });
      await onReload();
    } finally {
      setBusyId(null);
    }
  };

  const waive = async (inst: Installment) => {
    const reason = window.prompt(`Waive "${inst.label}"? Optional reason for the audit log:`);
    if (reason === null) return;
    setBusyId(inst.id);
    try {
      const next = installments.map(i => i.id === inst.id
        ? {
            ...i,
            status: 'waived' as const,
            waivedAt: new Date(),
            waivedBy: actorUid,
            waivedByName: actorName,
            waivedReason: reason.trim() || undefined,
          }
        : i);
      const allDone = next.every(i => i.status === 'paid' || i.status === 'waived');
      const patch: Record<string, any> = { installments: next, updatedAt: serverTimestamp() };
      if (allDone) { patch.status = 'paid'; patch.paidAt = serverTimestamp(); }
      await updateDoc(doc(db, 'registrations', registration.id), patch);
      await logActivity({
        clubId: registration.clubId,
        kind: 'installment_waived',
        registrationId: registration.id,
        seasonId: registration.seasonId,
        actorUid,
        actorName,
        payload: { installmentId: inst.id, label: inst.label, amountCents: inst.amountCents, reason: reason.trim() || undefined },
      });
      await onReload();
    } finally {
      setBusyId(null);
    }
  };

  if (installments.length === 0) return null;
  return (
    <div className="mt-3 pl-3 border-l-2 border-brand-primary-soft/30 space-y-1.5">
      {installments.map(inst => {
        const due = inst.dueDate ? toDate(inst.dueDate) : null;
        const overdue = inst.status === 'pending' && due && due.getTime() < Date.now();
        return (
          <div key={inst.id} className="text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-bold text-bone">
                  {inst.label}
                  <span className="ml-2 text-bone/40 font-normal tabular-nums">${((inst.amountCents || 0) / 100).toFixed(2)}</span>
                </div>
                {due && (
                  <div className={`text-[10px] ${overdue ? 'text-amber-300 font-bold' : 'text-bone/50'}`}>
                    Due {due.toLocaleDateString()}{overdue ? ' · overdue' : ''}
                  </div>
                )}
                {inst.status === 'waived' && inst.waivedReason && (
                  <div className="text-[10px] text-bone/50 italic">Waived: {inst.waivedReason}</div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className={`text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded ring-1 ${
                  inst.status === 'paid' ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
                  : inst.status === 'waived' ? 'bg-charcoal-950 text-bone/65 ring-white/15'
                  : overdue ? 'bg-amber-500/15 text-amber-300 ring-amber-400/30'
                  : 'bg-charcoal-900 text-bone/65 ring-white/10'
                }`}>{inst.status}</span>
                {inst.status === 'pending' && (
                  <>
                    <button type="button" disabled={busyId === inst.id} onClick={() => sendLink(inst)} className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50">
                      Link
                    </button>
                    <button type="button" disabled={busyId === inst.id} onClick={() => markPaid(inst)} className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-charcoal-900 text-emerald-300 ring-1 ring-emerald-400/30 hover:bg-emerald-500/15">
                      Mark paid
                    </button>
                    <button type="button" disabled={busyId === inst.id} onClick={() => waive(inst)} className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-charcoal-900 text-bone/65 ring-1 ring-white/10 hover:bg-white/[0.05]">
                      Waive
                    </button>
                  </>
                )}
              </div>
            </div>
            {linkFor?.id === inst.id && (
              <div className="mt-1 rounded bg-brand-primary/15 ring-1 ring-brand-primary-soft p-2">
                <div className="text-[10px] text-bone/85 font-mono break-all">{linkFor.url}</div>
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" onClick={async () => {
                    try { await navigator.clipboard.writeText(linkFor.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
                  }} className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-brand-primary text-white hover:bg-brand-primary">
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <a href={linkFor.url} target="_blank" rel="noopener noreferrer" className="text-[9px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded bg-charcoal-900 ring-1 ring-brand-primary-soft text-brand-primary-soft">
                    Open
                  </a>
                  <button type="button" onClick={() => setLinkFor(null)} className="text-[9px] text-bone/50 hover:text-bone/90 ml-auto">
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const NotesTab: React.FC<{ activities: Activity[]; onAddNote: () => void }> = ({ activities, onAddNote }) => {
  const notes = activities.filter(a => a.kind === 'note_added' && a.payload?.note);
  return (
    <div className="space-y-3">
      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-4 flex items-center justify-between">
        <div className="text-sm text-bone/65">{notes.length} note{notes.length === 1 ? '' : 's'} on file.</div>
        <button type="button" onClick={onAddNote} className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary text-white text-sm font-bold">+ Add note</button>
      </div>
      {notes.length === 0 ? (
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">No notes yet — add one for the rest of the staff to see.</div>
      ) : (
        <ul className="space-y-2">
          {notes.map(a => {
            const ts = toDate(a.createdAt);
            return (
              <li key={a.id} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-4">
                <div className="flex items-center gap-2 text-[11px] text-bone/50 mb-1">
                  <span className="font-bold text-bone/85">{a.actorName || 'Staff'}</span>
                  <span>· {ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p className="text-sm text-bone/90 whitespace-pre-wrap">{a.payload?.note}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const CommunicationsTab: React.FC<{ activities: Activity[] }> = ({ activities }) => {
  const comms = activities.filter(a => a.kind === 'email_sent');
  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5">
        <h2 className="font-bold text-bone/90">Emails sent</h2>
      </div>
      {comms.length === 0 ? (
        <div className="p-6 text-center text-sm text-bone/50">No emails on record for this family.</div>
      ) : (
        <ul className="divide-y divide-white/5">
          {comms.map(a => {
            const ts = toDate(a.createdAt);
            return (
              <li key={a.id} className="px-4 py-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-bone truncate">{a.payload?.subject || '(no subject)'}</div>
                  <div className="text-[11px] text-bone/50 mt-0.5">
                    {a.payload?.channel || 'email'}
                    {a.parentEmail && <span> · to {a.parentEmail}</span>}
                  </div>
                </div>
                <div className="text-[10px] text-bone/40 shrink-0 tabular-nums">{ts.toLocaleDateString()}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const ActivityTab: React.FC<{ activities: Activity[] }> = ({ activities }) => {
  if (activities.length === 0) {
    return <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">No activity yet.</div>;
  }
  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5">
        <h2 className="font-bold text-bone/90">All activity ({activities.length})</h2>
      </div>
      <ul className="divide-y divide-white/5">
        {activities.map(a => {
          const ts = toDate(a.createdAt);
          return (
            <li key={a.id} className="px-4 py-3 flex items-start gap-3">
              <div className={`shrink-0 w-2 h-2 rounded-full mt-2 ${activityTone(a.kind)}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-bone/90">
                  <span className="font-bold">{a.actorName || 'System'}</span>{' '}
                  <span className="text-bone/50">{activityVerb(a.kind)}</span>{' '}
                  {a.payload?.playerName && <span className="font-bold">{a.payload.playerName}</span>}
                  {a.payload?.teamName && <span className="font-bold">{a.payload.teamName}</span>}
                  {a.payload?.title && <span className="font-bold">"{a.payload.title}"</span>}
                  {a.payload?.formName && <span className="font-bold">{a.payload.formName}</span>}
                </div>
                {a.payload?.note && <div className="text-[11px] text-bone/50 mt-0.5 italic">"{a.payload.note}"</div>}
                {a.payload?.subject && <div className="text-[11px] text-bone/50 mt-0.5">{a.payload.subject}</div>}
              </div>
              <div className="text-[10px] text-bone/40 shrink-0 mt-1 tabular-nums">{ts.toLocaleDateString()} · {ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const Mini: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-widest text-bone/50">{label}</div>
    <div className="text-sm font-bold text-bone mt-0.5 truncate">{value}</div>
  </div>
);

const Tile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-charcoal-900 rounded-xl ring-1 ring-white/10 px-4 py-3">
    <div className="text-2xl font-black text-bone leading-none tabular-nums">{value}</div>
    <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50 mt-1">{label}</div>
  </div>
);

function activityTone(kind: Activity['kind']): string {
  if (kind === 'registration_paid' || kind === 'offer_accepted' || kind === 'player_promoted' || kind === 'task_completed' || kind === 'form_signed') return 'bg-emerald-500';
  if (kind === 'offer_sent' || kind === 'tryout_invited') return 'bg-violet-500';
  if (kind === 'offer_declined') return 'bg-rose-500';
  if (kind.startsWith('coach_')) return 'bg-amber-500';
  if (kind === 'email_sent') return 'bg-white/40';
  if (kind.startsWith('task_')) return 'bg-brand-primary';
  return 'bg-white/25';
}

function activityVerb(kind: Activity['kind']): string {
  switch (kind) {
    case 'registration_submitted': return 'registered';
    case 'registration_paid': return 'paid for';
    case 'tryout_invited': return 'was invited to tryout for';
    case 'offer_sent': return 'sent an offer to';
    case 'offer_accepted': return 'accepted the offer from';
    case 'offer_declined': return 'declined the offer from';
    case 'player_promoted': return 'joined';
    case 'email_sent': return 'received an email';
    case 'coupon_redeemed': return 'redeemed coupon';
    case 'note_added': return 'noted on';
    case 'coach_favorited': return 'favorited';
    case 'coach_unfavorited': return 'unfavorited';
    case 'coach_rated': return 'rated';
    case 'coach_noted': return 'noted on';
    case 'coach_held': return 'placed a hold on';
    case 'coach_released': return 'released';
    case 'form_signed': return 'signed';
    case 'form_unsigned': return 'unsigned';
    case 'task_created': return 'created task';
    case 'task_assigned': return 'updated task';
    case 'task_completed': return 'completed task';
    case 'task_reopened': return 'reopened task';
    default: return kind;
  }
}

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
      <div className="bg-charcoal-900 w-full sm:max-w-md sm:rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-black text-bone">Add note</h2>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>
        <div className="p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="Anything worth remembering about this player — visible to coaches + admins."
            className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm"
          />
        </div>
        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
          <button type="button" disabled={!text.trim() || saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold">
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
      <div className="bg-charcoal-900 w-full sm:max-w-lg sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div>
            <h2 className="font-black text-bone">Mark as signed</h2>
            <p className="text-[11px] text-bone/50">{formDef.name}</p>
          </div>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {formDef.body && (
            <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/10 p-3 text-xs text-bone/85 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {formDef.body}
            </div>
          )}
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Signed by</span>
            <input
              value={signedByName}
              onChange={(e) => setSignedByName(e.target.value)}
              placeholder="Full name of the parent/guardian who signed"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="e.g. Paper copy in office binder, signed in person at tryouts"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm"
            />
          </label>
          {error && <div className="rounded-lg bg-rose-500/15 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-300">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
          <button type="button" disabled={!signedByName.trim() || saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Record signature'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Payment-link modal ──────────────────────────────────────────

const PaymentLinkModal: React.FC<{
  link: string;
  registrationId: string;
  parentEmail?: string;
  playerName: string;
  actorUid?: string;
  actorName?: string;
  clubId?: string;
  onClose: () => void;
}> = ({ link, registrationId, parentEmail, playerName, actorUid, actorName, clubId, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {/* ignore */}
  };

  const handleEmail = async () => {
    if (!parentEmail) return;
    setEmailing(true);
    setError(null);
    try {
      const html = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;background:#f0f9ff;">
          <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
            <div style="padding:20px;text-align:center;background:#0f172a;color:#fff;font-weight:900;letter-spacing:2.5px;text-transform:uppercase;font-size:16px;border-bottom:3px solid #06b6d4;">GoalKickr</div>
            <div style="padding:24px;color:#0f172a;line-height:1.6;font-size:15px;">
              <p style="margin:0 0 12px;color:#475569;">For <b>${playerName}</b></p>
              <p>Your registration balance is ready to settle. Tap below to pay securely with a card.</p>
              <p style="margin:16px 0;"><a href="${link}" style="display:inline-block;background:#06b6d4;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;">Pay now</a></p>
              <p style="font-size:11px;color:#94a3b8;">Sent by ${actorName || 'the club'}.</p>
            </div>
          </div>
        </div>`;
      const ok = await sendEmail({ to: parentEmail, subject: `Payment link for ${playerName}`, html });
      if (!ok) throw new Error('Send failed');
      if (clubId) {
        await logActivity({
          clubId,
          kind: 'email_sent',
          registrationId,
          parentEmail,
          actorUid,
          actorName,
          payload: { subject: `Payment link for ${playerName}`, channel: 'payment_link' },
        });
      }
      setEmailed(true);
    } catch (err: any) {
      setError(err?.message || 'Send failed.');
    } finally {
      setEmailing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-charcoal-900 w-full sm:max-w-md sm:rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-black text-bone">Payment link</h2>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-bone/65">One-time Stripe Checkout URL for {playerName}'s outstanding balance. Send it to the parent or copy and share however you like.</div>
          <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2 text-[11px] text-bone/85 font-mono break-all">{link}</div>
          {error && <div className="rounded-lg bg-rose-500/15 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-300">{error}</div>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleCopy} className="flex-1 px-3 py-2 rounded-lg bg-charcoal-950 hover:bg-white/15 text-bone/90 text-sm font-bold">
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a href={link} target="_blank" rel="noopener noreferrer" className="flex-1 text-center px-3 py-2 rounded-lg bg-charcoal-900 ring-1 ring-white/10 hover:ring-brand-primary-soft text-bone/90 text-sm font-bold">
              Open
            </a>
          </div>
          {parentEmail && (
            <button type="button" disabled={emailing || emailed} onClick={handleEmail} className="w-full px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold">
              {emailed ? `Sent to ${parentEmail}` : emailing ? 'Sending…' : `Email to ${parentEmail}`}
            </button>
          )}
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
    <div className="w-24 h-24 rounded-full bg-white/15 ring-2 ring-slate-100 flex items-center justify-center text-bone/50 text-2xl font-black shrink-0">
      {initials}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-widest text-bone/50">{label}</div>
    <div className="text-base font-black text-bone mt-1 truncate">{value}</div>
  </div>
);

const Card: React.FC<{ title: string; icon?: React.ReactNode; subtitle?: string; badge?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }> = ({ title, icon, subtitle, badge, action, children }) => (
  <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="w-7 h-7 rounded bg-brand-primary/15 ring-1 ring-brand-primary-soft flex items-center justify-center text-brand-primary shrink-0">{icon}</span>}
        <h2 className="font-bold text-bone/90 truncate">{title} {subtitle && <span className="text-[11px] text-bone/50 font-normal">{subtitle}</span>}</h2>
      </div>
      {badge}
    </div>
    <div className="p-4">{children}</div>
    {action && <div className="px-4 py-2 border-t border-white/5 text-center">{action}</div>}
  </div>
);

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="py-2 flex items-center justify-between gap-2">
    <dt className="text-bone/50">{label}</dt>
    <dd className="text-bone font-bold text-right">{value}</dd>
  </div>
);

const ActionLink: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button type="button" onClick={onClick} className="text-brand-primary hover:text-brand-primary-soft text-xs font-bold">{children}</button>
);

const Empty: React.FC<{ text: string }> = ({ text }) => <p className="text-[11px] text-bone/50">{text}</p>;

const QuickAction: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl hover:bg-white/[0.05] transition"
  >
    <span className="w-10 h-10 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft text-brand-primary flex items-center justify-center">{icon}</span>
    <span className="text-[10px] font-bold text-bone/85">{label}</span>
  </button>
);

const Dot: React.FC<{ color: 'emerald' | 'amber' | 'rose' | 'slate' }> = ({ color }) => (
  <span className={`w-2 h-2 rounded-full ${{ emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', slate: 'bg-white/25' }[color]}`} />
);

const StatusBadge: React.FC<{ status: Registration['status'] }> = ({ status }) => {
  const map: Record<Registration['status'], string> = {
    pending_payment: 'bg-amber-500/20 text-amber-200 ring-amber-300',
    paid: 'bg-emerald-500/20 text-emerald-200 ring-emerald-300',
    tryout_invited: 'bg-brand-primary/20 text-brand-primary-soft ring-brand-primary-soft',
    offer_sent: 'bg-violet-500/20 text-violet-200 ring-violet-300',
    accepted: 'bg-emerald-500/20 text-emerald-100 ring-emerald-400',
    declined: 'bg-rose-500/20 text-rose-800 ring-rose-300',
    withdrawn: 'bg-charcoal-950 text-bone/85 ring-white/15',
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
        <div className="text-lg font-black text-bone leading-none">{pct}%</div>
        <div className="text-[9px] text-bone/50 tabular-nums">{present}/{total}</div>
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
