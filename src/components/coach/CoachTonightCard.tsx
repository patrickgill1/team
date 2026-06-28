// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useViewMode } from '../../contexts/ViewModeContext';
import { isCoach } from '../../utils/helpers';
import type { CalendarEvent } from '../../types';

/**
 * Smart "tonight" card — adaptive single card for coaches that lives
 * on the dashboard between the hero and the dev plan row. Patrick
 * 2026-06-21 dialogue idea #2: 'a "What I'm doing tonight" smart
 * card... shifts based on what's actually happening — practice
 * tonight → shows the planned drills + countdown; game day → shows
 * formation + lineup link + weather; off day → shows the next big
 * thing.'
 *
 * V1 scope: renders only when there's a next event within 36 hours
 * AND user is a coach. Otherwise hidden (off-day surfacing TBD —
 * keeps v1 tight). Two type branches:
 *
 *   GAME  → game-day mode CTA + 'open formation' as secondary
 *   PRACTICE → practice plan CTA + 'mark attendance' as secondary
 *
 * Country to redundancy with the hero: the hero already shows the
 * event title + time + location + RSVP buttons. This card adds
 * coach-only context the hero doesn't carry: countdown, coach prep
 * actions (Game Day mode, practice plan), lineup/plan status.
 */

const CoachTonightCard: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Tick every 60s so the countdown stays fresh without re-running
  // the Firestore query.
  const [now, setNow] = useState(() => new Date());

  const { viewMode } = useViewMode();
  const isUserCoach = isCoach((userData as any)?.role) && viewMode === 'coach';

  useEffect(() => {
    if (!isUserCoach || !selectedTeamId) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const horizon = new Date(Date.now() + 36 * 60 * 60 * 1000);
        const q = query(
          collection(db, 'events'),
          where('teamId', '==', selectedTeamId),
          where('date', '>=', Timestamp.fromDate(new Date())),
          where('date', '<=', Timestamp.fromDate(horizon)),
          orderBy('date', 'asc'),
          limit(1)
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        if (!snap.empty) {
          const d: any = snap.docs[0].data();
          setEvent({
            id: snap.docs[0].id,
            ...d,
            date: d.date?.toDate?.() || new Date(d.date),
          });
        } else {
          setEvent(null);
        }
      } catch (err) {
        console.warn('[coach-tonight] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isUserCoach, selectedTeamId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const countdown = useMemo(() => {
    if (!event) return null;
    const ms = event.date.getTime() - now.getTime();
    if (ms < 0) return 'Live now';
    const totalMin = Math.floor(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h >= 24) return `in ${Math.round(h / 24)}d ${h % 24}h`;
    if (h >= 1) return `in ${h}h ${m}m`;
    if (m >= 5) return `in ${m}m`;
    return 'starting now';
  }, [event, now]);

  if (!isUserCoach) return null;
  if (!loaded) return null;
  if (!event) return null;

  const type = ((event as any).type || '').toLowerCase();
  const isGame = type === 'game' || type === 'tournament' || type === 'scrimmage';
  const isPractice = type === 'practice' || type === 'training';

  const eyebrow = isGame ? 'Game prep' : isPractice ? 'Practice prep' : 'Up next';
  const eyebrowTint = isGame ? 'text-brand-primary-soft' : isPractice ? 'text-amber-300' : 'text-sky-300';
  const headline = event.title || (isGame ? 'Game' : isPractice ? 'Practice' : 'Event');

  // Primary CTA differs by event type
  const primary = isGame
    ? { label: 'Open Game Day mode', href: `/game-day/${event.id}` }
    : isPractice
      ? { label: 'Open practice plan', href: '/practice-plan' }
      : { label: 'Open event', href: `/event/${event.id}` };

  return (
    <article className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 overflow-hidden animate-fade-in">
      <div className="px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className={`text-[10px] font-extrabold tracking-widest uppercase ${eyebrowTint}`}>{eyebrow}</p>
          <p className="text-[11px] font-bold text-ink-primary/55 tabular-nums">{countdown}</p>
        </div>
        <h3 className="text-lg font-black text-ink-primary leading-tight">{headline}</h3>
        <p className="text-xs text-ink-primary/55 mt-0.5">
          {event.date.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          {(event as any).location ? ` · ${(event as any).location}` : ''}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to={primary.href}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand-primary hover:bg-brand-primary text-white font-bold rounded-md text-[12px] tracking-wide ring-1 ring-brand-primary-soft/30 transition-colors"
          >
            {primary.label}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
          </Link>
          <Link
            to={`/event/${event.id}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-ink-primary/85 hover:text-ink-primary font-semibold rounded-md text-[12px] tracking-wide ring-1 ring-line-default/15 hover:ring-bone/40 hover:bg-line-default/5 transition-colors"
          >
            View RSVPs
          </Link>
        </div>
      </div>
    </article>
  );
};

export default CoachTonightCard;
