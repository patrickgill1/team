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

const EventDiscussion: React.FC<Props> = ({ eventId, teamId, userUid, userName, userPhotoURL }) => {
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
      setComments(snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as any),
        createdAt: (d.data() as any).createdAt?.toDate?.() || new Date(),
      })) as Comment[]);
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
    } catch (err) {
      console.error('post comment failed', err);
      alert('Failed to send — please try again.');
    } finally {
      setPosting(false);
    }
  };

  const deleteComment = async (c: Comment) => {
    if (c.authorId !== userUid) return;
    if (!window.confirm('Delete this comment?')) return;
    try {
      await deleteDoc(doc(db, 'eventComments', c.id));
    } catch (err) {
      console.error('delete comment failed', err);
    }
  };

  return (
    <section className="bg-white px-4 sm:px-6 py-3 border-b border-slate-200">
      <div className="text-xs font-extrabold tracking-widest uppercase text-slate-600 mb-2 flex items-center gap-1.5">
        <svg className="w-3 h-3 text-cyan-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Discussion
        <span className="ml-1 text-slate-400 font-bold">{comments.length}</span>
      </div>

      {comments.length === 0 ? (
        <p className="text-sm text-slate-500 mb-3">No messages yet — say something to kick it off.</p>
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
                  <div className="text-[11px] text-slate-500">
                    <span className="font-semibold text-slate-700">{c.authorName}</span>
                    <span className="ml-1.5">{formatRelative(c.createdAt)}</span>
                  </div>
                  <div
                    className={`inline-block mt-0.5 px-3 py-1.5 rounded-2xl text-sm break-words ${
                      isMine
                        ? 'bg-cyan-600 text-white rounded-tr-sm'
                        : 'bg-slate-100 text-slate-900 rounded-tl-sm'
                    }`}
                  >
                    {c.content}
                  </div>
                  {isMine && (
                    <button
                      onClick={() => deleteComment(c)}
                      className="block text-[10px] text-slate-400 hover:text-rose-500 mt-0.5"
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                post();
              }
            }}
            placeholder="Say something about this event…"
            rows={1}
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
          <button
            onClick={post}
            disabled={!draft.trim() || posting}
            className="px-4 rounded-lg bg-cyan-600 text-white text-sm font-bold disabled:opacity-50"
          >Send</button>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Sign in to join the discussion.</p>
      )}
    </section>
  );
};

export default EventDiscussion;
