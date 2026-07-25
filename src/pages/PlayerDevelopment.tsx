import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { DevelopmentPlan, DevelopmentGoal, PracticeLogEntry, Player, VideoLink, Drill, PlanComment } from '../types';
import DrillPickerModal from '../components/development/DrillPickerModal';
import CoachSawThisPill from '../components/coach/CoachSawThisPill';
import CloudflareStreamIframe from '../components/common/CloudflareStreamIframe';
import { getOrEnableStreamDownloadUrl, streamIframeUrl } from '../utils/streamUpload';
import { coachVerifyLogEntry, buildPracticeDayKeys, computeStreakDaysFromKeys, didItToday } from '../utils/devPlanActions';
import { resolveGoalVideo as resolveGoalVideoShared } from '../utils/resolveGoalVideo';
import { isCoachOfTeam, formatDate } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';
import DataGate from '../components/common/DataGate';
import GametapeSection from '../components/gametape/GametapeSection';

// Extract YouTube video ID from any common YouTube URL shape (also accepts a raw 11-char ID)
function extractYouTubeId(input: string): string | null {
  if (!input) return null;
  const url = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1).split('/')[0] || null;
    }
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['embed', 'shorts', 'live', 'v'].includes(p));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {}
  const m = url.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

const PlayerDevelopment: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getDevelopmentPlansByTeam, getDevelopmentPlansByPlayer, addDevelopmentPlan, updateDevelopmentPlan, getDocuments, getPlayersByTeam, deleteDocument, updateDocument } = useFirestore();

  const [plans, setPlans] = useState<DevelopmentPlan[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Create plan form
  const [planPlayerId, setPlanPlayerId] = useState('');
  const [bulkPlayerIds, setBulkPlayerIds] = useState<string[]>([]);
  const [planTitle, setPlanTitle] = useState('');
  const [planDescription, setPlanDescription] = useState('');
  const [planCategory, setPlanCategory] = useState<DevelopmentPlan['category']>('technical');
  // Anti-double-tap + preview gate. When the coach taps Create with 2+
  // players selected (or any player already has a plan with the same
  // title), we open the preview modal first so they can confirm or
  // skip duplicates instead of fan-out spamming the team.
  const [submitting, setSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [planGoals, setPlanGoals] = useState<Omit<DevelopmentGoal, 'playerCompleted' | 'coachVerified' | 'readyForReview'>[]>([
    { id: `goal_${Date.now()}`, title: '', description: '', order: 0 }
  ]);
  const [prefillPlayerId, setPrefillPlayerId] = useState('');
  // Drill picker state. When the coach taps "Import from library" we
  // open it, they pick N drills, and we append goals to planGoals
  // pre-filled from each drill's content. The source drill ids are
  // tracked so we can bump assignmentCount on every drill after the
  // plan is successfully written.
  const [drillPickerOpen, setDrillPickerOpen] = useState(false);
  const [importedDrillIds, setImportedDrillIds] = useState<string[]>([]);
  // Coach View / Parent View toggle — only meaningful for the
  // coach-who's-also-a-parent case (e.g., Patrick coaching Hunter's
  // U10 team). Parents without coach role auto-land on 'parent' and
  // don't see the toggle. Coaches without linked players auto-land
  // on 'coach' and also don't see the toggle.
  const [viewMode, setViewMode] = useState<'coach' | 'parent'>('coach');
  const [searchParams, setSearchParams] = useSearchParams();

  const isUserCoach = isCoachOfTeam(userData, selectedTeam);

  // Optimistic verified-by cache for the CoachSawThisPill so the
  // pill flips state instantly on coach tap without waiting for a
  // full plan reload. Cleared on plan reload (loadData resets state
  // implicitly by reassigning plans).
  const [verifiedOptimistic, setVerifiedOptimistic] = useState<Record<string, { uid: string; name: string; at: Date }>>({});
  const handleVerifyLog = async (planForVerify: DevelopmentPlan, goalId: string, logId: string) => {
    try {
      const result = await coachVerifyLogEntry({ plan: planForVerify, goalId, logId });
      setVerifiedOptimistic(prev => ({ ...prev, [logId]: result.verifiedBy }));
    } catch (err) {
      console.warn('[dev-plan] verify log failed', err);
      alert('Could not save. Try again.');
    }
  };

  // Fire-and-forget cache write when a drill's Cloudflare Stream MP4
  // URL first resolves during a Share tap. Only writes if the drill
  // isn't already carrying the same value AND we haven't already
  // written it in this session (avoids a write storm if the same drill
  // gets shared repeatedly). Updates local drillsById so the next
  // Share in this same session reads the cached URL without a network
  // round trip. Non-fatal on error — worst case is the next tap
  // repeats the enable-download call.
  const [cachedMp4UrlsSession, setCachedMp4UrlsSession] = useState<Record<string, string>>({});
  const handleCacheDrillMp4Url = (drillId: string, url: string) => {
    if (!drillId || !url) return;
    if (cachedMp4UrlsSession[drillId] === url) return;
    const existing = (drillsById[drillId] as any)?.streamMp4Url;
    setCachedMp4UrlsSession(prev => ({ ...prev, [drillId]: url }));
    setDrillsById(prev => {
      const cur = prev[drillId];
      if (!cur) return prev;
      return { ...prev, [drillId]: { ...cur, streamMp4Url: url } as any };
    });
    if (existing === url) return;
    (async () => {
      try {
        await updateDocument('drills', drillId, { streamMp4Url: url });
      } catch (err) {
        console.warn('[dev-plan] cache drill mp4 url failed', err);
      }
    })();
  };

  useEffect(() => {
    loadData();
  }, [selectedTeamId, selectedPlayerId]);

  // Live cache of the team's drills, keyed by id. Used to resolve a
  // goal's video LIVE from its source drill instead of from the
  // snapshot copied at import time.
  //
  // Patrick's pain (2026-06-16): he imported a drill into a plan,
  // hit an upload issue, re-uploaded the TikTok to the drill — and
  // the goal in the plan kept showing nothing. The goal was a
  // snapshot of the drill at import time, so it had the OLD (broken
  // or empty) streamUid. Re-importing into an existing plan to
  // re-snapshot would have meant deleting the old goal + adding a
  // dup. So instead we look up the source drill at render time and
  // prefer its CURRENT streamUid. Coach edits to title/description
  // still stay sticky — only the video is auto-synced.
  const [drillsById, setDrillsById] = useState<Record<string, Drill>>({});
  useEffect(() => {
    if (!selectedTeamId) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await getDocuments('drills', []);
        if (cancelled) return;
        const map: Record<string, Drill> = {};
        for (const d of (all as any[])) {
          if (d.isActive === false) continue;
          if (d.teamId !== selectedTeamId) continue;
          map[d.id] = d as Drill;
        }
        setDrillsById(map);
      } catch { /* non-fatal — goals fall back to their snapshot streamUid */ }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, getDocuments]);

  // Deep-link: "Set a Challenge" button on a drill card lands here with
  // ?seedDrill=<id>. Open the new-plan modal with that drill seeded as
  // the first goal so the coach just picks players and saves. Wait for
  // drillsById to populate before firing — otherwise we'd open an empty
  // modal and the import would no-op.
  useEffect(() => {
    const seedDrill = searchParams.get('seedDrill');
    if (!seedDrill) return;
    const drill = drillsById[seedDrill];
    if (!drill) return; // drills still loading; effect will re-run when ready
    resetCreateForm();
    setEditingPlanId(null);
    importDrillsToPlan([drill]);
    setShowCreateModal(true);
    // Strip the param so a reload doesn't re-open the modal forever.
    const next = new URLSearchParams(searchParams);
    next.delete('seedDrill');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillsById, searchParams]);

  // Resolve a goal's current video via the shared resolver in
  // src/utils/resolveGoalVideo.ts — same logic the kid-facing
  // InlineDevPlanCard uses so both surfaces agree on which video is
  // "current" (drill re-uploads propagate everywhere without
  // re-importing the goal).
  const resolveGoalVideo = (goal: DevelopmentGoal) =>
    resolveGoalVideoShared(goal, drillsById);

  // Deep-link: /development?expand=<planId> opens that plan expanded
  // once the plans list is loaded. Consumed so it doesn't keep firing
  // on subsequent reloads.
  useEffect(() => {
    const target = searchParams.get('expand');
    if (!target) return;
    if (plans.some(p => p.id === target)) {
      setExpandedPlanId(target);
      // Also flip to Parent View on landing — the card lives on the
      // parent dashboard, so they're already in parent mindset.
      const haveLinked = !!(userData && players.some(pp => (pp.parentIds || []).includes(userData.uid)));
      if (haveLinked && isUserCoach) setViewMode('parent');
      const next = new URLSearchParams(searchParams);
      next.delete('expand');
      setSearchParams(next, { replace: true });
    }
  }, [plans, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async (opts: { silent?: boolean } = {}) => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      // `silent` reloads keep the current card visible while the fetch
      // runs. Without it, setLoading(true) unmounts everything and the
      // page flashes to a spinner before the fresh data lands — Patrick
      // saw this after tapping "I did it" on a goal.
      if (!opts.silent) setLoading(true);

      // Load players and plans in parallel
      // Pass selectedTeamId so a shared player selected from the
      // dropdown doesn't leak their OTHER team's plans into this
      // team's /development view. The dropdown itself is populated
      // from getPlayersByTeam(selectedTeamId) so the (playerId,
      // teamId) pair is always consistent here. Founder-reported
      // bug 2026-07-14 (cross-team dev plan bleed).
      const plansPromise = (selectedPlayerId && selectedPlayerId !== 'all')
        ? getDevelopmentPlansByPlayer(selectedPlayerId, selectedTeamId)
        : getDevelopmentPlansByTeam(selectedTeamId);

      const [teamPlayersRaw, plansData] = await Promise.all([
        getPlayersByTeam(selectedTeamId).catch(() => []),
        plansPromise,
      ]);
      setPlayers(teamPlayersRaw.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
      })) as Player[]);

      const formattedPlans = plansData.map((p: any) => ({
        ...p,
        createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt),
        updatedAt: p.updatedAt?.toDate ? p.updatedAt.toDate() : undefined,
        completedAt: p.completedAt?.toDate ? p.completedAt.toDate() : undefined,
      })) as DevelopmentPlan[];

      setPlans(formattedPlans);
    } catch (error) {
      console.error('Error loading development data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Self-heal for stale player.currentStreakDays. Any time plans
  // (re)load, compute each player's true streak from their active
  // plans and compare to the cached value on the player doc — if
  // they disagree (which happens when a previous handleQuickDidIt
  // fire-and-forget write lost a race with loadData refetching the
  // player), write the correct streak back. Patrick: "the full plan
  // page says 5 day streak but the profile pills still say 4."
  // Without this, the drift only fixes itself on the NEXT new-day
  // tap; with it, opening the dev plan page resyncs.
  useEffect(() => {
    if (plans.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { computeStreakDays, recomputeAndPersistPlayerStreak } = await import('../utils/devPlanActions');
        const { doc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const byPlayer = new Map<string, DevelopmentPlan[]>();
        for (const p of plans) {
          if (p.status !== 'active') continue;
          const arr = byPlayer.get(p.playerId) || [];
          arr.push(p);
          byPlayer.set(p.playerId, arr);
        }
        for (const [playerId, activePlans] of Array.from(byPlayer.entries())) {
          if (cancelled) return;
          const computed = computeStreakDays(activePlans);
          // Read the cached value and only write when it differs to
          // avoid a write storm on every page load.
          try {
            // Direct doc read by ID — was `where('__name__', '==', id)`
            // which doesn't actually match in the Firestore Web SDK
            // (returns an empty snapshot, so the self-heal was a no-op
            // and the cached streak never resynced). Patrick: "on his
            // profile it says 5, in the development plan it says 6."
            const snap = await getDoc(doc(db, 'players', playerId));
            if (!snap.exists()) continue;
            const cached = (snap.data() as any).currentStreakDays || 0;
            if (cached === computed) continue;
            await recomputeAndPersistPlayerStreak(playerId, activePlans);
          } catch (err) {
            console.warn('streak self-heal skipped for', playerId, err);
          }
        }
      } catch (err) {
        console.warn('streak self-heal failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [plans]);

  // Players who already have an ACTIVE plan with the same (case-insensitive)
  // title. Surfaced in the preview modal so the coach can opt to skip them
  // and avoid the duplicate fan-out (Patrick hit this — assigned the same
  // plan to every kid, ended up with two of each).
  const detectDuplicates = (title: string, candidatePlayerIds: string[]): string[] => {
    const t = title.trim().toLowerCase();
    if (!t) return [];
    return candidatePlayerIds.filter(pid => plans.some(p =>
      p.playerId === pid
      && p.status === 'active'
      && (p.title || '').trim().toLowerCase() === t
    ));
  };

  // Validates + routes to the preview modal. Single-player creates
  // skip the preview (it's friction the bulk case needs but the solo
  // case doesn't).
  const handleCreatePlan = () => {
    if (!userData || !planTitle.trim()) return;

    const targetIds: string[] = bulkPlayerIds.length > 0 ? bulkPlayerIds : (planPlayerId ? [planPlayerId] : []);
    if (targetIds.length === 0) { alert('Please select at least one player.'); return; }

    const baseGoalsTpl = planGoals.filter(g => g.title.trim());
    if (baseGoalsTpl.length === 0) { alert('Please add at least one goal to the plan.'); return; }

    const duplicates = detectDuplicates(planTitle, targetIds);

    // Solo path with no duplicate: commit directly. No friction.
    if (targetIds.length === 1 && duplicates.length === 0) {
      void commitCreatePlan(targetIds);
      return;
    }

    // Bulk OR any duplicate detected → confirm via preview first.
    setSkipDuplicates(duplicates.length > 0); // default to skipping dups when any exist
    setPreviewOpen(true);
  };

  // The actual fan-out write. Called either directly from the solo
  // path or from the preview modal's Confirm. Disables the Create
  // button via `submitting` so a slow network can't trigger a
  // double-submit (one of the suspected sources of Patrick's
  // accidental duplicates).
  //
  // NOTE: does not touch players/{id}.currentStreakDays. Streak is
  // player-scoped (players/{id}/dev_checkins subcollection, seeded
  // per tap by the worker), not plan-scoped. Creating a new plan
  // must never reset a kid's streak — the whole point of the 2026-
  // 07-21 rework. If a future refactor tempts you to bind streak to
  // plan status, re-read src/utils/devPlanActions.ts first.
  const commitCreatePlan = async (targetIds: string[]) => {
    if (!userData) return;
    if (submitting) return;
    setSubmitting(true);
    setPreviewOpen(false);

    const baseGoalsTpl = planGoals.filter(g => g.title.trim());
    let createdCount = 0;
    let failedCount = 0;
    const baseTime = Date.now();

    for (let pi = 0; pi < targetIds.length; pi++) {
      const pid = targetIds[pi];
      const player = players.find(p => p.id === pid);
      if (!player) { failedCount++; continue; }

      // Fresh goal IDs per plan so each player has independent objects
      const goals: DevelopmentGoal[] = baseGoalsTpl.map((g, i) => ({
        ...g,
        id: `goal_${baseTime}_${pi}_${i}`,
        playerCompleted: false,
        coachVerified: false,
        readyForReview: false,
        order: i,
      }));

      try {
        const { withSeasonId } = await import('../utils/seasons');
        const planPayload = await withSeasonId({
          playerId: pid,
          playerName: player.name,
          teamId: selectedTeamId,
          title: planTitle.trim(),
          description: planDescription.trim() || undefined,
          category: planCategory,
          goals,
          status: 'active',
          createdBy: userData.uid,
          createdByName: userData.name,
          updatedAt: new Date(),
        });
        await addDevelopmentPlan(planPayload as any);
        createdCount++;

        // Email + push parents per player (fire-and-forget)
        try {
          const { getParentEmailsForPlayer, tplDevPlan, sendEmailBatch, sendPushToPlayerParents } = await import('../utils/notify');
          const parents = await getParentEmailsForPlayer(pid, 'devPlan');
          if (parents.length > 0) {
            const { subject, html } = tplDevPlan({
              playerName: player.name,
              planTitle: planTitle.trim(),
              goalCount: goals.length,
              coachName: userData.name,
              signature: {
                name: userData.name,
                role: (userData as any).coachLevel === 'assistant_coach' ? 'Assistant Coach' : 'Head Coach',
                teamName: selectedTeam?.name,
                email: userData.email,
                avatarUrl: (userData as any).photoURL || (userData as any).profilePhotoUrl,
              },
            });
            sendEmailBatch(parents.map(p => ({ to: p.email, subject, html })));
          }
          sendPushToPlayerParents(pid, {
            title: `${player.name}: new growth plan`,
            body: `${planTitle.trim()} · ${goals.length} goal${goals.length === 1 ? '' : 's'}`,
            path: `/development`,
          }, 'devPlan');
        } catch (e) { console.warn('dev plan notify failed', e); }
      } catch (error) {
        console.error('Error creating development plan for', pid, error);
        failedCount++;
      }
    }

    setSubmitting(false);

    if (createdCount > 0 && failedCount === 0) {
      void bumpDrillAssignmentCounts(createdCount);
      resetCreateForm();
      setShowCreateModal(false);
      loadData();
    } else if (createdCount > 0 && failedCount > 0) {
      void bumpDrillAssignmentCounts(createdCount);
      alert(`Created ${createdCount} plan(s), but ${failedCount} failed. Refreshing…`);
      resetCreateForm();
      setShowCreateModal(false);
      loadData();
    } else {
      alert('Failed to create plan(s). Please try again.');
    }
  };

  // Bump usage counter on every drill the coach imported into this
  // plan, once per player the plan landed on. Bubbles workhorse drills
  // to the top of the library. Fire-and-forget — never blocks the
  // create flow.
  const bumpDrillAssignmentCounts = async (plansCreated: number) => {
    if (importedDrillIds.length === 0 || plansCreated <= 0) return;
    try {
      const { doc: fsDoc, getDoc, updateDoc, increment } = await import('firebase/firestore');
      const { db } = await import('../utils/firebase');
      await Promise.all(importedDrillIds.map(async (id) => {
        try {
          const ref = fsDoc(db, 'drills', id);
          const snap = await getDoc(ref);
          if (!snap.exists()) return;
          await updateDoc(ref, { assignmentCount: increment(plansCreated), updatedAt: new Date() });
        } catch { /* ignore single-drill failures */ }
      }));
    } catch (err) {
      console.warn('bumpDrillAssignmentCounts failed', err);
    }
  };

  const handleTogglePlayerComplete = async (plan: DevelopmentPlan, goalId: string) => {
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId
        ? {
            ...g,
            playerCompleted: !g.playerCompleted,
            playerCompletedAt: !g.playerCompleted ? new Date() : undefined,
          }
        : g
    );

    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      loadData();
    } catch (error) {
      console.error('Error updating goal:', error);
      alert("Couldn't save. Try again.");
    }
  };

  const handleCoachVerify = async (plan: DevelopmentPlan, goalId: string) => {
    if (!userData || !isUserCoach) return;

    const updatedGoals = plan.goals.map(g =>
      g.id === goalId
        ? {
            ...g,
            coachVerified: !g.coachVerified,
            coachVerifiedAt: !g.coachVerified ? new Date() : undefined,
            coachVerifiedBy: !g.coachVerified ? userData.uid : undefined,
            coachVerifiedByName: !g.coachVerified ? userData.name : undefined,
          }
        : g
    );

    // Check if all goals are now verified
    const allVerified = updatedGoals.every(g => g.coachVerified);
    const justCompleted = allVerified && plan.status !== 'completed';

    try {
      await updateDevelopmentPlan(plan.id, {
        goals: updatedGoals,
        status: allVerified ? 'completed' : 'active',
        completedAt: allVerified ? new Date() : undefined,
      });
      // Auto-post to the team wall when the plan crosses the finish
      // line (was not yet 'completed' and now is).
      if (justCompleted) {
        try {
          const player = players.find(p => p.id === plan.playerId);
          if (player && player.teamId) {
            const { autoPostDevPlanCompleteToWall } = await import('../utils/autoPostToWall');
            void autoPostDevPlanCompleteToWall(
              { name: player.name, teamId: player.teamId },
              { title: plan.title },
              { uid: userData.uid, name: userData.name || 'Coach', role: 'coach' },
            );
          }
        } catch (e) { console.warn('dev plan wall post failed', e); }
      }
      loadData();
    } catch (error) {
      console.error('Error verifying goal:', error);
      alert("Couldn't verify. Try again.");
    }
  };

  const handleCoachNote = async (plan: DevelopmentPlan, goalId: string, note: string) => {
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId ? { ...g, notes: note } : g
    );

    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
    } catch (error) {
      console.error('Error saving note:', error);
      alert("Couldn't save your note. Try again.");
    }
  };

  const handleReadyForReview = async (plan: DevelopmentPlan, goalId: string) => {
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId
        ? { ...g, readyForReview: !g.readyForReview, readyForReviewAt: !g.readyForReview ? new Date() : undefined }
        : g
    );
    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      loadData();
    } catch (error) {
      console.error('Error toggling ready for review:', error);
      alert("Couldn't mark ready. Try again.");
    }
  };

  // Add a comment to the plan's discussion thread. Visible to anyone
  // who can see the plan (coach, the kid's parents). Triggers a push
  // to the OTHER side — coach pings get parents, parent pings get
  // the coach who created the plan.
  const handleAddComment = async (plan: DevelopmentPlan, text: string) => {
    if (!userData || !text.trim()) return;
    const comment: PlanComment = {
      id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      authorUid: userData.uid,
      authorName: userData.name || 'Member',
      authorRole: userData.role as any,
      text: text.trim().slice(0, 1000),
      createdAt: new Date(),
    };
    const next = [...(plan.comments || []), comment];
    try {
      await updateDevelopmentPlan(plan.id, { comments: next } as any);
      loadData();
      // Fire-and-forget push fan-out.
      try {
        const { sendPushToUsers, sendPushToPlayerParents } = await import('../utils/notify');
        const fromUid = userData.uid;
        if (isUserCoach) {
          // Coach commented → push the parents of this plan's player
          // AND every other coach on the team, so assistants and
          // co-heads see the exchange without having to open the
          // plan. Any coach who doesn't want these can mute via
          // their own push preferences. Self-guard drops the
          // commenter from the fanout so the coach who typed doesn't
          // buzz their own phone.
          sendPushToPlayerParents(plan.playerId, {
            title: `Coach ${userData.name?.split(' ')[0] || ''} on ${plan.playerName}'s plan`,
            body: comment.text.length > 140 ? `${comment.text.slice(0, 137)}…` : comment.text,
            path: `/development?expand=${plan.id}`,
          }, { coachTeamId: plan.teamId, fromUid });
        } else {
          // Parent commented → push the coach who created the plan.
          if (plan.createdBy && plan.createdBy !== fromUid) {
            sendPushToUsers([plan.createdBy], {
              title: `${userData.name?.split(' ')[0] || 'Parent'}: question on ${plan.playerName}'s plan`,
              body: comment.text.length > 140 ? `${comment.text.slice(0, 137)}…` : comment.text,
              url: `/development?expand=${plan.id}`,
            }, { fromUid });
          }
        }
      } catch (e) { console.warn('plan comment push failed', e); }
    } catch (err) {
      console.error('add comment failed', err);
      alert('Couldn\'t post — try again.');
    }
  };

  // One-tap "I did this drill today" for parents. No note, no
  // duration — just a dated entry. The full "Log Practice" form stays
  // for when the parent wants to add a detail.
  const handleQuickDidIt = async (plan: DevelopmentPlan, goalId: string) => {
    if (!userData) return;
    const entry: PracticeLogEntry = {
      id: `log_${Date.now()}`,
      date: new Date(),
      note: 'Did it today',
      loggedBy: userData.uid,
      loggedByName: userData.name,
    };
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId ? { ...g, practiceLog: [...(g.practiceLog || []), entry] } : g
    );
    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      // Cache the new streak on the player doc so PlayerCard rows
      // can show a badge without re-loading plans. AWAIT (not void)
      // because loadData() below re-reads the player from Firestore.
      // If the streak write hasn't landed yet, loadData reads the
      // OLD currentStreakDays — that's the bug Patrick reported:
      // "the full plan page says 5 day streak but the profile pills
      // still say 4." Same race InlineDevPlanCard had; same fix.
      await recomputeAndPersistPlayerStreak(plan.playerId, plan, updatedGoals);
      loadData({ silent: true });
    } catch (error) {
      console.error('Error logging quick did-it:', error);
      alert("Couldn't log 'did it' today. Try again.");
    }
  };

  // Walk every practice-log date across this player's active plans,
  // bucket by day, count consecutive days ending today (Sundays
  // skipped — see computeStreakDays in utils/devPlanActions). Write the
  // result to players/{id}.currentStreakDays.
  const recomputeAndPersistPlayerStreak = async (
    playerId: string,
    updatedPlan: DevelopmentPlan,
    updatedGoalsForThisPlan: DevelopmentGoal[],
  ) => {
    try {
      const playerPlans = plans
        .filter(p => p.playerId === playerId && p.status === 'active')
        .map(p => p.id === updatedPlan.id ? { ...p, goals: updatedGoalsForThisPlan } : p);
      if (!playerPlans.some(p => p.id === updatedPlan.id) && updatedPlan.status === 'active') {
        playerPlans.push({ ...updatedPlan, goals: updatedGoalsForThisPlan });
      }
      const { recomputeAndPersistPlayerStreak: persist } = await import('../utils/devPlanActions');
      // Pass the logged-in user as the actor so the helper can detect
      // streak-milestone crossings and fire a wall post.
      const actor = userData ? { uid: userData.uid, name: userData.name || 'Coach', role: userData.role } : undefined;
      await persist(playerId, playerPlans, actor);
    } catch (err) {
      console.warn('streak cache write failed', err);
    }
  };

  const handleAddPracticeLog = async (plan: DevelopmentPlan, goalId: string, note: string, minutes?: number) => {
    if (!userData || !note.trim()) return;
    const entry: PracticeLogEntry = {
      id: `log_${Date.now()}`,
      date: new Date(),
      note: note.trim(),
      minutes,
      loggedBy: userData.uid,
      loggedByName: userData.name,
    };
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId ? { ...g, practiceLog: [...(g.practiceLog || []), entry] } : g
    );
    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      loadData();
    } catch (error) {
      console.error('Error adding practice log:', error);
    }
  };

  const handleAddVideoLink = async (plan: DevelopmentPlan, goalId: string, url: string, title?: string) => {
    if (!userData) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const link: VideoLink = {
      id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      url: trimmed,
      youtubeId: extractYouTubeId(trimmed) || undefined,
      title: title?.trim() || undefined,
      addedBy: userData.uid,
      addedByName: userData.name,
      addedAt: new Date(),
    };
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId ? { ...g, videoLinks: [...(g.videoLinks || []), link] } : g
    );
    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      loadData();
    } catch (error) {
      console.error('Error adding video link:', error);
      alert('Failed to add link.');
    }
  };

  const handleRemoveVideoLink = async (plan: DevelopmentPlan, goalId: string, linkId: string) => {
    const updatedGoals = plan.goals.map(g =>
      g.id === goalId ? { ...g, videoLinks: (g.videoLinks || []).filter(l => l.id !== linkId) } : g
    );
    try {
      await updateDevelopmentPlan(plan.id, { goals: updatedGoals });
      loadData();
    } catch (error) {
      console.error('Error removing video link:', error);
      alert("Couldn't remove the video. Try again.");
    }
  };

  const handleCreateNextPlan = (plan: DevelopmentPlan) => {
    resetCreateForm();
    setPrefillPlayerId(plan.playerId);
    setPlanPlayerId(plan.playerId);
    setBulkPlayerIds([plan.playerId]);
    setPlanCategory(plan.category);
    setShowCreateModal(true);
  };

  const handleArchivePlan = async (planId: string) => {
    if (!window.confirm('Archive this development plan? It will be hidden from the player\'s active list but the work history is kept.')) return;
    try {
      // Archive is silent. The previous implementation also auto-posted
      // a "X completed their plan!" to the wall on every archive, which
      // false-fired when Patrick archived an accidental duplicate plan
      // and the team saw "Hunter completed Foundations" for kids who
      // hadn't touched it. The true completion signal still fires from
      // handleVerifyGoal when every goal flips to coach-verified — that
      // path is correct and intact. Archive just parks the plan.
      await updateDevelopmentPlan(planId, { status: 'archived' });
      loadData();
    } catch (error) {
      console.error('Error archiving plan:', error);
      alert("Couldn't archive the plan. Try again.");
    }
  };

  // Soft-delete for "created in error" cleanup (e.g. accidental
  // duplicates from the bulk-assign flow). status='deleted' is filtered
  // out of every view query. No wall post, no completedAt stamp — this
  // plan is treated as if it never existed.
  const handleDeletePlan = async (planId: string) => {
    if (!window.confirm('Delete this plan? It will disappear from the player\'s page. Use Archive instead if the kid actually worked on it. No wall post will be sent.')) return;
    try {
      await updateDevelopmentPlan(planId, { status: 'deleted' });
      loadData();
    } catch (error) {
      console.error('Error deleting plan:', error);
      alert("Couldn't delete. Try again.");
    }
  };

  const handleEditPlan = (plan: DevelopmentPlan) => {
    setEditingPlanId(plan.id);
    setPlanPlayerId(plan.playerId);
    setPlanTitle(plan.title);
    setPlanDescription(plan.description || '');
    setPlanCategory(plan.category);
    // Preserve all existing goal state (completion, notes, links, etc.)
    setPlanGoals(plan.goals.map((g, i) => ({ ...g, order: i })));
    setShowCreateModal(true);
  };

  const handleUpdatePlan = async () => {
    if (!editingPlanId || !planTitle.trim()) return;
    const existing = plans.find(p => p.id === editingPlanId);
    if (!existing) return;

    // Merge: keep existing goal state by id; new goals get fresh defaults
    const existingById = new Map(existing.goals.map(g => [g.id, g]));
    const mergedGoals: DevelopmentGoal[] = planGoals
      .filter(g => g.title.trim())
      .map((g, i) => {
        const prior = existingById.get(g.id);
        return {
          ...(prior || {
            playerCompleted: false,
            coachVerified: false,
            readyForReview: false,
          }),
          ...g,
          order: i,
        } as DevelopmentGoal;
      });

    if (mergedGoals.length === 0) {
      alert('Plan must have at least one goal.');
      return;
    }

    try {
      await updateDevelopmentPlan(editingPlanId, {
        title: planTitle.trim(),
        description: planDescription.trim() || undefined,
        category: planCategory,
        goals: mergedGoals,
        updatedAt: new Date(),
      });
      resetCreateForm();
      setEditingPlanId(null);
      setShowCreateModal(false);
      loadData();
    } catch (error) {
      console.error('Error updating plan:', error);
      alert('Failed to update plan. Please try again.');
    }
  };

  const addGoalField = () => {
    setPlanGoals([...planGoals, {
      id: `goal_${Date.now()}`,
      title: '',
      description: '',
      order: planGoals.length,
    }]);
  };

  const updateGoalField = (index: number, field: string, value: any) => {
    const updated = [...planGoals];
    (updated[index] as any)[field] = value;
    setPlanGoals(updated);
  };

  const removeGoalField = (index: number) => {
    if (planGoals.length <= 1) return;
    setPlanGoals(planGoals.filter((_, i) => i !== index));
  };

  const resetCreateForm = () => {
    setPlanPlayerId('');
    setBulkPlayerIds([]);
    setPlanTitle('');
    setPlanDescription('');
    setPlanCategory('technical');
    setPlanGoals([{ id: `goal_${Date.now()}`, title: '', description: '', order: 0 }]);
    setImportedDrillIds([]);
  };

  // Append library drills to the in-progress plan. Each drill becomes a
  // goal pre-filled with title/setup/instructions/focus/duration/videos
  // — coach can still edit before saving. If the existing planGoals
  // array only has the initial empty placeholder, we replace it; if
  // they've already typed goals, we append.
  const importDrillsToPlan = (drills: Drill[]) => {
    if (drills.length === 0) return;
    const newGoals = drills.map((d, i) => ({
      id: `goal_${Date.now()}_${i}`,
      // Track the source drill so the goal can live-resolve its
      // video later. If the coach re-uploads to the drill, resolveGoalVideo
      // picks up the new streamUid without needing to re-import.
      drillId: d.id,
      title: d.title,
      description: d.description || '',
      setup: d.setup || undefined,
      instructions: d.instructions || undefined,
      focus: d.focus || undefined,
      duration: d.durationMinutes != null ? `${d.durationMinutes} min` : undefined,
      targetMinutes: d.durationMinutes,
      videoLinks: d.videoLinks || [],
      // Carry the drill's coach-uploaded Stream video onto the goal as
      // a snapshot. resolveGoalVideo prefers the drill's CURRENT value
      // at render time, so this is just the fallback for orphan goals
      // (drill deleted, etc.).
      ...(d.streamUid ? { streamUid: d.streamUid, streamReady: d.streamReady } : {}),
      order: 0, // re-numbered below
    }));
    const existing = planGoals.filter(g => g.title.trim());
    const merged = [...existing, ...newGoals].map((g, i) => ({ ...g, order: i }));
    setPlanGoals(merged);
    setImportedDrillIds(prev => Array.from(new Set([...prev, ...drills.map(d => d.id)])));
    // Smart-fill the plan title + category on the first import if the
    // coach hasn't already set them — saves a round-trip when they're
    // really just spinning up a one-drill plan.
    if (!planTitle.trim() && drills.length === 1) {
      setPlanTitle(drills[0].title);
      setPlanCategory(drills[0].category);
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'technical': return 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/20';
      case 'tactical': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'physical': return 'bg-orange-100 text-orange-300 border-orange-400/30';
      case 'mental': return 'bg-green-100 text-emerald-300 border-green-200';
      default: return 'bg-line-default/[0.08] text-ink-primary/85 border-line-default/10';
    }
  };

  // Returns an AppIcon name (no emoji) — keeps the visual cue per
  // category aligned with the rest of the app's icon language.
  const getCategoryIcon = (category: string): any => {
    switch (category) {
      case 'technical': return 'soccer';
      case 'tactical': return 'chart';
      case 'physical': return 'running';
      case 'mental': return 'trophy';
      default: return 'clipboard';
    }
  };

  const getProgressPercentage = (plan: DevelopmentPlan) => {
    if (plan.goals.length === 0) return 0;
    return Math.round((plan.goals.filter(g => g.coachVerified).length / plan.goals.length) * 100);
  };

  // Streak per player — reads the player-scoped source of truth
  // (players/{pid}.currentStreakDays, backed by the dev_checkins
  // subcollection). Prior shape derived a coach-verified-goals count
  // from the plan docs, which reset every time a plan was retired or
  // replaced — the exact per-plan drift Patrick called out
  // ("dashboard has the right streak, but the plan page has the new
  // one"). Reading the cache keeps every surface aligned with the
  // Dashboard chip.
  const playerStreaks = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of players) {
      const n = Number((p as any).currentStreakDays);
      if (Number.isFinite(n) && n > 0) map[p.id] = n;
    }
    return map;
  }, [players]);

  // topStreak is computed once visiblePlans exists (declared below).
  // Delayed so parent view can't leak another family's kid name into
  // the "Top streak" DevTile — previously iterated the full team's
  // playerStreaks map (audit 2026-07-11).

  // Linked players for the current user (parent → kids OR coach-with-
  // kids). Drives whether the Coach/Parent toggle shows up at all.
  const myLinkedPlayers = useMemo(() => {
    if (!userData) return [] as Player[];
    return players.filter(p => (p.parentIds || []).includes(userData.uid));
  }, [players, userData]);
  const hasLinkedPlayers = myLinkedPlayers.length > 0;
  // Effective view: if the user isn't a coach, they're always parent.
  // If they're a coach with no linked players, they're always coach.
  // Otherwise the toggle picks.
  const effectiveView: 'coach' | 'parent' = isUserCoach
    ? (hasLinkedPlayers ? viewMode : 'coach')
    : 'parent';

  // For parents (or coaches in Parent View): find plans related to
  // their children. Coaches in Coach View see everything.
  const getVisiblePlans = () => {
    if (effectiveView === 'coach') return plans;
    if (!userData) return [];
    return plans.filter(plan => {
      const player = players.find(p => p.id === plan.playerId);
      return player?.parentIds?.includes(userData.uid);
    });
  };

  const visiblePlans = getVisiblePlans();
  const activePlans = visiblePlans.filter(p => p.status === 'active');
  const completedPlans = visiblePlans.filter(p => p.status === 'completed');
  const archivedPlans = visiblePlans.filter(p => p.status === 'archived');

  // Top streak DevTile — scope to visible plans so parent view sees
  // only their own kids in the "Top streak" panel. Coach view still
  // sees everyone because visiblePlans === plans for coach.
  const topStreak = React.useMemo(() => {
    const visiblePlayerIds = new Set(visiblePlans.map(p => p.playerId));
    let best: { playerId: string; name: string; streak: number } | null = null;
    for (const pid in playerStreaks) {
      if (!visiblePlayerIds.has(pid)) continue;
      const s = playerStreaks[pid];
      if (s <= 0) continue;
      if (!best || s > best.streak) {
        const player = players.find(p => p.id === pid);
        best = { playerId: pid, name: player?.name || 'Player', streak: s };
      }
    }
    return best;
  }, [playerStreaks, players, visiblePlans]);

  // Parent view (whether the user is actually a parent or a coach who
  // toggled to it) sees only their own children in the player filter.
  // Dedup-by-id is defensive: Patrick was seeing "two Hunters" in the
  // selector even though only one Hunter doc exists in Firestore. The
  // root cause of the duplication wasn't reproducible from the data,
  // so we dedup here as belt-and-suspenders — the selector should
  // never render the same player twice regardless of what state holds.
  const visiblePlayers = (() => {
    const list = effectiveView === 'coach' ? players : myLinkedPlayers;
    return Array.from(new Map(list.map(p => [p.id, p])).values());
  })();
  // Convenience for hiding coach-side controls in Parent View.
  const showCoachControls = effectiveView === 'coach';

  if (loading) return <DataGate when="loading" />;

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title="Player Pathway" subtitle="Personalized growth plans for every player on the squad." />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Coach View / Parent View toggle — only renders for users who
            wear both hats (Patrick coaches Hunter's U10 team). Other
            users land on their natural view and don't see the chip. */}
        {isUserCoach && hasLinkedPlayers && (
          <div className="mb-3 inline-flex rounded-xl bg-surface-elevated ring-1 ring-line-default/10 shadow-sm p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('coach')}
              className={`px-4 py-1.5 rounded-lg text-xs font-extrabold tracking-widest uppercase transition ${
                viewMode === 'coach' ? 'bg-brand-primary text-white shadow' : 'text-ink-primary/50 hover:text-ink-primary'
              }`}
            >
              Coach View
            </button>
            <button
              type="button"
              onClick={() => { setViewMode('parent'); setSelectedPlayerId('all'); }}
              className={`px-4 py-1.5 rounded-lg text-xs font-extrabold tracking-widest uppercase transition ${
                viewMode === 'parent' ? 'bg-brand-primary text-white shadow' : 'text-ink-primary/50 hover:text-ink-primary'
              }`}
            >
              My {myLinkedPlayers.length > 1 ? 'kids' : 'kid'}
            </button>
          </div>
        )}

        {/* Filter + New Plan */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-primary/50">
              <AppIcon name="players" className="w-4 h-4" />
            </span>
            <select
              value={selectedPlayerId}
              onChange={e => setSelectedPlayerId(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 bg-surface-elevated border border-line-default/10 rounded-xl text-sm font-medium text-ink-primary shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
              style={{ fontSize: '16px' }}
            >
              <option value="all">{effectiveView === 'coach' ? 'All Players' : (myLinkedPlayers.length > 1 ? 'All My Children' : myLinkedPlayers[0]?.name || 'My child')}</option>
              {visiblePlayers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {showCoachControls && (
            <button
              onClick={() => { resetCreateForm(); setEditingPlanId(null); setShowCreateModal(true); }}
              className="bg-brand-primary hover:bg-brand-primary text-white px-4 py-2.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm"
            >
              <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
              <span>New Plan</span>
            </button>
          )}
        </div>

        {/* Summary Stats — 2x2 on mobile, 4-up on desktop */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <DevTile icon="clipboard" tint="cyan" value={activePlans.length} label="Active Plans" />
          <DevTile icon="check" tint="emerald" value={completedPlans.length} label="Completed" />
          <DevTile icon="players" tint="navy" value={isUserCoach ? players.length : visiblePlayers.length} label={isUserCoach ? 'Players' : 'My Children'} />
          <DevTile
            icon="highlight"
            tint="fire"
            value={topStreak ? topStreak.streak : 0}
            label={topStreak ? `${topStreak.name.split(' ')[0]}'s streak` : 'Top streak'}
            badge={topStreak ? 'Keep it up!' : undefined}
          />
        </div>

        {/* GAMETAPE — coach-drops-a-clip section. Silent-empty when
            there are no active clips. Coach view (showCoachControls)
            gets the compose entry point + watched-by counter; parent
            view gets Got it. Passes selectedPlayerId only when a
            specific player is picked; 'all' collapses to team-wide.
            See DESIGN.clientFiles: GametapeSection. */}
        {selectedTeamId && (
          <GametapeSection
            teamId={selectedTeamId}
            visiblePlayers={visiblePlayers.map(p => ({
              id: p.id,
              name: p.name,
              profilePhotoUrl: (p as any).profilePhotoUrl || null,
            }))}
            effectiveView={effectiveView}
            showCoachControls={showCoachControls && isUserCoach}
            totalTeamPlayers={players.length}
          />
        )}

        {/* "Needs Review" coach banner removed — verification flow gone. */}

        {/* Active Plans */}
        {activePlans.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-ink-primary mb-4">Active Plans</h2>
            <div className="space-y-4">
              {activePlans.map(plan => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isCoach={showCoachControls && isUserCoach}
                  isExpanded={expandedPlanId === plan.id}
                  onToggleExpand={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
                  onPlayerComplete={(goalId) => handleTogglePlayerComplete(plan, goalId)}
                  onCoachVerify={(goalId) => handleCoachVerify(plan, goalId)}
                  onCoachNote={(goalId, note) => handleCoachNote(plan, goalId, note)}
                  onReadyForReview={(goalId) => handleReadyForReview(plan, goalId)}
                  onAddPracticeLog={(goalId, note, mins) => handleAddPracticeLog(plan, goalId, note, mins)}
                  onQuickDidIt={(goalId) => handleQuickDidIt(plan, goalId)}
                  onAddComment={(text) => handleAddComment(plan, text)}
                  onAddVideoLink={(goalId, url, title) => handleAddVideoLink(plan, goalId, url, title)}
                  onRemoveVideoLink={(goalId, linkId) => handleRemoveVideoLink(plan, goalId, linkId)}
                  onArchive={() => handleArchivePlan(plan.id)}
                  onDelete={() => handleDeletePlan(plan.id)}
                  onEdit={() => handleEditPlan(plan)}
                  onCreateNextPlan={() => handleCreateNextPlan(plan)}
                  getCategoryColor={getCategoryColor}
                  getCategoryIcon={getCategoryIcon}
                  getProgressPercentage={getProgressPercentage}
                  canPlayerComplete={effectiveView === 'parent' || !isUserCoach}
                  canLogPractice={true}
                  canVerifyLogs={isUserCoach}
                  onVerifyLog={handleVerifyLog}
                  verifiedOptimistic={verifiedOptimistic}
                  streak={playerStreaks[plan.playerId] || 0}
                  playerPhoto={(players.find(pp => pp.id === plan.playerId) as any)?.profilePhotoUrl || null}
                  resolveGoalVideo={resolveGoalVideo}
                  onCacheDrillMp4Url={handleCacheDrillMp4Url}
                />
              ))}
            </div>
          </div>
        )}

        {/* Completed Plans */}
        {completedPlans.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-ink-primary mb-4 flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-emerald-500/15 text-emerald-300 flex items-center justify-center">
                <AppIcon name="check" className="w-4 h-4" />
              </span>
              <span>Completed Plans</span>
            </h2>
            <div className="space-y-4">
              {completedPlans.map(plan => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isCoach={showCoachControls && isUserCoach}
                  isExpanded={expandedPlanId === plan.id}
                  onToggleExpand={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
                  onPlayerComplete={() => {}}
                  onCoachVerify={() => {}}
                  onCoachNote={() => {}}
                  onReadyForReview={() => {}}
                  onAddPracticeLog={() => {}}
                  onQuickDidIt={() => {}}
                  onAddVideoLink={() => {}}
                  onRemoveVideoLink={() => {}}
                  onArchive={() => handleArchivePlan(plan.id)}
                  onDelete={() => handleDeletePlan(plan.id)}
                  onEdit={() => handleEditPlan(plan)}
                  onCreateNextPlan={() => handleCreateNextPlan(plan)}
                  getCategoryColor={getCategoryColor}
                  getCategoryIcon={getCategoryIcon}
                  getProgressPercentage={getProgressPercentage}
                  canPlayerComplete={false}
                  canLogPractice={false}
                  canVerifyLogs={isUserCoach}
                  onVerifyLog={handleVerifyLog}
                  verifiedOptimistic={verifiedOptimistic}
                  streak={playerStreaks[plan.playerId] || 0}
                  playerPhoto={(players.find(pp => pp.id === plan.playerId) as any)?.profilePhotoUrl || null}
                  resolveGoalVideo={resolveGoalVideo}
                  onCacheDrillMp4Url={handleCacheDrillMp4Url}
                />
              ))}
            </div>
          </div>
        )}

        {visiblePlans.length === 0 && (
          <div className="text-center py-12 bg-surface-elevated rounded-2xl border border-line-default/10">
            <div className="mb-3 flex justify-center text-ink-primary/35">
              <AppIcon name="clipboard" className="w-12 h-12" />
            </div>
            <h3 className="text-lg font-medium text-ink-primary">No development plans yet</h3>
            <p className="text-ink-primary/65 mt-2">
              {isUserCoach
                ? "Create individual development plans to track each player's growth."
                : "Your coach hasn't created any development plans yet."}
            </p>
          </div>
        )}

        {/* Create Plan Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-6">
            <div className="bg-surface-elevated rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col">
              {/* Sticky header */}
              <div className="px-5 py-3 border-b border-line-default/10 flex items-center justify-between flex-shrink-0">
                <div>
                  {/* When the modal opens from a "Set a Challenge"
                      tap on a drill card, the first goal carries the
                      source drill's id. Surface that as the title so
                      the user understands what action they're in. */}
                  {(() => {
                    const seedDrill = !editingPlanId
                      ? planGoals.find(g => (g as any).drillId && drillsById[(g as any).drillId])
                      : null;
                    if (editingPlanId) return <h2 className="text-base font-bold text-ink-primary">Edit plan</h2>;
                    if (seedDrill) {
                      const drill = drillsById[(seedDrill as any).drillId];
                      return (
                        <>
                          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">Add to a Plan</p>
                          <h2 className="text-base font-bold text-ink-primary">{drill.title}</h2>
                        </>
                      );
                    }
                    return <h2 className="text-base font-bold text-ink-primary">New development plan</h2>;
                  })()}
                  {!editingPlanId && bulkPlayerIds.length > 0 && (
                    <p className="text-[11px] text-ink-primary/50 mt-0.5">{bulkPlayerIds.length} player{bulkPlayerIds.length === 1 ? '' : 's'} · {planGoals.filter(g => g.title.trim()).length || 0} goal{planGoals.filter(g => g.title.trim()).length === 1 ? '' : 's'}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { resetCreateForm(); setEditingPlanId(null); setShowCreateModal(false); }}
                  className="text-ink-primary/40 hover:text-ink-primary/85"
                  aria-label="Close"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <div className="space-y-4">
                  {/* Players — compact chips, multi-select, with quick all/clear */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65">
                        {editingPlanId ? 'Player' : `Players${bulkPlayerIds.length > 0 ? ` · ${bulkPlayerIds.length}` : ''}`}
                      </label>
                      {!editingPlanId && (
                        <div className="flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => { setBulkPlayerIds(players.map(p => p.id)); setPlanPlayerId(''); }}
                            className="text-brand-primary-soft hover:text-brand-primary-soft font-bold"
                          >All</button>
                          <span className="text-ink-primary/35">·</span>
                          <button
                            type="button"
                            onClick={() => { setBulkPlayerIds([]); setPlanPlayerId(''); }}
                            className="text-ink-primary/50 hover:text-ink-primary/90 font-bold"
                          >Clear</button>
                        </div>
                      )}
                    </div>
                    {editingPlanId ? (
                      <select
                        value={planPlayerId}
                        onChange={e => setPlanPlayerId(e.target.value)}
                        disabled
                        className="w-full px-3 py-2 text-sm border border-line-default/15 rounded-lg disabled:bg-line-default/[0.04] disabled:text-ink-primary/50"
                      >
                        {players.map(p => (
                          <option key={p.id} value={p.id}>{p.name}{p.jerseyNumber != null ? ` (#${p.jerseyNumber})` : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto p-2 border border-line-default/10 rounded-lg bg-line-default/[0.04]">
                          {players.length === 0 && (
                            <div className="w-full text-center text-xs text-ink-primary/50 py-3">Squad's empty.</div>
                          )}
                          {players.map(p => {
                            const checked = bulkPlayerIds.includes(p.id);
                            const label = p.jerseyNumber != null
                              ? `#${p.jerseyNumber} ${(p.name || '').split(' ')[0]}`
                              : p.name;
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => {
                                  setPlanPlayerId('');
                                  setBulkPlayerIds(prev => checked ? prev.filter(id => id !== p.id) : [...prev, p.id]);
                                }}
                                title={p.name}
                                className={`px-2.5 py-1 rounded-full text-xs font-bold transition-colors whitespace-nowrap ${checked
                                  ? 'bg-brand-primary text-white shadow-sm'
                                  : 'bg-surface-elevated text-ink-primary/85 ring-1 ring-line-default/15 hover:ring-brand-primary-soft'}`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        {bulkPlayerIds.length > 1 && (
                          <p className="mt-1.5 text-[11px] text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 rounded-md px-2 py-1">
                            Creates <b>{bulkPlayerIds.length}</b> identical plans — each tracks progress on its own.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65 mb-1.5">Plan title</label>
                    <input
                      type="text"
                      value={planTitle}
                      onChange={e => setPlanTitle(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      placeholder="e.g. Ball Control Mastery"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65 mb-1.5">Category</label>
                      <select
                        value={planCategory}
                        onChange={e => setPlanCategory(e.target.value as DevelopmentPlan['category'])}
                        className="w-full px-3 py-2 text-sm bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                      >
                        <option value="technical">Technical: ball, passing, shooting</option>
                        <option value="tactical">Tactical: positioning, awareness</option>
                        <option value="physical">Physical: speed, strength</option>
                        <option value="mental">Mental: focus, confidence</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65 mb-1.5">Description <span className="text-ink-primary/40 normal-case tracking-normal">(optional)</span></label>
                      <input
                        type="text"
                        value={planDescription}
                        onChange={e => setPlanDescription(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                        placeholder="What this plan focuses on…"
                      />
                    </div>
                  </div>

                  {/* Goals */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/65">Goals</label>
                      <button
                        type="button"
                        onClick={() => setDrillPickerOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-200 text-violet-200 text-[11px] font-extrabold tracking-widest uppercase ring-1 ring-violet-200"
                        title="Pick drills from your library"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>
                        Import from library
                      </button>
                    </div>
                    <div className="space-y-3">
                      {planGoals.map((goal, index) => (
                        <div key={goal.id} className="flex items-start space-x-2 bg-line-default/[0.04] p-3 rounded-lg">
                          <span className="text-sm font-medium text-ink-primary/40 mt-2">{index + 1}.</span>
                          <div className="flex-1 space-y-2">
                            <input
                              type="text"
                              value={goal.title}
                              onChange={e => updateGoalField(index, 'title', e.target.value)}
                              className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:ring-2 focus:ring-brand-primary text-sm font-medium"
                              placeholder="Title (e.g. Pass Weight Drill, Distance Control)"
                            />
                            <input
                              type="text"
                              value={(goal as any).duration || ''}
                              onChange={e => updateGoalField(index, 'duration', e.target.value)}
                              className="w-full px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                              placeholder="Duration (e.g. 10-15 min)"
                            />
                            <textarea
                              value={(goal as any).setup || ''}
                              onChange={e => updateGoalField(index, 'setup', e.target.value)}
                              rows={2}
                              className="w-full px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                              placeholder="Setup: e.g. Place 3 cones in a line at 10, 20, and 25 yards"
                            />
                            <textarea
                              value={(goal as any).instructions || ''}
                              onChange={e => updateGoalField(index, 'instructions', e.target.value)}
                              rows={3}
                              className="w-full px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                              placeholder="Instructions: step-by-step what to do"
                            />
                            <textarea
                              value={(goal as any).focus || ''}
                              onChange={e => updateGoalField(index, 'focus', e.target.value)}
                              rows={2}
                              className="w-full px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                              placeholder="Focus: the key coaching point"
                            />
                            <input
                              type="number"
                              min={0}
                              value={(goal as any).targetMinutes ?? ''}
                              onChange={e => updateGoalField(index, 'targetMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                              className="w-full px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                              placeholder="Practice minutes target (optional, e.g. 60)"
                            />
                            {/* YouTube link picker */}
                            <div className="space-y-1">
                              {(goal.videoLinks || []).map((link, li) => (
                                <div key={link.id} className="flex items-center gap-2 px-2 py-1 bg-surface-elevated border border-line-default/10 rounded text-xs">
                                  <svg className="w-3 h-3 text-rose-300 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M9 10l5 3-5 3z" fill="currentColor"/></svg>
                                  <span className="flex-1 truncate text-ink-primary/85">{link.title || link.url}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const updated = [...planGoals];
                                      const links = [...(updated[index].videoLinks || [])];
                                      links.splice(li, 1);
                                      (updated[index] as any).videoLinks = links;
                                      setPlanGoals(updated);
                                    }}
                                    className="text-ink-primary/40 hover:text-rose-300"
                                    aria-label="Remove"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                  </button>
                                </div>
                              ))}
                              <div className="flex gap-1">
                                <input
                                  type="url"
                                  placeholder="YouTube URL (optional)"
                                  className="flex-1 px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      const url = (e.target as HTMLInputElement).value.trim();
                                      if (!url) return;
                                      const titleInput = (e.currentTarget.parentElement?.querySelector('input[data-link-title]') as HTMLInputElement | null);
                                      const title = titleInput?.value.trim() || undefined;
                                      const updated = [...planGoals];
                                      const newLink: VideoLink = {
                                        id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                        url,
                                        youtubeId: extractYouTubeId(url) || undefined,
                                        title,
                                      };
                                      (updated[index] as any).videoLinks = [...(updated[index].videoLinks || []), newLink];
                                      setPlanGoals(updated);
                                      (e.target as HTMLInputElement).value = '';
                                      if (titleInput) titleInput.value = '';
                                    }
                                  }}
                                />
                                <input
                                  type="text"
                                  data-link-title="1"
                                  placeholder="Title"
                                  className="w-24 px-2 py-1 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/10 rounded text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    const wrap = e.currentTarget.parentElement!;
                                    const urlInput = wrap.querySelector('input[type="url"]') as HTMLInputElement;
                                    const titleInput = wrap.querySelector('input[data-link-title]') as HTMLInputElement;
                                    const url = urlInput.value.trim();
                                    if (!url) return;
                                    const updated = [...planGoals];
                                    const newLink: VideoLink = {
                                      id: `vl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                      url,
                                      youtubeId: extractYouTubeId(url) || undefined,
                                      title: titleInput.value.trim() || undefined,
                                    };
                                    (updated[index] as any).videoLinks = [...(updated[index].videoLinks || []), newLink];
                                    setPlanGoals(updated);
                                    urlInput.value = '';
                                    titleInput.value = '';
                                  }}
                                  className="px-2 py-1 bg-brand-primary hover:bg-brand-primary text-white text-xs font-medium rounded"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          </div>
                          {planGoals.length > 1 && (
                            <button
                              onClick={() => removeGoalField(index)}
                              className="p-1 text-red-400 hover:text-rose-300 mt-2"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={addGoalField}
                      className="mt-2 text-sm text-brand-primary-soft hover:text-brand-primary-soft font-bold"
                    >
                      + Add another goal
                    </button>
                  </div>
                </div>

              </div>
              {/* Sticky footer */}
              <div className="px-5 py-3 border-t border-line-default/10 flex items-center justify-end gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => { resetCreateForm(); setEditingPlanId(null); setShowCreateModal(false); }}
                  className="px-4 py-2 text-sm font-bold text-ink-primary/85 hover:bg-line-default/[0.08] rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={editingPlanId ? handleUpdatePlan : handleCreatePlan}
                  disabled={submitting || (editingPlanId ? !planPlayerId : (bulkPlayerIds.length === 0 && !planPlayerId)) || !planTitle.trim() || planGoals.every(g => !g.title.trim())}
                  className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary/150 disabled:opacity-50 rounded-lg"
                >
                  {submitting
                    ? 'Creating…'
                    : editingPlanId
                      ? 'Save changes'
                      : (bulkPlayerIds.length > 1 ? `Review ${bulkPlayerIds.length} plans` : 'Create plan')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bulk-create preview modal. Confirms the fan-out, surfaces
            anyone who already has an active plan with the same title,
            and offers a "skip duplicates" toggle so the coach doesn't
            accidentally double-assign. Solo creates with no duplicate
            skip this gate entirely. */}
        {previewOpen && (() => {
          const baseIds: string[] = bulkPlayerIds.length > 0 ? bulkPlayerIds : (planPlayerId ? [planPlayerId] : []);
          const duplicates = detectDuplicates(planTitle, baseIds);
          const dupSet = new Set(duplicates);
          const finalIds = skipDuplicates ? baseIds.filter(id => !dupSet.has(id)) : baseIds;
          return (
            <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-fade-in" onClick={() => setPreviewOpen(false)}>
              <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl p-5 sm:p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
                <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Review · {finalIds.length} plan{finalIds.length === 1 ? '' : 's'}</p>
                <h3 className="text-ink-primary text-lg font-bold leading-tight">
                  You're about to create {finalIds.length} {finalIds.length === 1 ? 'plan' : 'plans'}.
                </h3>
                <p className="text-ink-primary/65 text-sm mt-2">
                  Title: <span className="font-bold text-ink-primary">{planTitle.trim() || '(untitled)'}</span> · {planGoals.filter(g => g.title.trim()).length} goal{planGoals.filter(g => g.title.trim()).length === 1 ? '' : 's'} per player.
                </p>

                {duplicates.length > 0 && (
                  <div className="mt-4 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/30 px-3 py-3">
                    <p className="text-amber-300 text-xs font-extrabold uppercase tracking-widest mb-1.5">
                      Already has this plan
                    </p>
                    <ul className="text-amber-100 text-sm space-y-0.5">
                      {duplicates.map(pid => {
                        const player = players.find(p => p.id === pid);
                        return <li key={pid}>· {player?.name || pid}</li>;
                      })}
                    </ul>
                    <label className="flex items-center gap-2 mt-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={skipDuplicates}
                        onChange={(e) => setSkipDuplicates(e.target.checked)}
                        className="accent-brand-primary"
                      />
                      <span className="text-ink-primary text-xs">
                        Skip players who already have a "{planTitle.trim()}" plan
                      </span>
                    </label>
                  </div>
                )}

                <div className="mt-5 max-h-44 overflow-y-auto rounded-lg ring-1 ring-line-default/10 divide-y divide-line-default/10">
                  {baseIds.map(pid => {
                    const player = players.find(p => p.id === pid);
                    const isDup = dupSet.has(pid);
                    const willCreate = !isDup || !skipDuplicates;
                    return (
                      <div key={pid} className={`flex items-center justify-between px-3 py-2 text-sm ${willCreate ? 'text-ink-primary' : 'text-ink-primary/40 line-through'}`}>
                        <span>{player?.name || pid}</span>
                        {isDup && (
                          <span className="text-[10px] font-extrabold tracking-widest uppercase text-amber-300">
                            Has it
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-5 flex items-center gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(false)}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-semibold text-ink-primary/85 hover:text-ink-primary disabled:opacity-50"
                  >
                    Back to edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void commitCreatePlan(finalIds)}
                    disabled={submitting || finalIds.length === 0}
                    className="px-4 py-2 text-sm font-bold text-white bg-brand-primary hover:bg-brand-primary/90 disabled:opacity-50 rounded-lg"
                  >
                    {submitting
                      ? 'Creating…'
                      : `Create ${finalIds.length} ${finalIds.length === 1 ? 'plan' : 'plans'}`}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Drill picker — mounted AFTER the Create modal so when both
            are open it stacks on top. Same z-50 as the Create modal;
            later in DOM wins by default. */}
        <DrillPickerModal
          isOpen={drillPickerOpen}
          onClose={() => setDrillPickerOpen(false)}
          teamId={selectedTeamId || ''}
          onPick={(drills) => importDrillsToPlan(drills)}
        />
      </div>
    </div>
  );
};

// ─── Summary tile ────────────────────────────────────────────────────────────
const DEV_TILE_TINT: Record<string, { box: string; icon: string; value: string }> = {
  cyan:    { box: 'bg-brand-primary/15',     icon: 'text-brand-primary-soft',    value: 'text-brand-primary-soft'    },
  emerald: { box: 'bg-emerald-500/15',  icon: 'text-emerald-300', value: 'text-emerald-300' },
  navy:    { box: 'bg-surface-raised/10', icon: 'text-ink-primary/85',    value: 'text-ink-primary/85'    },
  fire:    { box: 'bg-brand-primary/15',     icon: 'text-ink-primary/85',    value: 'text-ink-primary/85'    },
};

const DevTile: React.FC<{
  icon: any;
  tint: 'cyan' | 'emerald' | 'navy' | 'fire';
  value: number;
  label: string;
  badge?: string;
}> = ({ icon, tint, value, label, badge }) => {
  const t = DEV_TILE_TINT[tint];
  return (
    <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10 p-4 flex items-center gap-3">
      <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${t.box} ${t.icon}`}>
        <AppIcon name={icon} className="w-5 h-5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-2xl font-bold ${t.value} leading-tight tabular-nums`}>{value}</p>
        <p className="text-xs text-ink-primary/65 truncate">{label}</p>
      </div>
      {badge && (
        <span className="px-2 py-1 rounded-full bg-brand-primary/20 text-charcoal-800 text-[11px] font-bold whitespace-nowrap">
          {badge}
        </span>
      )}
    </div>
  );
};

// ─── Plan Card Component ─────────────────────────────────────────────────────
interface PlanCardProps {
  plan: DevelopmentPlan;
  isCoach: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onPlayerComplete: (goalId: string) => void;
  onCoachVerify: (goalId: string) => void;
  onCoachNote: (goalId: string, note: string) => void;
  onReadyForReview: (goalId: string) => void;
  onAddPracticeLog: (goalId: string, note: string, minutes?: number) => void;
  onQuickDidIt: (goalId: string) => void;
  onAddComment?: (text: string) => void;
  onAddVideoLink: (goalId: string, url: string, title?: string) => void;
  onRemoveVideoLink: (goalId: string, linkId: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onCreateNextPlan: () => void;
  getCategoryColor: (cat: string) => string;
  getCategoryIcon: (cat: string) => any;
  getProgressPercentage: (plan: DevelopmentPlan) => number;
  canPlayerComplete: boolean;
  canLogPractice: boolean;
  /** True when the viewer can tap "Saw this" on a log entry to
   *  emit a coach_verify whisper. Distinct from canLogPractice
   *  (which is truthy for parents on their own kid too). */
  canVerifyLogs: boolean;
  onVerifyLog: (plan: DevelopmentPlan, goalId: string, logId: string) => Promise<void>;
  /** Optimistic verified-by cache shared from the outer page so the
   *  pill flips state instantly on coach tap without waiting for a
   *  full plan reload. */
  verifiedOptimistic: Record<string, { uid: string; name: string; at: Date }>;
  streak?: number;
  playerPhoto?: string | null;
  resolveGoalVideo: (goal: DevelopmentGoal) => {
    streamUid?: string;
    streamReady?: boolean;
    sourceDrillId?: string;
    streamMp4Url?: string;
  };
  /** Called after Share successfully resolves an MP4 URL from
   *  Cloudflare Stream, so the outer page can cache it back on the
   *  source drill doc (`drills/{id}.streamMp4Url`). Next Share tap
   *  short-circuits the network round trip. Optional — silently skips
   *  when the video resolved from a goal snapshot (no drill to write). */
  onCacheDrillMp4Url?: (drillId: string, url: string) => void;
}

// Inline comments thread — questions/replies/anything about THIS plan.
// Distinct from per-goal practice logs (which are dated "I did it"
// markers) — these are real prose between parent and coach.
const PlanComments: React.FC<{ comments: PlanComment[]; onAdd: (text: string) => void }> = ({ comments, onAdd }) => {
  const [draft, setDraft] = useState('');
  const sorted = [...comments].sort((a, b) => {
    const at = (a.createdAt as any)?.toDate?.()?.getTime?.() || new Date(a.createdAt).getTime();
    const bt = (b.createdAt as any)?.toDate?.()?.getTime?.() || new Date(b.createdAt).getTime();
    return at - bt;
  });
  const handleSubmit = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };
  return (
    <div className="mt-4 border-t border-line-default/5 pt-4">
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-4 h-4 text-ink-primary/50" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/65">
          Comments {sorted.length > 0 && <span className="text-ink-primary/40">· {sorted.length}</span>}
        </span>
      </div>
      {sorted.length > 0 && (
        <ul className="space-y-2 mb-3">
          {sorted.map(c => {
            const t = (c.createdAt as any)?.toDate?.() || new Date(c.createdAt);
            const isCoachAuthor = c.authorRole === 'coach' || c.authorRole === 'team_manager';
            return (
              <li key={c.id} className="rounded-lg bg-line-default/[0.04] ring-1 ring-line-default/10 px-3 py-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-xs font-bold text-ink-primary/90">{c.authorName}</span>
                  {isCoachAuthor && (
                    <span className="text-[9px] font-extrabold tracking-widest uppercase text-brand-primary-soft bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 px-1 py-0.5 rounded">Coach</span>
                  )}
                  <span className="ml-auto text-[10px] text-ink-primary/40">{t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p className="text-sm text-ink-primary/85 whitespace-pre-wrap">{c.text}</p>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || true)) handleSubmit(); }}
          placeholder="Question, update, or note…"
          className="flex-1 min-w-0 px-3 py-2 text-sm border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!draft.trim()}
          className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/150 disabled:opacity-50 text-white text-xs font-bold"
        >
          Post
        </button>
      </div>
    </div>
  );
};

const PlanCard: React.FC<PlanCardProps> = ({
  plan, isCoach, isExpanded, onToggleExpand, onPlayerComplete, onCoachVerify,
  onCoachNote, onReadyForReview, onAddPracticeLog, onQuickDidIt, onAddComment, onAddVideoLink, onRemoveVideoLink, onArchive, onDelete, onEdit, onCreateNextPlan, playerPhoto,
  getCategoryColor, getCategoryIcon, getProgressPercentage, canPlayerComplete, canLogPractice, canVerifyLogs, onVerifyLog, verifiedOptimistic, streak, resolveGoalVideo, onCacheDrillMp4Url
}) => {
  const progress = getProgressPercentage(plan);
  const playerProgress = plan.goals.length > 0
    ? Math.round((plan.goals.filter(g => g.playerCompleted).length / plan.goals.length) * 100)
    : 0;
  const totalLoggedMinutes = plan.goals.reduce(
    (sum, g) => sum + (g.practiceLog || []).reduce((s, l) => s + (l.minutes || 0), 0),
    0
  );
  const totalTargetMinutes = plan.goals.reduce((sum, g) => sum + (g.targetMinutes || 0), 0);
  const minutesProgress = totalTargetMinutes > 0
    ? Math.min(100, Math.round((totalLoggedMinutes / totalTargetMinutes) * 100))
    : 0;
  const readyForReviewCount = plan.goals.filter(g => g.readyForReview && !g.coachVerified).length;
  const [logGoalId, setLogGoalId] = useState<string | null>(null);
  const [logNote, setLogNote] = useState('');
  const [logMinutes, setLogMinutes] = useState('');
  const [showAllLogs, setShowAllLogs] = useState<string | null>(null);
  // Add-link inline form
  const [linkGoalId, setLinkGoalId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  // Per-goal share-in-flight lock. Prevents a double-tap from firing
  // two enable-download calls (and, worse, two native share sheets in
  // a row on iOS which the second one silently no-ops). Also drives
  // the "Preparing…" label on the button so the parent knows we're
  // actually working, not that the tap was lost.
  const [sharingGoalId, setSharingGoalId] = useState<string | null>(null);
  // One-shot toast for the pre-render fallback. Kept dead-simple: no
  // portal, no animation, just a warm hint that sits below the video
  // for a few seconds so the parent knows the share went out but the
  // MP4 wasn't ready yet.
  const [shareToast, setShareToast] = useState<{ goalId: string; message: string } | null>(null);

  const handleShareDrillVideo = async (
    goal: DevelopmentGoal,
    resolved: { streamUid?: string; streamReady?: boolean; sourceDrillId?: string; streamMp4Url?: string },
  ) => {
    const { streamUid, sourceDrillId, streamMp4Url } = resolved;
    if (!streamUid) return;
    if (sharingGoalId) return;
    setSharingGoalId(goal.id);
    try {
      // 1) Prefer the URL cached on the drill doc — instant, no network.
      // 2) Otherwise race Cloudflare's /downloads endpoint against a
      //    ~4s budget. If ready, share the MP4 (auto-plays inline in
      //    iMessage). Cache it back on the drill for next time.
      // 3) Otherwise fall back to the universal iframe embed. Still
      //    plays for the receiver, and the enable call we just fired
      //    has kicked off Cloudflare's render so the next tap resolves.
      let url: string | null = streamMp4Url || null;
      let usedFallback = false;
      if (!url) {
        url = await getOrEnableStreamDownloadUrl(streamUid, { timeoutMs: 4000 });
        if (url && sourceDrillId && onCacheDrillMp4Url) {
          try { onCacheDrillMp4Url(sourceDrillId, url); } catch { /* non-fatal */ }
        }
      }
      if (!url) {
        url = streamIframeUrl(streamUid);
        usedFallback = true;
      }
      const shareData = {
        title: goal.title || 'Soccer drill',
        url,
      };
      let shared = false;
      let usedClipboard = false;
      try {
        if (typeof navigator !== 'undefined' && (navigator as any).share) {
          await (navigator as any).share(shareData);
          shared = true;
        } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(url);
          shared = true;
          usedClipboard = true;
        }
      } catch (err: any) {
        // User dismissed the native sheet — no toast, no noise.
        if (err?.name !== 'AbortError') {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              await navigator.clipboard.writeText(url);
              shared = true;
              usedClipboard = true;
            }
          } catch {
            console.error('share drill failed', err);
          }
        }
      }
      if (shared) {
        if (usedFallback) {
          // Pre-render fallback: tell the parent the share went out but
          // the MP4 wasn't ready yet, so the next tap gets the nicer
          // inline preview.
          setShareToast({
            goalId: goal.id,
            message: 'Video preview is still cooking, share again shortly for the inline player.',
          });
        } else if (usedClipboard) {
          setShareToast({ goalId: goal.id, message: 'Link copied' });
        }
      }
    } finally {
      setSharingGoalId(null);
      // Auto-dismiss any toast after a short beat.
      setTimeout(() => setShareToast(prev => (prev && prev.goalId === goal.id ? null : prev)), 3500);
    }
  };

  const handleSubmitLog = () => {
    if (!logGoalId || !logNote.trim()) return;
    onAddPracticeLog(logGoalId, logNote, logMinutes ? parseInt(logMinutes) : undefined);
    setLogGoalId(null);
    setLogNote('');
    setLogMinutes('');
  };

  const playerInitial = (plan.playerName || '?').charAt(0).toUpperCase();

  return (
    <div className={`bg-surface-elevated rounded-2xl shadow-sm border overflow-hidden ${isExpanded ? 'border-brand-primary-soft/40 ring-2 ring-brand-primary-soft' : 'border-line-default/10'}`}>
      {/* Header — player avatar + name + title, with two horizontal
          progress bars beneath. Matches the Ollie reference card. */}
      <div
        className="p-4 cursor-pointer hover:bg-line-default/[0.05] transition-colors"
        onClick={onToggleExpand}
      >
        <div className="flex items-start gap-3">
          {/* Player avatar with category icon overlay */}
          <div className="relative shrink-0">
            {playerPhoto ? (
              <img
                src={playerPhoto}
                alt={plan.playerName}
                className="w-12 h-12 rounded-full object-cover ring-2 ring-brand-primary-soft"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-brand-primary to-surface-raised text-white flex items-center justify-center font-bold text-base ring-2 ring-brand-primary-soft">
                {playerInitial}
              </div>
            )}
            <span className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-surface-elevated shadow ring-1 ring-line-default/10 flex items-center justify-center ${getCategoryColor(plan.category).split(' ')[1]}`} title={plan.category}>
              <AppIcon name={getCategoryIcon(plan.category)} className="w-3 h-3" />
            </span>
          </div>

          {/* Title + name + pills */}
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-ink-primary leading-tight">{plan.title}</h3>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-sm text-ink-primary/65">{plan.playerName}</span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${getCategoryColor(plan.category)}`}>
                {plan.category}
              </span>
              {plan.status === 'completed' && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                  <AppIcon name="check" className="w-3 h-3" />
                  <span>Completed</span>
                </span>
              )}
              {/* "Ready for review" badge removed — no verification flow. */}
              {typeof streak === 'number' && streak >= 2 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-brand-primary/20 text-charcoal-800 border border-brand-primary-soft/30" title={`${streak}-day practice streak`}>
                  <AppIcon name="highlight" className="w-3 h-3" />
                  <span>{streak} streak</span>
                </span>
              )}
            </div>
          </div>

          <button
            className="text-ink-primary/40 hover:text-ink-primary/85 p-1.5 rounded-lg hover:bg-line-default/[0.08] shrink-0"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          >
            <svg className={`w-5 h-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Practice activity summary — single bar based on the player's
            session count. Replaces the dual player-progress / coach-
            verified bars (verification flow removed). */}
        <div className="mt-4 pt-4 border-t border-line-default/5">
          {(() => {
            const totalSessions = plan.goals.reduce((s, g) => s + (g.practiceLog?.length || 0), 0);
            return (
              <div className="text-[11px] flex items-center justify-between">
                <span className="text-ink-primary/50 font-semibold">Sessions logged</span>
                <span className="text-brand-primary-soft font-bold tabular-nums">{totalSessions}</span>
              </div>
            );
          })()}
          <div className="mt-2 text-[11px] text-ink-primary/50 flex items-center gap-3 justify-center">
            {totalLoggedMinutes > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-primary/150" />
                {totalTargetMinutes > 0 ? `${totalLoggedMinutes}/${totalTargetMinutes} min` : `${totalLoggedMinutes} min`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Goals */}
      {isExpanded && (
        <div className="border-t border-line-default/10 p-4">
          {plan.description && (
            <div className="mb-4 flex items-start gap-3">
              <span className="w-8 h-8 rounded-full bg-brand-primary text-white flex items-center justify-center shrink-0 mt-0.5">
                <AppIcon name="highlight" className="w-4 h-4" />
              </span>
              <p className="text-sm text-ink-primary/85 flex-1">{plan.description}</p>
            </div>
          )}

          {/* Practice Summary — only if anything logged */}
          {(() => {
            const totalMinutes = plan.goals.reduce((sum, g) =>
              sum + (g.practiceLog || []).reduce((s, e: any) => s + (e.minutes || 0), 0), 0);
            const totalEntries = plan.goals.reduce((sum, g) => sum + (g.practiceLog || []).length, 0);
            if (totalEntries === 0) return null;
            const hours = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;
            return (
              <div className="mb-4 flex items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5 bg-brand-primary/15 text-brand-primary-soft px-2.5 py-1 rounded-full">
                  <AppIcon name="clock" className="w-3.5 h-3.5" />
                  <span className="font-semibold">
                    {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`} practiced
                  </span>
                </span>
                <span className="text-ink-primary/50">{totalEntries} session{totalEntries !== 1 ? 's' : ''} logged</span>
              </div>
            );
          })()}

          <div className="space-y-3">
            {plan.goals.sort((a, b) => a.order - b.order).map((goal) => (
              <div key={goal.id} className="p-3 rounded-lg border bg-surface-elevated border-line-default/10">
                <div className="flex items-start space-x-3">
                  {/* Coach-verification UI removed (Patrick: "I want to
                      set the plan for them, but have them work on it,
                      with the parent logging that it was done. I don't
                      know whether I need to verify, I will see it
                      through practice if they are getting better.") The
                      coachVerified / readyForReview fields remain on the
                      schema for older docs but no UI reads or writes
                      them — the plan is parent-driven; the coach
                      judges progress in person. */}

                  <div className="flex-1">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="font-medium text-sm text-ink-primary">
                        {goal.title}
                        {(() => {
                          const goalMins = (goal.practiceLog || []).reduce((s, l) => s + (l.minutes || 0), 0);
                          if (goal.targetMinutes && goal.targetMinutes > 0) {
                            const pct = Math.min(100, Math.round((goalMins / goal.targetMinutes) * 100));
                            const done = pct >= 100;
                            return (
                              <span className={`ml-2 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${done ? 'bg-emerald-500/20 text-emerald-300' : 'bg-brand-primary/20 text-ink-primary/85'}`}>
                                {goalMins}/{goal.targetMinutes} min
                              </span>
                            );
                          }
                          if (goalMins > 0) {
                            return <span className="ml-2 text-[10px] font-semibold text-ink-primary/85">{goalMins} min</span>;
                          }
                          return null;
                        })()}
                      </span>
                      {/* Ready / Verify buttons removed — no
                          coach-verification flow. */}
                    </div>
                    {goal.description && (
                      <p className="text-xs text-ink-primary/50 mt-1">{goal.description}</p>
                    )}
                    {(goal.duration || goal.setup || goal.instructions || goal.focus) && (
                      <div className="mt-2 bg-line-default/[0.04] border border-line-default/10 rounded-lg p-3 space-y-2">
                        {goal.duration && (
                          <div className="inline-flex items-center gap-1.5 text-xs bg-surface-elevated text-ink-primary/85 px-2 py-0.5 rounded-full ring-1 ring-line-default/10">
                            <AppIcon name="clock" className="w-3.5 h-3.5 text-ink-primary/40" />
                            <span className="font-semibold">{goal.duration}</span>
                          </div>
                        )}
                        {goal.setup && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">Setup</div>
                            <p className="text-xs text-ink-primary/85 whitespace-pre-line mt-0.5">{goal.setup}</p>
                          </div>
                        )}
                        {goal.instructions && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">Instructions</div>
                            <p className="text-xs text-ink-primary/85 whitespace-pre-line mt-0.5">{goal.instructions}</p>
                          </div>
                        )}
                        {goal.focus && (
                          <div className="bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 rounded-lg p-2">
                            <div className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-ink-primary/85">
                              <AppIcon name="trophy" className="w-3 h-3" />
                              <span>Focus</span>
                            </div>
                            <p className="text-xs text-ink-primary/85 whitespace-pre-line mt-0.5">{goal.focus}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {goal.notes && (
                      <p className="text-xs text-brand-primary mt-1 italic">Coach note: {goal.notes}</p>
                    )}
                    <div className="flex items-center space-x-3 mt-1 text-xs text-ink-primary/40">
                      {goal.playerCompleted && (
                        <span className="inline-flex items-center gap-1">
                          <AppIcon name="check" className="w-3 h-3" />
                          <span>Player marked done</span>
                        </span>
                      )}
                      {goal.coachVerified && goal.coachVerifiedByName && (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
                          <AppIcon name="check" className="w-3 h-3" />
                          <span>Verified by {goal.coachVerifiedByName}</span>
                        </span>
                      )}
                    </div>

                    {/* Coach-uploaded reference video (Cloudflare Stream).
                        Live-resolved from the source drill — if the
                        coach re-uploads to the drill, the new video
                        shows up here without re-importing. Falls back
                        to the goal's own snapshot if the drill is
                        deleted or can't be matched. */}
                    {(() => {
                      const resolved = resolveGoalVideo(goal);
                      const { streamUid, streamReady } = resolved;
                      if (!streamUid) return null;
                      const isSharing = sharingGoalId === goal.id;
                      const toast = shareToast && shareToast.goalId === goal.id ? shareToast : null;
                      return (
                        <div className="mt-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-xs font-semibold text-ink-primary/50 uppercase tracking-wide inline-flex items-center gap-1.5">
                              <AppIcon name="film" className="w-3.5 h-3.5 text-ink-primary/40" />
                              <span>Demo video</span>
                            </p>
                            {/* Share to another parent via native sheet
                                (iMessage, WhatsApp, AirDrop) so a kid
                                without the app can still watch. Only
                                shown when the goal has a Cloudflare
                                Stream video — YouTube links already
                                share from YouTube. */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleShareDrillVideo(goal, resolved);
                              }}
                              disabled={isSharing}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-semibold text-brand-primary hover:text-brand-primary-hov bg-brand-primary/12 hover:bg-brand-primary/20 ring-1 ring-brand-primary/25 disabled:opacity-60 disabled:cursor-progress transition-colors"
                              aria-label="Share this drill video"
                              title="Share this drill"
                            >
                              <AppIcon name="share" className="w-4 h-4" />
                              <span>{isSharing ? 'Preparing…' : 'Share'}</span>
                            </button>
                          </div>
                          <div className="aspect-video w-full rounded-lg overflow-hidden bg-black ring-1 ring-line-default/10">
                            <CloudflareStreamIframe
                              uid={streamUid}
                              streamReady={streamReady === true}
                              title={`${goal.title}, coach demo`}
                              allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
                              iframeClassName="w-full h-full block border-0"
                            />
                          </div>
                          {toast && (
                            <p
                              role="status"
                              className="mt-1.5 text-[11px] text-ink-primary/60"
                            >
                              {toast.message}
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Video links / tutorials */}
                    {((goal.videoLinks && goal.videoLinks.length > 0) || (isCoach && plan.status === 'active')) && (
                      <div className="mt-3">
                        {goal.videoLinks && goal.videoLinks.length > 0 && (
                          <>
                            <p className="text-xs font-semibold text-ink-primary/50 uppercase tracking-wide mb-1.5 inline-flex items-center gap-1.5">
                              <AppIcon name="film" className="w-3.5 h-3.5 text-ink-primary/40" />
                              <span>Watch & Learn</span>
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {goal.videoLinks.map(link => (
                                <div key={link.id} className="relative group">
                                  <a
                                    href={link.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block w-40 rounded-lg overflow-hidden border border-line-default/10 bg-black hover:ring-2 hover:ring-red-400 transition-all"
                                  >
                                    {link.youtubeId ? (
                                      <div className="relative aspect-video bg-black">
                                        <img
                                          src={`https://i.ytimg.com/vi/${link.youtubeId}/mqdefault.jpg`}
                                          alt={link.title || 'Tutorial'}
                                          className="w-full h-full object-cover"
                                          loading="lazy"
                                        />
                                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                                          <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center shadow-md">
                                            <svg className="w-3.5 h-3.5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                                          </div>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="aspect-video bg-gradient-to-br from-brand-primary to-surface-raised flex items-center justify-center text-white text-xs px-2 text-center">
                                        Open link
                                      </div>
                                    )}
                                    <div className="px-2 py-1.5 bg-surface-elevated">
                                      <p className="text-xs font-medium text-ink-primary/90 line-clamp-2 leading-snug">
                                        {link.title || (link.youtubeId ? 'YouTube tutorial' : link.url)}
                                      </p>
                                    </div>
                                  </a>
                                  {isCoach && plan.status === 'active' && (
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        if (window.confirm('Remove this link?')) onRemoveVideoLink(goal.id, link.id);
                                      }}
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-opacity"
                                      aria-label="Remove link"
                                    >
                                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                        {isCoach && plan.status === 'active' && (
                          <div className="mt-2">
                            {linkGoalId === goal.id ? (
                              <div className="space-y-2 bg-brand-primary/15/60 border border-brand-primary-soft/20 rounded-lg p-2">
                                <input
                                  type="url"
                                  value={linkUrl}
                                  onChange={e => setLinkUrl(e.target.value)}
                                  placeholder="Paste YouTube link (https://youtu.be/...)"
                                  className="w-full px-2 py-1.5 text-xs border border-line-default/15 rounded focus:ring-2 focus:ring-brand-primary"
                                  autoFocus
                                />
                                <input
                                  type="text"
                                  value={linkTitle}
                                  onChange={e => setLinkTitle(e.target.value)}
                                  placeholder="Optional title (e.g. 'Inside-of-foot pass technique')"
                                  className="w-full px-2 py-1.5 text-xs border border-line-default/15 rounded focus:ring-2 focus:ring-brand-primary"
                                />
                                <div className="flex justify-end space-x-2">
                                  <button
                                    onClick={() => { setLinkGoalId(null); setLinkUrl(''); setLinkTitle(''); }}
                                    className="text-xs text-ink-primary/50 hover:text-ink-primary/85 px-2 py-1"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (!linkUrl.trim()) return;
                                      onAddVideoLink(goal.id, linkUrl, linkTitle);
                                      setLinkGoalId(null);
                                      setLinkUrl('');
                                      setLinkTitle('');
                                    }}
                                    disabled={!linkUrl.trim()}
                                    className="text-xs bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white font-medium px-3 py-1 rounded"
                                  >
                                    Add Link
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setLinkGoalId(goal.id); setLinkUrl(''); setLinkTitle(''); }}
                                className="text-xs text-brand-primary hover:text-brand-primary-soft font-medium"
                              >
                                + Add YouTube tutorial
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Practice Log */}
                    {(() => {
                      const logs = goal.practiceLog || [];
                      const totalMins = logs.reduce((s: number, e: any) => s + (e.minutes || 0), 0);
                      const hours = Math.floor(totalMins / 60);
                      const mins = totalMins % 60;
                      return (
                        <>
                          {logs.length > 0 && (
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-semibold text-ink-primary/50 uppercase tracking-wide">Practice Log</p>
                                {totalMins > 0 && (
                                  <span className="text-xs font-medium text-brand-primary bg-brand-primary/15 px-2 py-0.5 rounded-full">
                                    {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`} total
                                  </span>
                                )}
                              </div>
                              {logs.slice().reverse().slice(0, showAllLogs === goal.id ? undefined : 3).map((entry: any) => {
                                // Same coercion the streak math uses
                                // (utils/devPlanActions: coerceLogDate).
                                // Inlined here so we don't have to
                                // export the helper just for one
                                // render path.
                                const rawDate: any = entry.date;
                                const parsed: Date | null = (() => {
                                  if (!rawDate) return null;
                                  if (typeof rawDate.toDate === 'function') { try { return rawDate.toDate(); } catch { return null; } }
                                  if (rawDate instanceof Date) return Number.isNaN(rawDate.getTime()) ? null : rawDate;
                                  if (typeof rawDate === 'number' || typeof rawDate === 'string') {
                                    const d = new Date(rawDate);
                                    return Number.isNaN(d.getTime()) ? null : d;
                                  }
                                  if (typeof rawDate.seconds === 'number') {
                                    const ms = rawDate.seconds * 1000 + Math.floor((rawDate.nanoseconds || 0) / 1e6);
                                    const d = new Date(ms);
                                    return Number.isNaN(d.getTime()) ? null : d;
                                  }
                                  return null;
                                })();
                                const opt = verifiedOptimistic[entry.id];
                                const mergedEntry = opt ? { ...entry, verifiedBy: entry.verifiedBy || opt } : entry;
                                return (
                                  <div key={entry.id} className="text-xs text-ink-primary/65 bg-surface-elevated rounded px-2 py-1.5 border border-line-default/5">
                                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                                      <span className="text-ink-primary/40">
                                        {parsed ? parsed.toLocaleDateString() : 'Date unknown'}
                                      </span>
                                      {entry.minutes && <span className="text-brand-primary font-medium">({entry.minutes} min)</span>}
                                      <span>: {entry.note}</span>
                                      {entry.loggedByName && <span className="text-ink-primary/40">by {entry.loggedByName}</span>}
                                    </div>
                                    <div className="mt-1">
                                      <CoachSawThisPill
                                        entry={mergedEntry}
                                        canVerify={canVerifyLogs}
                                        onVerify={() => onVerifyLog(plan, goal.id, entry.id)}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                              {logs.length > 3 && showAllLogs !== goal.id && (
                                <button
                                  onClick={() => setShowAllLogs(goal.id)}
                                  className="text-xs text-brand-primary hover:text-brand-primary-soft"
                                >
                                  Show all {logs.length} entries
                                </button>
                              )}
                              {showAllLogs === goal.id && logs.length > 3 && (
                                <button
                                  onClick={() => setShowAllLogs(null)}
                                  className="text-xs text-ink-primary/50 hover:text-ink-primary/85"
                                >
                                  Show less
                                </button>
                              )}
                            </div>
                          )}

                          {/* One-tap "I DID IT" — the ONLY parent action
                              now. Big, bold, celebratory. Once tapped,
                              swaps to a streak callout that builds with
                              consecutive days. Per-goal logging feeds
                              the player-level streak that shows on
                              their profile too. */}
                          {canLogPractice && plan.status === 'active' && !goal.coachVerified && (() => {
                            // Streak reads the player-scoped source of
                            // truth (players/{pid}.currentStreakDays,
                            // backed by the dev_checkins subcollection),
                            // threaded in via the `streak` prop from
                            // playerStreaks up above. Prior shape walked
                            // THIS plan's practiceLog only, which meant
                            // a player with two active plans saw two
                            // different numbers on the same page and
                            // the number drifted from the Dashboard /
                            // squad chip. One log-tap on any plan
                            // counts as one day for the player, so the
                            // same number renders everywhere.
                            const loggedToday = didItToday(goal);
                            const streakToShow = typeof streak === 'number' ? streak : 0;
                            return (
                              <div className="mt-3">
                                {loggedToday ? (
                                  <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 px-5 py-4 text-white shadow-md">
                                    <div className="flex items-center gap-3">
                                      <span className="flex-shrink-0 w-10 h-10 rounded-full bg-line-default/20 ring-2 ring-line-default/30 flex items-center justify-center">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">Logged today</div>
                                        <div className="text-xl font-black leading-tight">
                                          {streakToShow > 1 ? `${streakToShow}-day streak, keep it going` : "Nice work!"}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => onQuickDidIt(goal.id)}
                                    className="w-full rounded-xl bg-brand-primary hover:bg-brand-primary-soft dark:bg-gradient-to-br dark:from-brand-primary dark:via-brand-primary dark:to-surface-elevated dark:hover:from-brand-primary-soft dark:hover:via-brand-primary dark:hover:to-surface-input text-white shadow-lg hover:shadow-xl active:scale-[0.98] transition-all px-5 py-4 group"
                                  >
                                    <div className="flex items-center justify-center gap-3">
                                      <span className="flex-shrink-0 w-10 h-10 rounded-full bg-white/25 ring-2 ring-white/30 flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                                      </span>
                                      <span className="text-lg font-black tracking-wide uppercase">I did it</span>
                                      {streakToShow > 0 && (
                                        <span className="text-xs font-bold bg-white/25 px-2 py-0.5 rounded-full">
                                          {streakToShow}-day streak, don't break it
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                )}
                              </div>
                            );
                          })()}

                          {/* The legacy multi-field "Log Practice" form
                              lived here. It was redundant with "Did it
                              today" (both wrote to the same practiceLog
                              array) and confusing — Patrick: "isn't the
                              did it today button supposed to take care
                              of that?" Removed. If a parent needs to
                              add a note or duration, they post in the
                              new plan-comments thread below. */}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Comments — parent ↔ coach conversation about this plan.
              "if it is for the parents to log any comments, i would
              rather have more of a comment section" (Patrick). Posts
              fire a push to the OTHER side (coach → parents, parent
              → plan creator). */}
          {onAddComment && (
            <PlanComments comments={plan.comments || []} onAdd={onAddComment} />
          )}

          {/* Actions */}
          <div className="mt-4 flex justify-between items-center">
            {isCoach && plan.status === 'completed' && (
              <button
                onClick={onCreateNextPlan}
                className="text-sm bg-brand-primary text-white px-4 py-2 rounded-lg hover:bg-brand-primary font-medium flex items-center space-x-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                <span>Create Next Plan for {plan.playerName}</span>
              </button>
            )}
            {isCoach && (
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={onEdit}
                  className="text-sm text-brand-primary hover:text-brand-primary-soft px-3 py-1 rounded-lg hover:bg-brand-primary/15 font-medium"
                >
                  Edit plan
                </button>
                <button
                  onClick={onArchive}
                  className="text-sm text-ink-primary/50 hover:text-ink-primary/85 px-3 py-1 rounded-lg hover:bg-line-default/[0.08]"
                >
                  Archive
                </button>
                <button
                  onClick={onDelete}
                  className="text-sm text-rose-400 hover:text-rose-300 px-3 py-1 rounded-lg hover:bg-rose-500/10"
                  title="Created in error? Delete removes the plan with no wall post."
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 text-xs text-ink-primary/40">
            Created by {plan.createdByName} • {plan.createdAt ? formatDate(plan.createdAt) : ''}
          </div>
        </div>
      )}
    </div>
  );
};

export default PlayerDevelopment;
