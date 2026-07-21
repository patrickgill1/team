// NotificationsHeaderBar — compact "what's new" bar next to the
// profile avatar in the top chrome. Replaces the standalone
// ChatHeaderButton + WallHeaderButton with one unified affordance
// that surfaces new activity across three surfaces:
//
//   💬 Chats — unread messages (server-side chat_threads.unreadCount)
//   📅 Events — events created or modified since last calendar visit
//   📢 Wall — wall posts posted since last wall visit
//
// The bar renders NOTHING when all three counters are zero. Patrick
// asked specifically for it to not "show randomly like the old wall
// did" — silent by default, loud when there's actually something.
//
// Last-visit stamps live in localStorage per team:
//   calendar.lastSeen.<teamId>
//   wall.lastSeen.<teamId>       (existing key from WallHeaderButton)
// Bumped by Calendar / Wall page useEffects on mount so this bar's
// count naturally drops when the user visits the surface.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where, limit as fsLimit } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import { useAuth } from '../../hooks/useAuth';

const chatKey = (teamId: string | null) => `chat.lastSeen.${teamId || 'none'}`;
const wallKey = (teamId: string | null) => `wall.lastSeen.${teamId || 'none'}`;
const eventsKey = (teamId: string | null) => `calendar.lastSeen.${teamId || 'none'}`;

/** Called from the Calendar page mount so the events indicator
 *  drops once the user has looked at their upcoming events. */
export function markCalendarSeen(teamId: string | null) {
  try { localStorage.setItem(eventsKey(teamId), String(Date.now())); } catch { /* ignore */ }
}

/** Called from the Wall page mount for the same reason. Kept next
 *  to markCalendarSeen so both are discoverable from one import. */
export function markWallSeen(teamId: string | null) {
  try { localStorage.setItem(wallKey(teamId), String(Date.now())); } catch { /* ignore */ }
}

/** Called from the Chat page mount. Chat has server-side unreadCount
 *  per thread, but that only clears when the user actually opens each
 *  thread. Stamp a last-seen locally too so the header pill drops the
 *  moment the user lands on /chat — matches user expectation
 *  ("I looked, why is the number still there?"). */
export function markChatSeen(teamId: string | null) {
  try { localStorage.setItem(chatKey(teamId), String(Date.now())); } catch { /* ignore */ }
}

const NotificationsHeaderBar: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const { userData } = useAuth();
  const [unreadChats, setUnreadChats] = useState(0);
  const [newEvents, setNewEvents] = useState(0);
  const [newWall, setNewWall] = useState(0);

  // Chats — sum of per-user unreadCount across TWO subscription
  // scopes because chat_threads has two shapes:
  //   1. team-scoped threads where teamId == selectedTeamId
  //   2. DMs where isDM==true and participants includes me — DMs
  //      carry teamId:'' so a plain teamId equality query misses
  //      them entirely. First shipped miss was Patrick receiving a
  //      DM from Melanie: the "1 NEW" showed inside /chat but the
  //      header bar stayed blank because this subscription filtered
  //      by teamId only.
  //
  // Local dampener kept — if the user visited /chat AFTER every
  // thread's latest activity, zero the pill. New activity after their
  // visit re-lights it.
  useEffect(() => {
    if (!selectedTeamId || !userData?.uid) { setUnreadChats(0); return; }
    const uid = userData.uid;
    const teamQ = query(collection(db, 'chat_threads'), where('teamId', '==', selectedTeamId));
    const dmQ = query(
      collection(db, 'chat_threads'),
      where('isDM', '==', true),
      where('participants', 'array-contains', uid),
    );
    // Groups moved to `chat_group_threads` (2026-07-21 subcollection
    // migration). Collection identity is the discriminator — the
    // isGroup filter is gone. Rules gate read on participants
    // array-contains uid, matching this query by construction.
    const groupQ = query(
      collection(db, 'chat_group_threads'),
      where('participants', 'array-contains', uid),
    );
    // Per-subscription maps keyed by threadId, so the same doc
    // appearing in multiple streams (e.g. a legacy group that still
    // matches BOTH the team query and the new group query during the
    // migration window) only counts once. Without this dedupe the
    // pill double-counts every legacy group between deploy-client
    // and run-backfill.
    type Entry = { u: number; t: number };
    const teamMap = new Map<string, Entry>();
    const dmMap = new Map<string, Entry>();
    const groupMap = new Map<string, Entry>();
    const publish = () => {
      const merged = new Map<string, Entry>();
      teamMap.forEach((v, k) => merged.set(k, v));
      dmMap.forEach((v, k) => merged.set(k, v));
      groupMap.forEach((v, k) => merged.set(k, v));
      let sum = 0;
      let latestActivity = 0;
      merged.forEach((v) => {
        sum += v.u;
        if (v.t > latestActivity) latestActivity = v.t;
      });
      let out = sum;
      try {
        const seen = parseInt(localStorage.getItem(chatKey(selectedTeamId)) || '0', 10);
        if (seen > latestActivity) out = 0;
      } catch { /* ignore */ }
      setUnreadChats(out);
    };
    const fillFrom = (map: Map<string, Entry>, snap: any) => {
      map.clear();
      snap.docs.forEach((d: any) => {
        const data: any = d.data();
        const u = typeof data?.unreadCount?.[uid] === 'number' ? data.unreadCount[uid] : 0;
        const last = data?.lastActivity?.toDate?.()?.getTime?.() || 0;
        map.set(d.id, { u, t: last });
      });
    };
    // Group variant skips isActive:false tombstones so a soft-deleted
    // group's stale unread count doesn't keep the pill lit.
    const fillActiveFrom = (map: Map<string, Entry>, snap: any) => {
      map.clear();
      snap.docs.forEach((d: any) => {
        const data: any = d.data();
        if (data?.isActive === false) return;
        const u = typeof data?.unreadCount?.[uid] === 'number' ? data.unreadCount[uid] : 0;
        const last = data?.lastActivity?.toDate?.()?.getTime?.() || 0;
        map.set(d.id, { u, t: last });
      });
    };
    const unsubTeam = onSnapshot(teamQ, (snap) => { fillFrom(teamMap, snap); publish(); });
    const unsubDm = onSnapshot(dmQ, (snap) => { fillFrom(dmMap, snap); publish(); });
    const unsubGroup = onSnapshot(groupQ, (snap) => { fillActiveFrom(groupMap, snap); publish(); });
    return () => { unsubTeam(); unsubDm(); unsubGroup(); };
  }, [selectedTeamId, userData?.uid]);

  // Events — count of events whose updatedAt (fallback createdAt) is
  // newer than the last calendar-seen stamp. Bounded to the 30 most
  // recent events so a busy season doesn't scan the entire history
  // on every tab focus.
  useEffect(() => {
    if (!selectedTeamId) { setNewEvents(0); return; }
    const q = query(
      collection(db, 'events'),
      where('teamId', '==', selectedTeamId),
      fsLimit(30),
    );
    const unsub = onSnapshot(q, (snap) => {
      try {
        const seen = parseInt(localStorage.getItem(eventsKey(selectedTeamId)) || '0', 10);
        let count = 0;
        snap.docs.forEach(d => {
          const data: any = d.data();
          const stampSrc = data.updatedAt || data.createdAt;
          const t = stampSrc?.toDate?.()?.getTime?.() || 0;
          if (t > seen) count++;
        });
        setNewEvents(count);
      } catch { setNewEvents(0); }
    });
    return () => unsub();
  }, [selectedTeamId]);

  // Wall — same shape as events. Reuses the existing wall.lastSeen
  // key WallHeaderButton set before we consolidated, so users don't
  // see phantom "new" flags on posts they'd already seen pre-upgrade.
  useEffect(() => {
    if (!selectedTeamId) { setNewWall(0); return; }
    const q = query(
      collection(db, 'wall_posts'),
      where('teamId', '==', selectedTeamId),
      fsLimit(30),
    );
    const unsub = onSnapshot(q, (snap) => {
      try {
        const seen = parseInt(localStorage.getItem(wallKey(selectedTeamId)) || '0', 10);
        let count = 0;
        snap.docs.forEach(d => {
          const data: any = d.data();
          const t = data.timestamp?.toDate?.()?.getTime?.() || 0;
          if (t > seen) count++;
        });
        setNewWall(count);
      } catch { setNewWall(0); }
    });
    return () => unsub();
  }, [selectedTeamId]);

  const total = unreadChats + newEvents + newWall;
  // Silent when there's nothing new. Patrick's constraint: "don't
  // want it to show randomly like the old wall did." So we occupy
  // exactly zero header real estate on quiet days.
  if (total === 0) return null;

  return (
    <div className="inline-flex items-center gap-1 pl-1 pr-1 py-1 rounded-full bg-line-default/[0.06] ring-1 ring-line-default/10">
      {newEvents > 0 && (
        <Pill
          to="/calendar"
          count={newEvents}
          ariaLabel={`${newEvents} new event update${newEvents === 1 ? '' : 's'}`}
          tint="sky"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          }
        />
      )}
      {unreadChats > 0 && (
        <Pill
          to="/chat"
          count={unreadChats}
          ariaLabel={`${unreadChats} unread chat message${unreadChats === 1 ? '' : 's'}`}
          tint="brand"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          }
        />
      )}
      {newWall > 0 && (
        <Pill
          to="/wall"
          count={newWall}
          ariaLabel={`${newWall} new wall post${newWall === 1 ? '' : 's'}`}
          tint="amber"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M3 11v2a1 1 0 001 1h3l4 4V6L7 10H4a1 1 0 00-1 1z" />
              <path d="M15 8a5 5 0 010 8" />
            </svg>
          }
        />
      )}
    </div>
  );
};

// Compact interior pill — one per surface with new activity. Icon +
// count. Ring-colored per surface so the eye can pick out which
// bucket at a glance without reading the number.
const Pill: React.FC<{
  to: string;
  count: number;
  ariaLabel: string;
  tint: 'brand' | 'amber' | 'sky';
  icon: React.ReactNode;
}> = ({ to, count, ariaLabel, tint, icon }) => {
  const tintClass = tint === 'brand'
    ? 'text-brand-primary-soft bg-brand-primary/15 ring-brand-primary/25 hover:bg-brand-primary/25'
    : tint === 'amber'
      ? 'text-amber-300 bg-amber-500/15 ring-amber-400/25 hover:bg-amber-500/25'
      : 'text-sky-300 bg-sky-500/15 ring-sky-400/25 hover:bg-sky-500/25';
  const label = count > 99 ? '99+' : String(count);
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 pl-1.5 pr-2 py-1 rounded-full ring-1 text-[11px] font-black tabular-nums transition ${tintClass}`}
    >
      {icon}
      {label}
    </Link>
  );
};

export default NotificationsHeaderBar;
