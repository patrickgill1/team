import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import type { WallPost } from '../types';
import { getShareOrigin } from '../utils/origin';
import { RichContent } from './Wall';

// Public-facing single wall post view. Anyone with the share link can
// open this; the post's content + attachments render but there's no
// auth-gated chrome (no app shell, no nav, no comments composer).
// Gated by Firestore rule on wall_posts.isPublic === true.

const PublicWallPost: React.FC = () => {
  const { postId } = useParams<{ postId: string }>();
  const [post, setPost] = useState<WallPost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!postId) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'wall_posts', postId));
        if (!snap.exists()) { setError('Post not found.'); return; }
        const data = snap.data() as any;
        if (!data.isPublic) { setError('This post is private.'); return; }
        setPost({
          id: snap.id,
          teamId: data.teamId,
          content: data.content || '',
          // Drives the TipTap-HTML vs legacy-markdown render branch.
          // Without this, every post rendered escaped HTML tags as
          // visible text. Same bug as fixed in Wall.tsx on 3.7.24,
          // missed on this public-share page.
          ...(data.contentFormat ? { contentFormat: data.contentFormat } : {}),
          senderId: data.senderId,
          senderName: data.senderName || 'Coach',
          senderRole: data.senderRole,
          timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
          attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
          reactions: Array.isArray(data.reactions) ? data.reactions : [],
          wallPinnedTop: data.wallPinnedTop ?? null,
          postedFrom: data.postedFrom,
        });
      } catch (err: any) {
        console.error('public wall load failed', err);
        setError(err?.message || 'Could not load post.');
      } finally {
        setLoading(false);
      }
    })();
  }, [postId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary/30 border-t-cyan-400" />
      </div>
    );
  }
  if (error || !post) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-center">
        <div>
          <h1 className="text-xl font-bold text-slate-900 mb-1">{error || 'Post unavailable'}</h1>
          <p className="text-sm text-slate-500">The link may have expired or the post may have been deleted.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 sm:px-6 py-5 text-center border-b border-brand-primary/15">
        <p className="text-[10px] font-extrabold tracking-[0.3em] text-brand-primary-soft uppercase">GoalKickr · The Wall</p>
        <h1 className="text-xl sm:text-2xl font-black text-white mt-1">A post from {post.senderName}</h1>
      </header>

      <article className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
          <div className="px-4 sm:px-6 py-3 border-b border-slate-100 flex items-center gap-2">
            <span className="text-sm font-bold text-slate-900">{post.senderName}</span>
            {post.senderRole === 'coach' && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-brand-primary bg-brand-primary-soft ring-1 ring-brand-primary-soft px-1.5 py-0.5 rounded">Coach</span>
            )}
            <span className="text-[11px] text-slate-400 ml-auto">
              {post.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <div className="px-4 sm:px-6 py-4 text-slate-800 break-words text-[15px] leading-relaxed">
            {post.contentFormat === 'tiptap-html' ? (
              <div
                className="tiptap-rendered"
                // TipTap output is schema-constrained — only the
                // nodes/marks our extensions allow are ever
                // serialized. Safe to render directly.
                dangerouslySetInnerHTML={{ __html: post.content }}
              />
            ) : (
              <RichContent text={post.content} />
            )}
          </div>
          {post.attachments && post.attachments.length > 0 && (
            <div className={`px-4 sm:px-6 pb-4 grid gap-2 ${post.attachments.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {post.attachments.slice(0, 4).map((a, i) => (
                <img
                  key={i}
                  src={a.url}
                  alt={a.name || ''}
                  loading="lazy"
                  className="rounded-lg object-cover w-full max-h-[480px] ring-1 ring-slate-200"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              ))}
            </div>
          )}
        </div>
        <p className="text-center text-xs text-slate-400 mt-6">
          Shared from GoalKickr. <Link to="/" className="text-brand-primary font-semibold">Open the app</Link>
        </p>
      </article>
    </div>
  );
};

export default PublicWallPost;

export const wallPostShareUrl = (postId: string) => `${getShareOrigin()}/wall/p/${postId}`;
