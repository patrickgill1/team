import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { arrayRemove, arrayUnion, collection, doc, getDocs, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useViewMode } from '../contexts/ViewModeContext';
import type { Player, Team, DevelopmentPlan, Season } from '../types';
import { debugWarn } from '../utils/debug';
import InlineDevPlanCard from '../components/player/InlineDevPlanCard';
import KidModePinModal from '../components/player/KidModePinModal';
import KidChatRoom from '../components/kidChat/KidChatRoom';
import KidHeroCard from '../components/kidChat/KidHeroCard';
import KidXpToast from '../components/kidChat/KidXpToast';
import KidBadgeReveal from '../components/kidChat/KidBadgeReveal';
import PhotoTape from '../components/player/PhotoTape';
import SeasonTimeline from '../components/player/SeasonTimeline';
import PersonalRecords from '../components/player/PersonalRecords';
import CoachRecognitionsArchive from '../components/player/CoachRecognitionsArchive';
import PlayerXpHistoryFeed from '../components/player/PlayerXpHistoryFeed';
import { awardMicroXp } from '../utils/microXp';
import { getActiveSeasonForTeam } from '../utils/seasons';

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
  // Live copy of the kid_chat thread doc for this team. Used by the
  // bell toggle in the chat modal header — reflects the "Notify me
  // for all messages" state without a per-tap round-trip.
  const [chatThreadDoc, setChatThreadDoc] = useState<{ notifyAllUids?: string[] } | null>(null);
  const [chatNotifySaving, setChatNotifySaving] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Active season + POTM wins/nominations for this kid — fed into
  // SeasonTimeline + PersonalRecords so the kid sees the same
  // deep-profile signal a parent sees on /player/:id, without
  // needing to leave kid mode.
  const [activeSeason, setActiveSeason] = useState<Season | null>(null);
  const [votingWins, setVotingWins] = useState<any[]>([]);
  const [votingNominationsList, setVotingNominationsList] = useState<any[]>([]);

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

  // Load the kid's active dev plans, scoped to the team they're
  // currently viewing. 2026-07-14: added teamId narrowing to fix
  // cross-team leak — a kid rostered on two teams was seeing both
  // teams' plans in this home card. Team-scope is applied client-
  // side (no composite index needed) and the effect deliberately
  // waits until `player` (and therefore teamId) has loaded before
  // subscribing, so we never fall back to an unfiltered query.
  useEffect(() => {
    if (!activeKidPlayerId) return;
    const teamId = player?.teamId || (Array.isArray((player as any)?.teamIds) ? (player as any).teamIds[0] : '');
    if (!teamId) return; // wait for player to resolve — no unfiltered fallback.
    const q = query(collection(db, 'development_plans'), where('playerId', '==', activeKidPlayerId));
    const unsub = onSnapshot(q, (snap) => {
      const rows: DevelopmentPlan[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((p: any) => p.teamId === teamId) as any;
      setPlans(rows);
    }, err => console.warn('kid dashboard plans load failed', err));
    return () => unsub();
  }, [activeKidPlayerId, player?.teamId]);

  // Subscribe to this team's kid_chat thread doc so the header bell
  // reflects the current notifyAllUids state. One-thread-per-team
  // model: doc id is `team_<teamId>`. Absent thread = no one has
  // sent a message yet, still safe to render the toggle (thread is
  // provisioned on first send).
  useEffect(() => {
    const teamId = player?.teamId;
    if (!teamId) { setChatThreadDoc(null); return; }
    const unsub = onSnapshot(doc(db, 'kid_chat_threads', `team_${teamId}`), (snap) => {
      if (!snap.exists()) { setChatThreadDoc(null); return; }
      const d: any = snap.data();
      setChatThreadDoc({ notifyAllUids: Array.isArray(d.notifyAllUids) ? d.notifyAllUids : [] });
    }, (err) => {
      const code = (err as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('[kid-dash] chat thread subscribe denied (auth transition)', err);
      } else {
        debugWarn('[kid-dash] chat thread subscribe failed', err);
      }
    });
    return () => unsub();
  }, [player?.teamId]);

  // Deep-link support: a push tap URL contains `?chat=1` so users
  // land inside the modal, not the collapsed dashboard. Also strips
  // the param after opening so a back-navigation doesn't re-trigger.
  useEffect(() => {
    if (searchParams.get('chat') !== '1') return;
    setChatOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('chat');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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

  // Resolve the active season for this team — powers SeasonTimeline's
  // season scoping and Personal Records' "This Season" filter.
  useEffect(() => {
    const teamId = player?.teamId;
    if (!teamId) { setActiveSeason(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const s = await getActiveSeasonForTeam(teamId);
        if (!cancelled) setActiveSeason(s);
      } catch (err) {
        debugWarn('[kid-dash] active season resolve failed', err);
        if (!cancelled) setActiveSeason(null);
      }
    })();
    return () => { cancelled = true; };
  }, [player?.teamId]);

  // Load match_votings the kid participated in — powers Personal
  // Records (career POTM wins + most votes in a match). Same read
  // path the parent-side profile uses; rules allow open read on
  // match_votings so no per-season composite index is required.
  // teamId filter is intentionally OMITTED so a kid who played on a
  // renamed/recreated team across seasons still gets credit for
  // every past POTM (matches the 3.9.242 fix on the parent side).
  useEffect(() => {
    if (!activeKidPlayerId) { setVotingWins([]); setVotingNominationsList([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'match_votings'));
        if (cancelled) return;
        const allVotings = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        const wins = allVotings.filter((v: any) =>
          (Array.isArray(v.winners) && v.winners.some((w: any) => w?.playerId === activeKidPlayerId))
          || v.winner?.playerId === activeKidPlayerId
        );
        const nominated = allVotings.filter((v: any) =>
          Array.isArray(v.votes) && v.votes.some((x: any) => x?.playerId === activeKidPlayerId)
        );
        setVotingWins(wins);
        setVotingNominationsList(nominated);
      } catch (err) {
        debugWarn('[kid-dash] votings load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [activeKidPlayerId]);

  const firstName = (player?.name || '').split(' ')[0] || 'Player';

  // Bell toggle state — derived from the live thread doc. Absent doc
  // (thread not created yet) treats the user as opted-out (matches
  // the mentions-only default).
  const isNotifyAll = useMemo(() => {
    const uid = (userData as any)?.uid;
    if (!uid) return false;
    return Array.isArray(chatThreadDoc?.notifyAllUids)
      && chatThreadDoc!.notifyAllUids!.includes(uid);
  }, [chatThreadDoc, userData]);

  const toggleNotifyAll = async () => {
    const uid = (userData as any)?.uid;
    const teamId = player?.teamId;
    if (!uid || !teamId || chatNotifySaving) return;
    setChatNotifySaving(true);
    try {
      const ref = doc(db, 'kid_chat_threads', `team_${teamId}`);
      // Rules gate this to a self-scoped arrayUnion/arrayRemove; a
      // caller can only add/remove their own uid.
      await updateDoc(ref, {
        notifyAllUids: isNotifyAll ? arrayRemove(uid) : arrayUnion(uid),
      });
    } catch (err) {
      debugWarn('[kid-dash] notifyAll toggle failed', err);
      alert("Couldn't update notifications. Try again.");
    } finally {
      setChatNotifySaving(false);
    }
  };

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
      {/* Coach live-grant XP reveal. Watches player_xp_events for
          fresh coach_live grants and pops a stackable toast. See
          KidXpToast.tsx — it manages its own lastSeenXpAt cursor so
          returning after the app closed doesn't dogpile. */}
      <KidXpToast playerId={activeKidPlayerId} />

      {/* Badge earn reveal. Big centered modal with badge art +
          confetti + count-up XP when a new badge crosses. Uses
          player.lastSeenBadgeAt cursor bumped on dismiss so one
          reveal per earn ship-forward only. */}
      <KidBadgeReveal player={player} />

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

        {/* PHOTO TAPE — sits directly under the hero because scrolling
            past a wall of photos of yourself is the strongest reason a
            kid opens the app. Photo-with-purpose: no ambient
            background image on the hero, but this ribbon gives them
            an immediate reason to keep scrolling. */}
        <PhotoTape
          playerId={activeKidPlayerId}
          teamId={player.teamId || ''}
          playerName={firstName}
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

        {/* SEASON TIMELINE — chronological ribbon of every milestone
            the kid has earned this season. Kids scroll right to watch
            their season unfold. Silent-empty on brand-new seasons or
            legacy teams pre-XP-opt-in. */}
        <SeasonTimeline
          playerId={activeKidPlayerId}
          player={player}
          teamId={player.teamId || ''}
          season={activeSeason}
          xpEnabled={Boolean((team as any)?.xpConfig?.enabled)}
        />

        {/* PERSONAL RECORDS — bragging rights. Most goals in a match,
            longest scoring streak, career POTM crowns, juggles PB.
            Client-side one-pass over stats + votings; silent-empty
            when the kid has nothing above zero yet. */}
        <PersonalRecords
          playerId={activeKidPlayerId}
          player={player}
          seasonId={activeSeason?.id || 'lifetime'}
          votingWins={votingWins}
          votingNominations={votingNominationsList}
        />

        {/* COACH RECOGNITIONS ARCHIVE — the wall of every kind thing
            a coach has ever written about them. Read on a bad day is
            the point. Silent-empty on non-XP teams. */}
        <CoachRecognitionsArchive
          playerId={activeKidPlayerId}
          teamId={player.teamId || ''}
          xpEnabled={Boolean((team as any)?.xpConfig?.enabled)}
        />

        {/* RECENT XP — every XP grant the kid has earned, including
            coach live grants (Coach recognitions have their own
            archive above; this one is the fuller ledger with reasons).
            Patrick 2026-07-12: "players should be able to see past
            xp points as well." Silent-empty on non-XP teams; the feed
            component gates on its own query result. */}
        <PlayerXpHistoryFeed playerId={activeKidPlayerId} />

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
                      xpEnabled={Boolean((team as any)?.xpConfig?.enabled)}
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

      {/* Chat modal — full-screen sheet on mobile (covers status bar
          + home indicator with safe-area padding), bounded card on
          desktop. Keeps kid inside the KidDashboard route so kid-mode
          routing guarantees hold. */}
      {chatOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Team chat"
          onClick={() => setChatOpen(false)}
        >
          <div
            className="w-full h-full sm:mt-[10vh] sm:mx-auto sm:max-w-lg sm:h-[75vh] bg-surface-elevated sm:rounded-3xl overflow-hidden sm:ring-1 sm:ring-line-default flex flex-col"
            onClick={(ev) => ev.stopPropagation()}
            style={{
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-line-default/40 shrink-0">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-brand-primary-soft">Team chat</p>
                <p className="text-sm font-black leading-none mt-0.5">Say hi</p>
              </div>
              <div className="flex items-center gap-2">
                {/* Notify-me-for-all toggle. Default is mentions-only
                    (bell-slash icon, no highlight). When on, we render
                    the filled bell with the same amber tint TeamChat
                    uses for its own per-thread notification state so
                    users recognize the affordance. */}
                <button
                  type="button"
                  onClick={toggleNotifyAll}
                  aria-pressed={isNotifyAll}
                  aria-label={isNotifyAll ? 'Notifying for every message. Tap to only notify for mentions.' : 'Only notifying for mentions. Tap to notify for every message.'}
                  disabled={chatNotifySaving || !player?.teamId}
                  className={
                    'p-2 rounded-full ring-1 transition '
                    + (isNotifyAll
                      ? 'bg-amber-500/20 ring-amber-500/40 text-amber-500'
                      : 'bg-line-default/10 ring-line-default/20 text-ink-primary/60 hover:text-ink-primary')
                    + (chatNotifySaving ? ' opacity-50' : '')
                  }
                >
                  {isNotifyAll ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4" aria-hidden>
                      <path d="M12 2a2 2 0 0 0-2 2v.6A7 7 0 0 0 5 11v3.6l-1.7 1.7A1 1 0 0 0 4 18h16a1 1 0 0 0 .7-1.7L19 14.6V11a7 7 0 0 0-5-6.4V4a2 2 0 0 0-2-2Zm-2 18a2 2 0 1 0 4 0h-4Z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden>
                      <path d="M3 3l18 18" />
                      <path d="M17 14.6V11a5 5 0 0 0-9.5-2.2M5 11v3.6L3.3 16.3A1 1 0 0 0 4 18h13" />
                      <path d="M10 20a2 2 0 0 0 4 0" />
                    </svg>
                  )}
                </button>
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
  xpEnabled?: boolean;
}> = ({ eventId, playerId, playerName, playerPhotoUrl, parentUid, currentStatus, xpEnabled }) => {
  const [busy, setBusy] = useState<RsvpStatus | null>(null);

  const setStatus = async (status: RsvpStatus) => {
    if (!parentUid || busy) return;
    setBusy(status);
    // Snapshot the transition BEFORE the write so the RSVP =>
    // 'going' micro-XP only fires on a fresh crossing. A kid tapping
    // 'going' twice in a row (once already going) will not double-
    // grant. Toggling going -> no -> going grants twice, which is
    // an accepted spam edge case in v1.
    const crossedIntoGoing = status === 'going' && currentStatus !== 'going';
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
      if (crossedIntoGoing) {
        void awardMicroXp(playerId, 5, {
          xpEnabled: Boolean(xpEnabled),
          actionKey: 'rsvp_going',
        });
      }
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
