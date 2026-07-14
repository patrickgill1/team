// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, limit, orderBy, query, updateDoc, where, Timestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import type { CalendarEvent, Player } from '../types';
import { REQUIRED_COACH_CERT_KINDS } from '../types';
import CoachRecentMediaCard from '../components/coach/CoachRecentMediaCard';
import CoachGrantXpModal from '../components/coach/CoachGrantXpModal';
import XpIntroCard from '../components/coach/XpIntroCard';

/**
 * Coach cockpit — one-page landing for coaches. Mirror of /club for
 * admins. Patrick 2026-06-21: 'as a coach, I would love options to
 * manage my team from one page.' Built as a scaffold first — the
 * pieces that matter are here (next event, quick actions, cert status)
 * so the surface is useful immediately; depth ships in follow-ups.
 *
 * Visible in More menu under the 'Coach' entry (Navigation.tsx adds it
 * when isCoach is true). Pure parents don't see this; pure admins
 * don't need it (they have /club); regular coaches and multi-role
 * users (admin+coach) get this as the cleanest coach-specific surface.
 *
 * Scaffold sections:
 *   1. Hero: selected team + age group + format + next event mini
 *   2. Quick actions: 4 tile grid into the things coaches do daily
 *   3. Cert status: 4-item checklist (Grassroots / background /
 *      concussion / SafeSport) with quick links to update
 *
 * Future passes (when Patrick says so):
 *   - Multi-team picker if coach is on more than one team
 *   - This-week practice plans summary
 *   - Recent RSVPs to acknowledge
 *   - Coach commitment dashboard (which families haven't paid /
 *     finished tryouts etc.)
 */

const CERT_LABELS: Record<string, string> = {
  coach: 'Grassroots license',
  background_check: 'Background check',
  concussion: 'Concussion training',
  safesport: 'SafeSport training',
};

const CoachCockpit: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const [nextEvent, setNextEvent] = useState<CalendarEvent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [grantXpOpen, setGrantXpOpen] = useState(false);
  const [roster, setRoster] = useState<Player[]>([]);
  const [credentialsExpanded, setCredentialsExpanded] = useState(false);

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    if (!selectedTeamId) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const now = new Date();
        const q = query(
          collection(db, 'events'),
          where('teamId', '==', selectedTeamId),
          where('date', '>=', Timestamp.fromDate(now)),
          orderBy('date', 'asc'),
          limit(1)
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        if (!snap.empty) {
          const d: any = snap.docs[0].data();
          setNextEvent({
            id: snap.docs[0].id,
            ...d,
            date: d.date?.toDate?.() || new Date(d.date),
          });
        } else {
          setNextEvent(null);
        }
      } catch (err) {
        console.warn('[coach-cockpit] next-event load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  // Roster load — deferred until the Grant XP modal is opened so we
  // don't cost a per-mount read on every cockpit visit.
  useEffect(() => {
    if (!grantXpOpen || !selectedTeamId) return;
    let cancelled = false;
    (async () => {
      try {
        const q = query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', selectedTeamId),
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        setRoster(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => p.isActive !== false) as Player[]);
      } catch (err) {
        console.warn('[coach-cockpit] roster load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [grantXpOpen, selectedTeamId]);

  const certStatus = useMemo(() => {
    const list = (userData as any)?.coachCertifications || [];
    const byKind = new Map<string, any>();
    for (const c of list) {
      byKind.set(c.kind, c);
    }
    return REQUIRED_COACH_CERT_KINDS.map((k) => ({
      kind: k,
      label: CERT_LABELS[k] || k,
      done: byKind.has(k),
    }));
  }, [userData]);

  // Self-attestation: coach taps a row to confirm they hold that
  // credential. Adds/removes a manual cert row on the user doc.
  // When the Sports Affinity webhook lands, the 'ussf' source wins
  // on conflict, so manual rows get automatically superseded — no
  // migration needed. Optimistic UI: refresh happens via
  // AuthContext's user-doc listener.
  const [certBusyKind, setCertBusyKind] = useState<string | null>(null);
  const toggleCert = async (kind: string) => {
    if (!userData?.uid || certBusyKind) return;
    setCertBusyKind(kind);
    try {
      const current = Array.isArray((userData as any)?.coachCertifications)
        ? [...(userData as any).coachCertifications]
        : [];
      const alreadyOn = current.some((c: any) => c?.kind === kind);
      const next = alreadyOn
        ? current.filter((c: any) => c?.kind !== kind)
        : [
            ...current,
            {
              id: `manual-${kind}-${Date.now()}`,
              name: CERT_LABELS[kind] || kind,
              kind,
              source: 'manual',
              issuedAt: new Date(),
            },
          ];
      await updateDoc(doc(db, 'users', userData.uid), {
        coachCertifications: next,
      });
    } catch (err) {
      console.error('[coach-cockpit] cert toggle failed', err);
      alert('Could not update. Try again.');
    } finally {
      setCertBusyKind(null);
    }
  };

  const isUserCoach = isCoach((userData as any)?.role);
  if (!isUserCoach) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
        <p className="text-ink-primary/85 font-semibold mb-1">Coach view</p>
        <p className="text-ink-primary/55 text-sm mb-4">This page is for coaches.</p>
        <Link to="/dashboard" className="text-brand-primary-soft font-bold text-sm hover:text-brand-primary-soft">← Back to dashboard</Link>
      </div>
    );
  }

  const certDoneCount = certStatus.filter((c) => c.done).length;
  const certTotal = certStatus.length;
  const nextEventType = String((nextEvent as any)?.type || '').toLowerCase();
  const nextEventIsGame = ['game', 'scrimmage', 'tournament'].includes(nextEventType);
  const coachFlow = nextEvent
    ? [
        {
          label: nextEventIsGame ? 'Open Game Day mode' : 'Review event details',
          hint: nextEventIsGame ? 'Score, lineup, rotation bell, and recap.' : 'RSVPs, notes, location, and discussion.',
          to: nextEventIsGame ? `/game-day/${nextEvent.id}` : `/events/${nextEvent.id}`,
          accent: nextEventIsGame ? 'bg-brand-primary text-white' : 'bg-amber-500 text-charcoal-950',
        },
        {
          label: 'Check RSVPs',
          hint: 'See who is in, maybe, out, or still pending.',
          to: `/events/${nextEvent.id}`,
          accent: 'bg-emerald-500 text-charcoal-950',
        },
        {
          label: 'Message the team',
          hint: 'Send the update parents are probably waiting for.',
          to: '/chat',
          accent: 'bg-sky-500 text-charcoal-950',
        },
      ]
    : [
        {
          label: 'Schedule the next event',
          hint: 'Add the practice, game, or meeting parents need next.',
          to: '/calendar',
          accent: 'bg-amber-500 text-charcoal-950',
        },
        {
          label: 'Post a team update',
          hint: 'Keep families oriented even when the calendar is quiet.',
          to: '/wall',
          accent: 'bg-brand-primary text-white',
        },
      ];

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title="Coach"
        subtitle={selectedTeam ? `${selectedTeam.name}${selectedTeam.ageGroup ? ` · ${selectedTeam.ageGroup}` : ''}${(selectedTeam as any).format ? ` · ${(selectedTeam as any).format}` : ''}` : 'No team selected'}
      />
      {/* 2026-07-14: hero image removed per Patrick — coaches use
          this page as a launchpad, not a mood board, and the photo
          was pushing action cards below the fold on smaller phones. */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        {showProgress && !loaded && (
          <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
            <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
          </div>
        )}

        <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {/* Next event mini */}
          {nextEvent ? (
            <Link
              to={`/events/${nextEvent.id}`}
              className="block rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/30 transition p-4"
            >
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Next up</p>
              <p className="text-base font-black text-ink-primary leading-tight">{nextEvent.title || 'Event'}</p>
              <p className="text-xs text-ink-primary/55 mt-0.5">
                {nextEvent.date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {(nextEvent as any).location ? ` · ${(nextEvent as any).location}` : ''}
              </p>
            </Link>
          ) : (
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-4">
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1">Next up</p>
              <p className="text-sm text-ink-primary/70">Nothing scheduled. <Link to="/calendar" className="text-brand-primary-soft font-bold hover:text-brand-primary-soft">Create an event →</Link></p>
            </div>
          )}

          <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-4 mt-3">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Coach flow</p>
                <h2 className="text-base font-black text-ink-primary leading-tight mt-0.5">
                  {nextEvent ? 'Your next useful taps' : 'Get the week moving'}
                </h2>
              </div>
              <span className="text-[11px] font-bold text-ink-primary/45 tabular-nums">{coachFlow.length} steps</span>
            </div>
            <div className="space-y-2">
              {coachFlow.map((item, idx) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className="group flex items-center gap-3 rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 hover:ring-brand-primary/30 p-3 transition"
                >
                  <span className={`w-7 h-7 rounded-full ${item.accent} flex items-center justify-center text-[11px] font-black shrink-0`}>
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-ink-primary leading-tight">{item.label}</span>
                    <span className="block text-[11px] text-ink-primary/55 leading-snug mt-0.5">{item.hint}</span>
                  </span>
                  <span className="text-ink-primary/30 group-hover:text-ink-primary/70 transition">→</span>
                </Link>
              ))}
            </div>
          </section>

          {/* XP intro nudge — discovery card for coaches on teams
              where xpConfig is off. Hides once xp is turned on OR
              the coach has dismissed on this device. Without this,
              coaches on pre-2026-07-10 teams never discover XP or
              the Grant XP tile below. */}
          {selectedTeam && (
            <div className="mt-3">
              <XpIntroCard team={selectedTeam} />
            </div>
          )}

          {/* Coach control panel — 8 quick actions covering the
              team's operational surface. Head coach sees all of
              them. When Phase 4 wires per-permission gating, tiles
              a person doesn't have permission for will hide. */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 mt-3">
            <CoachTile
              to="/calendar"
              title="New event"
              hint="Practice, game, or team meeting."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>}
            />
            <CoachTile
              to="/players"
              title="Roster"
              hint="Add players, edit jerseys, positions."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>}
            />
            <CoachTile
              to="/wall"
              title="Post to wall"
              hint="Announcement every family sees."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="16" rx="2" /><line x1="7" y1="9" x2="17" y2="9" /><line x1="7" y1="13" x2="17" y2="13" /><line x1="7" y1="17" x2="13" y2="17" />
              </svg>}
            />
            <CoachTile
              to="/chat"
              title="Team chat"
              hint="Reply to parents, send a DM."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>}
            />
            <CoachTile
              to="/player-media"
              title="Media"
              hint="Post photos and clips. POTM."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
              </svg>}
            />
            <CoachTile
              to="/practice-plan"
              title="Practice plan"
              hint="Timeline of drills. Save and print."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="12" y2="17" />
              </svg>}
            />
            <CoachTile
              to="/development"
              title="Development plans"
              hint="Set goals + log practice per kid."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>}
            />
            <CoachTile
              to="/team/staff"
              title="Staff"
              hint="Assistants, managers, permissions."
              icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2z" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>}
            />
            {(selectedTeam as any)?.xpConfig?.enabled === true && (
              <CoachActionTile
                title="Grant XP"
                hint="Hand out live XP mid-practice."
                onClick={() => setGrantXpOpen(true)}
                icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M12 2l8.66 5v10L12 22 3.34 17V7L12 2z" /><path d="M12 8v6M9 11h6" />
                </svg>}
              />
            )}
          </div>

          {/* Recent media uploaded by the team — surfaces parents'
              fresh photos/videos so the coach actually sees them.
              Patrick 2026-06-21 dialogue idea #4. Hidden when no
              media in window. */}
          <CoachRecentMediaCard />

          {/* Coach cert checklist — collapsed by default so it doesn't
              hog the cockpit. Full checklist really belongs in club
              settings; keeping it here as a personal reminder tile
              with a summary + expand only when the coach needs it.
              (Patrick 2026-07-11: "should minimize or something".) */}
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 mt-3 overflow-hidden">
            <button
              type="button"
              onClick={() => setCredentialsExpanded(v => !v)}
              className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-line-default/[0.04] transition"
              aria-expanded={credentialsExpanded}
            >
              <div className="min-w-0 text-left">
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Credentials</p>
                <p className="text-[13px] font-bold text-ink-primary mt-0.5">
                  {certDoneCount === certTotal
                    ? <span className="text-emerald-300">All {certTotal} on file</span>
                    : <><span className="text-ink-primary/85">{certDoneCount} of {certTotal}</span><span className="text-ink-primary/50 font-normal">  ·  on file</span></>}
                </p>
              </div>
              <svg
                className={`w-4 h-4 text-ink-primary/50 shrink-0 transition-transform ${credentialsExpanded ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {credentialsExpanded && (
              <div className="px-4 pb-4 border-t border-line-default/10">
                <ul className="space-y-1 mt-3">
                  {certStatus.map((c) => {
                    const busy = certBusyKind === c.kind;
                    return (
                      <li key={c.kind}>
                        <button
                          type="button"
                          onClick={() => toggleCert(c.kind)}
                          disabled={busy}
                          className={`w-full flex items-center gap-2 text-[13px] py-1.5 px-1.5 rounded-lg hover:bg-line-default/[0.05] transition-colors disabled:opacity-60 ${
                            busy ? 'cursor-wait' : 'cursor-pointer'
                          }`}
                        >
                          <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center ring-1 transition-colors ${
                            c.done ? 'bg-emerald-500/15 ring-emerald-400/40 text-emerald-300' : 'bg-bone/5 ring-line-default/20 text-ink-primary/40'
                          }`}>
                            {c.done ? (
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                            ) : null}
                          </span>
                          <span className={c.done ? 'text-ink-primary/85' : 'text-ink-primary/55'}>{c.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-ink-primary/45 mt-3 italic">
                  Tap a row to confirm you hold that credential. Once the Sports Affinity integration lands, these will auto-confirm from your learning.ussoccer.com record.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedTeam && (selectedTeam as any)?.xpConfig?.enabled === true && (
        <CoachGrantXpModal
          open={grantXpOpen}
          onClose={() => setGrantXpOpen(false)}
          team={selectedTeam}
          roster={roster}
        />
      )}
    </div>
  );
};

const CoachTile: React.FC<{
  to: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
}> = ({ to, title, hint, icon }) => (
  <Link
    to={to}
    className="rounded-xl bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/30 transition p-4 flex flex-col gap-1 min-h-[92px]"
  >
    <span className="text-brand-primary-soft">{icon}</span>
    <p className="text-[13px] font-black text-ink-primary leading-tight mt-1">{title}</p>
    <p className="text-[11px] text-ink-primary/55 leading-snug">{hint}</p>
  </Link>
);

// Button variant of CoachTile — for tiles that open a modal / sheet
// instead of navigating. Optional accent lifts the tile visually to
// signal "this one does something bigger than a link."
const CoachActionTile: React.FC<{
  title: string;
  hint: string;
  icon: React.ReactNode;
  onClick: () => void;
  accent?: 'brand' | 'neutral';
}> = ({ title, hint, icon, onClick, accent = 'neutral' }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      'rounded-xl transition p-4 flex flex-col gap-1 min-h-[92px] text-left ring-1 ' +
      (accent === 'brand'
        ? 'bg-brand-primary/12 ring-brand-primary/35 hover:ring-brand-primary/60'
        : 'bg-surface-elevated ring-line-default/10 hover:ring-brand-primary/30')
    }
  >
    <span className={accent === 'brand' ? 'text-brand-primary' : 'text-brand-primary-soft'}>{icon}</span>
    <p className="text-[13px] font-black text-ink-primary leading-tight mt-1">{title}</p>
    <p className="text-[11px] text-ink-primary/55 leading-snug">{hint}</p>
  </button>
);

export default CoachCockpit;
