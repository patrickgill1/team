import React, { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { sendPushToUsers } from '../../utils/notify';
import { useConfirm } from '../common/ConfirmDialog';

// Per-event discussion thread. Lives on the event page, NOT in the
// Chat tab — keeps the chat inbox uncluttered while still giving
// each event its own conversation surface. Backed by the top-level
// eventComments collection so we can query "recent activity across
// all events" for the Chat-tab strip without a collection-group read.

interface Comment {
  id: string;
  eventId: string;
  teamId: string;
  authorId: string;
  authorName: string;
  authorPhotoURL?: string;
  content: string;
  createdAt: any;
}

interface Props {
  eventId: string;
  teamId: string;
  userUid?: string;
  userName?: string;
  userPhotoURL?: string;
  /** User IDs we should ping when a new comment is posted (everyone
   *  who's RSVP'd going/maybe to this event, minus the commenter). */
  notifyUids?: string[];
  /** Event title — used in the notification text. */
  eventTitle?: string;
  /** Fires whenever the comment list length changes. Lets the parent
   *  collapse or hide the whole thread when it's empty without
   *  doubling up on a Firestore subscription. */
  onCountChange?: (n: number) => void;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const dayCount = Math.round(hr / 24);
  if (dayCount < 7) return `${dayCount}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const EventDiscussion: React.FC<Props> = ({ eventId, teamId, userUid, userName, userPhotoURL, notifyUids, eventTitle, onCountChange }) => {
  const confirm = useConfirm();
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const q = query(
      collection(db, 'eventComments'),
      where('eventId', '==', eventId),
      orderBy('createdAt', 'asc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as any),
        createdAt: (d.data() as any).createdAt?.toDate?.() || new Date(),
      })) as Comment[];
      setComments(list);
      // Bubble the count up so the parent can gate the whole thread
      // (hide when 0, collapse when >0) without a second listener.
      onCountChange?.(list.length);
    }, (err) => {
      // Firestore may take a moment to provision the composite index for
      // (eventId + createdAt). Don't surface that as a fatal error.
      console.warn('event comments subscribe failed', err);
    });
    return () => unsub();
  }, [eventId]);

  const post = async () => {
    const content = draft.trim();
    if (!content || !userUid || !userName || posting) return;
    setPosting(true);
    try {
      await addDoc(collection(db, 'eventComments'), {
        eventId,
        teamId,
        authorId: userUid,
        authorName: userName,
        authorPhotoURL: userPhotoURL || null,
        content,
        createdAt: serverTimestamp(),
      });
      setDraft('');
      // Refocus the composer for fast multi-message bursts.
      composerRef.current?.focus();
      // Push-notify everyone going/maybe on the event (minus the
      // commenter). Best-effort — silent no-op if push isn't
      // configured for the workspace.
      if (notifyUids && notifyUids.length > 0) {
        const targets = notifyUids.filter(u => u && u !== userUid);
        if (targets.length > 0) {
          sendPushToUsers(targets, {
            title: eventTitle ? `New comment on ${eventTitle}` : 'New event comment',
            body: `${userName}: ${content.slice(0, 140)}${content.length > 140 ? '…' : ''}`,
            url: `/events/${eventId}`,
          }, { pushPrefKey: 'events' }).catch(() => { /* non-fatal */ });
        }
      }
    } catch (err) {
      console.error('post comment failed', err);
      alert('Failed to send — please try again.');
    } finally {
      setPosting(false);
    }
  };

  const deleteComment = async (c: Comment) => {
    if (c.authorId !== userUid) return;
    if (!(await confirm({ body: 'Delete this comment?', destructive: true, confirmText: 'Delete' }))) return;
    try {
      await deleteDoc(doc(db, 'eventComments', c.id));
    } catch (err) {
      console.error('delete comment failed', err);
    }
  };

  return (
    <section className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 shadow-xl shadow-black/10 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="text-xs font-extrabold tracking-widest uppercase text-ink-primary/60 mb-2 flex items-center gap-1.5">
        <svg className="w-3 h-3 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Comments
        <span className="ml-1 text-ink-primary/40 font-bold">{comments.length}</span>
      </div>

      {comments.length === 0 ? (
        <p className="text-sm text-ink-primary/55 mb-3">First word's yours.</p>
      ) : (
        <ul className="space-y-2 mb-3 max-h-[60vh] overflow-y-auto">
          {comments.map(c => {
            const isMine = c.authorId === userUid;
            return (
              <li key={c.id} className={`flex gap-2 ${isMine ? 'flex-row-reverse' : ''}`}>
                {c.authorPhotoURL ? (
                  <img src={c.authorPhotoURL} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <span className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {(c.authorName || '?').charAt(0).toUpperCase()}
                  </span>
                )}
                <div className={`flex-1 min-w-0 ${isMine ? 'text-right' : ''}`}>
                  <div className="text-[11px] text-ink-primary/45">
                    <span className="font-semibold text-ink-primary/75">{c.authorName}</span>
                    <span className="ml-1.5">{formatRelative(c.createdAt)}</span>
                  </div>
                  <div
                    className={`inline-block mt-0.5 px-3 py-1.5 rounded-2xl text-sm break-words whitespace-pre-wrap text-left ${
                      isMine
                        ? 'bg-brand-primary text-white rounded-tr-sm'
                        : 'bg-surface-input text-ink-primary ring-1 ring-line-default/15 rounded-tl-sm'
                    }`}
                  >
                    {c.content}
                  </div>
                  {isMine && (
                    <button
                      onClick={() => deleteComment(c)}
                      className="block text-[10px] text-ink-primary/45 hover:text-rose-500 mt-0.5"
                    >Delete</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {userUid ? (
        <div className="flex gap-2">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter = send (desktop power-user). Plain Enter
              // inserts a newline — matches iMessage / WhatsApp on
              // mobile where there's no Shift key, and lets multi-line
              // comments survive instead of being submitted half-typed.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                post();
              }
            }}
            placeholder="Say something about this event…"
            rows={2}
            className="flex-1 px-3 py-2 bg-surface-input text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          />
          <button
            onClick={post}
            disabled={!draft.trim() || posting}
            className="px-4 rounded-lg bg-brand-primary text-white text-sm font-bold disabled:opacity-50"
          >Send</button>
        </div>
      ) : (
        <p className="text-xs text-ink-primary/50">Sign in to leave a comment.</p>
      )}
    </section>
  );
};

export default EventDiscussion;
