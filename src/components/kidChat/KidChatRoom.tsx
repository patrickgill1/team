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
// No push notifications in v1 — pushes would route to parent uid
// which is confusing when the message is FROM the kid. Phase 3.
const KidChatRoom: React.FC<Props> = ({ actingAsPlayer, team, canPost, variant = 'full' }) => {
  const { userData } = useAuth();
  const [messages, setMessages] = useState<KidChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Cached "thread already exists" flag so send() doesn't setDoc on
  // every message. Firestore rules forbid updates on kid_chat_threads
  // (create-only), and setDoc(..., {merge:true}) on an existing doc
  // becomes an UPDATE — that permission-denied error was silently
  // failing every subsequent send after the first (audit 2026-07-12).
  const [threadReady, setThreadReady] = useState(false);

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

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    if (!actingAsPlayer || !userData || !teamId) return;
    setSending(true);
    try {
      // Thread doc is provisioned by the mount effect above. Nothing
      // to write here except the message itself.
      const firstName = (actingAsPlayer.name || 'Player').split(' ')[0];
      await addDoc(collection(db, 'kid_chat_messages'), {
        threadId: threadDocId,
        teamId,
        actingAsPlayerId: actingAsPlayer.id,
        actingAsName: firstName,
        actingAsPhotoUrl: actingAsPlayer.profilePhotoUrl || null,
        senderUid: (userData as any).uid,
        text: body,
        createdAt: serverTimestamp(),
        isDeleted: false,
      });
      // Micro-XP: +2 per message, daily cap 20 (10 messages). Fires
      // fire-and-forget so the player-doc round-trip doesn't block
      // the composer clearing. awardMicroXp is fail-closed on
      // xpEnabled, so teams that never turned XP on write nothing.
      void awardMicroXp(actingAsPlayer.id, 2, {
        xpEnabled: Boolean((team as any)?.xpConfig?.enabled),
        dailyCap: 20,
        actionKey: 'chat_message',
      });
      setText('');
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
        <div className="border-t border-line-default/15 bg-surface-elevated/80 backdrop-blur px-2 py-2 flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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
