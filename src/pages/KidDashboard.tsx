import React, { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useViewMode } from '../contexts/ViewModeContext';
import type { Player, Team, DevelopmentPlan } from '../types';
import InlineDevPlanCard from '../components/player/InlineDevPlanCard';
import KidModePinModal from '../components/player/KidModePinModal';
import KidChatRoom from '../components/kidChat/KidChatRoom';
import KidHeroCard from '../components/kidChat/KidHeroCard';

type RsvpStatus = 'going' | 'maybe' | 'no';

// Hex clip-path for event-type icon containers. Rendered once as a
// constant so every event row shares the same polygon and browsers can
// cache the mask cheaply.
const HEX_CLIP = 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)';

// KidDashboard — the stripped-down view a player sees when in kid
// profile mode. No chat, no parent circle, no settings admin, no
// other players' profiles. Just: own card, own XP, own dev plan +
// "I did it", and upcoming events (read-only in Phase 1; RSVP-as-
// self lands in Phase 3).
//
// Auth is still the parent's uid — kid mode is a UI-only constraint.
// All writes attributed to parent uid; display uses player name.

const KidDashboard: React.FC = () => {
  const { userData } = useAuth();
  const { activeKidPlayerId } = useViewMode();
  const [player, setPlayer] = useState<Player | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [pinOpen, setPinOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // Load the kid's player doc.
  useEffect(() => {
    if (!activeKidPlayerId) return;
    const unsub = onSnapshot(doc(db, 'players', activeKidPlayerId), (snap) => {
      if (!snap.exists()) { setPlayer(null); return; }
      const data: any = snap.data();
      setPlayer({
        id: snap.id,
        ...data,
        dateOfBirth: data.dateOfBirth?.toDate ? data.dateOfBirth.toDate() : (data.dateOfBirth ? new Date(data.dateOfBirth) : undefined),
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || Date.now()),
      } as Player);
    }, err => console.warn('kid dashboard player load failed', err));
    return () => unsub();
  }, [activeKidPlayerId]);

  // Load the kid's team.
  useEffect(() => {
    const teamId = player?.teamId || (Array.isArray((player as any)?.teamIds) ? (player as any).teamIds[0] : '');
    if (!teamId) { setTeam(null); return; }
    const unsub = onSnapshot(doc(db, 'teams', teamId), (snap) => {
      if (!snap.exists()) { setTeam(null); return; }
      setTeam({ id: snap.id, ...(snap.data() as any) } as Team);
    }, err => console.warn('kid dashboard team load failed', err));
    return () => unsub();
  }, [player?.teamId]);

  // Load the kid's active dev plans.
  useEffect(() => {
    if (!activeKidPlayerId) return;
    const q = query(collection(db, 'development_plans'), where('playerId', '==', activeKidPlayerId));
    const unsub = onSnapshot(q, (snap) => {
      const rows: DevelopmentPlan[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as any;
      setPlans(rows);
    }, err => console.warn('kid dashboard plans load failed', err));
    return () => unsub();
  }, [activeKidPlayerId]);

  // Load the next few events for the kid's team.
  useEffect(() => {
    const teamId = player?.teamId;
    if (!teamId) { setEvents([]); return; }
    const unsub = onSnapshot(
      query(collection(db, 'events'), where('teamId', '==', teamId)),
      (snap) => {
        const now = Date.now();
        const rows = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((e: any) => !e.isCancelled)
          .map((e: any) => ({
            ...e,
            _ms: (e.date?.toDate?.() ?? new Date(e.date || 0)).getTime?.() || 0,
          }))
          .filter((e: any) => e._ms > now - 6 * 60 * 60 * 1000)
          .sort((a: any, b: any) => a._ms - b._ms)
          .slice(0, 4);
        setEvents(rows);
      },
      err => console.warn('kid dashboard events load failed', err)
    );
    return () => unsub();
  }, [player?.teamId]);

  const firstName = (player?.name || '').split(' ')[0] || 'Player';

  if (!activeKidPlayerId) return null;
  if (!player) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-primary/60 text-sm">
        Loading {firstName}'s view...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      {/* Kid-mode header — welcome + escape hatch. Kid device stays in
          this view by default; PIN unlocks parent view for the parent
          when they need to schedule / configure. pt-safe pushes the
          content clear of the notch / status bar on iOS. */}
      <header className="sticky top-0 z-40 bg-surface-elevated/85 backdrop-blur border-b border-line-default/10 pt-[env(safe-area-inset-top)]">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-brand-primary-soft">Player view</p>
            <h1 className="text-lg font-black tracking-tight leading-none mt-0.5">Hey, {firstName}</h1>
          </div>
          <button
            onClick={() => setPinOpen(true)}
            aria-label="Parent view"
            className="p-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/60 hover:text-ink-primary hover:bg-line-default/15 transition"
            title="Switch to parent view"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5 space-y-5">
        {/* Consolidated identity hero. Owns photo, name, rarity,
            streak, badges, level, XP progress, locker. PlayerXpCard
            was intentionally removed 2026-07-11 — it was showing the
            same level / XP rail / badges the hero card already owns.
            Kids saw everything twice. Coach + parent still see the
            PlayerXpCard on /player/:id (the profile page). */}
        <KidHeroCard player={player} team={team} />

        {/* Own dev plan + "I did it" — same write path as parent view,
            attributed to whoever's uid is signed in (which is still
            the parent). Kid sees the streak chip + can tap the button. */}
        {plans.length > 0 && (
          <InlineDevPlanCard
            plans={plans}
            playerId={activeKidPlayerId}
            actor={userData ? { uid: (userData as any).uid, name: (userData as any).name || firstName } : null}
            currentStreakDays={(player as any).currentStreakDays || 0}
            onUpdated={() => { /* onSnapshot listeners refresh */ }}
          />
        )}

        {/* Upcoming events with RSVP-as-self. Hex icon container on
            the left of each row calls out the event type at a glance
            without needing a corner badge duplicate. */}
        <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">What's coming up</p>
            {events.length > 0 && (
              <span className="text-[11px] font-semibold text-brand-primary/80">
                View all
                <span className="ml-0.5" aria-hidden>&rsaquo;</span>
              </span>
            )}
          </div>
          {events.length === 0 ? (
            <p className="text-sm text-ink-primary/50">Nothing on the schedule yet.</p>
          ) : (
            <ul className="space-y-3">
              {events.map((e: any) => {
                const currentStatus: RsvpStatus | undefined = e.playerRsvps?.[activeKidPlayerId]?.status;
                const typeLabel = e.type === 'game' ? 'Game' : e.type === 'practice' ? 'Practice' : 'Event';
                return (
                  <li key={e.id} className="rounded-xl bg-surface-base/50 ring-1 ring-line-default/10 px-3 py-3">
                    <div className="flex items-start gap-3">
                      <EventTypeHex type={e.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/45">
                            {typeLabel}
                          </span>
                          <span className="text-[10px] font-semibold text-ink-primary/40 tabular-nums">
                            {new Date(e._ms).toLocaleString(undefined, {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                        </div>
                        <p className="text-sm font-bold truncate mt-0.5">
                          {e.title || typeLabel}
                        </p>
                        <p className="text-[11px] text-ink-primary/55 tabular-nums">
                          {new Date(e._ms).toLocaleString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                    <KidRsvpButtons
                      eventId={e.id}
                      playerId={activeKidPlayerId}
                      playerName={firstName}
                      playerPhotoUrl={player.profilePhotoUrl || null}
                      parentUid={(userData as any)?.uid}
                      currentStatus={currentStatus}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Team chat summary. Preview shows an empty-state
            illustration (two speech bubbles + crimson ball); tapping
            "See all" opens the real chat room in a modal. Kid mode
            short-circuits routing so we do NOT link out — the modal
            keeps the kid inside their dashboard. */}
        <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">Team chat</span>
              <span className="text-[10px] text-ink-primary/35 truncate">Your parents can see this</span>
            </div>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="text-[11px] font-semibold text-brand-primary/90 hover:text-brand-primary transition shrink-0"
            >
              See all
              <span className="ml-0.5" aria-hidden>&rsaquo;</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="w-full rounded-xl bg-surface-base/40 ring-1 ring-line-default/10 py-6 px-4 flex flex-col items-center gap-2 hover:bg-surface-base/60 transition"
          >
            <ChatEmptyIllustration className="w-24 h-16" />
            <p className="text-xs font-semibold text-ink-primary/70">
              No messages yet. Say hi to your teammates.
            </p>
          </button>
        </section>
      </main>

      <KidModePinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        mode="exit"
      />

      {/* Chat modal — full-screen sheet on mobile, keeps kid inside
          the KidDashboard route so kid-mode routing guarantees hold. */}
      {chatOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Team chat"
          onClick={() => setChatOpen(false)}
        >
          <div
            className="mt-auto sm:mt-[10vh] sm:mx-auto w-full sm:max-w-lg bg-surface-elevated rounded-t-3xl sm:rounded-3xl overflow-hidden ring-1 ring-line-default flex flex-col h-[85vh] sm:h-[75vh]"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-line-default/40 shrink-0">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-brand-primary-soft">Team chat</p>
                <p className="text-sm font-black leading-none mt-0.5">Say hi</p>
              </div>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                aria-label="Close chat"
                className="p-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 hover:text-ink-primary transition"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="w-4 h-4" aria-hidden>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <KidChatRoom
                actingAsPlayer={player}
                team={team}
                canPost={true}
                variant="full"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Hex-clipped event type icon. Amber trophy for games, emerald ball
// for practice, brand star for anything else. The clip-path is a
// standard 6-point hex; browsers cache the mask so re-renders are
// cheap.
const EventTypeHex: React.FC<{ type?: string }> = ({ type }) => {
  const t = type === 'game' ? 'game' : type === 'practice' ? 'practice' : 'event';
  const bg =
    t === 'game' ? 'bg-amber-500/15'
      : t === 'practice' ? 'bg-emerald-500/15'
      : 'bg-brand-primary/15';
  const fg =
    t === 'game' ? 'text-amber-500'
      : t === 'practice' ? 'text-emerald-500'
      : 'text-brand-primary';

  return (
    <div
      className={`shrink-0 w-14 h-14 flex items-center justify-center ${bg}`}
      style={{ clipPath: HEX_CLIP }}
      aria-hidden
    >
      {t === 'game' && <TrophyIcon className={`w-6 h-6 ${fg}`} />}
      {t === 'practice' && <SoccerBallIcon className={`w-6 h-6 ${fg}`} />}
      {t === 'event' && <StarIcon className={`w-6 h-6 ${fg}`} />}
    </div>
  );
};

const TrophyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M8 4h8v4a4 4 0 0 1-8 0V4z" />
    <path d="M8 6H5a2 2 0 0 0 0 4h3" />
    <path d="M16 6h3a2 2 0 0 1 0 4h-3" />
    <path d="M10 14h4v3h-4z" />
    <path d="M8 20h8" />
    <path d="M12 17v3" />
  </svg>
);

const SoccerBallIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <polygon points="12,8 15.5,10.5 14,14.5 10,14.5 8.5,10.5" />
    <path d="M12 3v5" />
    <path d="M20.5 9.5L15.5 10.5" />
    <path d="M3.5 9.5L8.5 10.5" />
    <path d="M6.5 19.5L10 14.5" />
    <path d="M17.5 19.5L14 14.5" />
  </svg>
);

const StarIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.5L6 22l1.5-7.2L2 10l7.1-1.1L12 2z" />
  </svg>
);

// Chat empty-state art. Two overlapping speech bubbles with a small
// crimson soccer ball inside — the ball ties the illustration to the
// brand without stamping a logo on top of it.
const ChatEmptyIllustration: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 160 96" fill="none" className={className} aria-hidden="true">
    <path
      d="M14 18h68a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10H36l-14 12v-12h-8A10 10 0 0 1 4 50V28A10 10 0 0 1 14 18z"
      fill="currentColor"
      className="text-surface-input"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M78 34h68a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10h-8v12l-14-12H78a10 10 0 0 1-10-10V44a10 10 0 0 1 10-10z"
      fill="currentColor"
      className="text-surface-elevated"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    {/* Crimson soccer ball nestled in the overlap */}
    <g transform="translate(72 42)">
      <circle cx="12" cy="12" r="11" fill="rgb(200,32,44)" />
      <polygon points="12,7 16.5,10.2 14.8,15.5 9.2,15.5 7.5,10.2" fill="white" opacity="0.9" />
      <path d="M12 2v5M22.5 9L16.5 10.2M1.5 9L7.5 10.2M4.5 19L9.2 15.5M19.5 19L14.8 15.5" stroke="white" strokeWidth="1" opacity="0.75" strokeLinecap="round" />
    </g>
  </svg>
);

// Compact 3-way RSVP row (Going / Maybe / No) attributed as the
// kid, not the parent. Write goes to event.playerRsvps[playerId]
// with actingAsSelf: true so downstream display code can format as
// "Hunter is going" instead of the parent's default byUid label.
const KidRsvpButtons: React.FC<{
  eventId: string;
  playerId: string;
  playerName: string;
  playerPhotoUrl?: string | null;
  parentUid?: string;
  currentStatus?: RsvpStatus;
}> = ({ eventId, playerId, playerName, playerPhotoUrl, parentUid, currentStatus }) => {
  const [busy, setBusy] = useState<RsvpStatus | null>(null);

  const setStatus = async (status: RsvpStatus) => {
    if (!parentUid || busy) return;
    setBusy(status);
    try {
      await updateDoc(doc(db, 'events', eventId), {
        [`playerRsvps.${playerId}`]: {
          status,
          playerName,
          playerPhotoUrl: playerPhotoUrl || null,
          byUid: parentUid,
          byName: playerName,
          actingAsSelf: true,
          respondedAt: new Date(),
        },
      });
    } catch (err) {
      console.error('[kid-rsvp] failed', err);
      alert('Could not save your RSVP. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const opts: Array<{ status: RsvpStatus; label: string; tone: string; activeTone: string }> = [
    { status: 'going', label: "I'm going", tone: 'bg-emerald-500/10 ring-emerald-400/30 text-emerald-500', activeTone: 'bg-emerald-500 text-white ring-emerald-500' },
    { status: 'maybe', label: 'Maybe',    tone: 'bg-amber-500/10 ring-amber-400/30 text-amber-500',      activeTone: 'bg-amber-500 text-white ring-amber-500' },
    { status: 'no',    label: "Can't",    tone: 'bg-rose-500/10 ring-rose-400/30 text-rose-500',         activeTone: 'bg-rose-500 text-white ring-rose-500' },
  ];

  return (
    <div className="mt-3 flex items-center gap-1.5">
      {opts.map(o => {
        const isActive = currentStatus === o.status;
        const isBusy = busy === o.status;
        return (
          <button
            key={o.status}
            onClick={() => setStatus(o.status)}
            disabled={!!busy}
            className={`flex-1 inline-flex items-center justify-center px-2 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider ring-1 transition disabled:opacity-60 ${
              isActive ? o.activeTone : o.tone
            }`}
          >
            {isBusy ? '...' : o.label}
          </button>
        );
      })}
    </div>
  );
};

export default KidDashboard;
