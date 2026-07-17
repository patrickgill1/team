import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import type { KidChatMessage, Player, Team } from '../../types';
import { isCoachOfTeam } from '../../utils/helpers';
import { awardMicroXp } from '../../utils/microXp';
import { isXpSourceEnabled } from '../../utils/xpSource';
import { extractMentions } from '../../utils/extractMentions';
import { sendPushToUsers } from '../../utils/notify';
import { getShareOrigin } from '../../utils/origin';
import { useKidChatMembers } from './kidChatMembers';
import { debug, debugWarn } from '../../utils/debug';

interface Props {
  /** The kid whose bubble the message will be attributed to. When
   *  omitted, the composer is hidden — that's the parent shadow /
   *  coach moderation read-only mode. */
  actingAsPlayer?: Player | null;
  /** The team the chat belongs to. Required in all modes. */
  team: Team | null | undefined;
  /** Composer visibility. Kid mode = true. Parent shadow + coach
   *  moderation = false. */
  canPost: boolean;
  /** Room chrome: full-height flex column vs. bounded card. */
  variant?: 'full' | 'compact';
}

// KidChatRoom — the kids-only team chat room. One thread per team;
// created on first send. Every message stamps actingAsPlayerId +
// actingAsName so the bubble reads "Hunter" even though the auth
// layer is Patrick's uid.
//
// Read audience: parents (shadow) + coaches (moderation) + kids
// themselves. All gated at the rules layer by user.teamIds matching
// message.teamId.
//
// Write audience: parent-of-actingAsPlayer only. Kid in kid mode
// hits the composer; parent uid is the actor at the auth layer but
// the bubble displays as the kid. Rules enforce that senderUid is
// on the acting-as player's parentIds AND kidMode is enabled on
// that player.
//
// Push routing (2026-07-12, v1 mentions-only):
//   Kid chat pushes default to mentions-only. Recipients =
//   (mentioned parent uids) ∪ (thread.notifyAllUids) minus sender.
//   Push copy attributes to actingAsName (kid) not the parent uid so
//   a parent doesn't see "Patrick in Fire FC chat" when the message
//   was actually from their kid Hunter. @everyone / @channel / @all
//   are parsed but NOT expanded in v1 — kids don't need @channel and
//   the alternative is a team-wide user query on every message.
const KidChatRoom: React.FC<Props> = ({ actingAsPlayer, team, canPost, variant = 'full' }) => {
  const { userData } = useAuth();
  const [messages, setMessages] = useState<KidChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Cached "thread already exists" flag so send() doesn't setDoc on
  // every message. Firestore rules forbid updates on kid_chat_threads
  // (create-only for non-notifyAllUids fields), and setDoc(..., {merge:true})
  // on an existing doc becomes an UPDATE — that permission-denied
  // error was silently failing every subsequent send after the first
  // (audit 2026-07-12).
  const [threadReady, setThreadReady] = useState(false);
  // Live copy of the thread doc so send() can read notifyAllUids
  // without a per-send round-trip. Subscribed once per thread; the
  // bell toggle in KidDashboard writes back to the same doc and this
  // callback picks it up.
  const [threadDoc, setThreadDoc] = useState<{ notifyAllUids?: string[] } | null>(null);

  // Mention-picker state — ported from MessageComposer's plain-textarea
  // pattern (rest of the app is plain-text-on-the-wire, no TipTap
  // mention node). Roster comes from kidChatMembers helper: kids by
  // firstName + coaches; expandToPushTargets turns kid picks into
  // their parent uids at send time.
  const kidMembers = useKidChatMembers(team?.id || null, team);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [pickerHighlight, setPickerHighlight] = useState(0);

  const teamId = team?.id || '';
  const threadDocId = teamId ? `team_${teamId}` : '';
  const isCoach = isCoachOfTeam(userData, team);

  // One-shot thread provisioning. Reads existence first, only writes
  // if missing. Runs on mount + on teamId change; the threadReady
  // gate below in send() means we never try to write again this
  // session even if this effect races.
  useEffect(() => {
    if (!teamId || !userData) return;
    if (!canPost) { setThreadReady(true); return; } // read-only viewers don't need write path
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, 'kid_chat_threads', threadDocId);
        const snap = await getDoc(ref);
        if (cancelled) return;
        if (snap.exists()) {
          setThreadReady(true);
          return;
        }
        // Thread doesn't exist yet — create it once.
        await setDoc(ref, {
          teamId,
          audience: 'kids',
          createdAt: serverTimestamp(),
          createdByUid: (userData as any).uid,
        });
        if (!cancelled) setThreadReady(true);
      } catch (err) {
        // Thread might exist and read was denied, or create race with
        // another parent. Either way, message send below will surface
        // the real error if it fails. Mark ready to unblock.
        console.warn('[kid-chat] thread provision check failed', err);
        if (!cancelled) setThreadReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [teamId, threadDocId, canPost, (userData as any)?.uid]);

  // Live subscription on the thread doc. Purpose: read notifyAllUids
  // synchronously at send() time to compute the push recipient set
  // as (mentions ∪ notifyAllUids), and to keep the KidDashboard bell
  // toggle in sync with any changes another device makes. Errors
  // during auth transitions route to debugWarn — the send path
  // gracefully handles null threadDoc.
  useEffect(() => {
    if (!threadDocId) return;
    const unsub = onSnapshot(doc(db, 'kid_chat_threads', threadDocId), (snap) => {
      if (!snap.exists()) { setThreadDoc(null); return; }
      const d: any = snap.data();
      setThreadDoc({ notifyAllUids: Array.isArray(d.notifyAllUids) ? d.notifyAllUids : [] });
    }, (err) => {
      const code = (err as any)?.code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        debugWarn('[kid-chat] thread subscribe denied (auth transition)', err);
      } else {
        debugWarn('[kid-chat] thread subscribe failed', err);
      }
    });
    return () => unsub();
  }, [threadDocId]);

  // Subscribe to messages for this team's kid chat thread. We use a
  // deterministic thread id (team_<teamId>) so the "one thread per
  // team" invariant lives in the id space, not a query.
  useEffect(() => {
    if (!teamId) { setLoading(false); return; }
    const q = query(
      collection(db, 'kid_chat_messages'),
      where('teamId', '==', teamId),
      orderBy('createdAt', 'asc'),
      fsLimit(200),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: KidChatMessage[] = snap.docs.map(d => {
        const data: any = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() ?? new Date(data.createdAt || Date.now()),
          deletedAt: data.deletedAt?.toDate?.() ?? (data.deletedAt ? new Date(data.deletedAt) : undefined),
        } as KidChatMessage;
      });
      setMessages(rows);
      setLoading(false);
    }, (err) => {
      console.warn('[kid-chat] messages subscribe failed', err);
      setLoading(false);
    });
    return () => unsub();
  }, [teamId]);

  // Auto-scroll to bottom on new messages. Only if the reader is
  // already near the bottom so we don't yank them out of scroll-
  // back reading.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [messages.length]);

  // Mention picker — port of MessageComposer's caret+regex approach.
  // Kept plaintext (no TipTap) so the wire format stays "@FirstName"
  // and the doc reads the same as adult chat. Picker filters against
  // kids' first names + coach display names.
  const updateMentionState = (val: string, caret: number) => {
    const before = val.slice(0, caret);
    const match = before.match(/(^|\s)@([A-Za-z][A-Za-z0-9 _'-]{0,28})$/);
    if (match) {
      const start = caret - match[2].length - 1; // include the @
      setMentionQuery(match[2].toLowerCase());
      setMentionRange({ start, end: caret });
      setPickerHighlight(0);
    } else {
      setMentionQuery(null);
      setMentionRange(null);
    }
  };

  const filteredPickerMembers = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim();
    return kidMembers.pickerMembers
      .filter(m => m.name && m.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, kidMembers.pickerMembers]);

  const insertMention = (m: { uid: string; name: string }) => {
    if (!mentionRange) return;
    const before = text.slice(0, mentionRange.start);
    const after = text.slice(mentionRange.end);
    const insert = `@${m.name} `;
    const next = before + insert + after;
    setText(next);
    setMentionQuery(null);
    setMentionRange(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) {
        const caret = before.length + insert.length;
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    if (!actingAsPlayer || !userData || !teamId) return;
    setSending(true);
    try {
      // Thread doc is provisioned by the mount effect above. Nothing
      // to write here except the message itself.
      const firstName = (actingAsPlayer.name || 'Player').split(' ')[0];

      // Parse @-mentions client-side against the kids+coaches roster.
      // `resolvedUids` is a mix of playerIds (kids) and real coach
      // uids. `pushTargets` expands kid playerIds to their parents.
      const { uids: resolvedUids, everyone } = extractMentions(body, kidMembers.pickerMembers);
      const senderUid: string = (userData as any).uid;
      const pushTargets = kidMembers
        .expandToPushTargets(resolvedUids)
        .filter(u => u && u !== senderUid);

      // Write mentions[] onto the doc even when empty is missing:
      // downstream schemas (KidChatMessage type) treat undefined and
      // [] identically. Omitting the key keeps the doc lean when
      // there are no @'s.
      const messagePayload: any = {
        threadId: threadDocId,
        teamId,
        actingAsPlayerId: actingAsPlayer.id,
        actingAsName: firstName,
        actingAsPhotoUrl: actingAsPlayer.profilePhotoUrl || null,
        senderUid,
        text: body,
        createdAt: serverTimestamp(),
        isDeleted: false,
      };
      if (pushTargets.length > 0) messagePayload.mentions = pushTargets;
      if (everyone) messagePayload.mentionsEveryone = true;

      await addDoc(collection(db, 'kid_chat_messages'), messagePayload);

      // Push fanout: mentions ∪ thread.notifyAllUids, minus sender.
      // v1 explicitly does NOT expand @everyone — kids don't need
      // @channel and a team-wide user query per message is heavier
      // than the feature earns. If a coach or engaged parent wants
      // full visibility, they flip the bell in the modal header
      // (writes to notifyAllUids).
      try {
        const notifyAll = threadDoc?.notifyAllUids || [];
        const recipientSet = new Set<string>([...pushTargets, ...notifyAll]);
        recipientSet.delete(senderUid);
        const recipients = Array.from(recipientSet);
        if (recipients.length > 0) {
          const teamName = team?.name || 'Team HQ';
          const title = `${firstName} in ${teamName}`;
          const preview = body.length > 140 ? body.slice(0, 140) + '...' : body;
          const url = `${getShareOrigin()}/kid-dashboard?playerId=${encodeURIComponent(actingAsPlayer.id)}&chat=1`;
          // Fire-and-forget: same pattern as TeamChat. If the network
          // drops between addDoc and this call the message still
          // persists; the push just won't fire (acceptable for chat).
          void sendPushToUsers(recipients, { title, body: preview, url }, {
            pushPrefKey: 'chat',
            fromUid: senderUid,
          }).catch(err => debugWarn('[kid-chat] push fanout failed', err));
        } else {
          debug('[kid-chat] no push recipients (no mentions + no notifyAll)');
        }
      } catch (err) {
        // Push fanout error must never fail the send — the message
        // already landed in Firestore.
        debugWarn('[kid-chat] push fanout threw', err);
      }

      // Micro-XP: +2 per message, daily cap 20 (10 messages). Fires
      // fire-and-forget so the player-doc round-trip doesn't block
      // the composer clearing. awardMicroXp is fail-closed on
      // xpEnabled, so teams that never turned XP on write nothing.
      void awardMicroXp(actingAsPlayer.id, 2, {
        xpEnabled: isXpSourceEnabled(team as any, 'kidChat'),
        dailyCap: 20,
        actionKey: 'chat_message',
      });
      setText('');
      setMentionQuery(null);
      setMentionRange(null);
      // Force scroll-to-bottom after own send even if user had
      // scrolled up — treat the send as intent to see the new msg.
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (err) {
      console.error('[kid-chat] send failed', err);
      alert('Could not send message. Try again.');
    } finally {
      setSending(false);
    }
  };

  const moderate = async (m: KidChatMessage) => {
    if (!userData) return;
    const isMine = m.senderUid === (userData as any).uid;
    if (!isMine && !isCoach) return;
    if (m.isDeleted) return;
    const label = isCoach && !isMine ? 'Remove this message?' : 'Delete this message?';
    if (!window.confirm(label)) return;
    try {
      await updateDoc(doc(db, 'kid_chat_messages', m.id), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedByUid: (userData as any).uid,
      });
    } catch (err) {
      console.error('[kid-chat] delete failed', err);
      alert('Could not remove.');
    }
  };

  const wrapperClass = variant === 'full'
    ? 'flex flex-col h-full min-h-0'
    : 'flex flex-col max-h-[420px]';

  return (
    <div className={wrapperClass}>
      {/* Message list — empty state centers vertically in the pane
          so the composer at the bottom doesn't feel like it's
          floating alone with a headline stuck at the top. */}
      <div
        ref={scrollRef}
        className={
          'flex-1 min-h-0 overflow-y-auto px-1 py-2 ' +
          (messages.length === 0 ? 'flex flex-col items-center justify-center' : 'space-y-2')
        }
      >
        {loading ? (
          <p className="text-sm text-ink-primary/50 text-center py-6">Loading messages...</p>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 max-w-xs text-center px-4">
            <svg viewBox="0 0 120 80" className="w-24 h-16 text-brand-primary/70" aria-hidden>
              <rect x="6" y="10" width="70" height="42" rx="12" fill="none" stroke="currentColor" strokeWidth="2.4" />
              <rect x="44" y="28" width="70" height="42" rx="12" fill="none" stroke="currentColor" strokeWidth="2.4" />
              <circle cx="79" cy="49" r="6.5" fill="currentColor" />
              <path d="M75.5 46.5 L79 43.5 L82.5 46.5 L82.5 51.5 L79 54.5 L75.5 51.5 Z" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.2" />
            </svg>
            <p className="text-sm font-semibold text-ink-primary/70 leading-snug">
              {canPost
                ? "No messages yet. Say hi to your teammates!"
                : "Nothing here yet."}
            </p>
          </div>
        ) : (
          messages.map(m => (
            <KidMessageBubble
              key={m.id}
              message={m}
              isMine={userData ? m.actingAsPlayerId === actingAsPlayer?.id : false}
              canModerate={
                (userData && m.senderUid === (userData as any).uid)
                || isCoach
              }
              onModerate={() => moderate(m)}
            />
          ))
        )}
      </div>

      {/* Composer — only in kid mode. Rules also gate write on
          parent-of-actingAsPlayer + kidMode enabled. */}
      {canPost && actingAsPlayer && (
        <div className="border-t border-line-default/15 bg-surface-elevated/80 backdrop-blur px-2 py-2 flex items-end gap-2 relative">
          {/* Mention picker dropdown — same rendering as adult chat's
              MessageComposer for consistency. Anchored above the
              textarea via absolute positioning. */}
          {mentionQuery !== null && filteredPickerMembers.length > 0 && (
            <div className="absolute z-30 bottom-full mb-1 left-2 right-16 max-h-48 overflow-y-auto bg-surface-elevated ring-1 ring-line-default/10 rounded-lg shadow-2xl">
              {filteredPickerMembers.map((m, i) => (
                <button
                  key={m.uid}
                  type="button"
                  onMouseDown={(e) => {
                    // onMouseDown (not onClick) so the textarea keeps
                    // focus and the caret position stays intact.
                    e.preventDefault();
                    insertMention(m);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-line-default/5 flex items-center gap-2 ${
                    i === pickerHighlight ? 'bg-line-default/5' : ''
                  }`}
                >
                  <span className="font-medium text-ink-primary">@{m.name}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              updateMentionState(v, e.target.selectionStart || v.length);
            }}
            onKeyDown={(e) => {
              // Picker navigation takes precedence when open.
              if (mentionQuery !== null && filteredPickerMembers.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPickerHighlight(h => Math.min(h + 1, filteredPickerMembers.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPickerHighlight(h => Math.max(h - 1, 0));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  insertMention(filteredPickerMembers[pickerHighlight]);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={`Message your teammates`}
            className="flex-1 resize-none rounded-xl bg-surface-input ring-1 ring-line-default/20 px-3 py-2 text-sm text-ink-primary placeholder:text-ink-primary/40 outline-none focus:ring-2 focus:ring-brand-primary/40 max-h-24"
            disabled={sending}
          />
          <button
            onClick={send}
            disabled={sending || !text.trim()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-brand-primary text-white text-xs font-black tracking-wider uppercase shadow-md hover:brightness-110 active:scale-95 transition disabled:opacity-50"
            aria-label="Send"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
};

// Message bubble — attributes to the kid (not the parent uid).
// Shows a "removed" placeholder when isDeleted so shadow readers
// see that moderation happened.
const KidMessageBubble: React.FC<{
  message: KidChatMessage;
  isMine: boolean;
  canModerate: boolean;
  onModerate: () => void;
}> = ({ message, isMine, canModerate, onModerate }) => {
  const bubbleTone = isMine
    ? 'bg-brand-primary text-white'
    : 'bg-surface-input text-ink-primary';
  const align = isMine ? 'items-end ml-auto' : 'items-start';
  const time = message.createdAt ? new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

  if (message.isDeleted) {
    return (
      <div className={`flex flex-col gap-1 max-w-[85%] ${align}`}>
        <div className="rounded-2xl bg-line-default/[0.06] ring-1 ring-line-default/15 px-3 py-1.5 text-[12px] italic text-ink-primary/50">
          Removed
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex flex-col gap-0.5 max-w-[85%] ${align}`}>
      {!isMine && (
        <div className="flex items-center gap-1.5 pl-1">
          {message.actingAsPhotoUrl ? (
            <img src={message.actingAsPhotoUrl} alt="" className="w-4 h-4 rounded-full object-cover" />
          ) : (
            <div className="w-4 h-4 rounded-full bg-line-default/20 flex items-center justify-center text-[8px] font-black text-ink-primary/70">
              {message.actingAsName?.charAt(0) || '?'}
            </div>
          )}
          <span className="text-[10px] font-bold text-ink-primary/65">{message.actingAsName}</span>
        </div>
      )}
      <div
        className={`relative rounded-2xl px-3 py-2 text-[14px] leading-snug shadow-sm ${bubbleTone} whitespace-pre-wrap break-words`}
        onContextMenu={canModerate ? (e) => { e.preventDefault(); onModerate(); } : undefined}
      >
        {message.text}
        {canModerate && (
          <button
            onClick={onModerate}
            aria-label="Remove message"
            className={`absolute -top-2 -right-2 w-5 h-5 rounded-full bg-surface-base ring-1 ring-line-default/25 text-[10px] font-black text-ink-primary/60 opacity-0 group-hover:opacity-100 focus:opacity-100 transition`}
          >
            ×
          </button>
        )}
      </div>
      {time && (
        <span className={`text-[9px] text-ink-primary/40 tabular-nums ${isMine ? 'pr-1' : 'pl-1'}`}>{time}</span>
      )}
    </div>
  );
};

export default KidChatRoom;
