// useDashboardActivity — subscribes to the same three signals
// NotificationsHeaderBar tracks (chat unread, wall posts new since
// last visit, events created/updated since last visit) and returns
// the counts as a typed object.
//
// The header bar owns the top-chrome pill treatment. This hook owns
// the dashboard-hero digest treatment for the busy-parent lens
// Patrick raised: she checks the app twice a week, needs to see
// "here's what's waiting for you" ON the dashboard rather than
// hunting for a red dot on a tab bar. Same last-seen localStorage
// keys as NotificationsHeaderBar so visiting a surface drops both
// pill and digest at the same time. No new tracking added.

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, limit as fsLimit } from 'firebase/firestore';
import { db } from '../utils/firebase';

const chatKey = (teamId: string | null) => `chat.lastSeen.${teamId || 'none'}`;
const wallKey = (teamId: string | null) => `wall.lastSeen.${teamId || 'none'}`;
const eventsKey = (teamId: string | null) => `calendar.lastSeen.${teamId || 'none'}`;

export interface DashboardActivity {
  chat: number;
  wall: number;
  events: number;
}

export function useDashboardActivity(
  teamId: string | null | undefined,
  uid: string | null | undefined,
): DashboardActivity {
  const [chat, setChat] = useState(0);
  const [wall, setWall] = useState(0);
  const [events, setEvents] = useState(0);

  // Chat unread — sums chat_threads.unreadCount[uid] across team
  // threads, DMs, AND groups. DMs carry teamId set to whichever team
  // they were created from (opened cross-team via participants),
  // groups carry teamId='' at rest (2026-07-21 privacy fix), so a
  // plain teamId equality query misses both. Three subscriptions run
  // in parallel and publish() combines. Local lastSeen dampener
  // zeroes the count when the user visited /chat AFTER the freshest
  // activity — matches "I looked, why is the number still there".
  useEffect(() => {
    if (!teamId || !uid) { setChat(0); return; }
    const teamQ = query(collection(db, 'chat_threads'), where('teamId', '==', teamId));
    const dmQ = query(
      collection(db, 'chat_threads'),
      where('isDM', '==', true),
      where('participants', 'array-contains', uid),
    );
    const groupQ = query(
      collection(db, 'chat_threads'),
      where('isGroup', '==', true),
      where('participants', 'array-contains', uid),
    );
    // Per-subscription maps keyed by threadId. Dedupes when a doc
    // appears in more than one stream (e.g. a legacy group thread
    // that still matches both the team and group queries between
    // client deploy and backfill run).
    type Entry = { u: number; t: number };
    const teamMap = new Map<string, Entry>();
    const dmMap = new Map<string, Entry>();
    const groupMap = new Map<string, Entry>();
    const publish = () => {
      const merged = new Map<string, Entry>();
      teamMap.forEach((v, k) => merged.set(k, v));
      dmMap.forEach((v, k) => merged.set(k, v));
      groupMap.forEach((v, k) => merged.set(k, v));
      let sum = 0, latest = 0;
      merged.forEach((v) => {
        sum += v.u;
        if (v.t > latest) latest = v.t;
      });
      let out = sum;
      try {
        const seen = parseInt(localStorage.getItem(chatKey(teamId)) || '0', 10);
        if (seen > latest) out = 0;
      } catch { /* ignore */ }
      setChat(out);
    };
    const fillFrom = (map: Map<string, Entry>, snap: any) => {
      map.clear();
      snap.docs.forEach((d: any) => {
        const data: any = d.data();
        const u = typeof data?.unreadCount?.[uid] === 'number' ? data.unreadCount[uid] : 0;
        const t = data?.lastActivity?.toDate?.()?.getTime?.() || 0;
        map.set(d.id, { u, t });
      });
    };
    const unsubTeam = onSnapshot(teamQ, (snap) => { fillFrom(teamMap, snap); publish(); });
    const unsubDm = onSnapshot(dmQ, (snap) => { fillFrom(dmMap, snap); publish(); });
    const unsubGroup = onSnapshot(groupQ, (snap) => { fillFrom(groupMap, snap); publish(); });
    return () => { unsubTeam(); unsubDm(); unsubGroup(); };
  }, [teamId, uid]);

  // Wall — count of wall_posts with timestamp newer than last visit.
  useEffect(() => {
    if (!teamId) { setWall(0); return; }
    const q = query(
      collection(db, 'wall_posts'),
      where('teamId', '==', teamId),
      fsLimit(30),
    );
    const unsub = onSnapshot(q, (snap) => {
      try {
        const seen = parseInt(localStorage.getItem(wallKey(teamId)) || '0', 10);
        let count = 0;
        snap.docs.forEach(d => {
          const data: any = d.data();
          const t = data.timestamp?.toDate?.()?.getTime?.() || 0;
          if (t > seen) count++;
        });
        setWall(count);
      } catch { setWall(0); }
    });
    return () => unsub();
  }, [teamId]);

  // Events — count of events with createdAt/updatedAt newer than
  // last calendar visit. Bounded to the 30 most recent so a busy
  // season doesn't scan the entire history on every focus.
  useEffect(() => {
    if (!teamId) { setEvents(0); return; }
    const q = query(
      collection(db, 'events'),
      where('teamId', '==', teamId),
      fsLimit(30),
    );
    const unsub = onSnapshot(q, (snap) => {
      try {
        const seen = parseInt(localStorage.getItem(eventsKey(teamId)) || '0', 10);
        let count = 0;
        snap.docs.forEach(d => {
          const data: any = d.data();
          const stampSrc = data.updatedAt || data.createdAt;
          const t = stampSrc?.toDate?.()?.getTime?.() || 0;
          if (t > seen) count++;
        });
        setEvents(count);
      } catch { setEvents(0); }
    });
    return () => unsub();
  }, [teamId]);

  return { chat, wall, events };
}
