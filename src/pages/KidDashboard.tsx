import React, { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useViewMode } from '../contexts/ViewModeContext';
import type { Player, Team, DevelopmentPlan } from '../types';
import PlayerCard from '../components/player/PlayerCard';
import PlayerXpCard from '../components/player/PlayerXpCard';
import InlineDevPlanCard from '../components/player/InlineDevPlanCard';
import KidModePinModal from '../components/player/KidModePinModal';
import KidChatRoom from '../components/kidChat/KidChatRoom';
import { Link } from 'react-router-dom';

type RsvpStatus = 'going' | 'maybe' | 'no';

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
  const { activeKidPlayerId, exitKidMode } = useViewMode();
  const [player, setPlayer] = useState<Player | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [pinOpen, setPinOpen] = useState(false);

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
        Loading {firstName}'s view…
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
        {/* Own player card — reuses the Squad tile via heroLayout so
            the streak lands as a noticeable avatar-corner bubble and
            the action row (with its dead "View profile" link that
            went nowhere from kid mode) is hidden entirely. */}
        <PlayerCard player={player} showActions={false} heroLayout={true} />

        {/* Own XP + badges. PlayerXpCard renders null if team.xpConfig
            isn't enabled, so cost is zero on non-XP teams. */}
        <PlayerXpCard
          player={player}
          team={team}
          isCoach={false}
          onRecognize={() => { /* kids can't recognize */ }}
        />

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

        {/* Upcoming events with RSVP-as-self. Kid taps Going/Maybe/No
            on their own row. Auth is still parent uid (kid mode is
            UI-only) but the write stamps actingAsSelf: true so any
            downstream display can render "Hunter is going" instead
            of "Patrick RSVP'd for Hunter". */}
        <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">What's coming up</p>
          </div>
          {events.length === 0 ? (
            <p className="text-sm text-ink-primary/50">Nothing on the schedule yet.</p>
          ) : (
            <ul className="space-y-3">
              {events.map((e: any) => {
                const currentStatus: RsvpStatus | undefined = e.playerRsvps?.[activeKidPlayerId]?.status;
                return (
                  <li key={e.id} className="rounded-xl bg-surface-base/50 ring-1 ring-line-default/10 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold truncate">{e.title || (e.type === 'game' ? 'Game' : e.type === 'practice' ? 'Practice' : 'Event')}</p>
                        <p className="text-[11px] text-ink-primary/55">
                          {new Date(e._ms).toLocaleString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                      <span className={`text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full ring-1 shrink-0 ${
                        e.type === 'game' ? 'text-rose-500 ring-rose-400/40 bg-rose-400/10'
                          : e.type === 'practice' ? 'text-emerald-500 ring-emerald-400/40 bg-emerald-400/10'
                          : 'text-ink-primary/60 ring-line-default/20 bg-line-default/10'
                      }`}>
                        {e.type || 'event'}
                      </span>
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

        {/* Team kid chat — same team's kids room. Composer visible;
            rules gate the write on parent-of-actingAsPlayer AND kid
            mode enabled on the player. Parents shadow-read from
            Player Circle; coaches can moderate via any authed team-
            member view. */}
        <section className="rounded-2xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[10px] uppercase tracking-widest font-bold text-ink-primary/55">Team chat</span>
            <span className="text-[10px] text-ink-primary/35">Your parents can see this</span>
          </div>
          <div className="h-[420px]">
            <KidChatRoom
              actingAsPlayer={player}
              team={team}
              canPost={true}
              variant="full"
            />
          </div>
        </section>
      </main>

      <KidModePinModal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        mode="exit"
      />
    </div>
  );
};

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
    <div className="mt-2 flex items-center gap-1.5">
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
