import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useTeam } from '../contexts/TeamContext';
import { DevelopmentPlan, DevelopmentGoal, PracticeLogEntry, Player, VideoLink, Drill, PlanComment } from '../types';
import DrillPickerModal from '../components/development/DrillPickerModal';
import { streamIframeUrl } from '../utils/streamUpload';
import { isCoach, formatDate } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';

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
  const { getDevelopmentPlansByTeam, getDevelopmentPlansByPlayer, addDevelopmentPlan, updateDevelopmentPlan, getDocuments, deleteDocument } = useFirestore();

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

  const isUserCoach = userData ? isCoach(userData.role) : false;

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

  // Resolve a goal's current video. Priority:
  // 1) Source drill (by drillId, or by normalized-title match for
  //    legacy goals that didn't store drillId).
  // 2) Goal's own snapshot — fallback for orphan goals (drill deleted,
  //    or pre-drillId imports with no title match).
  //
  // Title match is normalized (trim + lowercase + collapsed whitespace)
  // because the strict-equality match was missing goals whose title
  // had been lightly edited by the coach (trailing space, capitalization
  // change, etc.). And critically: if a drill has streamUid but match
  // fails, the goal would fall back to a stale snapshot from a previous
  // failed upload — Cloudflare then renders 'An unknown error occurred'
  // in the iframe because that streamUid has been replaced.
  const resolveGoalVideo = (goal: DevelopmentGoal): { streamUid?: string; streamReady?: boolean } => {
    const drillId = (goal as any).drillId as string | undefined;
    let drill: Drill | undefined = drillId ? drillsById[drillId] : undefined;
    if (!drill) {
      const normalize = (s: string) =>
        (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const goalKey = normalize(goal.title);
      if (goalKey) {
        const titleMatches = Object.values(drillsById).filter(
          (d) => normalize(d.title) === goalKey,
        );
        if (titleMatches.length === 1) drill = titleMatches[0];
      }
    }
    if (drill?.streamUid) {
      return { streamUid: drill.streamUid, streamReady: drill.streamReady };
    }
    return {
      streamUid: (goal as any).streamUid,
      streamReady: (goal as any).streamReady,
    };
  };

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

  const loadData = async () => {
    if (!selectedTeamId) { setLoading(false); return; }
    try {
      setLoading(true);

      // Load players and plans in parallel
      const plansPromise = (selectedPlayerId && selectedPlayerId !== 'all')
        ? getDevelopmentPlansByPlayer(selectedPlayerId)
        : getDevelopmentPlansByTeam(selectedTeamId);

      const [playersData, plansData] = await Promise.all([
        getDocuments('players', []),
        plansPromise
      ]);

      const teamPlayers = playersData
        .filter((p: any) => (p.teamId === selectedTeamId || p.teamIds?.includes(selectedTeamId)) && p.isActive)
        .map((p: any) => ({
          ...p,
          createdAt: p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt)
        })) as Player[];
      setPlayers(teamPlayers);

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

  const handleCreatePlan = async () => {
    if (!userData || !planTitle.trim()) return;

    // Bulk mode: create one plan per selected player. Single mode: use planPlayerId.
    const targetIds: string[] = bulkPlayerIds.length > 0 ? bulkPlayerIds : (planPlayerId ? [planPlayerId] : []);
    if (targetIds.length === 0) { alert('Please select at least one player.'); return; }

    const baseGoalsTpl = planGoals.filter(g => g.title.trim());
    if (baseGoalsTpl.length === 0) { alert('Please add at least one goal to the plan.'); return; }

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
            title: `${player.name}: new development plan 🎯`,
            body: `${planTitle.trim()} · ${goals.length} goal${goals.length === 1 ? '' : 's'}`,
            path: `/development`,
          }, 'devPlan');
        } catch (e) { console.warn('dev plan notify failed', e); }
      } catch (error) {
        console.error('Error creating development plan for', pid, error);
        failedCount++;
      }
    }

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
          // Coach commented → push the parents of this plan's player.
          sendPushToPlayerParents(plan.playerId, {
            title: `Coach ${userData.name?.split(' ')[0] || ''} on ${plan.playerName}'s plan`,
            body: comment.text.length > 140 ? `${comment.text.slice(0, 137)}…` : comment.text,
            path: `/development?expand=${plan.id}`,
          });
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
      loadData();
    } catch (error) {
      console.error('Error logging quick did-it:', error);
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
    if (!window.confirm('Archive this development plan?')) return;
    try {
      // Snapshot the plan + player BEFORE archiving so we can fire the
      // wall post (and so we have the name/teamId we need without
      // racing the loadData refetch). The "plan complete" auto-post
      // used to be gated on every goal being coach-verified, which
      // no longer happens since the verification flow was removed.
      // Archive is the natural completion signal — coach is saying
      // "the kid is done with this plan, moving on."
      const planSnap = plans.find(p => p.id === planId);
      const playerSnap = planSnap ? players.find(pl => pl.id === planSnap.playerId) : null;

      await updateDevelopmentPlan(planId, { status: 'archived', completedAt: new Date() });

      if (planSnap && playerSnap?.teamId && userData) {
        try {
          const { autoPostDevPlanCompleteToWall } = await import('../utils/autoPostToWall');
          void autoPostDevPlanCompleteToWall(
            { name: playerSnap.name, teamId: playerSnap.teamId },
            { title: planSnap.title },
            { uid: userData.uid, name: userData.name || 'Coach', role: 'coach' },
          );
        } catch (e) { console.warn('dev plan archive wall post failed', e); }
      }

      loadData();
    } catch (error) {
      console.error('Error archiving plan:', error);
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
      case 'technical': return 'bg-cyan-50 text-cyan-700 border-cyan-100';
      case 'tactical': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'physical': return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'mental': return 'bg-green-100 text-emerald-700 border-green-200';
      default: return 'bg-gray-100 text-gray-700 border-gray-200';
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

  // — Streak: per player, count of most-recent consecutive coach-verified goals across all their plans.
  // A goal is considered "attempted" once it has a playerCompletedAt OR coachVerifiedAt timestamp.
  // Walk attempts most-recent-first; count while coachVerified === true; stop at first miss.
  const playerStreaks = React.useMemo(() => {
    const map: Record<string, number> = {};
    const byPlayer: Record<string, { verified: boolean; t: number }[]> = {};
    for (const pl of plans) {
      for (const g of pl.goals) {
        const verifiedAt: any = (g as any).coachVerifiedAt;
        const playerAt: any = (g as any).playerCompletedAt;
        const tRaw = verifiedAt || playerAt;
        if (!tRaw) continue;
        const t = tRaw?.toDate ? tRaw.toDate().getTime() : new Date(tRaw).getTime();
        if (Number.isNaN(t)) continue;
        (byPlayer[pl.playerId] = byPlayer[pl.playerId] || []).push({ verified: !!g.coachVerified, t });
      }
    }
    for (const pid in byPlayer) {
      const arr = byPlayer[pid].sort((a, b) => b.t - a.t);
      let n = 0;
      for (const item of arr) { if (item.verified) n++; else break; }
      map[pid] = n;
    }
    return map;
  }, [plans]);

  const topStreak = React.useMemo(() => {
    let best: { playerId: string; name: string; streak: number } | null = null;
    for (const pid in playerStreaks) {
      const s = playerStreaks[pid];
      if (s <= 0) continue;
      if (!best || s > best.streak) {
        const player = players.find(p => p.id === pid);
        best = { playerId: pid, name: player?.name || 'Player', streak: s };
      }
    }
    return best;
  }, [playerStreaks, players]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-200 border-t-cyan-500" />
          <span className="text-sm text-gray-400 font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <Header title="Player Development" subtitle="Personalized plans that help each player grow." />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Coach View / Parent View toggle — only renders for users who
            wear both hats (Patrick coaches Hunter's U10 team). Other
            users land on their natural view and don't see the chip. */}
        {isUserCoach && hasLinkedPlayers && (
          <div className="mb-3 inline-flex rounded-xl bg-white ring-1 ring-slate-200 shadow-sm p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('coach')}
              className={`px-4 py-1.5 rounded-lg text-xs font-extrabold tracking-widest uppercase transition ${
                viewMode === 'coach' ? 'bg-cyan-600 text-white shadow' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              Coach View
            </button>
            <button
              type="button"
              onClick={() => { setViewMode('parent'); setSelectedPlayerId('all'); }}
              className={`px-4 py-1.5 rounded-lg text-xs font-extrabold tracking-widest uppercase transition ${
                viewMode === 'parent' ? 'bg-cyan-600 text-white shadow' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              My {myLinkedPlayers.length > 1 ? 'kids' : 'kid'}
            </button>
          </div>
        )}

        {/* Filter + New Plan */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
              <AppIcon name="players" className="w-4 h-4" />
            </span>
            <select
              value={selectedPlayerId}
              onChange={e => setSelectedPlayerId(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
              className="bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm"
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

        {/* "Needs Review" coach banner removed — verification flow gone. */}

        {/* Active Plans */}
        {activePlans.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Active Plans</h2>
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
                  onEdit={() => handleEditPlan(plan)}
                  onCreateNextPlan={() => handleCreateNextPlan(plan)}
                  getCategoryColor={getCategoryColor}
                  getCategoryIcon={getCategoryIcon}
                  getProgressPercentage={getProgressPercentage}
                  canPlayerComplete={effectiveView === 'parent' || !isUserCoach}
                  canLogPractice={true}
                  streak={playerStreaks[plan.playerId] || 0}
                  playerPhoto={(players.find(pp => pp.id === plan.playerId) as any)?.profilePhotoUrl || null}
                  resolveGoalVideo={resolveGoalVideo}
                />
              ))}
            </div>
          </div>
        )}

        {/* Completed Plans */}
        {completedPlans.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
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
                  onEdit={() => handleEditPlan(plan)}
                  onCreateNextPlan={() => handleCreateNextPlan(plan)}
                  getCategoryColor={getCategoryColor}
                  getCategoryIcon={getCategoryIcon}
                  getProgressPercentage={getProgressPercentage}
                  canPlayerComplete={false}
                  canLogPractice={false}
                  streak={playerStreaks[plan.playerId] || 0}
                  playerPhoto={(players.find(pp => pp.id === plan.playerId) as any)?.profilePhotoUrl || null}
                  resolveGoalVideo={resolveGoalVideo}
                />
              ))}
            </div>
          </div>
        )}

        {visiblePlans.length === 0 && (
          <div className="text-center py-12 bg-white rounded-2xl border border-gray-200">
            <div className="mb-3 flex justify-center text-gray-300">
              <AppIcon name="clipboard" className="w-12 h-12" />
            </div>
            <h3 className="text-lg font-medium text-gray-900">No development plans yet</h3>
            <p className="text-gray-600 mt-2">
              {isUserCoach
                ? "Create individual development plans to track each player's growth."
                : "Your coach hasn't created any development plans yet."}
            </p>
          </div>
        )}

        {/* Create Plan Modal */}
        {showCreateModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-6">
            <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col">
              {/* Sticky header */}
              <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
                <div>
                  <h2 className="text-base font-bold text-slate-900">{editingPlanId ? 'Edit plan' : 'New development plan'}</h2>
                  {!editingPlanId && bulkPlayerIds.length > 0 && (
                    <p className="text-[11px] text-slate-500 mt-0.5">{bulkPlayerIds.length} player{bulkPlayerIds.length === 1 ? '' : 's'} · {planGoals.filter(g => g.title.trim()).length || 0} goal{planGoals.filter(g => g.title.trim()).length === 1 ? '' : 's'}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { resetCreateForm(); setEditingPlanId(null); setShowCreateModal(false); }}
                  className="text-slate-400 hover:text-slate-700"
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
                      <label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600">
                        {editingPlanId ? 'Player' : `Players${bulkPlayerIds.length > 0 ? ` · ${bulkPlayerIds.length}` : ''}`}
                      </label>
                      {!editingPlanId && (
                        <div className="flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => { setBulkPlayerIds(players.map(p => p.id)); setPlanPlayerId(''); }}
                            className="text-cyan-700 hover:text-cyan-900 font-bold"
                          >All</button>
                          <span className="text-slate-300">·</span>
                          <button
                            type="button"
                            onClick={() => { setBulkPlayerIds([]); setPlanPlayerId(''); }}
                            className="text-slate-500 hover:text-slate-800 font-bold"
                          >Clear</button>
                        </div>
                      )}
                    </div>
                    {editingPlanId ? (
                      <select
                        value={planPlayerId}
                        onChange={e => setPlanPlayerId(e.target.value)}
                        disabled
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50 disabled:text-slate-500"
                      >
                        {players.map(p => (
                          <option key={p.id} value={p.id}>{p.name}{p.jerseyNumber != null ? ` (#${p.jerseyNumber})` : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto p-2 border border-slate-200 rounded-lg bg-slate-50">
                          {players.length === 0 && (
                            <div className="w-full text-center text-xs text-slate-500 py-3">No players on this team yet.</div>
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
                                  ? 'bg-cyan-600 text-white shadow-sm'
                                  : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:ring-cyan-400'}`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        {bulkPlayerIds.length > 1 && (
                          <p className="mt-1.5 text-[11px] text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 rounded-md px-2 py-1">
                            Creates <b>{bulkPlayerIds.length}</b> identical plans — each tracks progress on its own.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1.5">Plan title</label>
                    <input
                      type="text"
                      value={planTitle}
                      onChange={e => setPlanTitle(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                      placeholder="e.g. Ball Control Mastery"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1.5">Category</label>
                      <select
                        value={planCategory}
                        onChange={e => setPlanCategory(e.target.value as DevelopmentPlan['category'])}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                      >
                        <option value="technical">Technical — ball, passing, shooting</option>
                        <option value="tactical">Tactical — positioning, awareness</option>
                        <option value="physical">Physical — speed, strength</option>
                        <option value="mental">Mental — focus, confidence</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1.5">Description <span className="text-slate-400 normal-case tracking-normal">(optional)</span></label>
                      <input
                        type="text"
                        value={planDescription}
                        onChange={e => setPlanDescription(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                        placeholder="What this plan focuses on…"
                      />
                    </div>
                  </div>

                  {/* Goals */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600">Goals</label>
                      <button
                        type="button"
                        onClick={() => setDrillPickerOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-100 hover:bg-violet-200 text-violet-800 text-[11px] font-extrabold tracking-widest uppercase ring-1 ring-violet-200"
                        title="Pick drills from your library"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>
                        Import from library
                      </button>
                    </div>
                    <div className="space-y-3">
                      {planGoals.map((goal, index) => (
                        <div key={goal.id} className="flex items-start space-x-2 bg-gray-50 p-3 rounded-lg">
                          <span className="text-sm font-medium text-gray-400 mt-2">{index + 1}.</span>
                          <div className="flex-1 space-y-2">
                            <input
                              type="text"
                              value={goal.title}
                              onChange={e => updateGoalField(index, 'title', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 text-sm font-medium"
                              placeholder="Title (e.g. Pass Weight Drill – Distance Control)"
                            />
                            <input
                              type="text"
                              value={(goal as any).duration || ''}
                              onChange={e => updateGoalField(index, 'duration', e.target.value)}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-600"
                              placeholder="Duration (e.g. 10–15 min)"
                            />
                            <textarea
                              value={(goal as any).setup || ''}
                              onChange={e => updateGoalField(index, 'setup', e.target.value)}
                              rows={2}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-700"
                              placeholder="Setup — e.g. Place 3 cones in a line at 10, 20, and 25 yards"
                            />
                            <textarea
                              value={(goal as any).instructions || ''}
                              onChange={e => updateGoalField(index, 'instructions', e.target.value)}
                              rows={3}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-700"
                              placeholder="Instructions — step-by-step what to do"
                            />
                            <textarea
                              value={(goal as any).focus || ''}
                              onChange={e => updateGoalField(index, 'focus', e.target.value)}
                              rows={2}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-700"
                              placeholder="Focus — the key coaching point"
                            />
                            <input
                              type="number"
                              min={0}
                              value={(goal as any).targetMinutes ?? ''}
                              onChange={e => updateGoalField(index, 'targetMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                              className="w-full px-2 py-1 border border-gray-200 rounded text-xs text-gray-700"
                              placeholder="Practice minutes target (optional, e.g. 60)"
                            />
                            {/* YouTube link picker */}
                            <div className="space-y-1">
                              {(goal.videoLinks || []).map((link, li) => (
                                <div key={link.id} className="flex items-center gap-2 px-2 py-1 bg-white border border-gray-200 rounded text-xs">
                                  <span className="text-red-600">📺</span>
                                  <span className="flex-1 truncate text-gray-700">{link.title || link.url}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const updated = [...planGoals];
                                      const links = [...(updated[index].videoLinks || [])];
                                      links.splice(li, 1);
                                      (updated[index] as any).videoLinks = links;
                                      setPlanGoals(updated);
                                    }}
                                    className="text-gray-400 hover:text-red-500"
                                    aria-label="Remove"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                              <div className="flex gap-1">
                                <input
                                  type="url"
                                  placeholder="YouTube URL (optional)"
                                  className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs"
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
                                  className="w-24 px-2 py-1 border border-gray-200 rounded text-xs"
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
                                  className="px-2 py-1 bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-medium rounded"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          </div>
                          {planGoals.length > 1 && (
                            <button
                              onClick={() => removeGoalField(index)}
                              className="p-1 text-red-400 hover:text-red-600 mt-2"
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
                      className="mt-2 text-sm text-cyan-700 hover:text-cyan-900 font-bold"
                    >
                      + Add another goal
                    </button>
                  </div>
                </div>

              </div>
              {/* Sticky footer */}
              <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => { resetCreateForm(); setEditingPlanId(null); setShowCreateModal(false); }}
                  className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={editingPlanId ? handleUpdatePlan : handleCreatePlan}
                  disabled={(editingPlanId ? !planPlayerId : (bulkPlayerIds.length === 0 && !planPlayerId)) || !planTitle.trim() || planGoals.every(g => !g.title.trim())}
                  className="px-4 py-2 text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg"
                >
                  {editingPlanId ? 'Save changes' : (bulkPlayerIds.length > 1 ? `Create ${bulkPlayerIds.length} plans` : 'Create plan')}
                </button>
              </div>
            </div>
          </div>
        )}

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
  cyan:    { box: 'bg-cyan-50',     icon: 'text-cyan-700',    value: 'text-cyan-700'    },
  emerald: { box: 'bg-emerald-50',  icon: 'text-emerald-700', value: 'text-emerald-700' },
  navy:    { box: 'bg-navy-700/10', icon: 'text-navy-700',    value: 'text-navy-700'    },
  fire:    { box: 'bg-fire-50',     icon: 'text-fire-700',    value: 'text-fire-700'    },
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
    <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-4 flex items-center gap-3">
      <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${t.box} ${t.icon}`}>
        <AppIcon name={icon} className="w-5 h-5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-2xl font-bold ${t.value} leading-tight tabular-nums`}>{value}</p>
        <p className="text-xs text-gray-600 truncate">{label}</p>
      </div>
      {badge && (
        <span className="px-2 py-1 rounded-full bg-fire-100 text-fire-800 text-[11px] font-bold whitespace-nowrap">
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
  onEdit: () => void;
  onCreateNextPlan: () => void;
  getCategoryColor: (cat: string) => string;
  getCategoryIcon: (cat: string) => any;
  getProgressPercentage: (plan: DevelopmentPlan) => number;
  canPlayerComplete: boolean;
  canLogPractice: boolean;
  streak?: number;
  playerPhoto?: string | null;
  resolveGoalVideo: (goal: DevelopmentGoal) => { streamUid?: string; streamReady?: boolean };
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
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span className="text-[10px] font-extrabold tracking-widest uppercase text-slate-600">
          Comments {sorted.length > 0 && <span className="text-slate-400">· {sorted.length}</span>}
        </span>
      </div>
      {sorted.length > 0 && (
        <ul className="space-y-2 mb-3">
          {sorted.map(c => {
            const t = (c.createdAt as any)?.toDate?.() || new Date(c.createdAt);
            const isCoachAuthor = c.authorRole === 'coach' || c.authorRole === 'team_manager';
            return (
              <li key={c.id} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-xs font-bold text-slate-800">{c.authorName}</span>
                  {isCoachAuthor && (
                    <span className="text-[9px] font-extrabold tracking-widest uppercase text-cyan-700 bg-cyan-50 ring-1 ring-cyan-200 px-1 py-0.5 rounded">Coach</span>
                  )}
                  <span className="ml-auto text-[10px] text-slate-400">{t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{c.text}</p>
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
          className="flex-1 min-w-0 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!draft.trim()}
          className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold"
        >
          Post
        </button>
      </div>
    </div>
  );
};

const PlanCard: React.FC<PlanCardProps> = ({
  plan, isCoach, isExpanded, onToggleExpand, onPlayerComplete, onCoachVerify,
  onCoachNote, onReadyForReview, onAddPracticeLog, onQuickDidIt, onAddComment, onAddVideoLink, onRemoveVideoLink, onArchive, onEdit, onCreateNextPlan, playerPhoto,
  getCategoryColor, getCategoryIcon, getProgressPercentage, canPlayerComplete, canLogPractice, streak, resolveGoalVideo
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

  const handleSubmitLog = () => {
    if (!logGoalId || !logNote.trim()) return;
    onAddPracticeLog(logGoalId, logNote, logMinutes ? parseInt(logMinutes) : undefined);
    setLogGoalId(null);
    setLogNote('');
    setLogMinutes('');
  };

  const playerInitial = (plan.playerName || '?').charAt(0).toUpperCase();

  return (
    <div className={`bg-white rounded-2xl shadow-sm border overflow-hidden ${isExpanded ? 'border-cyan-300 ring-2 ring-cyan-100' : 'border-gray-200'}`}>
      {/* Header — player avatar + name + title, with two horizontal
          progress bars beneath. Matches the Ollie reference card. */}
      <div
        className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={onToggleExpand}
      >
        <div className="flex items-start gap-3">
          {/* Player avatar with category icon overlay */}
          <div className="relative shrink-0">
            {playerPhoto ? (
              <img
                src={playerPhoto}
                alt={plan.playerName}
                className="w-12 h-12 rounded-full object-cover ring-2 ring-cyan-100"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-cyan-500 to-navy-700 text-white flex items-center justify-center font-bold text-base ring-2 ring-cyan-100">
                {playerInitial}
              </div>
            )}
            <span className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white shadow ring-1 ring-gray-200 flex items-center justify-center ${getCategoryColor(plan.category).split(' ')[1]}`} title={plan.category}>
              <AppIcon name={getCategoryIcon(plan.category)} className="w-3 h-3" />
            </span>
          </div>

          {/* Title + name + pills */}
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-gray-900 leading-tight">{plan.title}</h3>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-sm text-gray-600">{plan.playerName}</span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${getCategoryColor(plan.category)}`}>
                {plan.category}
              </span>
              {plan.status === 'completed' && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                  <AppIcon name="check" className="w-3 h-3" />
                  <span>Completed</span>
                </span>
              )}
              {/* "Ready for review" badge removed — no verification flow. */}
              {typeof streak === 'number' && streak >= 2 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-fire-100 text-fire-800 border border-fire-200" title={`${streak}-day practice streak`}>
                  <AppIcon name="highlight" className="w-3 h-3" />
                  <span>{streak} streak</span>
                </span>
              )}
            </div>
          </div>

          <button
            className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100 shrink-0"
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
        <div className="mt-4 pt-4 border-t border-gray-100">
          {(() => {
            const totalSessions = plan.goals.reduce((s, g) => s + (g.practiceLog?.length || 0), 0);
            return (
              <div className="text-[11px] flex items-center justify-between">
                <span className="text-gray-500 font-semibold">Sessions logged</span>
                <span className="text-cyan-700 font-bold tabular-nums">{totalSessions}</span>
              </div>
            );
          })()}
          <div className="mt-2 text-[11px] text-gray-500 flex items-center gap-3 justify-center">
            {totalLoggedMinutes > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-fire-500" />
                {totalTargetMinutes > 0 ? `${totalLoggedMinutes}/${totalTargetMinutes} min` : `${totalLoggedMinutes} min`}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Goals */}
      {isExpanded && (
        <div className="border-t border-gray-200 p-4">
          {plan.description && (
            <div className="mb-4 flex items-start gap-3">
              <span className="w-8 h-8 rounded-full bg-cyan-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                <AppIcon name="highlight" className="w-4 h-4" />
              </span>
              <p className="text-sm text-slate-700 flex-1">{plan.description}</p>
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
                <span className="inline-flex items-center gap-1.5 bg-cyan-50 text-cyan-700 px-2.5 py-1 rounded-full">
                  <AppIcon name="clock" className="w-3.5 h-3.5" />
                  <span className="font-semibold">
                    {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`} practiced
                  </span>
                </span>
                <span className="text-gray-500">{totalEntries} session{totalEntries !== 1 ? 's' : ''} logged</span>
              </div>
            );
          })()}

          <div className="space-y-3">
            {plan.goals.sort((a, b) => a.order - b.order).map((goal) => (
              <div key={goal.id} className="p-3 rounded-lg border bg-white border-slate-200">
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
                      <span className="font-medium text-sm text-gray-900">
                        {goal.title}
                        {(() => {
                          const goalMins = (goal.practiceLog || []).reduce((s, l) => s + (l.minutes || 0), 0);
                          if (goal.targetMinutes && goal.targetMinutes > 0) {
                            const pct = Math.min(100, Math.round((goalMins / goal.targetMinutes) * 100));
                            const done = pct >= 100;
                            return (
                              <span className={`ml-2 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-fire-100 text-fire-700'}`}>
                                {goalMins}/{goal.targetMinutes} min
                              </span>
                            );
                          }
                          if (goalMins > 0) {
                            return <span className="ml-2 text-[10px] font-semibold text-fire-700">{goalMins} min</span>;
                          }
                          return null;
                        })()}
                      </span>
                      {/* Ready / Verify buttons removed — no
                          coach-verification flow. */}
                    </div>
                    {goal.description && (
                      <p className="text-xs text-gray-500 mt-1">{goal.description}</p>
                    )}
                    {(goal.duration || goal.setup || goal.instructions || goal.focus) && (
                      <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
                        {goal.duration && (
                          <div className="inline-flex items-center gap-1.5 text-xs bg-white text-gray-700 px-2 py-0.5 rounded-full ring-1 ring-gray-200">
                            <AppIcon name="clock" className="w-3.5 h-3.5 text-gray-400" />
                            <span className="font-semibold">{goal.duration}</span>
                          </div>
                        )}
                        {goal.setup && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wide text-cyan-600">Setup</div>
                            <p className="text-xs text-gray-700 whitespace-pre-line mt-0.5">{goal.setup}</p>
                          </div>
                        )}
                        {goal.instructions && (
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wide text-cyan-600">Instructions</div>
                            <p className="text-xs text-gray-700 whitespace-pre-line mt-0.5">{goal.instructions}</p>
                          </div>
                        )}
                        {goal.focus && (
                          <div className="bg-fire-50 ring-1 ring-fire-200 rounded-lg p-2">
                            <div className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-fire-700">
                              <AppIcon name="trophy" className="w-3 h-3" />
                              <span>Focus</span>
                            </div>
                            <p className="text-xs text-gray-700 whitespace-pre-line mt-0.5">{goal.focus}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {goal.notes && (
                      <p className="text-xs text-cyan-600 mt-1 italic">Coach note: {goal.notes}</p>
                    )}
                    <div className="flex items-center space-x-3 mt-1 text-xs text-gray-400">
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
                      const { streamUid } = resolveGoalVideo(goal);
                      if (!streamUid) return null;
                      return (
                        <div className="mt-3">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 inline-flex items-center gap-1.5">
                            <AppIcon name="film" className="w-3.5 h-3.5 text-gray-400" />
                            <span>Demo video</span>
                          </p>
                          <div className="aspect-video w-full rounded-lg overflow-hidden bg-black ring-1 ring-slate-200">
                            <iframe
                              src={streamIframeUrl(streamUid)}
                              title={`${goal.title} — demo`}
                              loading="lazy"
                              allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
                              allowFullScreen
                              className="w-full h-full block border-0"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Video links / tutorials */}
                    {((goal.videoLinks && goal.videoLinks.length > 0) || (isCoach && plan.status === 'active')) && (
                      <div className="mt-3">
                        {goal.videoLinks && goal.videoLinks.length > 0 && (
                          <>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 inline-flex items-center gap-1.5">
                              <AppIcon name="film" className="w-3.5 h-3.5 text-gray-400" />
                              <span>Watch & Learn</span>
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {goal.videoLinks.map(link => (
                                <div key={link.id} className="relative group">
                                  <a
                                    href={link.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block w-40 rounded-lg overflow-hidden border border-gray-200 bg-black hover:ring-2 hover:ring-red-400 transition-all"
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
                                      <div className="aspect-video bg-gradient-to-br from-cyan-500 to-navy-700 flex items-center justify-center text-white text-xs px-2 text-center">
                                        Open link
                                      </div>
                                    )}
                                    <div className="px-2 py-1.5 bg-white">
                                      <p className="text-xs font-medium text-gray-800 line-clamp-2 leading-snug">
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
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-opacity"
                                      aria-label="Remove link"
                                    >
                                      ✕
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
                              <div className="space-y-2 bg-cyan-50/60 border border-cyan-100 rounded-lg p-2">
                                <input
                                  type="url"
                                  value={linkUrl}
                                  onChange={e => setLinkUrl(e.target.value)}
                                  placeholder="Paste YouTube link (https://youtu.be/...)"
                                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500"
                                  autoFocus
                                />
                                <input
                                  type="text"
                                  value={linkTitle}
                                  onChange={e => setLinkTitle(e.target.value)}
                                  placeholder="Optional title (e.g. 'Inside-of-foot pass technique')"
                                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:ring-2 focus:ring-cyan-500"
                                />
                                <div className="flex justify-end space-x-2">
                                  <button
                                    onClick={() => { setLinkGoalId(null); setLinkUrl(''); setLinkTitle(''); }}
                                    className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
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
                                    className="text-xs bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white font-medium px-3 py-1 rounded"
                                  >
                                    Add Link
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setLinkGoalId(goal.id); setLinkUrl(''); setLinkTitle(''); }}
                                className="text-xs text-cyan-600 hover:text-cyan-700 font-medium"
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
                                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Practice Log</p>
                                {totalMins > 0 && (
                                  <span className="text-xs font-medium text-cyan-600 bg-cyan-50 px-2 py-0.5 rounded-full">
                                    ⏱️ {hours > 0 ? `${hours}h ${mins}m` : `${mins}m`} total
                                  </span>
                                )}
                              </div>
                              {logs.slice().reverse().slice(0, showAllLogs === goal.id ? undefined : 3).map((entry: any) => (
                                <div key={entry.id} className="text-xs text-gray-600 bg-white rounded px-2 py-1 border border-gray-100">
                                  <span className="text-gray-400">
                                    {entry.date?.toDate ? entry.date.toDate().toLocaleDateString() : new Date(entry.date).toLocaleDateString()}
                                  </span>
                                  {entry.minutes && <span className="text-cyan-600 font-medium ml-1">({entry.minutes} min)</span>}
                                  {' — '}{entry.note}
                                  {entry.loggedByName && <span className="text-gray-400 ml-1">— {entry.loggedByName}</span>}
                                </div>
                              ))}
                              {logs.length > 3 && showAllLogs !== goal.id && (
                                <button
                                  onClick={() => setShowAllLogs(goal.id)}
                                  className="text-xs text-cyan-600 hover:text-cyan-700"
                                >
                                  Show all {logs.length} entries
                                </button>
                              )}
                              {showAllLogs === goal.id && logs.length > 3 && (
                                <button
                                  onClick={() => setShowAllLogs(null)}
                                  className="text-xs text-gray-500 hover:text-gray-700"
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
                            const todayStart = (() => {
                              const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
                            })();
                            const logs = (goal.practiceLog || []) as any[];
                            const loggedToday = logs.some((l) => {
                              const t = l.date?.toDate ? l.date.toDate().getTime() : new Date(l.date).getTime();
                              return t >= todayStart;
                            });
                            // Walk the day-bucketed log set from today
                            // backwards counting consecutive days.
                            const days = new Set<string>();
                            for (const l of logs) {
                              const d = l.date?.toDate ? l.date.toDate() : new Date(l.date);
                              const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                              days.add(key);
                            }
                            let streak = 0;
                            const cursor = new Date();
                            cursor.setHours(0, 0, 0, 0);
                            // If they haven't done today, the streak
                            // window starts at yesterday — don't break
                            // it just because they haven't tapped yet.
                            if (!loggedToday) cursor.setDate(cursor.getDate() - 1);
                            for (;;) {
                              const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
                              if (days.has(key)) {
                                streak++;
                                cursor.setDate(cursor.getDate() - 1);
                              } else break;
                            }
                            return (
                              <div className="mt-3">
                                {loggedToday ? (
                                  <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 px-5 py-4 text-white shadow-md">
                                    <div className="flex items-center gap-3">
                                      <span className="flex-shrink-0 w-10 h-10 rounded-full bg-white/20 ring-2 ring-white/30 flex items-center justify-center">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">Logged today</div>
                                        <div className="text-xl font-black leading-tight">
                                          {streak > 1 ? `${streak}-day streak — keep it going` : "Nice work!"}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => onQuickDidIt(goal.id)}
                                    className="w-full rounded-xl bg-gradient-to-br from-cyan-500 via-cyan-600 to-violet-600 hover:from-cyan-400 hover:via-cyan-500 hover:to-violet-500 text-white shadow-lg hover:shadow-xl active:scale-[0.98] transition-all px-5 py-4 group"
                                  >
                                    <div className="flex items-center justify-center gap-3">
                                      <span className="flex-shrink-0 w-10 h-10 rounded-full bg-white/20 ring-2 ring-white/30 flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                                      </span>
                                      <span className="text-lg font-black tracking-wide uppercase">I did it</span>
                                      {streak > 0 && (
                                        <span className="text-xs font-bold bg-white/20 px-2 py-0.5 rounded-full">
                                          {streak}-day streak — don't break it
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
                className="text-sm bg-cyan-600 text-white px-4 py-2 rounded-lg hover:bg-cyan-700 font-medium flex items-center space-x-1"
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
                  className="text-sm text-cyan-600 hover:text-cyan-700 px-3 py-1 rounded-lg hover:bg-cyan-50 font-medium"
                >
                  ✏️ Edit Plan
                </button>
                <button
                  onClick={onArchive}
                  className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1 rounded-lg hover:bg-gray-100"
                >
                  Archive
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 text-xs text-gray-400">
            Created by {plan.createdByName} • {plan.createdAt ? formatDate(plan.createdAt) : ''}
          </div>
        </div>
      )}
    </div>
  );
};

export default PlayerDevelopment;
