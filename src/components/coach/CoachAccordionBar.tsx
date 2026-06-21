// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useViewMode } from '../../contexts/ViewModeContext';
import { isCoach } from '../../utils/helpers';

/**
 * Coach accordion bar — ambient status indicator for coaches. Patrick
 * 2026-06-21 dialogue:
 *   'maybe a message came in so the bar turns green, maybe it is game
 *    day, so it turns red, maybe someone said they can't make it to
 *    practice or a game... when you click on the bar, the accordion
 *    expands and you can click new event, message team, see who has
 *    done their development plans.'
 *
 * Two visual states:
 *
 *   COLLAPSED: a slim bar that runs the page width. Color signals
 *     the highest-priority actionable state at a glance — coach can
 *     read the situation without parsing text. One-line summary +
 *     chevron beside it.
 *
 *   EXPANDED: the bar pushes down a panel below it with:
 *     - Status chips (one per active actionable category — RSVPs, game
 *       today, messages — each color-coded to match priority)
 *     - Quick action 2x2 (New event, Message team, Mark attendance,
 *       Open team chat)
 *
 * Color palette (priority order, brightest at top):
 *   crimson — action required NOW (RSVPs missing for event <24h)
 *   amber   — today / this-event-window (game day, practice today)
 *   cyan    — informational (new messages, new wall posts)
 *   hidden  — nothing actionable, bar collapses to 0px
 *
 * Renders as 0-height element when nothing's actionable so it doesn't
 * add visual chrome to a quiet day. Per the photo-with-purpose memory,
 * the hero photo above this bar should never compete with chrome that
 * isn't earning its place.
 */

type Priority = 'crimson' | 'amber' | 'cyan';

interface StatusItem {
  key: string;
  priority: Priority;
  label: string;
  detail: string;
  href: string;
}

interface MessagePreview {
  threadId: string;
  senderName: string;
  snippet: string;
  timestamp: Date;
}

const CoachAccordionBar: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const [items, setItems] = useState<StatusItem[]>([]);
  // Inbox preview: latest message per thread from senders other
  // than this coach, last 24h. Surfaced inline in the expanded
  // panel so a coach taps the bar → sees who pinged them → taps a
  // row → straight into that thread. 2-click path to a reply.
  // Patrick 2026-06-21 dialogue idea #5 (quick reply inbox), wired
  // into the accordion expansion rather than a new dashboard card.
  const [inboxPreviews, setInboxPreviews] = useState<MessagePreview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Tap-outside-to-close + Escape-to-close. Patrick 2026-06-21
  // reported feeling 'trapped' in the expanded panel — the only
  // close path was tapping the bar's chevron again. Now tapping
  // anywhere off the bar OR hitting Escape collapses it. Standard
  // inline-accordion behavior on web; matches what the More menu
  // does on the bottom sheet.
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const { viewMode } = useViewMode();
  // Bar shows only when the user is BOTH a coach AND has selected
  // coach view mode in the profile sheet. Multi-role users (admin+
  // coach+parent — Patrick himself) flip to parent view to clear
  // the dashboard of coach chrome when they're in family-context.
  const isUserCoach = isCoach((userData as any)?.role) && viewMode === 'coach';

  useEffect(() => {
    if (!isUserCoach || !selectedTeamId) {
      setLoaded(true);
      setItems([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
        const inOneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Pull upcoming events for the team + active player count in
        // parallel. The 'RSVPs missing' calc mirrors the Dashboard hero's
        // own math (rsvpCounts at Dashboard.tsx line 741): reads
        // event.playerRsvps (NOT event.rsvps — that's a legacy field)
        // and compares against the active players collection for the
        // team (NOT team.playerIds — that field is stale on
        // multi-team rosters). Both 'wrong field' mistakes were in
        // earlier versions; this finally matches the source of truth
        // the Dashboard already trusts.
        const eventsQ = query(
          collection(db, 'events'),
          where('teamId', '==', selectedTeamId),
          where('date', '>=', Timestamp.fromDate(now)),
          where('date', '<=', Timestamp.fromDate(inOneWeek)),
          orderBy('date', 'asc'),
          limit(5)
        );
        const playersQ = query(
          collection(db, 'players'),
          where('isActive', '==', true)
        );
        const [eventsSnap, playersSnap] = await Promise.all([
          getDocs(eventsQ),
          getDocs(playersQ),
        ]);
        if (cancelled) return;
        // Filter client-side to the active team (same pattern
        // useFirestore.getPlayersByTeam uses — avoids a composite
        // index requirement). Counts both legacy teamId field and
        // newer teamIds[] array memberships.
        const rosterSize = playersSnap.docs.filter((d) => {
          const p: any = d.data();
          if (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) return true;
          if (p.teamId === selectedTeamId) return true;
          return false;
        }).length;

        const next: StatusItem[] = [];

        // Game today check — any event whose date falls in today's window.
        const today = eventsSnap.docs.find((d) => {
          const ts: any = d.data().date;
          const dt = ts?.toDate?.() || new Date(ts);
          return dt >= startOfToday && dt < endOfToday;
        });
        if (today) {
          const data: any = today.data();
          const dt = data.date?.toDate?.() || new Date(data.date);
          next.push({
            key: 'today',
            priority: 'amber',
            label: 'Today',
            detail: `${data.title || 'Event'} · ${dt.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
            href: `/event/${today.id}`,
          });
        }

        // RSVPs missing for the next upcoming event — escalate to
        // crimson if that event is within 24h. Pending count =
        // team.playerIds.length minus the count of rsvps entries.
        // This is approximate (rsvps map may key on parent uid with
        // forPlayerName for multi-kid families, not on playerId
        // directly) but matches the order-of-magnitude users expect
        // when they think 'X kids haven't responded.'
        const nextEv = eventsSnap.docs[0];
        if (nextEv && rosterSize > 0) {
          const data: any = nextEv.data();
          const dt = data.date?.toDate?.() || new Date(data.date);
          // playerRsvps is keyed by playerId — same field the Dashboard
          // hero footer ('4 going · 3 pending') reads. publicRsvps
          // (separate field) covers guests/non-roster respondents and
          // doesn't reduce the 'how many roster kids are pending' count.
          const playerRsvps = data.playerRsvps || {};
          const responded = Object.keys(playerRsvps).length;
          const missing = Math.max(0, rosterSize - responded);
          if (missing > 0) {
            const hoursUntil = (dt.getTime() - now.getTime()) / (1000 * 60 * 60);
            const urgent = hoursUntil < 24;
            next.push({
              key: 'rsvps',
              priority: urgent ? 'crimson' : 'amber',
              label: urgent ? `${missing} RSVPs missing` : `${missing} pending RSVPs`,
              detail: `${data.title || 'Next event'} · ${urgent ? 'within 24h' : `${Math.round(hoursUntil)}h away`}`,
              href: `/event/${nextEv.id}`,
            });
          }
        }

        // Unread chats — read the local-storage lastSeen marker that
        // WallHeaderButton uses for the wall and assume the chat
        // unread is implied by the global notifier. For v1 we surface
        // a single static cyan if there are recent (<24h) team chat
        // messages from someone other than the coach. Real unread
        // tracking is a follow-up — keeps this MVP query tight.
        try {
          const chatQ = query(
            collection(db, 'chat_messages'),
            where('teamId', '==', selectedTeamId),
            orderBy('timestamp', 'desc'),
            limit(5)
          );
          const chatSnap = await getDocs(chatQ);
          const myUid = (userData as any)?.uid;
          const recent = chatSnap.docs.filter((d) => {
            const data: any = d.data();
            const ts = data.timestamp?.toDate?.() || new Date(data.timestamp || 0);
            const fromOther = data.senderId && data.senderId !== myUid;
            return fromOther && (now.getTime() - ts.getTime()) < 24 * 60 * 60 * 1000;
          });
          if (recent.length > 0) {
            next.push({
              key: 'messages',
              priority: 'cyan',
              label: `${recent.length} recent message${recent.length === 1 ? '' : 's'}`,
              detail: 'In team chat',
              href: '/chat',
            });

            // Build the inbox preview list — latest message per
            // unique thread, capped at 3. Lets the expanded panel
            // show a tap-to-open inbox without a separate query.
            const byThread = new Map<string, MessagePreview>();
            for (const d of recent) {
              const data: any = d.data();
              if (byThread.has(data.threadId)) continue;  // first = newest because we ordered desc
              const ts = data.timestamp?.toDate?.() || new Date(data.timestamp || 0);
              const snippet = (data.content || '')
                .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
                .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
                .replace(/[#*_`>~]+/g, '')
                .replace(/\s+/g, ' ')
                .trim();
              byThread.set(data.threadId, {
                threadId: data.threadId,
                senderName: data.senderName || 'Member',
                snippet: snippet || '(no text)',
                timestamp: ts,
              });
              if (byThread.size >= 3) break;
            }
            setInboxPreviews(Array.from(byThread.values()));
          } else {
            setInboxPreviews([]);
          }
        } catch (err) {
          // Chat query may fail (rules, missing index); silent skip.
        }

        if (cancelled) return;
        setItems(next);
      } catch (err) {
        console.warn('[coach-accordion-bar] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isUserCoach, selectedTeamId, (userData as any)?.uid]);

  const topPriority = useMemo<Priority | null>(() => {
    if (items.length === 0) return null;
    if (items.some((i) => i.priority === 'crimson')) return 'crimson';
    if (items.some((i) => i.priority === 'amber')) return 'amber';
    return 'cyan';
  }, [items]);

  if (!isUserCoach) return null;
  if (!loaded) return null;

  // Bar lives ALWAYS once a coach is signed in. Patrick 2026-06-21:
  // 'i would love for it to bend with the hero photo and be more
  // transparent. i honestly think it should just live there always,
  // but also change color when there is a real need.'
  //
  // Two visual states:
  //
  //   QUIET (no items)   — glassy charcoal at low opacity, blends
  //                        into the hero photo it tucks under. Subtle
  //                        'Coach quick actions' label + chevron so
  //                        the affordance is discoverable but doesn't
  //                        compete with the hero. Always tappable.
  //
  //   ACTIVE (items > 0) — solid priority color (crimson / amber /
  //                        cyan), opaque so it pops against the hero
  //                        and signals 'something needs you.'
  //                        Headline mirrors the top-priority item.
  // Bar stays consistently glassy — the pulsating DOT carries the
  // color signal, not the bar background. Patrick 2026-06-21:
  // 'maybe we make the thing very transparent, and then that little
  // pulsating dot is what shows the color of the notification.'
  //
  // Less aggressive, more elegant. Bar reads as consistent ambient
  // chrome; the dot is the attention beacon. Text tint matches the
  // priority color too so the SIGNAL stays glanceable without the
  // bar flipping its whole background.
  const colorFor = (p: Priority) => {
    if (p === 'crimson') return { dot: 'bg-crimson-400', text: 'text-crimson-200', chip: 'bg-crimson-500/15 text-crimson-200 ring-crimson-400/40' };
    if (p === 'amber')   return { dot: 'bg-amber-400',   text: 'text-amber-200',   chip: 'bg-amber-500/15 text-amber-200 ring-amber-400/40' };
    return                      { dot: 'bg-sky-400',     text: 'text-sky-200',     chip: 'bg-sky-500/15 text-sky-200 ring-sky-400/40' };
  };

  const hasItems = items.length > 0;
  const top = hasItems ? colorFor(topPriority!) : null;
  const headline = hasItems
    ? items.find((i) => i.priority === topPriority!)?.label || `${items.length} item${items.length === 1 ? '' : 's'}`
    : 'Coach quick actions';

  // Bar styling is ALWAYS the same charcoal glass — only the dot and
  // text color change between states. Keeps the visual chrome
  // consistent so the eye only learns one shape, then watches the dot
  // for attention cues.
  const collapsedBarClass = 'bg-charcoal-950/35 backdrop-blur-md';
  const dotClass = hasItems
    ? `${top!.dot} animate-pulse`
    : 'bg-bone/30';
  const textClass = hasItems ? top!.text : 'text-bone/70';

  return (
    // Wrapper mirrors NextEventPoster's outer section (px-3 sm:px-4,
    // no max-width constraint) so the bar's left/right edges align
    // exactly with the hero article above it. Negative top margin
    // overlaps the hero's bottom edge slightly so the bar feels
    // attached, not floating. Patrick 2026-06-21: 'doesnt align
    // properly' — was using max-w-7xl + different padding which
    // produced a wider bar than the hero card.
    <div ref={wrapperRef} className="relative -mt-3 px-3 sm:px-4 z-10 animate-fade-in">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-4 py-2 ${expanded ? 'rounded-b-none' : 'rounded-b-2xl'} ${collapsedBarClass} ${textClass} font-bold text-[12.5px] transition-colors duration-300`}
        aria-expanded={expanded}
        aria-label={`Coach status — ${headline}`}
      >
        <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden />
        <span className="flex-1 text-left truncate">{headline}{hasItems && items.length > 1 ? ` · +${items.length - 1} more` : ''}</span>
        <svg className={`w-3.5 h-3.5 transition-transform opacity-60 ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {/* Expanded panel — status chips (only when items present)
          plus quick actions (always). Uses the same width as the
          bar so it lines up under it. Glassy charcoal background
          so it reads as an extension of the bar, not a separate
          surface. */}
      {expanded && (
        // Same width as the button above — no ring (which was adding
        // 1-2px and made the dropdown look wider than the bar). Sits
        // flush against the button with rounded-b-2xl matching the
        // bar's bottom-corner radius. Glassy charcoal so the photo
        // tints through, consistent with the bar.
        <div className="bg-charcoal-950/55 backdrop-blur-md rounded-b-2xl animate-fade-in">
          <div className="px-4 py-3 space-y-3">
            {hasItems && (
              <ul className="flex flex-wrap gap-1.5">
                {items.map((i) => {
                  const c = colorFor(i.priority);
                  return (
                    <li key={i.key}>
                      <Link
                        to={i.href}
                        onClick={() => setExpanded(false)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ${c.chip} text-[11px] font-semibold hover:brightness-110 transition`}
                      >
                        <span className="font-extrabold">{i.label}</span>
                        <span className="opacity-70">·</span>
                        <span className="opacity-90">{i.detail}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Inline inbox preview — when there are recent team-chat
                messages, show the latest from each thread so the coach
                can read + tap directly to reply. 2-click path:
                tap bar → tap preview → in the thread. No separate
                inbox card / extra navigation. */}
            {inboxPreviews.length > 0 && (
              <ul className="space-y-1 -mx-1">
                {inboxPreviews.map((p) => {
                  const ago = (() => {
                    const ms = Date.now() - p.timestamp.getTime();
                    const mins = Math.floor(ms / 60_000);
                    if (mins < 60) return `${mins}m`;
                    const hrs = Math.floor(mins / 60);
                    if (hrs < 24) return `${hrs}h`;
                    return `${Math.floor(hrs / 24)}d`;
                  })();
                  return (
                    <li key={p.threadId}>
                      <Link
                        to="/chat"
                        onClick={() => setExpanded(false)}
                        className="flex items-center gap-2.5 px-1 py-1.5 rounded-md hover:bg-white/[0.04] transition"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[12.5px] font-bold text-bone truncate">{p.senderName}</span>
                            <span className="text-[10px] text-bone/40 shrink-0">{ago}</span>
                          </div>
                          <p className="text-[11.5px] text-bone/65 truncate">{p.snippet}</p>
                        </div>
                        <svg className="w-3 h-3 text-bone/35 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Quick action 2x4 — what coaches do daily */}
            <div className="grid grid-cols-4 gap-1.5">
              <Link to="/events" onClick={() => setExpanded(false)} className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-crimson-500/30 transition py-2 text-bone/85 hover:text-bone">
                <svg className="w-4 h-4 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                <span className="text-[10px] font-bold">Event</span>
              </Link>
              <Link to="/chat" onClick={() => setExpanded(false)} className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-crimson-500/30 transition py-2 text-bone/85 hover:text-bone">
                <svg className="w-4 h-4 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
                <span className="text-[10px] font-bold">Message</span>
              </Link>
              <Link to="/wall" onClick={() => setExpanded(false)} className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-crimson-500/30 transition py-2 text-bone/85 hover:text-bone">
                <svg className="w-4 h-4 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="7" y1="9" x2="17" y2="9" /><line x1="7" y1="13" x2="17" y2="13" /><line x1="7" y1="17" x2="13" y2="17" /></svg>
                <span className="text-[10px] font-bold">Post</span>
              </Link>
              <Link to="/coach" onClick={() => setExpanded(false)} className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-crimson-500/30 transition py-2 text-bone/85 hover:text-bone">
                <svg className="w-4 h-4 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
                <span className="text-[10px] font-bold">Cockpit</span>
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoachAccordionBar;
